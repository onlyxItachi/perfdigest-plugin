import { spawn } from 'node:child_process';
import type { ModelReasoningEffort, Thread, Usage } from '@openai/codex-sdk';
import { codexThread, codexTurn } from './codex.js';
import { childEnvironment, redact } from './environment.js';
import type { Emit } from './config.js';

/**
 * Capability-based agent integration contract.
 *
 * PerfDigest never injects evidence into an agent's hidden reasoning. Evidence is delivered
 * as an ordinary later turn. How that turn is delivered depends on declared capabilities:
 * - sameSessionContinuation: the review turn continues the analysis session (Codex threads).
 * - otherwise: a fresh session receives the earlier analysis text plus the evidence, and the
 *   receipt records that weaker delivery explicitly.
 * nativeAsyncInput (accepting new input while a turn is running) is declared but never
 * assumed; no current adapter supports it and the runner does not require it.
 */
export interface AgentCapabilities {
  sameSessionContinuation: boolean;
  nativeAsyncInput: boolean;
  cancellation: boolean;
  usageReporting: boolean;
  /** Execution isolation the adapter requests from the agent runtime, if any. */
  sandbox: 'read-only' | 'agent-defined';
}

export type AgentPhase = 'analysis' | 'review';
export type EvidenceDelivery = 'same_session_next_turn' | 'fresh_session_with_context';

/** Kept field-compatible with the previous CodexTurn receipt shape (threadId). */
export interface AgentTurn {
  text: string;
  usage: Usage | null;
  threadId: string | null;
}

export type AgentErrorKind = 'failed' | 'timed_out' | 'cancelled' | 'protocol' | 'unsupported';
export class AgentError extends Error {
  constructor(readonly kind: AgentErrorKind, readonly phase: AgentPhase | 'start', message: string) {
    super(`Agent ${phase} ${kind}: ${redact(message)}`);
  }
  toJSON() { return { kind: this.kind, phase: this.phase, message: this.message }; }
}

export interface TurnOptions { signal: AbortSignal; emit: Emit }
export interface AgentSession {
  readonly id: string | null;
  turn(prompt: string, phase: AgentPhase, options: TurnOptions): Promise<AgentTurn>;
}
export interface AgentAdapter {
  readonly name: string;
  /** Timeline event prefix, e.g. codex.analysis.turn_started. */
  readonly eventPrefix: string;
  readonly capabilities: AgentCapabilities;
  start(options: { workspace: string; signal: AbortSignal }): Promise<AgentSession>;
}

/** Codex SDK adapter: preserves the existing same-thread delivery, isolation and event names. */
export function codexAdapter(options: { model?: string; effort?: ModelReasoningEffort } = {}): AgentAdapter {
  return {
    name: 'codex', eventPrefix: 'codex',
    capabilities: { sameSessionContinuation: true, nativeAsyncInput: false, cancellation: true, usageReporting: true, sandbox: 'read-only' },
    async start({ workspace }) {
      const thread: Thread = await codexThread(workspace, options.model, options.effort);
      return {
        get id() { return thread.id; },
        turn: (prompt, phase, { signal, emit }) => codexTurn(thread, prompt, phase, signal, emit),
      };
    },
  };
}

export interface GenericCliAgentOptions {
  /** Executable path; started without a shell and with the allowlisted child environment. */
  command: string;
  args?: string[];
  /** Declare true only if the agent honors sessionId across turns; verified on every review. */
  sessions?: boolean;
  /** Per-turn deadline. */
  timeoutMs?: number;
  /** Bound on stdout accepted from the agent. */
  maxOutputBytes?: number;
  /** Explicitly rejected if true: one-process-per-turn CLI agents do not support mid-turn async input. */
  nativeAsyncInput?: boolean;
}

const protocol = 'perfdigest-agent/v1';

/**
 * Generic asynchronous CLI adapter (protocol perfdigest-agent/v1). One process per turn:
 * stdin receives one JSON line {protocol, phase, prompt, sessionId}; stdout emits JSON lines,
 * optionally {"type":"started"} and exactly one final {"type":"result","text",...}.
 * Any other output, a nonzero exit, oversized output or a broken session claim is a protocol
 * failure. Cancellation and timeouts terminate the process (SIGTERM, then SIGKILL).
 */
