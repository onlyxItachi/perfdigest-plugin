import { realpath } from 'node:fs/promises';
import type OpenAI from 'openai';
import type {
  Emit,
  EvidenceAcquisitionStep,
  EvidencePacket,
  EvidenceProvenance,
  McpExtractionRecord,
  ReportSpec,
  RoutingMode,
} from './config.js';
import {
  iterativeDecisionsInput,
  offlineSelection,
  sanitizeUnitLabel,
  selectNextAction,
  selectReport,
  type CandidateMcpAction,
} from './decisions.js';
import { createDecisionProvider, providerName, type DecisionProvider } from './providers.js';
import { reportFile } from './files.js';
import { openPerfDigestSession, type PerfDigestSession, type PerfDigestSessionOptions, type PerfDigestSessionStats } from './perfdigest.js';

function getDigestUnits(entry: EvidencePacket['evidence'][number]): Array<Record<string, unknown>> {
  return Array.isArray(entry.digest.units) ? (entry.digest.units as Array<Record<string, unknown>>) : [];
}

function getTotalUnits(entry: EvidencePacket['evidence'][number]): number {
  return typeof entry.digest.total_units === 'number' ? entry.digest.total_units : 0;
}

function getReturnedUnits(entry: EvidencePacket['evidence'][number]): number {
  return typeof entry.digest.returned === 'number' ? entry.digest.returned : 0;
}

export function mightNeedIterativeDrillDown(
  reports: ReportSpec[],
  measured: EvidencePacket['evidence'],
): boolean {
  if (measured.length === 0) return false;
  if (reports.length === 1) {
    const only = measured[0]!;
    if (only.report.format === 'chrome-trace' && getTotalUnits(only) <= getReturnedUnits(only)) {
      return false;
    }
  }
  return true;
}

