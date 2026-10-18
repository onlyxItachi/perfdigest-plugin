import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { childEnvironment, executable, redact } from './environment.js';
import type { ReportSpec } from './config.js';

export interface PerfDigestSessionOptions {
  /** Maximum summarize_report calls allowed on a single MCP session (1..16, default 8). */
  maxCalls?: number;
  /** Maximum lifetime of the session in milliseconds (default 120_000). */
  maxLifetimeMs?: number;
  /** Timeout for initial MCP handshake in milliseconds (default 60_000). */
  connectTimeoutMs?: number;
  /** Per-call timeout for summarize_report in milliseconds (default 30_000). */
  callTimeoutMs?: number;
  /** Optional command override for version-qualification tests (e.g. uvx --from perfdigest-mcp==1.3.0). */
  command?: string;
  args?: string[];
}

export interface PerfDigestSessionStats {
  spawns: number;
  calls: number;
  reusedCalls: number;
  closed: boolean;
  tainted: boolean;
}

export interface PerfDigestSession {
  readonly maxCalls: number;
  digest(report: ReportSpec, absolutePath: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  stats(): PerfDigestSessionStats;
  close(): Promise<void>;
}

/**
 * Runs an async operation with a dedicated per-call AbortSignal that forwards aborts from
 * `parentSignal` and a bounded `timeoutMs`, and deterministically removes its listener in `finally`.
 * This prevents @modelcontextprotocol/sdk from retaining unremoved `{ once: true }` listeners on
 * long-lived parent AbortSignals across multi-report sessions or keeping Deno's event loop ref'd.
 */
async function withScopedSignal<T>(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  onAbortCleanup: () => void,
  fn: (scopedSignal: AbortSignal, didTimeout: () => boolean) => Promise<T>,
): Promise<T> {
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => {
    onAbortCleanup();
    controller.abort(parentSignal?.reason ?? new Error('Aborted'));
  };
  const timer = setTimeout(() => {
    timedOut = true;
    onAbortCleanup();
    controller.abort(new Error(`PerfDigest MCP timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  timer.unref?.();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  try {
    return await fn(controller.signal, () => timedOut);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export async function withPerfDigest<T>(
  workspace: string,
  signal: AbortSignal | undefined,
  run: (client: Client) => Promise<T>,
  options: Pick<PerfDigestSessionOptions, 'connectTimeoutMs' | 'command' | 'args'> = {},
): Promise<T> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 60_000;
  const client = new Client({ name: 'perfdigest-plugin', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: options.command ?? executable('uvx'),
    args: options.args ?? ['perfdigest-mcp'],
    cwd: workspace,
    env: childEnvironment(),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const closeNow = () => {
    void client.close().catch(() => {});
    void transport.close().catch(() => {});
  };
  try {
    return await withScopedSignal(signal, connectTimeoutMs, closeNow, async (scopedSignal) => {
      await client.connect(transport, { timeout: connectTimeoutMs, signal: scopedSignal });
      return await run(client);
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error(redact(`PerfDigest MCP failed: ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`));
  } finally {
    const keepAlive = setInterval(() => {}, 60_000);
    try {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    } finally {
      clearInterval(keepAlive);
    }
  }
}

/**
 * Opens a bounded, workspace-scoped PerfDigest MCP session that can be reused across multiple
 * reports within a single logical investigation.
 *
 * Invariants:
 * - Lazy spawn: `uvx perfdigest-mcp` is spawned on the first `digest()` call with `childEnvironment()`.
 * - Bounded reuse: at most `maxCalls` (default 8, max 16) sequential `digest()` calls and `maxLifetimeMs`.
 * - Failure isolation: any connection, tool, timeout, cancellation or validation failure marks the
 *   session tainted and immediately closes the subprocess so it can never be reused.
 * - Deterministic cleanup: `close()` is idempotent and always awaits client/transport teardown.
 */
export function openPerfDigestSession(
  workspace: string,
  sessionSignal?: AbortSignal,
  options: PerfDigestSessionOptions = {},
): PerfDigestSession {
  const maxCalls = options.maxCalls ?? 8;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 16) {
    throw new Error('PerfDigestSession maxCalls must be an integer between 1 and 16');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 120_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 60_000;
  const callTimeoutMs = options.callTimeoutMs ?? 30_000;
  if (connectTimeoutMs <= 0 || callTimeoutMs <= 0 || maxLifetimeMs <= 0) {
    throw new Error('PerfDigestSession timeouts must be positive');
  }

  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let stderr = '';
  let spawns = 0;
  let calls = 0;
  let reusedCalls = 0;
  let inFlight = false;
  let closed = false;
  let tainted = false;
  let closingPromise: Promise<void> | null = null;
  let lifetimeTimer: NodeJS.Timeout | undefined;

  const close = async (): Promise<void> => {
    closed = true;
    if (lifetimeTimer) {
      clearTimeout(lifetimeTimer);
      lifetimeTimer = undefined;
    }
    sessionSignal?.removeEventListener('abort', onSessionAbort);
    if (closingPromise) return closingPromise;
    const activeClient = client;
    const activeTransport = transport;
    client = null;
    transport = null;
    closingPromise = (async () => {
      if (!activeClient && !activeTransport) return;
      const keepAlive = setInterval(() => {}, 60_000);
      try {
        await activeClient?.close().catch(() => {});
        await activeTransport?.close().catch(() => {});
      } finally {
        clearInterval(keepAlive);
      }
    })();
    return closingPromise;
  };

  const onSessionAbort = () => {
    tainted = true;
    void close();
  };
  sessionSignal?.addEventListener('abort', onSessionAbort, { once: true });

  return {
    maxCalls,
    stats(): PerfDigestSessionStats {
      return { spawns, calls, reusedCalls, closed, tainted };
    },
    close,
    async digest(report: ReportSpec, absolutePath: string, callSignal?: AbortSignal): Promise<Record<string, unknown>> {
      const effectiveSignal = callSignal && sessionSignal
        ? AbortSignal.any([sessionSignal, callSignal])
        : (callSignal ?? sessionSignal);
      effectiveSignal?.throwIfAborted();
      if (inFlight) {
        tainted = true;
        await close();
        throw new Error('PerfDigest MCP session does not allow concurrent calls');
      }
      if (tainted) throw new Error('PerfDigest MCP session was tainted by a prior error and cannot be reused');
      if (closed) throw new Error('PerfDigest MCP session is closed');
      if (calls >= maxCalls) {
        tainted = true;
        await close();
        throw new Error(`PerfDigest MCP session call limit (${maxCalls}) exceeded`);
      }

      inFlight = true;
      calls++;
      try {
        if (!client || !transport) {
          const nextClient = new Client({ name: 'perfdigest-plugin', version: '0.1.0' });
          const nextTransport = new StdioClientTransport({
            command: options.command ?? executable('uvx'),
            args: options.args ?? ['perfdigest-mcp'],
            cwd: workspace,
            env: childEnvironment(),
            stderr: 'pipe',
          });
          stderr = '';
          nextTransport.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
          spawns++;
          client = nextClient;
          transport = nextTransport;
          lifetimeTimer = setTimeout(() => {
            tainted = true;
            void close();
          }, maxLifetimeMs);
          lifetimeTimer.unref?.();

          await withScopedSignal(effectiveSignal, connectTimeoutMs, () => { tainted = true; void close(); }, async (scopedSignal) => {
            await nextClient.connect(nextTransport, { timeout: connectTimeoutMs, signal: scopedSignal });
          });
        } else {
          reusedCalls++;
        }

        const activeClient = client!;
        return await withScopedSignal(effectiveSignal, callTimeoutMs, () => { tainted = true; void close(); }, async (scopedSignal) => {
          const result = await activeClient.callTool(
            { name: 'summarize_report', arguments: { report_ref: absolutePath, format: report.format, top_n: 3 } },
            undefined,
            { timeout: callTimeoutMs, signal: scopedSignal },
          );
          if (result.isError) throw new Error('summarize_report returned an MCP tool error');
          const structured = result.structuredContent;
          const content = result.content as Array<{ type: string; text?: string }>;
          const rawDigest: unknown = structured ?? JSON.parse(content.filter(p => p.type === 'text').map(p => p.text).join('\n'));
          return validateDigest(rawDigest, report.format, absolutePath);
        });
      } catch (error) {
        tainted = true;
        await close();
        if (sessionSignal?.aborted) throw sessionSignal.reason;
        if (callSignal?.aborted) throw callSignal.reason;
        throw new Error(redact(`PerfDigest MCP failed: ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`));
      } finally {
        inFlight = false;
      }
    },
  };
}

export async function withPerfDigestSession<T>(
  workspace: string,
  signal: AbortSignal | undefined,
  run: (session: PerfDigestSession) => Promise<T>,
  options: PerfDigestSessionOptions = {},
): Promise<T> {
  const session = openPerfDigestSession(workspace, signal, options);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

export async function digestReport(
  workspace: string,
  report: ReportSpec,
  absolutePath: string,
  signal?: AbortSignal,
  session?: PerfDigestSession,
): Promise<Record<string, unknown>> {
  if (session) return session.digest(report, absolutePath, signal);
  return withPerfDigestSession(workspace, signal, s => s.digest(report, absolutePath, signal), { maxCalls: 1 });
}

export function validateDigest(value: unknown, format: string, reportPath: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid PerfDigest result');
  const digest = value as Record<string, unknown>;
  if (digest.error || digest.format !== format || digest.raw_ref !== reportPath
      || !Number.isInteger(digest.total_units) || (digest.total_units as number) < 1
      || !Array.isArray(digest.units) || digest.units.length < 1
      || digest.returned !== digest.units.length || digest.units.length > (digest.total_units as number)) {
    throw new Error('PerfDigest did not return a nonempty digest for the requested report and format');
  }
  if (JSON.stringify(digest).length > 40_000) throw new Error('Digest exceeds MVP context budget; raw report remains on disk');
  // Do not fill or coerce metrics: null is an unmeasured value, never zero.
  return digest;
}