export function genericCliAdapter(options: GenericCliAgentOptions): AgentAdapter {
  if (!options.command || !options.command.trim()) {
    throw new AgentError('unsupported', 'start', 'generic CLI adapter requires a non-empty command');
  }
  if (options.nativeAsyncInput) {
    throw new AgentError('unsupported', 'start', 'generic CLI adapter does not support nativeAsyncInput');
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new AgentError('unsupported', 'start', 'timeoutMs must be a positive number');
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  const sessions = options.sessions ?? false;
  return {
    name: 'generic-cli', eventPrefix: 'agent',
    capabilities: { sameSessionContinuation: sessions, nativeAsyncInput: false, cancellation: true, usageReporting: true, sandbox: 'agent-defined' },
    async start({ workspace }) {
      let sessionId: string | null = null;
      return {
        get id() { return sessionId; },
        async turn(prompt, phase, { signal, emit }) {
          emit(`agent.${phase}.started`);
          const deadline = AbortSignal.timeout(timeoutMs);
          const combined = AbortSignal.any([signal, deadline]);
          const result = await runTurn(options.command, options.args ?? [], workspace, combined,
            JSON.stringify({ protocol, phase, prompt, sessionId: sessions ? sessionId : null }), maxOutputBytes,
            () => emit(`agent.${phase}.turn_started`))
            .catch((error: unknown) => {
              if (error instanceof AgentError) throw new AgentError(error.kind, phase, error.message);
              if (deadline.aborted) throw new AgentError('timed_out', phase, `no result within ${timeoutMs} ms`);
              if (signal.aborted) throw new AgentError('cancelled', phase, 'run cancelled');
              throw new AgentError('failed', phase, error instanceof Error ? error.message : String(error));
            });
          if (sessions) {
            if (!result.sessionId) throw new AgentError('protocol', phase, 'sessions were declared but no sessionId was returned');
            if (sessionId !== null && result.sessionId !== sessionId) throw new AgentError('protocol', phase, 'session continuation was declared but not honored');
            sessionId = result.sessionId;
          }
          emit(`agent.${phase}.completed`);
          return { text: redact(result.text), usage: result.usage, threadId: sessions ? sessionId : null };
        },
      };
    },
  };
}

interface TurnResult { text: string; sessionId: string | null; usage: Usage | null }

function runTurn(command: string, args: string[], cwd: string, signal: AbortSignal, input: string,
  maxOutputBytes: number, onStarted: () => void): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted before start')); return; }
    const child = spawn(command, args, { cwd, env: childEnvironment(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let bytes = 0; let settled = false; let started = false; let killTimer: NodeJS.Timeout | undefined;
    const finish = (error: Error | null, value?: TurnResult) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value!);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); killTimer.unref();
      finish(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) { child.kill('SIGKILL'); finish(new AgentError('protocol', 'start', 'agent output exceeded the limit')); return; }
      stdout += chunk.toString('utf8');
      if (!started && (stdout.includes('"type":"started"') || stdout.includes('"type": "started"'))) { started = true; onStarted(); }
    });
    child.stderr.resume();
    child.on('error', error => finish(new AgentError('failed', 'start', error.message)));
    child.on('close', code => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0) { finish(new AgentError('failed', 'start', `agent exited with code ${code}`)); return; }
      try {
        const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
        const results = lines.filter(l => l.type === 'result');
        if (lines.some(l => l.type !== 'result' && l.type !== 'started') || results.length !== 1) throw new Error();
        const r = results[0]!;
        if (typeof r.text !== 'string' || !r.text) throw new Error();
        if (r.sessionId !== undefined && r.sessionId !== null && (typeof r.sessionId !== 'string' || !/^[\w.-]{1,128}$/.test(r.sessionId))) throw new Error();
        const usage = r.usage && typeof r.usage === 'object' ? r.usage as Usage : null;
        finish(null, { text: r.text, sessionId: (r.sessionId as string | undefined) ?? null, usage });
      } catch { finish(new AgentError('protocol', 'start', 'agent output did not follow perfdigest-agent/v1')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${input}\n`);
  });
}
