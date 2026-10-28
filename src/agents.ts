import { spawn } from 'node:child_process';
import type { ModelReasoningEffort, Thread, Usage } from '@openai/codex-sdk';
import {
  codexAppServerInExecutionTurn,
  codexAppServerPreflight,
  CodexProtocolError,
  codexThread,
  codexTurn,
  type CodexSteeringMechanism,
} from './codex.js';
import { childEnvironment, redact } from './environment.js';
import type { AgentDeliveryMode, CommandReceipt, Emit, EvidencePacket } from './config.js';

export type CapabilitySupportStatus = 'supported' | 'unsupported';
export type RuntimeUsageReportingSemantics =
  | 'single_turn_only'
  | 'cumulative_session_trajectory'
  | 'incremental_per_turn';

/**
 * Capability-based agent integration contract.
 *
 * PerfDigest never injects evidence into an agent's hidden reasoning and never mislabels
 * queued next-turn stdin (`--input-format stream-json` in `agy -p` / `claude -p`) as live
 * mid-turn steering (`inExecutionAsyncInput`).
 *
 * Delivery modes:
 * - in_execution_async_input: the agent runtime accepts an asynchronous `{type:"evidence"}`
 *   frame on an open stream during its single active investigation execution.
 * - in_execution_tool_delivery: the agent runtime invokes `launch_evidence_prefetch` / `get_evidence_job`
 *   on the PerfDigest Evidence MCP server during its active turn.
 * - single_turn_with_evidence: single-execution fallback where the evidence worker completes
 *   first and delivers the verified packet in one self-contained turn (avoiding Turn-1 wait
 *   blocking and Turn-2 cumulative session token replay).
 * - same_session_next_turn: two-turn concurrent overlap where Turn 2 resumes the Turn 1 session.
 * - fresh_session_with_context: two-turn fallback when sameSessionContinuation is false.
 */
export interface AgentCapabilities {
  sameSessionContinuation: boolean;
  nativeAsyncInput: boolean;
  cancellation: boolean;
  usageReporting: boolean;
  /** Execution isolation the adapter requests from the agent runtime, if any. */
  sandbox: 'read-only' | 'agent-defined';
  /** Whether unsolicited evidence messages can be injected into an active turn mid-execution. */
  inExecutionAsyncInput?: CapabilitySupportStatus;
  /** Whether the agent can pull/await background evidence mid-turn via an MCP tool call. */
  inExecutionToolDelivery?: CapabilitySupportStatus;
  /** Whether stdin frames written during Turn 1 are queued by the CLI for a sequential Turn 2. */
  queuedStdinNextTurn?: CapabilitySupportStatus;
  /** Whether an active turn can be interrupted/steered mid-stream without losing context. */
  interruptionAndSteering?: CapabilitySupportStatus;
  /** How the runtime reports token usage across multi-turn sessions. */
  usageReportingSemantics?: RuntimeUsageReportingSemantics;
}

export type KnownAgentRuntimeId =
  | 'codex'
  | 'codex-app-server'
  | 'agy'
  | 'claude'
  | 'generic-cli'
  | 'generic-cli-in-execution';

/**
 * Returns the verified runtime capability profile for known agent CLIs and harnesses.
 * Notably:
 * - `codex-app-server` (`codex app-server --listen stdio://` 0.165.0+) supports live mid-turn steering
 *   via `turn/steer` (with `expectedTurnId` precondition) and `turn/start` `toolOutput` (`ExternalMessage`),
 *   as well as `turn/interrupt` and incremental/total `ThreadTokenUsage`.
 * - `codex` (`@openai/codex-sdk` `codex exec` per-turn CLI mode) supports `sameSessionContinuation`
 *   across turns via `codex exec resume <threadId>`, but not mid-turn steering within a single `codex exec` invocation.
 * - `agy -p` and `claude -p` support `queuedStdinNextTurn` (`--input-format stream-json`) and
 *   `inExecutionToolDelivery` (MCP tools), but do NOT support unsolicited `inExecutionAsyncInput`
 *   into an active print-mode turn.
 * - `agy --conversation <id>` reports `cumulative_session_trajectory` token usage on Turn 2+.
 */
