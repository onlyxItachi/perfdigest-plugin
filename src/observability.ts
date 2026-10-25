import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { redact } from './environment.js';

export type ConcurrencyLane =
  | 'runner'
  | 'agent_turn_1'
  | 'evidence_worker'
  | 'verification'
  | 'evidence_delivery'
  | 'agent_turn_2';

export type EventStatus = 'ok' | 'error' | 'unknown';

export interface ObservabilityEvent {
  eventId: string;
  seq: number;
  runId: string;
  arm: 'raw' | 'mcp_digest' | 'evidence';
  modelId: string;
  studyId: string;
  sessionId: string | null;
  parentSpanId: string | null;
  concurrencyLane: ConcurrencyLane;
  stage: string;
  event: string;
  monotonicMs: number;
  utcIso: string;
  status: EventStatus;
  detail: string;
  attributes?: Record<string, unknown>;
}

export interface SanitizeOptions {
  workspaceDir?: string;
  homeDir?: string;
  tmpDir?: string;
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function sanitizeStringForTrace(input: string, options: SanitizeOptions = {}): string {
  let out = redact(String(input ?? ''));
  if (options.workspaceDir && options.workspaceDir.length > 1) {
    out = out.split(options.workspaceDir).join('<WORKSPACE>');
  }
  if (options.tmpDir && options.tmpDir.length > 1) {
    out = out.split(options.tmpDir).join('<TMP>');
  }
  if (options.homeDir && options.homeDir.length > 1) {
    out = out.split(options.homeDir).join('<HOME>');
  }
  out = out.replace(/\/tmp\/perfdigest-[A-Za-z0-9._-]+/g, '<TMP_PERFDIGEST>');
  out = out.replace(/\/home\/[A-Za-z0-9._-]+/g, '<HOME>');
  out = out.replace(/\bhamza-usta\b/g, '<USER>');
  return out;
}

export function sanitizeValueForTrace(value: unknown, options: SanitizeOptions = {}): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeStringForTrace(value, options);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValueForTrace(item, options));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|api_key|apikey/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeValueForTrace(v, options);
      }
    }
    return out;
  }
  return String(value);
}

export interface TimelineRecorderOptions {
  runId: string;
  arm: 'raw' | 'mcp_digest' | 'evidence';
  modelId: string;
  studyId: string;
  sessionId?: string | null;
  sanitize?: SanitizeOptions;
  clockFn?: () => number;
  utcFn?: () => string;
}

export class TimelineRecorder {
  readonly runId: string;
  readonly arm: 'raw' | 'mcp_digest' | 'evidence';
  readonly modelId: string;
  readonly studyId: string;
  private sessionId: string | null;
  private readonly sanitizeOpts: SanitizeOptions;
  private readonly clockFn: () => number;
  private readonly utcFn: () => string;
  private readonly t0: number;
  private seqCounter = 0;
  private lastMonotonicMs = 0;
  private readonly recorded: ObservabilityEvent[] = [];

