import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { childEnvironment, executable, redact } from './environment.js';
import type { ReportSpec } from './config.js';

export interface PerfDigestSessionOptions {
  /** Maximum summarize_report calls allowed on a single MCP session (1..16, default 8). */
  maxCalls?: number;
  /** Number of top units requested from summarize_report (1..10, default 3). */
  topN?: number;
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
  supportsDrillDown(signal?: AbortSignal): Promise<boolean>;
  listKernels(report: ReportSpec, absolutePath: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  getMetrics(
    report: ReportSpec,
    absolutePath: string,
    kernel: string,
    metrics?: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  expandUnit(
    report: ReportSpec,
    absolutePath: string,
    kernel: string,
    section?: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  compareMetrics(
    reportA: ReportSpec,
    absolutePathA: string,
    reportB: ReportSpec,
    absolutePathB: string,
    kernel: string,
    kernelB?: string,
    metrics?: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
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
  const topN = options.topN ?? 3;
  if (!Number.isInteger(topN) || topN < 1 || topN > 10) {
    throw new Error('PerfDigestSession topN must be an integer between 1 and 10');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 120_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 60_000;
  const callTimeoutMs = options.callTimeoutMs ?? 30_000;
  if (connectTimeoutMs <= 0 || callTimeoutMs <= 0 || maxLifetimeMs <= 0) {
    throw new Error('PerfDigestSession timeouts must be positive');
  }

  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let resolvedCommand: string | null = null;
  let resolvedEnv: Record<string, string> | null = null;
  let stderr = '';
  let spawns = 0;
  let calls = 0;
  let reusedCalls = 0;
  let inFlight = false;
  let closed = false;
  let tainted = false;
  let cachedDrillDownSupport: boolean | null = null;
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

  const ensureClient = async (effectiveSignal?: AbortSignal): Promise<{ activeClient: Client; isReuse: boolean }> => {
    if (!client || !transport) {
      resolvedCommand ??= options.command ?? executable('uvx');
      resolvedEnv ??= childEnvironment();
      const nextClient = new Client({ name: 'perfdigest-plugin', version: '0.1.0' });
      const nextTransport = new StdioClientTransport({
        command: resolvedCommand,
        args: options.args ?? ['perfdigest-mcp'],
        cwd: workspace,
        env: resolvedEnv,
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
      return { activeClient: nextClient, isReuse: false };
    }
    return { activeClient: client, isReuse: true };
  };

  const invokeTool = async <T>(
    toolName: string,
    toolArgs: Record<string, unknown>,
    callSignal: AbortSignal | undefined,
    validate: (raw: unknown) => T,
  ): Promise<T> => {
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
      const { activeClient, isReuse } = await ensureClient(effectiveSignal);
      if (isReuse) reusedCalls++;
      return await withScopedSignal(effectiveSignal, callTimeoutMs, () => { tainted = true; void close(); }, async (scopedSignal) => {
        const result = await activeClient.callTool(
          { name: toolName, arguments: toolArgs },
          undefined,
          { timeout: callTimeoutMs, signal: scopedSignal },
        );
        if (result.isError) throw new Error(`${toolName} returned an MCP tool error`);
        const structured = result.structuredContent;
        const content = result.content as Array<{ type: string; text?: string }>;
        const rawValue: unknown = structured ?? JSON.parse(content.filter(p => p.type === 'text').map(p => p.text).join('\n'));
        return validate(rawValue);
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
  };

  return {
    maxCalls,
    stats(): PerfDigestSessionStats {
      return { spawns, calls, reusedCalls, closed, tainted };
    },
    close,
    async supportsDrillDown(callSignal?: AbortSignal): Promise<boolean> {
      if (cachedDrillDownSupport !== null) return cachedDrillDownSupport;
      const effectiveSignal = callSignal && sessionSignal
        ? AbortSignal.any([sessionSignal, callSignal])
        : (callSignal ?? sessionSignal);
      effectiveSignal?.throwIfAborted();
      if (inFlight || tainted || closed) return false;
      inFlight = true;
      try {
        const { activeClient } = await ensureClient(effectiveSignal);
        const srvName = activeClient.getServerVersion()?.name ?? '';
        if (srvName === 'mock' || srvName === 'zero-cost-mcp' || srvName === 'fixture-only') {
          cachedDrillDownSupport = false;
          return false;
        }
        const probeTimeout = Math.min(callTimeoutMs, 2000);
        const toolList = await withScopedSignal(effectiveSignal, probeTimeout, () => {}, async (scopedSignal) => {
          return await activeClient.listTools(undefined, { timeout: probeTimeout, signal: scopedSignal });
        });
        const names = new Set((toolList.tools ?? []).map(t => t.name));
        cachedDrillDownSupport =
          names.has('list_kernels') &&
          names.has('get_metrics') &&
          names.has('expand') &&
          names.has('compare_metrics');
        return cachedDrillDownSupport;
      } catch {
        cachedDrillDownSupport = false;
        return false;
      } finally {
        inFlight = false;
      }
    },
    async digest(report: ReportSpec, absolutePath: string, callSignal?: AbortSignal): Promise<Record<string, unknown>> {
      return invokeTool(
        'summarize_report',
        { report_ref: absolutePath, format: report.format, top_n: topN },
        callSignal,
        raw => validateDigest(raw, report.format, absolutePath),
      );
    },
    async listKernels(report: ReportSpec, absolutePath: string, callSignal?: AbortSignal): Promise<Record<string, unknown>> {
      return invokeTool(
        'list_kernels',
        { report_ref: absolutePath, format: report.format },
        callSignal,
        raw => validateListKernels(raw, report),
      );
    },
    async getMetrics(
      report: ReportSpec,
      absolutePath: string,
      kernel: string,
      metrics?: string[],
      callSignal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      return invokeTool(
        'get_metrics',
        { report_ref: absolutePath, format: report.format, kernel, ...(metrics ? { metrics } : {}) },
        callSignal,
        raw => validateGetMetrics(raw, report, absolutePath),
      );
    },
    async expandUnit(
      report: ReportSpec,
      absolutePath: string,
      kernel: string,
      section = 'all',
      callSignal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      return invokeTool(
        'expand',
        { report_ref: absolutePath, format: report.format, kernel, section },
        callSignal,
        raw => validateExpand(raw, report, absolutePath, section),
      );
    },
    async compareMetrics(
      reportA: ReportSpec,
      absolutePathA: string,
      reportB: ReportSpec,
      absolutePathB: string,
      kernel: string,
      kernelB?: string,
      metrics?: string[],
      callSignal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      if (reportA.format !== reportB.format) {
        throw new Error('compare_metrics requires reports with matching format');
      }
      return invokeTool(
        'compare_metrics',
        {
          report_a: absolutePathA,
          report_b: absolutePathB,
          format: reportA.format,
          kernel,
          ...(kernelB ? { kernel_b: kernelB } : {}),
          ...(metrics ? { metrics } : {}),
        },
        callSignal,
        raw => validateCompareMetrics(raw, reportA, absolutePathA, reportB, absolutePathB),
      );
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

export function validateListKernels(value: unknown, report: ReportSpec): Record<string, unknown> {
  const rawList = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).result)
      ? (value as Record<string, unknown>).result as unknown[]
      : null);
  if (!rawList || rawList.length < 1) {
    throw new Error('PerfDigest list_kernels did not return a nonempty unit list');
  }
  const units = rawList.slice(0, 64).map((item, fallbackIdx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid unit entry in list_kernels result');
    }
    const u = item as Record<string, unknown>;
    if (typeof u.name !== 'string' || u.name.length < 1) {
      throw new Error('Unit in list_kernels is missing name');
    }
    const index = typeof u.index === 'number' && Number.isInteger(u.index) && u.index >= 0 ? u.index : fallbackIdx;
    const duration_us = typeof u.duration_us === 'number' && Number.isFinite(u.duration_us) && u.duration_us >= 0
      ? u.duration_us
      : null;
    const domain = typeof u.domain === 'string' && u.domain.length > 0 ? u.domain.slice(0, 80) : null;
    return {
      index,
      name: redact(u.name).slice(0, 160),
      duration_us,
      domain,
    };
  });
  return {
    report_id: report.id,
    format: report.format,
    total_units: rawList.length,
    returned: units.length,
    units,
  };
}

function sanitizeFlatMetricsMap(rawMetrics: unknown): Record<string, unknown> {
  if (!rawMetrics || typeof rawMetrics !== 'object' || Array.isArray(rawMetrics)) {
    throw new Error('PerfDigest tool result is missing metrics object');
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawMetrics as Record<string, unknown>)) {
    const key = redact(k).slice(0, 120);
    if (v === null) {
      clean[key] = null;
    } else if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('Non-finite metric value in PerfDigest output');
      clean[key] = v;
    } else if (typeof v === 'string') {
      clean[key] = redact(v).slice(0, 200);
    } else if (Array.isArray(v)) {
      clean[key] = v
        .slice(0, 16)
        .filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    }
  }
  return clean;
}

export function validateGetMetrics(value: unknown, report: ReportSpec, reportPath: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid get_metrics result');
  const obj = value as Record<string, unknown>;
  if (obj.error || obj.format !== report.format || obj.raw_ref !== reportPath || typeof obj.kernel !== 'string' || !obj.kernel) {
    throw new Error('PerfDigest get_metrics did not match requested report and format');
  }
  const metrics = sanitizeFlatMetricsMap(obj.metrics);
  const out: Record<string, unknown> = {
    report_id: report.id,
    format: report.format,
    kernel: redact(obj.kernel).slice(0, 160),
    index: typeof obj.index === 'number' && Number.isInteger(obj.index) ? obj.index : 0,
    domain: typeof obj.domain === 'string' ? obj.domain.slice(0, 80) : null,
    metrics,
  };
  if (JSON.stringify(out).length > 32_000) throw new Error('get_metrics result exceeds context budget');
  return out;
}

export function validateExpand(
  value: unknown,
  report: ReportSpec,
  reportPath: string,
  section: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid expand result');
  const obj = value as Record<string, unknown>;
  if (obj.error || obj.raw_ref !== reportPath || typeof obj.kernel !== 'string' || !obj.kernel) {
    throw new Error('PerfDigest expand did not match requested report');
  }
  const metrics = sanitizeFlatMetricsMap(obj.metrics);
  const out: Record<string, unknown> = {
    report_id: report.id,
    format: report.format,
    kernel: redact(obj.kernel).slice(0, 160),
    index: typeof obj.index === 'number' && Number.isInteger(obj.index) ? obj.index : 0,
    domain: typeof obj.domain === 'string' ? obj.domain.slice(0, 80) : null,
    section_filter: typeof obj.section_filter === 'string' ? redact(obj.section_filter).slice(0, 80) : section,
    metric_count: typeof obj.metric_count === 'number' && Number.isInteger(obj.metric_count)
      ? obj.metric_count
      : Object.keys(metrics).length,
    metrics,
  };
  if (JSON.stringify(out).length > 32_000) throw new Error('expand result exceeds context budget');
  return out;
}

export function validateCompareMetrics(
  value: unknown,
  reportA: ReportSpec,
  pathA: string,
  reportB: ReportSpec,
  pathB: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid compare_metrics result');
  const obj = value as Record<string, unknown>;
  if (
    obj.error ||
    obj.format !== reportA.format ||
    obj.raw_ref_a !== pathA ||
    obj.raw_ref_b !== pathB ||
    typeof obj.kernel_a !== 'string' ||
    typeof obj.kernel_b !== 'string' ||
    !obj.metrics ||
    typeof obj.metrics !== 'object' ||
    Array.isArray(obj.metrics)
  ) {
    throw new Error('PerfDigest compare_metrics did not match requested reports and format');
  }
  const cleanMetrics: Record<string, unknown> = {};
  for (const [k, rawEntry] of Object.entries(obj.metrics as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;
    const normVal = (v: unknown) => {
      if (v === null) return null;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') return redact(v).slice(0, 120);
      return null;
    };
    cleanMetrics[redact(k).slice(0, 120)] = {
      a: normVal(entry.a),
      b: normVal(entry.b),
      delta: normVal(entry.delta),
      delta_pct: normVal(entry.delta_pct),
    };
  }
  const out: Record<string, unknown> = {
    report_id_a: reportA.id,
    report_id_b: reportB.id,
    format: reportA.format,
    domain: typeof obj.domain === 'string' ? obj.domain.slice(0, 80) : null,
    kernel_a: redact(obj.kernel_a).slice(0, 160),
    kernel_b: redact(obj.kernel_b).slice(0, 160),
    index_a: typeof obj.index_a === 'number' && Number.isInteger(obj.index_a) ? obj.index_a : 0,
    index_b: typeof obj.index_b === 'number' && Number.isInteger(obj.index_b) ? obj.index_b : 0,
    sign_convention: typeof obj.sign_convention === 'string' ? redact(obj.sign_convention).slice(0, 80) : 'delta = b - a',
    metrics: cleanMetrics,
  };
  if (JSON.stringify(out).length > 32_000) throw new Error('compare_metrics result exceeds context budget');
  return out;
}