export function getRuntimeCapabilityProfile(
  runtimeId: KnownAgentRuntimeId,
  options: { sessions?: boolean; inExecutionAsync?: boolean } = {},
): AgentCapabilities {
  switch (runtimeId) {
    case 'codex-app-server':
      return {
        sameSessionContinuation: true,
        nativeAsyncInput: true,
        cancellation: true,
        usageReporting: true,
        sandbox: 'read-only',
        inExecutionAsyncInput: 'supported',
        inExecutionToolDelivery: 'supported',
        queuedStdinNextTurn: 'unsupported',
        interruptionAndSteering: 'supported',
        usageReportingSemantics: 'incremental_per_turn',
      };
    case 'codex':
      if (options.inExecutionAsync) {
        return getRuntimeCapabilityProfile('codex-app-server');
      }
      return {
        sameSessionContinuation: true,
        nativeAsyncInput: false,
        cancellation: true,
        usageReporting: true,
        sandbox: 'read-only',
        inExecutionAsyncInput: 'unsupported',
        inExecutionToolDelivery: 'supported',
        queuedStdinNextTurn: 'unsupported',
        interruptionAndSteering: 'unsupported',
        usageReportingSemantics: 'incremental_per_turn',
      };
    case 'agy':
      return {
        sameSessionContinuation: true,
        nativeAsyncInput: false,
        cancellation: true,
        usageReporting: true,
        sandbox: 'agent-defined',
        inExecutionAsyncInput: 'unsupported',
        inExecutionToolDelivery: 'supported',
        queuedStdinNextTurn: 'supported',
        interruptionAndSteering: 'unsupported',
        usageReportingSemantics: 'cumulative_session_trajectory',
      };
    case 'claude':
      return {
        sameSessionContinuation: true,
        nativeAsyncInput: false,
        cancellation: true,
        usageReporting: true,
        sandbox: 'agent-defined',
        inExecutionAsyncInput: 'unsupported',
        inExecutionToolDelivery: 'supported',
        queuedStdinNextTurn: 'supported',
        interruptionAndSteering: 'unsupported',
        usageReportingSemantics: 'incremental_per_turn',
      };
    case 'generic-cli-in-execution':
      return {
        sameSessionContinuation: Boolean(options.sessions),
        nativeAsyncInput: true,
        cancellation: true,
        usageReporting: true,
        sandbox: 'agent-defined',
        inExecutionAsyncInput: 'supported',
        inExecutionToolDelivery: 'supported',
        queuedStdinNextTurn: options.sessions ? 'supported' : 'unsupported',
        interruptionAndSteering: 'unsupported',
        usageReportingSemantics: 'single_turn_only',
      };
    case 'generic-cli':
    default:
      return {
        sameSessionContinuation: options.sessions ?? false,
        nativeAsyncInput: false,
        cancellation: true,
        usageReporting: true,
        sandbox: 'agent-defined',
        inExecutionAsyncInput: 'unsupported',
        inExecutionToolDelivery: 'unsupported',
        queuedStdinNextTurn: 'unsupported',
        interruptionAndSteering: 'unsupported',
        usageReportingSemantics: 'incremental_per_turn',
      };
  }
}

export type AgentPhase = 'analysis' | 'review' | 'in_execution';
export type EvidenceDelivery =
  | 'same_session_next_turn'
  | 'fresh_session_with_context'
  | 'single_turn_with_evidence'
  | 'in_execution_async_input'
  | 'in_execution_tool_delivery';

export interface NegotiatedDeliveryPlan {
  requestedMode: AgentDeliveryMode;
  effectiveMode: 'in_execution' | 'single_turn' | 'two_turn';
  plannedEvidenceDelivery: EvidenceDelivery;
  reason: string;
  fellBack: boolean;
}