  constructor(options: TimelineRecorderOptions) {
    this.runId = options.runId;
    this.arm = options.arm;
    this.modelId = options.modelId;
    this.studyId = options.studyId;
    this.sessionId = options.sessionId ?? null;
    this.sanitizeOpts = options.sanitize ?? {};
    this.clockFn = options.clockFn ?? (() => performance.now());
    this.utcFn = options.utcFn ?? (() => new Date().toISOString());
    this.t0 = this.clockFn();
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  nowMonotonicMs(): number {
    const raw = Math.max(0, this.clockFn() - this.t0);
    const rounded = Math.round(raw * 100) / 100;
    if (rounded < this.lastMonotonicMs) {
      return this.lastMonotonicMs;
    }
    this.lastMonotonicMs = rounded;
    return rounded;
  }

  record(params: {
    stage: string;
    event: string;
    concurrencyLane?: ConcurrencyLane;
    parentSpanId?: string | null;
    sessionId?: string | null;
    status?: EventStatus;
    detail?: string;
    monotonicMs?: number;
    utcIso?: string;
    attributes?: Record<string, unknown>;
  }): ObservabilityEvent {
    this.seqCounter += 1;
    const seq = this.seqCounter;
    const eventId = `ev-${String(seq).padStart(4, '0')}`;
    const monotonicMs =
      typeof params.monotonicMs === 'number'
        ? Math.round(Math.max(0, params.monotonicMs) * 100) / 100
        : this.nowMonotonicMs();
    if (monotonicMs > this.lastMonotonicMs) {
      this.lastMonotonicMs = monotonicMs;
    }
    const ev: ObservabilityEvent = {
      eventId,
      seq,
      runId: this.runId,
      arm: this.arm,
      modelId: this.modelId,
      studyId: this.studyId,
      sessionId: params.sessionId !== undefined ? params.sessionId : this.sessionId,
      parentSpanId: params.parentSpanId ?? null,
      concurrencyLane: params.concurrencyLane ?? 'runner',
      stage: params.stage,
      event: params.event,
      monotonicMs,
      utcIso: params.utcIso ?? this.utcFn(),
      status: params.status ?? 'ok',
      detail: sanitizeStringForTrace(params.detail ?? '', this.sanitizeOpts),
      ...(params.attributes
        ? { attributes: sanitizeValueForTrace(params.attributes, this.sanitizeOpts) as Record<string, unknown> }
        : {}),
    };
    this.recorded.push(ev);
    return ev;
  }

  events(): ObservabilityEvent[] {
    return [...this.recorded];
  }
}

export interface TimelineInvariantReport {
  valid: boolean;
  errors: string[];
  checkedEventsCount: number;
  monotonicNonDecreasing: boolean;
  uniqueEventIds: boolean;
  contiguousSequenceNumbers: boolean;
  validParentSpans: boolean;
  sessionContinuityVerified: boolean;
}

export function validateTimelineInvariants(
  events: ObservabilityEvent[],
  options: { requireSameSessionContinuation?: boolean; enforceMonotonicOrder?: boolean } = {},
): TimelineInvariantReport {
  const errors: string[] = [];
  const enforceMonotonic = options.enforceMonotonicOrder ?? true;
  let monotonicNonDecreasing = true;
  let uniqueEventIds = true;
  let contiguousSequenceNumbers = true;
  let validParentSpans = true;

  if (events.length === 0) {
    return {
      valid: false,
      errors: ['Timeline contains zero events'],
      checkedEventsCount: 0,
      monotonicNonDecreasing: false,
      uniqueEventIds: true,
      contiguousSequenceNumbers: false,
      validParentSpans: true,
      sessionContinuityVerified: false,
    };
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.seq !== i + 1) {
      contiguousSequenceNumbers = false;
      errors.push(`Event at index ${i} has seq=${ev.seq}, expected ${i + 1}`);
    }
    if (seenIds.has(ev.eventId)) {
      uniqueEventIds = false;
      errors.push(`Duplicate eventId ${ev.eventId}`);
    }
    seenIds.add(ev.eventId);

    if (!Number.isFinite(ev.monotonicMs) || ev.monotonicMs < 0) {
      monotonicNonDecreasing = false;
      errors.push(`Invalid monotonicMs=${ev.monotonicMs} on ${ev.eventId} (${ev.event})`);
    }
    if (enforceMonotonic && i > 0 && ev.monotonicMs < events[i - 1]!.monotonicMs) {
      monotonicNonDecreasing = false;
      errors.push(
        `Non-monotonic timestamp at ${ev.eventId} (${ev.event}): ${ev.monotonicMs}ms < previous ${events[i - 1]!.monotonicMs}ms`,
      );
    }
    if (ev.parentSpanId !== null && !seenIds.has(ev.parentSpanId)) {
      validParentSpans = false;
      errors.push(`Event ${ev.eventId} (${ev.event}) references unknown or future parentSpanId ${ev.parentSpanId}`);
    }
  }

  if (events[0]!.event !== 'run.started') {
    errors.push(`First event must be run.started, got ${events[0]!.event}`);
  }
  const lastEvent = events[events.length - 1]!;
  if (lastEvent.event !== 'run.completed' && lastEvent.event !== 'run.failed') {
    errors.push(`Last event must be run.completed or run.failed, got ${lastEvent.event}`);
  }

  const findEv = (name: string) => events.find((e) => e.event === name);
  const workerStart = findEv('evidence.prefetch.started');
  const workerReady = findEv('evidence.ready');
  if (workerStart && workerReady && workerReady.monotonicMs < workerStart.monotonicMs) {
    errors.push(`evidence.ready (${workerReady.monotonicMs}ms) preceded evidence.prefetch.started (${workerStart.monotonicMs}ms)`);
  }

