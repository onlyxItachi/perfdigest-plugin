import type OpenAI from 'openai';
import type { Emit, EvidencePacket, ReportSpec, RoutingMode } from './config.js';
import { offlineSelection, selectReport } from './decisions.js';
import { createDecisionProvider, providerName, type DecisionProvider } from './providers.js';
import { reportFile } from './files.js';
import { digestReport } from './perfdigest.js';

export async function gatherEvidence(args: {
  workspace: string; issue: string; reports: ReportSpec[]; routing: RoutingMode;
  client?: OpenAI; provider?: DecisionProvider; signal?: AbortSignal; emit?: Emit;
}): Promise<EvidencePacket> {
  const emit = args.emit ?? (() => {});
  args.signal?.throwIfAborted();
  const provider = args.provider ?? (args.client ? undefined : createDecisionProvider(args.routing));
  const measuredRouting = providerName(args.routing) !== 'offline';
  const collect = async (report: ReportSpec): Promise<EvidencePacket['evidence'][number]> => {
    args.signal?.throwIfAborted();
    const before = await reportFile(args.workspace, report.path);
    emit('digest.started', report.id);
    const digest = await digestReport(args.workspace, report, before.path, args.signal);
    const after = await reportFile(args.workspace, report.path);
    if (before.sha256 !== after.sha256) throw new Error('Report changed while digesting; recapture and retry');
    return { report, sha256: before.sha256, bytes: before.bytes, modifiedAt: before.modifiedAt,
      provenance: 'perfdigest_mcp', digest };
  };
  // Bounded top-three summaries from at most eight declared reports inform routing.
  // Collection still runs concurrently with the first Codex turn. No raw report is sent.
  const measured: EvidencePacket['evidence'] = [];
  if (measuredRouting) {
    emit('routing.evidence.started');
    for (const report of args.reports) measured.push(await collect(report));
    emit('routing.evidence.completed', String(measured.length));
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
  if (!decision.selectedId) return { status: 'needs_review', routing: args.routing, decision, evidence: [] };
  const report = args.reports.find(r => r.id === decision.selectedId)!;
  const selected = measured.find(e => e.report.id === report.id) ?? await collect(report);
  emit('evidence.ready', report.id);
  return { status: 'complete', routing: args.routing, decision, evidence: [selected] };
}