/**
 * Deterministically negotiates the evidence delivery plan from the requested mode and
 * verified runtime capabilities.
 */
export function negotiateEvidenceDeliveryMode(
  requestedMode: AgentDeliveryMode,
  capabilities: AgentCapabilities | null,
  options: { strictDeliveryMode?: boolean } = {},
): NegotiatedDeliveryPlan {
  const supportsInExec =
    capabilities?.inExecutionAsyncInput === 'supported' || capabilities?.nativeAsyncInput === true;
  const supportsSameSession = capabilities?.sameSessionContinuation ?? false;

  if (requestedMode === 'auto') {
    if (supportsInExec) {
      return {
        requestedMode,
        effectiveMode: 'in_execution',
        plannedEvidenceDelivery: 'in_execution_async_input',
        reason: 'runtime_supports_in_execution_async_input',
        fellBack: false,
      };
    }
    return {
      requestedMode,
      effectiveMode: 'single_turn',
      plannedEvidenceDelivery: 'single_turn_with_evidence',
      reason: 'runtime_lacks_in_execution_async_input_selected_single_turn_fallback',
      fellBack: true,
    };
  }

  if (requestedMode === 'in_execution') {
    if (supportsInExec) {
      return {
        requestedMode,
        effectiveMode: 'in_execution',
        plannedEvidenceDelivery: 'in_execution_async_input',
        reason: 'explicit_in_execution_supported_by_runtime',
        fellBack: false,
      };
    }
    if (options.strictDeliveryMode) {
      throw new AgentError(
        'unsupported',
        'start',
        'in_execution delivery requires an adapter with inExecutionAsyncInput=supported',
      );
    }
    return {
      requestedMode,
      effectiveMode: 'single_turn',
      plannedEvidenceDelivery: 'single_turn_with_evidence',
      reason: 'requested_in_execution_unsupported_by_runtime_fell_back_to_single_turn',
      fellBack: true,
    };
  }

  if (requestedMode === 'single_turn') {
    return {
      requestedMode,
      effectiveMode: 'single_turn',
      plannedEvidenceDelivery: 'single_turn_with_evidence',
      reason: 'explicit_single_turn_with_evidence',
      fellBack: false,
    };
  }

  if (requestedMode === 'two_turn') {
    return {
      requestedMode,
      effectiveMode: 'two_turn',
      plannedEvidenceDelivery: supportsSameSession
        ? 'same_session_next_turn'
        : 'fresh_session_with_context',
      reason: supportsSameSession
        ? 'explicit_two_turn_same_session_next_turn'
        : 'explicit_two_turn_fresh_session_with_context',
      fellBack: !supportsSameSession,
    };
  }

  throw new AgentError(
    'unsupported',
    'start',
    'agentDelivery must be auto, in_execution, two_turn or single_turn',
  );
}