  const t1Start = findEv('agent.analysis.turn_started') ?? findEv('agent.turn1.started');
  const t1End = findEv('agent.analysis.completed') ?? findEv('agent.turn1.completed');
  if (t1Start && t1End && t1End.monotonicMs < t1Start.monotonicMs) {
    errors.push(`Turn 1 completion (${t1End.monotonicMs}ms) preceded Turn 1 start (${t1Start.monotonicMs}ms)`);
  }

  const verStart = findEv('verification.started');
  const verEnd = findEv('verification.completed');
  if (verStart && verEnd && verEnd.monotonicMs < verStart.monotonicMs) {
    errors.push(`verification.completed (${verEnd.monotonicMs}ms) preceded verification.started (${verStart.monotonicMs}ms)`);
  }

  const delivered = findEv('evidence.delivered');
  const t2Start = findEv('agent.review.turn_started') ?? findEv('agent.turn2.started');
  const t2End = findEv('agent.review.completed') ?? findEv('agent.turn2.completed');

  if (workerReady && delivered && delivered.monotonicMs < workerReady.monotonicMs) {
    errors.push(`evidence.delivered (${delivered.monotonicMs}ms) preceded evidence.ready (${workerReady.monotonicMs}ms)`);
  }
  if (t1End && delivered && delivered.monotonicMs < t1End.monotonicMs) {
    errors.push(`In two-turn mode, evidence.delivered (${delivered.monotonicMs}ms) preceded Turn 1 completion (${t1End.monotonicMs}ms)`);
  }
  if (delivered && t2Start && t2Start.monotonicMs < delivered.monotonicMs) {
    errors.push(`Turn 2 start (${t2Start.monotonicMs}ms) preceded evidence.delivered (${delivered.monotonicMs}ms)`);
  }
  if (t2Start && t2End && t2End.monotonicMs < t2Start.monotonicMs) {
    errors.push(`Turn 2 completion (${t2End.monotonicMs}ms) preceded Turn 2 start (${t2Start.monotonicMs}ms)`);
  }