export function buildCandidateActions(
  reports: ReportSpec[],
  measured: EvidencePacket['evidence'],
  primaryId: string,
  extractions: McpExtractionRecord[],
): CandidateMcpAction[] {
  if (!mightNeedIterativeDrillDown(reports, measured)) return [];
  const primary = measured.find(e => e.report.id === primaryId);
  if (!primary) return [];

  const completed = new Set<string>();
  for (const ex of extractions) {
    if (ex.tool === 'list_kernels') {
      completed.add(`list_kernels:${ex.reportId}`);
    } else if (ex.tool === 'get_metrics') {
      completed.add(`get_metrics:${ex.reportId}:${ex.unit ?? '0'}`);
    } else if (ex.tool === 'expand') {
      completed.add(`expand:${ex.reportId}:${ex.unit ?? '0'}:${ex.section ?? 'all'}`);
      completed.add(`expand:${ex.reportId}:0:${ex.section ?? 'all'}`);
    } else if (ex.tool === 'compare_metrics') {
      if (ex.secondaryReportId && ex.secondaryReportId !== ex.reportId) {
        completed.add(`compare_reports:${ex.reportId}:${ex.secondaryReportId}:${ex.unit ?? '0'}`);
        completed.add(`compare_reports:${ex.secondaryReportId}:${ex.reportId}:${ex.unit ?? '0'}`);
        completed.add(`compare_reports:${ex.reportId}:${ex.secondaryReportId}:0`);
        completed.add(`compare_reports:${ex.secondaryReportId}:${ex.reportId}:0`);
      } else {
        completed.add(`compare_units:${ex.reportId}:${ex.unit ?? '0'}:${ex.secondaryUnit ?? '1'}`);
        completed.add(`compare_units:${ex.reportId}:${ex.secondaryUnit ?? '1'}:${ex.unit ?? '0'}`);
      }
    }
  }

  const actions: CandidateMcpAction[] = [];
  const pushAction = (a: CandidateMcpAction) => {
    if (actions.length >= 6) return;
    if (completed.has(a.id)) return;
    if (actions.some(existing => existing.id === a.id)) return;
    actions.push(a);
  };

  // 1. Layer 2 — Unit Discovery: if primary report has more units than returned in top-N summary
  if (getTotalUnits(primary) > getReturnedUnits(primary)) {
    pushAction({
      id: `list_kernels:${primary.report.id}`,
      layer: 'unit_discovery',
      mcpTool: 'list_kernels',
      reportId: primary.report.id,
      description: `List all ${getTotalUnits(primary)} units/kernels in ${primary.report.id} (${primary.report.format}) to discover units beyond the top-${getReturnedUnits(primary)} summary`,
    });
  }

  // 2. Layer 2/3 — Unseen units discovered by list_kernels on the primary report
  const lkPrimary = extractions.find(x => x.tool === 'list_kernels' && x.reportId === primary.report.id);
  if (lkPrimary && Array.isArray(lkPrimary.data.units)) {
    const summaryIndices = new Set<number>();
    getDigestUnits(primary).forEach((u, idx) => {
      summaryIndices.add(typeof u.index === 'number' ? u.index : idx);
    });
    const lkUnits = lkPrimary.data.units as Array<{ index?: number; name?: string; duration_us?: number | null }>;
    const unseen = lkUnits.filter((u, idx) => !summaryIndices.has(typeof u.index === 'number' ? u.index : idx));
    const hasNumericDuration = unseen.length > 0 && typeof unseen[0]?.duration_us === 'number';
    const orderedUnseen = hasNumericDuration ? unseen : [...unseen].reverse();
    let compareCount = 0;
    for (let i = 0; i + 1 < orderedUnseen.length && compareCount < 2; i++) {
      const uA = orderedUnseen[i]!;
      const uB = orderedUnseen[i + 1]!;
      const idxA = String(uA.index ?? i);
      const idxB = String(uB.index ?? i + 1);
      const labelA = sanitizeUnitLabel(String(uA.name ?? idxA));
      const labelB = sanitizeUnitLabel(String(uB.name ?? idxB));
      const beforeLen = actions.length;
      pushAction({
        id: `compare_units:${primary.report.id}:${idxA}:${idxB}`,
        layer: 'deep_extraction',
        mcpTool: 'compare_metrics',
        reportId: primary.report.id,
        secondaryReportId: primary.report.id,
        unit: idxA,
        secondaryUnit: idxB,
        description: `Compare metrics between discovered units '${labelA}' (#${idxA}) and '${labelB}' (#${idxB}) in ${primary.report.id}`,
      });
      if (actions.length > beforeLen) compareCount++;
    }
    if (orderedUnseen.length === 1) {
      const u = orderedUnseen[0]!;
      const idxStr = String(u.index ?? 0);
      const label = sanitizeUnitLabel(String(u.name ?? idxStr));
      pushAction({
        id: `get_metrics:${primary.report.id}:${idxStr}`,
        layer: 'deep_extraction',
        mcpTool: 'get_metrics',
        reportId: primary.report.id,
        unit: idxStr,
        description: `Extract detailed metrics for discovered unit '${label}' (#${idxStr}) in ${primary.report.id}`,
      });
    }
  }

  // 3. Layer 2/3 — Cross-report delta comparison across same-format candidate reports
  for (let i = 0; i < measured.length; i++) {
    for (let j = i + 1; j < measured.length; j++) {
      const repA = measured[i]!;
      const repB = measured[j]!;
      if (repA.report.format !== repB.report.format) continue;
      const unitsA = getDigestUnits(repA);
      const unitsB = getDigestUnits(repB);
      if (unitsA.length === 0 || unitsB.length === 0) continue;
      const namesB = new Set(unitsB.map(u => (typeof u.name === 'string' ? u.name : '')).filter(Boolean));
      const commonUnit = unitsA.find(u => typeof u.name === 'string' && namesB.has(u.name));
      const unitRefA = commonUnit && typeof commonUnit.name === 'string'
        ? commonUnit.name
        : (typeof unitsA[0]?.name === 'string' && unitsA[0].name.length > 0 ? String(unitsA[0].name) : '0');
      const unitRefB = commonUnit && typeof commonUnit.name === 'string'
        ? commonUnit.name
        : (typeof unitsB[0]?.name === 'string' && unitsB[0].name.length > 0 ? String(unitsB[0].name) : '0');
      const labelA = sanitizeUnitLabel(unitRefA);
      const labelB = sanitizeUnitLabel(unitRefB);
      const desc = unitRefA === unitRefB
        ? `Compare '${labelA}' metrics across ${repA.report.id} and ${repB.report.id} (${repA.report.format})`
        : `Compare hot unit '${labelA}' in ${repA.report.id} vs '${labelB}' in ${repB.report.id} (${repA.report.format})`;
      pushAction({
        id: `compare_reports:${repA.report.id}:${repB.report.id}:0`,
        layer: 'deep_extraction',
        mcpTool: 'compare_metrics',
        reportId: repA.report.id,
        secondaryReportId: repB.report.id,
        unit: unitRefA,
        secondaryUnit: unitRefB,
        description: desc,
      });
    }
  }

  // 4. Layer 3 — Deep vendor section expansion on the hottest unit of the primary report
  const primaryUnits = getDigestUnits(primary);
  const primaryNeedsDiscoveryFirst =
    !lkPrimary &&
    getTotalUnits(primary) > getReturnedUnits(primary) &&
    (primaryUnits.length === 0 || primaryUnits[0]?.duration_us === null || primaryUnits[0]?.duration_us === undefined);

  if (!primaryNeedsDiscoveryFirst && primaryUnits.length > 0 && primary.report.format !== 'chrome-trace') {
    const topUnit = primaryUnits[0]!;
    const unitRef = typeof topUnit.name === 'string' && topUnit.name.length > 0 ? String(topUnit.name) : '0';
    const label = sanitizeUnitLabel(unitRef);
    pushAction({
      id: `expand:${primary.report.id}:0:all`,
      layer: 'deep_extraction',
      mcpTool: 'expand',
      reportId: primary.report.id,
      unit: unitRef,
      section: 'all',
      description: `Expand raw vendor metrics and section details for hot unit '${label}' in ${primary.report.id} (${primary.report.format})`,
    });
  }

  // 5. Layer 3 — Within-report comparison of top 2 summary units in primary report
  if (!primaryNeedsDiscoveryFirst && primaryUnits.length >= 2) {
    const u0 = primaryUnits[0]!;
    const u1 = primaryUnits[1]!;
    const idx0 = String(typeof u0.index === 'number' ? u0.index : 0);
    const idx1 = String(typeof u1.index === 'number' ? u1.index : 1);
    const label0 = sanitizeUnitLabel(String(u0.name ?? idx0));
    const label1 = sanitizeUnitLabel(String(u1.name ?? idx1));
    pushAction({
      id: `compare_units:${primary.report.id}:${idx0}:${idx1}`,
      layer: 'deep_extraction',
      mcpTool: 'compare_metrics',
      reportId: primary.report.id,
      secondaryReportId: primary.report.id,
      unit: idx0,
      secondaryUnit: idx1,
      description: `Compare metrics between top units '${label0}' and '${label1}' in ${primary.report.id} (${primary.report.format})`,
    });
  }

  // 6. Complementary report unit discovery & comparison (e.g. ptxas alongside ncu-rep)
  for (const rep of measured) {
    if (rep.report.id === primary.report.id) continue;
    const lkSecondary = extractions.find(x => x.tool === 'list_kernels' && x.reportId === rep.report.id);
    if (!lkSecondary && getTotalUnits(rep) > getReturnedUnits(rep)) {
      pushAction({
        id: `list_kernels:${rep.report.id}`,
        layer: 'unit_discovery',
        mcpTool: 'list_kernels',
        reportId: rep.report.id,
        description: `List all ${getTotalUnits(rep)} units/kernels in complementary report ${rep.report.id} (${rep.report.format})`,
      });
    } else if (lkSecondary && Array.isArray(lkSecondary.data.units)) {
      const secSummaryIndices = new Set<number>();
      getDigestUnits(rep).forEach((u, idx) => {
        secSummaryIndices.add(typeof u.index === 'number' ? u.index : idx);
      });
      const lkUnits = lkSecondary.data.units as Array<{ index?: number; name?: string; duration_us?: number | null }>;
      const unseen = lkUnits.filter((u, idx) => !secSummaryIndices.has(typeof u.index === 'number' ? u.index : idx));
      const hasNumericDuration = unseen.length > 0 && typeof unseen[0]?.duration_us === 'number';
      const orderedUnseen = hasNumericDuration ? unseen : [...unseen].reverse();
      let secCompareCount = 0;
      for (let i = 0; i + 1 < orderedUnseen.length && secCompareCount < 2; i++) {
        const uA = orderedUnseen[i]!;
        const uB = orderedUnseen[i + 1]!;
        const idxA = String(uA.index ?? i);
        const idxB = String(uB.index ?? i + 1);
        const labelA = sanitizeUnitLabel(String(uA.name ?? idxA));
        const labelB = sanitizeUnitLabel(String(uB.name ?? idxB));
        const beforeLen = actions.length;
        pushAction({
          id: `compare_units:${rep.report.id}:${idxA}:${idxB}`,
          layer: 'deep_extraction',
          mcpTool: 'compare_metrics',
          reportId: rep.report.id,
          secondaryReportId: rep.report.id,
          unit: idxA,
          secondaryUnit: idxB,
          description: `Compare metrics between discovered units '${labelA}' (#${idxA}) and '${labelB}' (#${idxB}) in complementary report ${rep.report.id}`,
        });
        if (actions.length > beforeLen) secCompareCount++;
      }
    }
  }

  return actions;
}