function compactDigest(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === 'raw_ref') continue;
    if (k === 'domain' && (v === null || v === undefined || v === '')) continue;
    if (k === 'units' && Array.isArray(v)) {
      out.units = v.map(u => {
        if (!u || typeof u !== 'object' || Array.isArray(u)) return u;
        const unitObj = u as Record<string, unknown>;
        const cu: Record<string, unknown> = {};
        for (const [uk, uv] of Object.entries(unitObj)) {
          if (uk === 'index') continue;
          if (uk === 'domain' && (uv === d.domain || uv === null || uv === undefined || uv === '')) continue;
          cu[uk] = uv;
        }
        return cu;
      });
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Formats the evidence packet and verification receipt for agent prompt delivery.
 * When `compact === true` (default), omits redundant provenance arrays, local filesystem paths
 * (`raw_ref`), per-unit duplicate `domain`/`index` fields, and full command metadata while
 * preserving 100% of diagnostic units, metrics (including `null` values), routing decisions,
 * corroborating digests, extracted MCP drill-downs, and verification status.
 */
export function formatAgentEvidence(
  evidence: EvidencePacket | null,
  verification: CommandReceipt | null,
  pipelineStatus: string,
  compact = true,
): string {
  if (!compact) {
    return JSON.stringify({ evidence, verification, pipelineStatus });
  }
  return JSON.stringify({
    schema: 'perfdigest.agent-evidence.v1',
    status: pipelineStatus,
    decision: evidence ? {
      selectedId: evidence.decision.selectedId,
      confidence: evidence.decision.confidence,
      reason: evidence.decision.reason,
      provider: evidence.decision.provider ?? evidence.decision.source,
    } : null,
    selected: evidence?.evidence.map(e => ({
      id: e.report.id,
      format: e.report.format,
      sha256Prefix: e.sha256.slice(0, 16),
      digest: compactDigest(e.digest),
      ...(e.extractions?.length ? {
        extractions: e.extractions.map(x => ({
          step: x.step,
          tool: x.tool,
          ...(x.secondaryReportId ? { secondaryReportId: x.secondaryReportId } : {}),
          ...(x.unit ? { unit: x.unit } : {}),
          ...(x.secondaryUnit ? { secondaryUnit: x.secondaryUnit } : {}),
          data: x.data,
        })),
      } : {}),
    })) ?? [],
    ...(evidence?.corroborating?.length ? {
      corroborating: evidence.corroborating.map(e => ({
        id: e.report.id,
        format: e.report.format,
        sha256Prefix: e.sha256.slice(0, 16),
        digest: compactDigest(e.digest),
        ...(e.extractions?.length ? {
          extractions: e.extractions.map(x => ({
            step: x.step,
            tool: x.tool,
            ...(x.secondaryReportId ? { secondaryReportId: x.secondaryReportId } : {}),
            ...(x.unit ? { unit: x.unit } : {}),
            ...(x.secondaryUnit ? { secondaryUnit: x.secondaryUnit } : {}),
            data: x.data,
          })),
        } : {}),
      })),
    } : {}),
    ...(evidence?.extractions?.length ? {
      extractions: evidence.extractions.map(x => ({
        step: x.step,
        tool: x.tool,
        reportId: x.reportId,
        ...(x.secondaryReportId ? { secondaryReportId: x.secondaryReportId } : {}),
        ...(x.unit ? { unit: x.unit } : {}),
        ...(x.secondaryUnit ? { secondaryUnit: x.secondaryUnit } : {}),
        data: x.data,
      })),
    } : {}),
    verification: verification ? {
      passed: verification.exitCode === 0 && !verification.timedOut && !verification.aborted,
      exitCode: verification.exitCode,
      elapsedMs: verification.elapsedMs,
      ...(verification.stdout.trim() ? { stdout: verification.stdout.trim().slice(0, 240) } : {}),
      ...(verification.stderr.trim() ? { stderr: verification.stderr.trim().slice(0, 240) } : {}),
    } : null,
  });
}

/** Kept field-compatible with the previous CodexTurn receipt shape (threadId). */
export interface AgentTurn {
  text: string;
  usage: Usage | null;
  threadId: string | null;
}

export interface InExecutionTurnResult {
  turn: AgentTurn;
  evidenceDeliveredInExecution: boolean;
  evidenceConsumedInExecution: boolean;
  earlyAgentCompletion: boolean;
  deliveryCount: number;
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
  /**
   * Executes a single continuous agent investigation turn while concurrently awaiting
   * `supplyEvidence()` and injecting the verified evidence frame into the live execution stream.
   */
  turnInExecution?(
    prompt: string,
    supplyEvidence: () => Promise<string>,
    options: TurnOptions,
  ): Promise<InExecutionTurnResult>;
}
export interface AgentAdapter {
  readonly name: string;
  /** Timeline event prefix, e.g. codex.analysis.turn_started. */
  readonly eventPrefix: string;
  readonly capabilities: AgentCapabilities;
  start(options: { workspace: string; signal: AbortSignal }): Promise<AgentSession>;
}

export interface CodexAdapterOptions {
  model?: string;
  effort?: ModelReasoningEffort;
  /** Enables live mid-turn steering via `codex app-server --listen stdio://`. */
  inExecutionAsync?: boolean;
  /** Selects `turn/steer` (with `expectedTurnId` precondition) or `toolOutput` (`ExternalMessage` wire format). */
  steeringMechanism?: CodexSteeringMechanism;
  /** Test-only override to verify mismatched/expired `expectedTurnId` rejection. */
  overrideExpectedTurnId?: string;
  /** Per-turn timeout in ms for `turnInExecution` (default 120000). */
  timeoutMs?: number;
  /** Bound on stdout bytes accepted from `codex app-server` (default 4 MiB). */
  maxOutputBytes?: number;
}

/** Codex SDK & App Server adapter: supports both two-turn/single-turn SDK mode and live `codex app-server` mid-turn steering. */
export function codexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const inExecutionAsync = options.inExecutionAsync ?? false;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 4_194_304;
  const capabilities: AgentCapabilities = inExecutionAsync
    ? getRuntimeCapabilityProfile('codex-app-server')
    : {
        sameSessionContinuation: true,
        nativeAsyncInput: false,
        cancellation: true,
        usageReporting: true,
        sandbox: 'read-only',
      };

  return {
    name: 'codex',
    eventPrefix: 'codex',
    capabilities,
    async start({ workspace }) {
      if (!inExecutionAsync) {
        const thread: Thread = await codexThread(workspace, options.model, options.effort);
        return {
          get id() {
            return thread.id;
          },
          turn: (prompt, phase, { signal, emit }) => codexTurn(thread, prompt, phase, signal, emit),
        };
      }

      const preflight = await codexAppServerPreflight(workspace);
      let currentThreadId: string | null = null;
      let fallbackThread: Thread | null = null;

      return {
        get id() {
          return currentThreadId ?? fallbackThread?.id ?? null;
        },
        async turn(prompt, phase, { signal, emit }) {
          if (!fallbackThread) {
            fallbackThread = await codexThread(workspace, options.model, options.effort);
          }
          const t = await codexTurn(fallbackThread, prompt, phase, signal, emit);
          currentThreadId = t.threadId;
          return t;
        },
        async turnInExecution(prompt, supplyEvidence, { signal, emit }) {
          const phase: AgentPhase = 'in_execution';
          emit('codex.in_execution.started');
          emit('codex.analysis.started');
          const deadlineController = new AbortController();
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            deadlineController.abort(new Error(`no result within ${timeoutMs} ms`));
          }, timeoutMs);
          timer.unref?.();
          const combined = AbortSignal.any([signal, deadlineController.signal]);
          let supplyError: unknown;
          let hasSupplyError = false;
          const trackedSupplyEvidence = async () => {
            try {
              return await supplyEvidence();
            } catch (err) {
              hasSupplyError = true;
              supplyError = err;
              throw err;
            }
          };

          const result = await codexAppServerInExecutionTurn({
            workspace,
            prompt,
            supplyEvidence: trackedSupplyEvidence,
            signal: combined,
            emit,
            preflight,
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
            ...(options.steeringMechanism ? { steeringMechanism: options.steeringMechanism } : {}),
            ...(options.overrideExpectedTurnId ? { overrideExpectedTurnId: options.overrideExpectedTurnId } : {}),
            timeoutMs,
            maxOutputBytes,
          })
            .catch((error: unknown) => {
              if (timedOut) throw new AgentError('timed_out', phase, `no result within ${timeoutMs} ms`);
              if (signal.aborted) throw new AgentError('cancelled', phase, 'run cancelled');
              if (hasSupplyError) throw supplyError;
              if (error instanceof AgentError) throw new AgentError(error.kind, phase, error.message);
              if (error instanceof CodexProtocolError) throw new AgentError('protocol', phase, error.message);
              throw new AgentError('failed', phase, error instanceof Error ? error.message : String(error));
            })
            .finally(() => clearTimeout(timer));

          currentThreadId = result.turn.threadId;
          emit('codex.analysis.completed');
          emit('codex.review.completed');
          emit('codex.in_execution.completed');
          return result;
        },
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
  /** Explicitly rejected if true on one-process-per-turn mode: use `inExecutionAsync: true` for the perfdigest-agent/v1 in-execution protocol. */
  nativeAsyncInput?: boolean;
  /**
   * Opts into the perfdigest-agent/v1 in-execution async evidence streaming protocol:
   * stdin stays open after the initial prompt frame, receives at most one `{"type":"evidence",...}`
   * frame when background evidence + verification complete, and finishes in one single process.
   */
  inExecutionAsync?: boolean;
}

const protocol = 'perfdigest-agent/v1';

/**
 * Generic asynchronous CLI adapter (protocol perfdigest-agent/v1).
 * - Default mode (`inExecutionAsync: false`): one process per turn.
 * - In-execution async mode (`inExecutionAsync: true`): single process stays open during
 *   investigation and accepts `{protocol, type:"evidence", evidence}` on stdin mid-execution.
 */
export function genericCliAdapter(options: GenericCliAgentOptions): AgentAdapter {
  if (!options.command || !options.command.trim()) {
    throw new AgentError('unsupported', 'start', 'generic CLI adapter requires a non-empty command');
  }
  if (options.nativeAsyncInput && !options.inExecutionAsync) {
    throw new AgentError('unsupported', 'start', 'generic CLI adapter does not support nativeAsyncInput');
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new AgentError('unsupported', 'start', 'timeoutMs must be a positive number');
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  const sessions = options.sessions ?? false;
  const inExecutionAsync = options.inExecutionAsync ?? false;
  const capabilities: AgentCapabilities = inExecutionAsync
    ? getRuntimeCapabilityProfile('generic-cli-in-execution', { sessions })
    : {
        sameSessionContinuation: sessions,
        nativeAsyncInput: false,
        cancellation: true,
        usageReporting: true,
        sandbox: 'agent-defined',
      };

  return {
    name: 'generic-cli', eventPrefix: 'agent',
    capabilities,
    async start({ workspace }) {
      let sessionId: string | null = null;
      return {
        get id() { return sessionId; },
        async turn(prompt, phase, { signal, emit }) {
          emit(`agent.${phase}.started`);
          const deadlineController = new AbortController();
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            deadlineController.abort(new Error(`no result within ${timeoutMs} ms`));
          }, timeoutMs);
          timer.unref?.();
          const combined = AbortSignal.any([signal, deadlineController.signal]);
          const result = await runTurn(options.command, options.args ?? [], workspace, combined,
            JSON.stringify({ protocol, phase, prompt, sessionId: sessions ? sessionId : null }), maxOutputBytes,
            () => emit(`agent.${phase}.turn_started`))
            .catch((error: unknown) => {
              if (error instanceof AgentError) throw new AgentError(error.kind, phase, error.message);
              if (timedOut) throw new AgentError('timed_out', phase, `no result within ${timeoutMs} ms`);
              if (signal.aborted) throw new AgentError('cancelled', phase, 'run cancelled');
              throw new AgentError('failed', phase, error instanceof Error ? error.message : String(error));
            })
            .finally(() => clearTimeout(timer));
          if (sessions) {
            if (!result.sessionId) throw new AgentError('protocol', phase, 'sessions were declared but no sessionId was returned');
            if (sessionId !== null && result.sessionId !== sessionId) throw new AgentError('protocol', phase, 'session continuation was declared but not honored');
            sessionId = result.sessionId;
          }
          emit(`agent.${phase}.completed`);
          return { text: redact(result.text), usage: result.usage, threadId: sessions ? sessionId : null };
        },
        ...(inExecutionAsync ? {
          async turnInExecution(prompt, supplyEvidence, { signal, emit }) {
            const phase: AgentPhase = 'in_execution';
            emit('agent.in_execution.started');
            emit('agent.analysis.started');
            const deadlineController = new AbortController();
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              deadlineController.abort(new Error(`no result within ${timeoutMs} ms`));
            }, timeoutMs);
            timer.unref?.();
            const combined = AbortSignal.any([signal, deadlineController.signal]);
            let supplyError: unknown;
            let hasSupplyError = false;
            const trackedSupplyEvidence = async () => {
              try {
                return await supplyEvidence();
              } catch (err) {
                hasSupplyError = true;
                supplyError = err;
                throw err;
              }
            };
            const result = await runInExecutionTurn(
              options.command,
              options.args ?? [],
              workspace,
              combined,
              JSON.stringify({
                protocol,
                phase: 'in_execution',
                prompt,
                sessionId: sessions ? sessionId : null,
              }),
              trackedSupplyEvidence,
              maxOutputBytes,
              emit,
            )
              .catch((error: unknown) => {
                if (timedOut) throw new AgentError('timed_out', phase, `no result within ${timeoutMs} ms`);
                if (signal.aborted) throw new AgentError('cancelled', phase, 'run cancelled');
                if (hasSupplyError) throw supplyError;
                if (error instanceof AgentError) throw new AgentError(error.kind, phase, error.message);
                throw new AgentError('failed', phase, error instanceof Error ? error.message : String(error));
              })
              .finally(() => clearTimeout(timer));

            if (sessions && result.turn.sessionId) {
              sessionId = result.turn.sessionId;
            }
            emit('agent.analysis.completed');
            emit('agent.review.completed');
            emit('agent.in_execution.completed');
            return {
              turn: {
                text: redact(result.turn.text),
                usage: result.turn.usage,
                threadId: result.turn.sessionId ?? (sessions ? sessionId : null),
              },
              evidenceDeliveredInExecution: result.evidenceDeliveredInExecution,
              evidenceConsumedInExecution: result.evidenceConsumedInExecution,
              earlyAgentCompletion: result.earlyAgentCompletion,
              deliveryCount: result.deliveryCount,
            };
          },
        } : {}),
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

interface RawInExecutionResult {
  turn: TurnResult;
  evidenceDeliveredInExecution: boolean;
  evidenceConsumedInExecution: boolean;
  earlyAgentCompletion: boolean;
  deliveryCount: number;
}

function runInExecutionTurn(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  initialInput: string,
  supplyEvidence: () => Promise<string>,
  maxOutputBytes: number,
  emit: Emit,
): Promise<RawInExecutionResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted before start')); return; }
    const child = spawn(command, args, { cwd, env: childEnvironment(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let bytes = 0;
    let settled = false;
    let started = false;
    let ackEmitted = false;
    let processClosed = false;
    let evidenceDelivered = false;
    let stdoutOffsetAtDelivery: number | null = null;
    let deliveryCount = 0;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (error: Error | null, value?: RawInExecutionResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value!);
    };

    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
      finish(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new AgentError('protocol', 'in_execution', 'agent output exceeded the limit'));
        return;
      }
      stdout += chunk.toString('utf8');
      if (!started && (stdout.includes('"type":"started"') || stdout.includes('"type": "started"'))) {
        started = true;
        emit('agent.analysis.turn_started');
      }
      if (evidenceDelivered && !ackEmitted && stdoutOffsetAtDelivery !== null) {
        const postDeliveryStdout = stdout.slice(stdoutOffsetAtDelivery);
        if (postDeliveryStdout.includes('"type":"evidence_ack"') || postDeliveryStdout.includes('"type": "evidence_ack"')) {
          ackEmitted = true;
          emit('evidence.accepted_by_runtime', 'generic-cli in-execution evidence_ack');
        }
      }
    });

    let stdinWriteFailed = false;
    child.stderr.resume();
    child.on('error', error => finish(new AgentError('failed', 'in_execution', error.message)));
    child.stdin.on('error', () => {
      stdinWriteFailed = true;
      evidenceDelivered = false;
      deliveryCount = 0;
    });

    // Write the initial investigation prompt frame while keeping stdin open for async evidence injection
    child.stdin.write(`${initialInput}\n`);

    // Concurrently await evidence from the background worker + verification
    void supplyEvidence().then(
      (evidencePayload) => {
        if (
          settled ||
          processClosed ||
          evidenceDelivered ||
          stdinWriteFailed ||
          child.exitCode !== null ||
          child.stdin.destroyed ||
          !child.stdin.writable
        ) {
          return;
        }
        stdoutOffsetAtDelivery = stdout.length;
        const frame = JSON.stringify({
          protocol,
          type: 'evidence',
          deliveryId: 'ev-1',
          evidence: evidencePayload,
        });
        evidenceDelivered = true;
        deliveryCount = 1;
        emit('evidence.delivered', 'In-execution asynchronous evidence frame sent to active generic-cli stream');
        child.stdin.end(`${frame}\n`, (writeErr?: Error | null) => {
          if (writeErr) {
            stdinWriteFailed = true;
            evidenceDelivered = false;
            deliveryCount = 0;
          }
        });
      },
      (err) => {
        if (settled || processClosed) return;
        child.kill('SIGTERM');
        finish(err instanceof Error ? err : new Error(String(err)));
      },
    );

    child.on('close', code => {
      processClosed = true;
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0) {
        finish(new AgentError('failed', 'in_execution', `agent exited with code ${code}`));
        return;
      }
      try {
        const allowedTypes = new Set(['started', 'progress', 'awaiting_evidence', 'evidence_ack', 'result']);
        const lines = stdout
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
          .map(l => JSON.parse(l) as Record<string, unknown>);
        const results = lines.filter(l => l.type === 'result');
        if (lines.some(l => typeof l.type !== 'string' || !allowedTypes.has(l.type)) || results.length !== 1) {
          throw new Error('invalid frame types');
        }
        const r = results[0]!;
        if (typeof r.text !== 'string' || !r.text) throw new Error('missing text');
        if (
          r.sessionId !== undefined &&
          r.sessionId !== null &&
          (typeof r.sessionId !== 'string' || !/^[\w.-]{1,128}$/.test(r.sessionId))
        ) {
          throw new Error('invalid sessionId');
        }
        const usage = r.usage && typeof r.usage === 'object' ? (r.usage as Usage) : null;
        const earlyAgentCompletion = !evidenceDelivered;
        const evidenceConsumed = evidenceDelivered && r.evidenceConsumed === true;
        if (earlyAgentCompletion) {
          emit('agent.in_execution.completed_before_evidence', 'Agent solved and exited before background evidence arrived');
        } else if (evidenceConsumed) {
          if (!ackEmitted) {
            emit('evidence.accepted_by_runtime', 'generic-cli in-execution result');
          }
          emit('evidence.model_visible', 'generic-cli in-execution stream');
          emit('evidence.consumed', 'Agent consumed in-execution evidence in single execution');
        }
        finish(null, {
          turn: {
            text: r.text,
            sessionId: (r.sessionId as string | undefined) ?? null,
            usage,
          },
          evidenceDeliveredInExecution: evidenceDelivered,
          evidenceConsumedInExecution: evidenceConsumed,
          earlyAgentCompletion,
          deliveryCount,
        });
      } catch {
        finish(new AgentError('protocol', 'in_execution', 'agent output did not follow perfdigest-agent/v1'));
      }
    });
  });
}