  let sessionContinuityVerified = true;
  if (options.requireSameSessionContinuation) {
    const t1Session = t1End?.sessionId ?? t1Start?.sessionId ?? null;
    const t2Session = t2Start?.sessionId ?? t2End?.sessionId ?? null;
    if (!t1Session || !t2Session || t1Session !== t2Session) {
      sessionContinuityVerified = false;
      errors.push(`Session continuity failed: Turn 1 sessionId=${String(t1Session)} vs Turn 2 sessionId=${String(t2Session)}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    checkedEventsCount: events.length,
    monotonicNonDecreasing,
    uniqueEventIds,
    contiguousSequenceNumbers,
    validParentSpans,
    sessionContinuityVerified,
  };
}

export interface IntervalAccounting {
  /** Directly observed monotonic interval between run.started and run.completed. Never a sum of stage durations. */
  endToEndWallMs: number;
  /** Total active agent CLI wall time (turn1WallMs + turn2WallMs). */
  agentSessionWallMs: number;
  turn1WallMs: number;
  turn2WallMs: number;
  turn1ToolExecutionWallMs: number;
  turn2ToolExecutionWallMs: number;
  evidenceWorkerWallMs: number;
  workerMcpDigestWallMs: number;
  workerCloudflareDecisionWallMs: number;
  workerMcpExtractionWallMs: number;
  /** Genuine concurrent execution overlap: max(0, min(evidenceReadyMs, turn1EndMs) - max(workerStartMs, turn1StartMs)). */
  parallelOverlapMs: number;
  /** Delay between evidence.ready and evidence.delivered. */
  evidenceReadyToDeliveryDelayMs: number;
  /** Time completed worker evidence waited in memory because wg.Wait() blocked on Turn 1 finishing. */
  workerBlockedOnTurn1CompletionMs: number;
  verificationWallMs: number;
  /** Delay between evidence.delivered and agent.review.turn_started. */
  deliveryToNextTurnDelayMs: number;
  /** Sum of individual stage durations (exceeds endToEndWallMs whenever worker overlaps with Turn 1). */
  sumOfStageDurationsMs: number;
  /** Critical-path execution time: max(turn1WallMs, evidenceWorkerWallMs) + verificationWallMs + turn2WallMs. */
  criticalPathWallMs: number;
  /** Runner initialization, config, and post-turn teardown outside the critical path. */
  orchestrationOverheadMs: number;
  /** Time spent by the Evidence agent in Turn 1 executing tool calls on profiler artifacts already digested by the worker. */
  duplicatedProfilerInvestigationWallMs: number;
}

export function computeIntervalAccounting(params: {
  runStartedMs: number;
  runCompletedMs: number;
  turn1StartMs: number;
  turn1EndMs: number;
  turn2StartMs?: number | null;
  turn2EndMs?: number | null;
  workerStartMs?: number | null;
  evidenceReadyMs?: number | null;
  verificationStartMs?: number | null;
  verificationEndMs?: number | null;
  evidenceDeliveredMs?: number | null;
  turn1ToolExecutionWallMs?: number;
  turn2ToolExecutionWallMs?: number;
  workerMcpDigestWallMs?: number;
  workerCloudflareDecisionWallMs?: number;
  workerMcpExtractionWallMs?: number;
  duplicatedProfilerInvestigationWallMs?: number;
}): IntervalAccounting {
  const round2 = (n: number) => Math.round(Math.max(0, n) * 100) / 100;

  const endToEndWallMs = round2(params.runCompletedMs - params.runStartedMs);
  const turn1WallMs = round2(params.turn1EndMs - params.turn1StartMs);
  const hasTurn2 = typeof params.turn2StartMs === 'number' && typeof params.turn2EndMs === 'number';
  const turn2WallMs = hasTurn2 ? round2(params.turn2EndMs! - params.turn2StartMs!) : 0;
  const agentSessionWallMs = round2(turn1WallMs + turn2WallMs);

  const hasWorker = typeof params.workerStartMs === 'number' && typeof params.evidenceReadyMs === 'number';
  const evidenceWorkerWallMs = hasWorker ? round2(params.evidenceReadyMs! - params.workerStartMs!) : 0;

  const parallelOverlapMs = hasWorker
    ? round2(Math.min(params.evidenceReadyMs!, params.turn1EndMs) - Math.max(params.workerStartMs!, params.turn1StartMs))
    : 0;

  const hasVerification = typeof params.verificationStartMs === 'number' && typeof params.verificationEndMs === 'number';
  const verificationWallMs = hasVerification ? round2(params.verificationEndMs! - params.verificationStartMs!) : 0;

  const evidenceReadyToDeliveryDelayMs =
    hasWorker && typeof params.evidenceDeliveredMs === 'number'
      ? round2(params.evidenceDeliveredMs - params.evidenceReadyMs!)
      : 0;

  const workerBlockedOnTurn1CompletionMs = hasWorker ? round2(params.turn1EndMs - params.evidenceReadyMs!) : 0;

  const deliveryToNextTurnDelayMs =
    typeof params.evidenceDeliveredMs === 'number' && typeof params.turn2StartMs === 'number'
      ? round2(params.turn2StartMs - params.evidenceDeliveredMs)
      : 0;

  const sumOfStageDurationsMs = round2(turn1WallMs + evidenceWorkerWallMs + verificationWallMs + turn2WallMs);
  const criticalPathWallMs = round2(Math.max(turn1WallMs, evidenceWorkerWallMs) + verificationWallMs + turn2WallMs);
  const orchestrationOverheadMs = round2(endToEndWallMs - criticalPathWallMs);

  return {
    endToEndWallMs,
    agentSessionWallMs,
    turn1WallMs,
    turn2WallMs,
    turn1ToolExecutionWallMs: round2(params.turn1ToolExecutionWallMs ?? 0),
    turn2ToolExecutionWallMs: round2(params.turn2ToolExecutionWallMs ?? 0),
    evidenceWorkerWallMs,
    workerMcpDigestWallMs: round2(params.workerMcpDigestWallMs ?? 0),
    workerCloudflareDecisionWallMs: round2(params.workerCloudflareDecisionWallMs ?? 0),
    workerMcpExtractionWallMs: round2(params.workerMcpExtractionWallMs ?? 0),
    parallelOverlapMs,
    evidenceReadyToDeliveryDelayMs,
    workerBlockedOnTurn1CompletionMs,
    verificationWallMs,
    deliveryToNextTurnDelayMs,
    sumOfStageDurationsMs,
    criticalPathWallMs,
    orchestrationOverheadMs,
    duplicatedProfilerInvestigationWallMs: round2(params.duplicatedProfilerInvestigationWallMs ?? 0),
  };
}

export interface TokenUsageBreakdown {
  inputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ReconciledUsageAndDuration {
  cli: 'agy' | 'claude';
  arm: 'raw' | 'mcp_digest' | 'evidence';
  turnsCount: number;
  /**
   * Explains how Turn 2's CLI result object reports usage/duration:
   * - 'single_turn_only': 1-turn arm (raw or mcp_digest).
   * - 'cumulative_session_trajectory': agy `--conversation <sessionId>` initializes from stored trajectory
   *   and emits cumulative (Turn 1 + Turn 2) usage and duration_seconds at the end of Turn 2.
   * - 'incremental_per_turn': CLI emits standalone Turn 2 usage/duration.
   */
  turn2ReportingSemantics: 'single_turn_only' | 'cumulative_session_trajectory' | 'incremental_per_turn';
  turn1ReportedTokens: TokenUsageBreakdown;
  turn2ReportedTokens: TokenUsageBreakdown | null;
  /** True standalone tokens consumed during Turn 2 alone. */
  turn2IncrementalTokens: TokenUsageBreakdown | null;
  /** True total tokens across the run (Turn 1 + Turn 2 incremental). */
  reconciledTotalTokens: TokenUsageBreakdown;
  /** Naive sum (turn1Reported + turn2Reported) as computed in v2 before discovering cumulative trajectory reporting. */
  naiveSummedTokens: TokenUsageBreakdown;
  /** Exact amount of Turn 1 tokens double-counted by naive summation (0 for single-turn or incremental CLIs). */
  doubleCountedTokens: TokenUsageBreakdown;
  turn1ReportedApiMs: number;
  turn2ReportedApiMs: number | null;
  turn2IncrementalApiMs: number | null;
  reconciledTotalApiMs: number;
  naiveSummedApiMs: number;
  doubleCountedApiMs: number;
  endToEndWallMs: number;
  /** Positive in v2 evidence cells because Turn 1 API duration was summed twice (t1 + (t1 + t2)). */
  naiveApiMinusEndToEndMs: number;
  /** Always <= 0 once cumulative trajectory reporting is reconciled. */
  reconciledApiMinusEndToEndMs: number;
  reconciliationExplanation: string;
}

function zeroTokens(): TokenUsageBreakdown {
  return {
    inputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

function addTokens(a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

function subTokens(cum: TokenUsageBreakdown, base: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    inputTokens: Math.max(0, cum.inputTokens - base.inputTokens),
    uncachedInputTokens: Math.max(0, cum.uncachedInputTokens - base.uncachedInputTokens),
    outputTokens: Math.max(0, cum.outputTokens - base.outputTokens),
    thinkingTokens: Math.max(0, cum.thinkingTokens - base.thinkingTokens),
    cacheReadInputTokens: Math.max(0, cum.cacheReadInputTokens - base.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(0, cum.cacheCreationInputTokens - base.cacheCreationInputTokens),
  };
}

export function reconcileMultiTurnUsageAndDuration(params: {
  cli: 'agy' | 'claude';
  arm: 'raw' | 'mcp_digest' | 'evidence';
  endToEndWallMs: number;
  turn1WallMs: number;
  turn2WallMs: number;
  turn1ReportedTokens: TokenUsageBreakdown;
  turn2ReportedTokens?: TokenUsageBreakdown | null;
  turn1ReportedApiMs: number;
  turn2ReportedApiMs?: number | null;
}): ReconciledUsageAndDuration {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const t1Tok = { ...params.turn1ReportedTokens };
  const t2Tok = params.turn2ReportedTokens ? { ...params.turn2ReportedTokens } : null;
  const t1Api = round2(params.turn1ReportedApiMs);
  const t2Api = typeof params.turn2ReportedApiMs === 'number' ? round2(params.turn2ReportedApiMs) : null;

  if (!t2Tok || t2Api === null) {
    return {
      cli: params.cli,
      arm: params.arm,
      turnsCount: 1,
      turn2ReportingSemantics: 'single_turn_only',
      turn1ReportedTokens: t1Tok,
      turn2ReportedTokens: null,
      turn2IncrementalTokens: null,
      reconciledTotalTokens: t1Tok,
      naiveSummedTokens: t1Tok,
      doubleCountedTokens: zeroTokens(),
      turn1ReportedApiMs: t1Api,
      turn2ReportedApiMs: null,
      turn2IncrementalApiMs: null,
      reconciledTotalApiMs: t1Api,
      naiveSummedApiMs: t1Api,
      doubleCountedApiMs: 0,
      endToEndWallMs: round2(params.endToEndWallMs),
      naiveApiMinusEndToEndMs: round2(t1Api - params.endToEndWallMs),
      reconciledApiMinusEndToEndMs: round2(t1Api - params.endToEndWallMs),
      reconciliationExplanation:
        'Single-turn execution: service-reported usage and modelApiDurationMs correspond to a single CLI invocation and are strictly less than endToEndWallMs.',
    };
  }

  // In agy, resuming a session with `--conversation <id>` loads the existing trajectory
  // via InitializeConversationResponse / GetTrajectoryUsage / GetCumulativeUsage and emits
  // cumulative conversation totals in Turn 2's terminal result event.
  const isCumulativeSession =
    params.cli === 'agy' &&
    t2Tok.inputTokens >= t1Tok.inputTokens &&
    t2Tok.uncachedInputTokens >= t1Tok.uncachedInputTokens &&
    t2Tok.outputTokens >= t1Tok.outputTokens;

  const naiveSummedTokens = addTokens(t1Tok, t2Tok);
  const naiveSummedApiMs = round2(t1Api + t2Api);

  if (isCumulativeSession) {
    const turn2IncrementalTokens = subTokens(t2Tok, t1Tok);
    const reconciledTotalTokens = { ...t2Tok };
    const doubleCountedTokens = { ...t1Tok };
    const turn2IncrementalApiMs = round2(Math.max(0, t2Api - t1Api));
    const reconciledTotalApiMs = t2Api;
    const doubleCountedApiMs = t1Api;

    return {
      cli: params.cli,
      arm: params.arm,
      turnsCount: 2,
      turn2ReportingSemantics: 'cumulative_session_trajectory',
      turn1ReportedTokens: t1Tok,
      turn2ReportedTokens: t2Tok,
      turn2IncrementalTokens,
      reconciledTotalTokens,
      naiveSummedTokens,
      doubleCountedTokens,
      turn1ReportedApiMs: t1Api,
      turn2ReportedApiMs: t2Api,
      turn2IncrementalApiMs,
      reconciledTotalApiMs,
      naiveSummedApiMs,
      doubleCountedApiMs,
      endToEndWallMs: round2(params.endToEndWallMs),
      naiveApiMinusEndToEndMs: round2(naiveSummedApiMs - params.endToEndWallMs),
      reconciledApiMinusEndToEndMs: round2(reconciledTotalApiMs - params.endToEndWallMs),
      reconciliationExplanation:
        `agy --conversation <sessionId> reports cumulative trajectory totals (Turn 1 + Turn 2) in Turn 2's result event ` +
        `(t2Reported=${t2Tok.inputTokens} input tokens, ${t2Api}ms API duration across ${params.turn2WallMs}ms Turn 2 wall). ` +
        `Summing t1 + t2Reported in v2 double-counted Turn 1 (${t1Tok.inputTokens} input tokens, ${t1Api}ms API duration). ` +
        `True Turn 2 incremental usage is ${turn2IncrementalTokens.inputTokens} input tokens (${turn2IncrementalApiMs}ms API), ` +
        `and true total run usage is ${reconciledTotalTokens.inputTokens} input tokens (${reconciledTotalApiMs}ms API <= ${params.endToEndWallMs}ms E2E wall).`,
    };
  }

  return {
    cli: params.cli,
    arm: params.arm,
    turnsCount: 2,
    turn2ReportingSemantics: 'incremental_per_turn',
    turn1ReportedTokens: t1Tok,
    turn2ReportedTokens: t2Tok,
    turn2IncrementalTokens: t2Tok,
    reconciledTotalTokens: naiveSummedTokens,
    naiveSummedTokens,
    doubleCountedTokens: zeroTokens(),
    turn1ReportedApiMs: t1Api,
    turn2ReportedApiMs: t2Api,
    turn2IncrementalApiMs: t2Api,
    reconciledTotalApiMs: naiveSummedApiMs,
    naiveSummedApiMs,
    doubleCountedApiMs: 0,
    endToEndWallMs: round2(params.endToEndWallMs),
    naiveApiMinusEndToEndMs: round2(naiveSummedApiMs - params.endToEndWallMs),
    reconciledApiMinusEndToEndMs: round2(naiveSummedApiMs - params.endToEndWallMs),
    reconciliationExplanation:
      'Per-turn incremental reporting: Turn 1 and Turn 2 report standalone deltas; total usage is Turn 1 + Turn 2.',
  };
}

export interface TracedToolCallRecord {
  callIndex: number;
  turn: 1 | 2;
  stepIndex: number | null;
  toolName: string;
  toolCategory: 'native_file' | 'native_shell' | 'native_search' | 'perfdigest_mcp' | 'other';
  sanitizedArgs: Record<string, unknown>;
  startedAtMonotonicMs: number | null;
  completedAtMonotonicMs: number | null;
  durationMs: number | null;
  status: string;
  exitCode: number | null;
  resultBytes: number;
  resultSha256: string;
  sanitizedResultPreview: string;
  stepInputTokens: number | null;
  stepCacheReadTokens: number | null;
  stepOutputTokens: number | null;
  accessedProfilerReportIds: string[];
  accessedSourceFiles: string[];
  duplicatesWorkerEvidence: boolean;
  duplicationReason: string | null;
}

export function classifyToolCategory(toolName: string): TracedToolCallRecord['toolCategory'] {
  if (toolName === 'call_mcp_tool' || toolName.startsWith('mcp_perfdigest_') || toolName.includes('perfdigest')) {
    return 'perfdigest_mcp';
  }
  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file' || toolName === 'Read') {
    return 'native_file';
  }
  if (toolName === 'run_command' || toolName === 'manage_task' || toolName === 'Bash') {
    return 'native_shell';
  }
  if (toolName === 'list_dir' || toolName === 'find_by_name' || toolName === 'grep_search' || toolName === 'Glob' || toolName === 'Grep') {
    return 'native_search';
  }
  return 'other';
}