export async function gatherEvidence(args: {
  workspace: string; issue: string; reports: ReportSpec[]; routing: RoutingMode;
  client?: OpenAI; provider?: DecisionProvider; signal?: AbortSignal; emit?: Emit;
  /**
   * Optional sink filled as each digest completes, so callers keep hash-checked provenance
   * even when routing later abstains, is rejected or fails with an exception.
   */
  provenance?: EvidenceProvenance[];
  /** Optional bounded session options (e.g. maxCalls, topN or command override in qualification tests). */
  mcpSessionOptions?: PerfDigestSessionOptions;
  /**
   * Controls whether candidate reports within this investigation share one bounded MCP session
   * (`true`, default) or open one fresh 1-call MCP session per report (`false`, controlled baseline).
   */
  reuseMcpSession?: boolean;
  /**
   * When true and a route is accepted, retains the other candidate digests already computed
   * during measured routing in `packet.corroborating` without re-spawning PerfDigest MCP.
   */
  includeCorroborating?: boolean;
  /** Maximum decision steps in iterative evidence acquisition (1..6, default 4). */
  maxSteps?: number;
  /** Optional observer receiving deterministic MCP session stats once the session is closed. */
  onMcpSessionStats?: (stats: PerfDigestSessionStats) => void;
}): Promise<EvidencePacket> {
  const emit = args.emit ?? (() => {});
  args.signal?.throwIfAborted();
  const selectedProvider = providerName(args.routing);
  if ((args.client && selectedProvider !== 'openai') || (args.client && args.provider)
      || (args.provider && args.provider.name !== selectedProvider)) throw new Error('Injected provider does not match the explicit routing selection');
  const provider = args.provider ?? (args.client ? undefined : createDecisionProvider(args.routing));
  const workspaceRealpath = await realpath(args.workspace);
  const measuredRouting = selectedProvider !== 'offline';
  const reuseMcpSession = args.reuseMcpSession ?? true;
  const maxSteps = Math.min(6, Math.max(1, args.maxSteps ?? 4));
  const considered: EvidenceProvenance[] = [];
  const canProviderIterate = Boolean(provider?.decideAction || args.client);
  const defaultMaxCalls = canProviderIterate
    ? Math.min(16, Math.max(8, args.reports.length + 6))
    : Math.min(16, Math.max(1, args.reports.length));
  const sharedSession: PerfDigestSession | null = reuseMcpSession
    ? openPerfDigestSession(workspaceRealpath, args.signal, {
        maxCalls: defaultMaxCalls,
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

  const withTransientSession = async <T>(fn: (s: PerfDigestSession) => Promise<T>): Promise<T> => {
    if (sharedSession) {
      return await fn(sharedSession);
    }
    const singleSession = openPerfDigestSession(workspaceRealpath, args.signal, {
      ...args.mcpSessionOptions,
      maxCalls: 1,
    });
    try {
      return await fn(singleSession);
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

  const digestOne = async (report: ReportSpec, absolutePath: string): Promise<EvidencePacket['evidence'][number]['digest']> => {
    return withTransientSession(s => s.digest(report, absolutePath, args.signal));
  };

  const collect = async (report: ReportSpec): Promise<EvidencePacket['evidence'][number]> => {
    args.signal?.throwIfAborted();
    const before = await reportFile(args.workspace, report.path, workspaceRealpath);
    emit('digest.started', report.id);
    const digest = await digestOne(report, before.path);
    const after = await reportFile(args.workspace, report.path, workspaceRealpath);
    if (before.sha256 !== after.sha256) throw new Error('Report changed while digesting; recapture and retry');
    emit('digest.completed', report.id);
    const record: EvidenceProvenance = { id: report.id, reference: report.path, format: report.format, sha256: before.sha256,
      bytes: before.bytes, modifiedAt: before.modifiedAt, provenance: 'perfdigest_mcp', delivered: false };
    considered.push(record);
    args.provenance?.push(record);
    return { report, sha256: before.sha256, bytes: before.bytes, modifiedAt: before.modifiedAt,
      provenance: 'perfdigest_mcp', digest };
  };

  const verifyMeasuredUnchanged = async (measured: EvidencePacket['evidence'], phaseMsg: string) => {
    for (const entry of measured) {
      if ((await reportFile(args.workspace, entry.report.path, workspaceRealpath)).sha256 !== entry.sha256) {
        throw new Error(`Report changed while ${phaseMsg}; recapture and retry`);
      }
    }
  };

  try {
    // Stage 1: Orientation digests across declared candidate reports.
    const measured: EvidencePacket['evidence'] = [];
    let drillDownSupported = false;
    if (measuredRouting) {
      emit('routing.evidence.started');
      for (const report of args.reports) measured.push(await collect(report));
      emit('routing.evidence.completed', String(measured.length));
      if (canProviderIterate && maxSteps > 1 && mightNeedIterativeDrillDown(args.reports, measured)) {
        drillDownSupported = await withTransientSession(s => s.supportsDrillDown(args.signal));
      }
      if (!drillDownSupported) {
        await sharedSession?.close();
      }
    }
    emit('routing.started');
    const decision = provider ? await provider.select(args.issue, args.reports, args.signal, measured)
      : measuredRouting ? await selectReport(args.client!, args.issue, args.reports, args.signal, measured)
        : offlineSelection(args.reports);
    await verifyMeasuredUnchanged(measured, 'routing');

    const touchedReportIds = new Set<string>();
    if (drillDownSupported && args.reports.length >= 2 && decision.probabilities) {
      const reportIds = new Set(args.reports.map(r => r.id));
      const hrProb = decision.probabilities.find(p => p.value === '__human_review__')?.probability ?? 0;
      const repProbs = decision.probabilities
        .filter(p => typeof p.value === 'string' && reportIds.has(p.value))
        .sort((a, b) => b.probability - a.probability);
      if (decision.reason === 'low_confidence' && repProbs.length >= 2) {
        const p1 = repProbs[0]!;
        const p2 = repProbs[1]!;
        const k = args.reports.length + 1;
        const uniform = 1 / k;
        const pairConfidence = ((p1.probability + p2.probability) - uniform) / (1 - uniform);
        if (p2.probability >= 0.15 && p1.probability > hrProb && pairConfidence >= 0.55) {
          decision.selectedId = String(p1.value);
          decision.confidence = Number(Math.min(1, pairConfidence).toFixed(4));
          decision.reason = 'selected';
          touchedReportIds.add(String(p2.value));
        }
      } else if (decision.selectedId) {
        for (const p of repProbs) {
          if (p.value !== decision.selectedId && p.probability >= 0.15) {
            touchedReportIds.add(String(p.value));
          }
        }
      }
    }

    emit('routing.completed', decision.reason);
    if (!decision.selectedId) {
      await sharedSession?.close();
      return { status: 'needs_review', routing: args.routing, decision, considered: [...considered], evidence: [] };
    }
    const report = args.reports.find(r => r.id === decision.selectedId)!;
    const selected = measured.find(e => e.report.id === report.id) ?? await collect(report);
    for (const record of considered) if (record.id === report.id && record.sha256 === selected.sha256) record.delivered = true;

    // Stage 2: Adaptive Iterative Evidence Acquisition (Decision -> PerfDigest MCP -> Decision -> MCP)
    const steps: EvidenceAcquisitionStep[] = [
      {
        step: 1,
        layer: 'report_orientation',
        action: `select_report:${report.id}`,
        mcpTool: 'summarize_report',
        targetReportId: report.id,
        confidence: decision.confidence,
        ...(decision.probabilities ? { probabilities: decision.probabilities } : {}),
        reason: 'selected',
        ...(decision.inputSha256 ? { inputSha256: decision.inputSha256 } : {}),
        latencyMs: decision.latencyMs,
        inputTokens: decision.inputTokens,
        outputTokens: decision.outputTokens,
      },
    ];
    const extractions: McpExtractionRecord[] = [];

    if (measuredRouting && canProviderIterate && drillDownSupported && maxSteps > 1) {
      for (let stepNum = 2; stepNum <= maxSteps; stepNum++) {
        if (sharedSession && sharedSession.stats().calls >= sharedSession.maxCalls) {
          steps.push({
            step: stepNum,
            layer: 'stopping',
            action: 'stop_budget_reached',
            mcpTool: null,
            targetReportId: null,
            confidence: null,
            reason: 'budget_reached',
            latencyMs: 0,
            inputTokens: null,
            outputTokens: null,
          });
          break;
        }
        const candidates = buildCandidateActions(args.reports, measured, report.id, extractions);
        if (candidates.length === 0) break;

        const stateJson = iterativeDecisionsInput(args.issue, args.reports, measured, extractions, stepNum);
        emit('routing.step.started', String(stepNum));
        const stepDecision = provider?.decideAction
          ? await provider.decideAction(stateJson, candidates, measured.length, args.signal)
          : await selectNextAction(args.client!, stateJson, candidates, measured.length, args.signal);
        await verifyMeasuredUnchanged(measured, 'routing');

        decision.requests += stepDecision.requests;
        decision.latencyMs += stepDecision.latencyMs;
        if (stepDecision.inputTokens !== null) {
          decision.inputTokens = (decision.inputTokens ?? 0) + stepDecision.inputTokens;
        }
        if (stepDecision.outputTokens !== null) {
          decision.outputTokens = (decision.outputTokens ?? 0) + stepDecision.outputTokens;
        }

        if (!stepDecision.selectedId || stepDecision.selectedId === 'stop_sufficient') {
          const stopReason = stepDecision.selectedId === 'stop_sufficient' ? 'sufficient' : stepDecision.reason;
          steps.push({
            step: stepNum,
            layer: 'stopping',
            action: stepDecision.selectedId ?? 'stop_abstained',
            mcpTool: null,
            targetReportId: null,
            confidence: stepDecision.confidence,
            ...(stepDecision.probabilities ? { probabilities: stepDecision.probabilities } : {}),
            reason: stopReason,
            ...(stepDecision.inputSha256 ? { inputSha256: stepDecision.inputSha256 } : {}),
            latencyMs: stepDecision.latencyMs,
            inputTokens: stepDecision.inputTokens,
            outputTokens: stepDecision.outputTokens,
          });
          emit('routing.step.completed', stopReason);
          break;
        }

        const chosenAction = candidates.find(c => c.id === stepDecision.selectedId);
        if (!chosenAction) break;
        emit('routing.step.completed', `${stepNum}:${chosenAction.id}`);

        const targetRep = args.reports.find(r => r.id === chosenAction.reportId);
        if (!targetRep) break;
        const beforePrimary = await reportFile(args.workspace, targetRep.path, workspaceRealpath);
        let secondaryRep: ReportSpec | undefined;
        let beforeSecondary: Awaited<ReturnType<typeof reportFile>> | undefined;
        if (chosenAction.secondaryReportId) {
          secondaryRep = args.reports.find(r => r.id === chosenAction.secondaryReportId);
          if (!secondaryRep) break;
          beforeSecondary = await reportFile(args.workspace, secondaryRep.path, workspaceRealpath);
        }

        emit('extraction.started', `${chosenAction.mcpTool}:${chosenAction.id}`);
        let extractedData: Record<string, unknown>;
        if (chosenAction.mcpTool === 'list_kernels') {
          extractedData = await withTransientSession(s => s.listKernels(targetRep, beforePrimary.path, args.signal));
        } else if (chosenAction.mcpTool === 'get_metrics') {
          extractedData = await withTransientSession(s =>
            s.getMetrics(targetRep, beforePrimary.path, chosenAction.unit ?? '0', undefined, args.signal),
          );
        } else if (chosenAction.mcpTool === 'expand') {
          extractedData = await withTransientSession(s =>
            s.expandUnit(targetRep, beforePrimary.path, chosenAction.unit ?? '0', chosenAction.section ?? 'all', args.signal),
          );
        } else {
          const repB = secondaryRep ?? targetRep;
          const pathB = beforeSecondary ? beforeSecondary.path : beforePrimary.path;
          extractedData = await withTransientSession(s =>
            s.compareMetrics(
              targetRep,
              beforePrimary.path,
              repB,
              pathB,
              chosenAction.unit ?? '0',
              chosenAction.secondaryUnit,
              undefined,
              args.signal,
            ),
          );
        }

        const afterPrimary = await reportFile(args.workspace, targetRep.path, workspaceRealpath);
        if (beforePrimary.sha256 !== afterPrimary.sha256) {
          throw new Error('Report changed while extracting metrics; recapture and retry');
        }
        if (secondaryRep && beforeSecondary) {
          const afterSecondary = await reportFile(args.workspace, secondaryRep.path, workspaceRealpath);
          if (beforeSecondary.sha256 !== afterSecondary.sha256) {
            throw new Error('Report changed while extracting metrics; recapture and retry');
          }
        }

        const extractionRecord: McpExtractionRecord = {
          step: stepNum,
          tool: chosenAction.mcpTool,
          reportId: targetRep.id,
          ...(secondaryRep ? { secondaryReportId: secondaryRep.id } : {}),
          ...(chosenAction.unit ? { unit: chosenAction.unit } : {}),
          ...(chosenAction.secondaryUnit ? { secondaryUnit: chosenAction.secondaryUnit } : {}),
          ...(chosenAction.section ? { section: chosenAction.section } : {}),
          sha256: beforePrimary.sha256,
          ...(beforeSecondary ? { secondarySha256: beforeSecondary.sha256 } : {}),
          provenance: 'perfdigest_mcp',
          data: extractedData,
        };
        extractions.push(extractionRecord);
        touchedReportIds.add(targetRep.id);
        if (secondaryRep) touchedReportIds.add(secondaryRep.id);

        const targetMeasured = measured.find(m => m.report.id === targetRep.id);
        if (targetMeasured) {
          targetMeasured.extractions ??= [];
          targetMeasured.extractions.push(extractionRecord);
        }

        steps.push({
          step: stepNum,
          layer: chosenAction.layer,
          action: chosenAction.id,
          mcpTool: chosenAction.mcpTool,
          targetReportId: targetRep.id,
          ...(secondaryRep ? { secondaryReportId: secondaryRep.id } : {}),
          ...(chosenAction.unit ? { targetUnit: chosenAction.unit } : {}),
          ...(chosenAction.secondaryUnit ? { secondaryUnit: chosenAction.secondaryUnit } : {}),
          confidence: stepDecision.confidence,
          ...(stepDecision.probabilities ? { probabilities: stepDecision.probabilities } : {}),
          reason: 'selected',
          ...(stepDecision.inputSha256 ? { inputSha256: stepDecision.inputSha256 } : {}),
          latencyMs: stepDecision.latencyMs,
          inputTokens: stepDecision.inputTokens,
          outputTokens: stepDecision.outputTokens,
        });
        emit('extraction.completed', `${chosenAction.mcpTool}:${chosenAction.id}`);
      }
    }

    await sharedSession?.close();

    const corroborating = args.includeCorroborating
      ? measured.filter(e => e.report.id !== report.id)
      : touchedReportIds.size > 0
        ? measured.filter(e => e.report.id !== report.id && touchedReportIds.has(e.report.id))
        : undefined;
    if (corroborating && corroborating.length > 0) {
      decision.complementaryIds = corroborating.map(c => c.report.id);
    }
    if (steps.length > 1 || extractions.length > 0) {
      decision.steps = steps;
    }

    emit('evidence.ready', report.id);
    return {
      status: 'complete',
      routing: args.routing,
      decision,
      considered: [...considered],
      evidence: [selected],
      ...(corroborating && corroborating.length > 0 ? { corroborating } : {}),
      ...(extractions.length > 0 ? { extractions } : {}),
      ...(steps.length > 1 || extractions.length > 0 ? { steps } : {}),
    };
  } finally {
    await sharedSession?.close();
    args.onMcpSessionStats?.(sharedSession ? sharedSession.stats() : { ...perReportAggregate });
  }
}
