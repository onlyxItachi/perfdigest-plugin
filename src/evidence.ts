import type OpenAI from 'openai';
import type { Emit, EvidencePacket, EvidenceProvenance, ReportSpec, RoutingMode } from './config.js';
import { offlineSelection, selectReport } from './decisions.js';
import { createDecisionProvider, providerName, type DecisionProvider } from './providers.js';
import { reportFile } from './files.js';
import { openPerfDigestSession, type PerfDigestSession, type PerfDigestSessionOptions, type PerfDigestSessionStats } from './perfdigest.js';

export async function gatherEvidence(args: {
  workspace: string; issue: string; reports: ReportSpec[]; routing: RoutingMode;
  client?: OpenAI; provider?: DecisionProvider; signal?: AbortSignal; emit?: Emit;
  /**
   * Optional sink filled as each digest completes, so callers keep hash-checked provenance
   * even when routing later abstains, is rejected or fails with an exception.
   */
  provenance?: EvidenceProvenance[];
  /** Optional bounded session options (e.g. maxCalls or command override in qualification tests). */
  mcpSessionOptions?: PerfDigestSessionOptions;
  /**
   * Controls whether candidate reports within this investigation share one bounded MCP session
   * (`true`, default) or open one fresh 1-call MCP session per report (`false`, controlled baseline).
   */
  reuseMcpSession?: boolean;
  /** Optional observer receiving deterministic MCP session stats once the session is closed. */
  onMcpSessionStats?: (stats: PerfDigestSessionStats) => void;
}): Promise<EvidencePacket> {
  const emit = args.emit ?? (() => {});
  args.signal?.throwIfAborted();
  const selectedProvider = providerName(args.routing);
  if ((args.client && selectedProvider !== 'openai') || (args.client && args.provider)
      || (args.provider && args.provider.name !== selectedProvider)) throw new Error('Injected provider does not match the explicit routing selection');
  const provider = args.provider ?? (args.client ? undefined : createDecisionProvider(args.routing));
  const measuredRouting = selectedProvider !== 'offline';
  const reuseMcpSession = args.reuseMcpSession ?? true;
  const considered: EvidenceProvenance[] = [];
  const sharedSession: PerfDigestSession | null = reuseMcpSession
    ? openPerfDigestSession(args.workspace, args.signal, {
        maxCalls: Math.min(16, Math.max(1, args.reports.length)),
        ...args.mcpSessionOptions,
      })
    : null;
  const perReportAggregate: PerfDigestSessionStats = {
    spawns: 0,
    calls: 0,
    reusedCalls: 0,
    closed: true,
    tainted: false,
  };

  const digestOne = async (report: ReportSpec, absolutePath: string): Promise<EvidencePacket['evidence'][number]['digest']> => {
    if (sharedSession) {
      return await sharedSession.digest(report, absolutePath, args.signal);
    }
    const singleSession = openPerfDigestSession(args.workspace, args.signal, {
      ...args.mcpSessionOptions,
      maxCalls: 1,
    });
    try {
      return await singleSession.digest(report, absolutePath, args.signal);
    } finally {
      await singleSession.close();
      const s = singleSession.stats();
      perReportAggregate.spawns += s.spawns;
      perReportAggregate.calls += s.calls;
      perReportAggregate.reusedCalls += s.reusedCalls;
      perReportAggregate.closed = perReportAggregate.closed && s.closed;
      perReportAggregate.tainted = perReportAggregate.tainted || s.tainted;
    }
  };

  const collect = async (report: ReportSpec): Promise<EvidencePacket['evidence'][number]> => {
    args.signal?.throwIfAborted();
    const before = await reportFile(args.workspace, report.path);
    emit('digest.started', report.id);
    const digest = await digestOne(report, before.path);
    const after = await reportFile(args.workspace, report.path);
    if (before.sha256 !== after.sha256) throw new Error('Report changed while digesting; recapture and retry');
    const record: EvidenceProvenance = { id: report.id, reference: report.path, format: report.format, sha256: before.sha256,
      bytes: before.bytes, modifiedAt: before.modifiedAt, provenance: 'perfdigest_mcp', delivered: false };
    considered.push(record);
    args.provenance?.push(record);
    return { report, sha256: before.sha256, bytes: before.bytes, modifiedAt: before.modifiedAt,
      provenance: 'perfdigest_mcp', digest };
  };

  try {
    // Bounded top-three summaries from at most eight declared reports inform routing.
    // All candidate reports share one workspace-scoped PerfDigest MCP session by default to avoid
    // repeated Python/uvx cold starts while preserving per-report SHA-256 verification.
    const measured: EvidencePacket['evidence'] = [];
    if (measuredRouting) {
      emit('routing.evidence.started');
      for (const report of args.reports) measured.push(await collect(report));
      emit('routing.evidence.completed', String(measured.length));
      // Close the Python MCP subprocess before invoking the decision provider so it does not
      // remain resident during network/model inference when all candidate digests are already collected.
      await sharedSession?.close();
    }
    emit('routing.started');
    const decision = provider ? await provider.select(args.issue, args.reports, args.signal, measured)
      : measuredRouting ? await selectReport(args.client!, args.issue, args.reports, args.signal, measured)
        : offlineSelection(args.reports);
    for (const entry of measured) {
      if ((await reportFile(args.workspace, entry.report.path)).sha256 !== entry.sha256) {
        throw new Error('Report changed while routing; recapture and retry');
      }
    }
    emit('routing.completed', decision.reason);
    if (!decision.selectedId) return { status: 'needs_review', routing: args.routing, decision, considered: [...considered], evidence: [] };
    const report = args.reports.find(r => r.id === decision.selectedId)!;
    const selected = measured.find(e => e.report.id === report.id) ?? await collect(report);
    for (const record of considered) if (record.id === report.id && record.sha256 === selected.sha256) record.delivered = true;
    emit('evidence.ready', report.id);
    return { status: 'complete', routing: args.routing, decision, considered: [...considered], evidence: [selected] };
  } finally {
    await sharedSession?.close();
    args.onMcpSessionStats?.(sharedSession ? sharedSession.stats() : { ...perReportAggregate });
  }
}