export function classifyToolCallDuplication(params: {
  arm: 'raw' | 'mcp_digest' | 'evidence';
  turn: 1 | 2;
  toolName: string;
  sanitizedArgs: Record<string, unknown>;
  sanitizedResultPreview: string;
  studyReports: Array<{ id: string; path: string }>;
}): {
  accessedProfilerReportIds: string[];
  accessedSourceFiles: string[];
  duplicatesWorkerEvidence: boolean;
  duplicationReason: string | null;
} {
  const argsJson = JSON.stringify(params.sanitizedArgs);
  const accessedProfilerReportIds: string[] = [];
  for (const rep of params.studyReports) {
    if (argsJson.includes(rep.path) || argsJson.includes(rep.id)) {
      accessedProfilerReportIds.push(rep.id);
    } else if (rep.path.endsWith('.ncu-rep') && /\bncu\b/.test(argsJson)) {
      accessedProfilerReportIds.push(rep.id);
    } else if (rep.path.includes('perf') && /\bperf\s+(report|stat|script)\b/.test(argsJson)) {
      accessedProfilerReportIds.push(rep.id);
    }
  }

  const accessedSourceFiles: string[] = [];
  for (const srcName of [
    'cuda_opt_bench.cu',
    'lib_template_heavy.cpp',
    'CMakeLists.txt',
    'recursive_grid.hpp',
    'api.hpp',
    'torch_train_bench.py',
    'cpu_bench.c',
  ]) {
    if (argsJson.includes(srcName) || params.sanitizedResultPreview.includes(srcName)) {
      accessedSourceFiles.push(srcName);
    }
  }

  const duplicatesWorkerEvidence =
    params.arm === 'evidence' && params.turn === 1 && accessedProfilerReportIds.length > 0;
  const duplicationReason = duplicatesWorkerEvidence
    ? `Agent Turn 1 invoked ${params.toolName} on profiler artifact(s) [${accessedProfilerReportIds.join(', ')}] while the concurrent GatherEvidence worker was already digesting/extracting those exact reports for Turn 2.`
    : null;

  return {
    accessedProfilerReportIds,
    accessedSourceFiles,
    duplicatesWorkerEvidence,
    duplicationReason,
  };
}
