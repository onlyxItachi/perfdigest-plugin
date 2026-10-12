import type OpenAI from 'openai';
import type { Emit, EvidencePacket, ReportSpec, RoutingMode } from './config.js';
import { offlineSelection, selectReport } from './decisions.js';
import { reportFile } from './files.js';
import { digestReport } from './perfdigest.js';

export async function gatherEvidence(args: {
  workspace: string; issue: string; reports: ReportSpec[]; routing: RoutingMode;
  client?: OpenAI; signal?: AbortSignal; emit?: Emit;
}): Promise<EvidencePacket> {
  const emit = args.emit ?? (() => {});
  args.signal?.throwIfAborted();
  emit('routing.started');
  if (args.routing === 'decisions' && !args.client) throw new Error('Live routing needs a Decisions client');
  const decision = args.routing === 'decisions'
    ? await selectReport(args.client!, args.issue, args.reports, args.signal)
    : offlineSelection(args.reports);
  emit('routing.completed', decision.reason);
  if (!decision.selectedId) return { status: 'needs_review', routing: args.routing, decision, evidence: [] };
  const report = args.reports.find(r => r.id === decision.selectedId)!;
  const before = await reportFile(args.workspace, report.path);
  emit('digest.started', report.id);
  const digest = await digestReport(args.workspace, report, before.path, args.signal);
  const after = await reportFile(args.workspace, report.path);
  if (before.sha256 !== after.sha256) throw new Error('Report changed while digesting; recapture and retry');
  emit('evidence.ready', report.id);
  return { status: 'complete', routing: args.routing, decision, evidence: [{ report,
    sha256: before.sha256, bytes: before.bytes, modifiedAt: before.modifiedAt, provenance: 'perfdigest_mcp', digest }] };
}
