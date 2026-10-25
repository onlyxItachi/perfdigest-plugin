import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TimelineRecorder,
  validateTimelineInvariants,
  computeIntervalAccounting,
  reconcileMultiTurnUsageAndDuration,
  classifyToolCategory,
  classifyToolCallDuplication,
  sanitizeValueForTrace,
  type ObservabilityEvent,
} from '../src/index.js';

test('TimelineRecorder enforces monotonic clock, contiguous sequence IDs, parent spans, and secret/path sanitization', () => {
  let mockNow = 1000;
  const recorder = new TimelineRecorder({
    runId: 'run-test-01',
    arm: 'evidence',
    modelId: 'gemini-4-argon-high',
    studyId: 'cuda_opt_loop',
    sessionId: 'sess-1234',
    sanitize: {
      workspaceDir: '/tmp/perfdigest-multi-model-v2-abc/cell-cuda_opt_loop',
      homeDir: '/home/hamza-usta',
      tmpDir: '/tmp',
    },
    clockFn: () => mockNow,
    utcFn: () => '2026-10-25T14:00:00.000Z',
  });

  const rootEv = recorder.record({
    stage: 'init',
    event: 'run.started',
    detail: 'Workspace /tmp/perfdigest-multi-model-v2-abc/cell-cuda_opt_loop initialized',
    attributes: {
      apiToken: 'cf-secret-token-value',
      path: '/tmp/perfdigest-multi-model-v2-abc/cell-cuda_opt_loop/cuda_opt.ncu-rep',
      homeConfig: '/home/hamza-usta/.config/perfdigest/cloudflare.env',
    },
  });
  assert.equal(rootEv.eventId, 'ev-0001');
  assert.equal(rootEv.seq, 1);
  assert.equal(rootEv.monotonicMs, 0);
  assert.equal(rootEv.detail, 'Workspace <WORKSPACE> initialized');
  assert.equal(rootEv.attributes?.apiToken, '[REDACTED]');
  assert.equal(rootEv.attributes?.path, '<WORKSPACE>/cuda_opt.ncu-rep');
  assert.equal(rootEv.attributes?.homeConfig, '<HOME>/.config/perfdigest/cloudflare.env');

  mockNow = 1012.45;
  const wStart = recorder.record({
    stage: 'worker',
    event: 'evidence.prefetch.started',
    concurrencyLane: 'evidence_worker',
    parentSpanId: rootEv.eventId,
  });

  mockNow = 1015.2;
  const t1Start = recorder.record({
    stage: 'turn1',
    event: 'agent.analysis.turn_started',
    concurrencyLane: 'agent_turn_1',
    parentSpanId: rootEv.eventId,
  });

  mockNow = 4212.45;
  const wReady = recorder.record({
    stage: 'worker',
    event: 'evidence.ready',
    concurrencyLane: 'evidence_worker',
    parentSpanId: wStart.eventId,
    detail: 'ncu-roofline',
  });

  mockNow = 56526.29;
  const t1End = recorder.record({
    stage: 'turn1',
    event: 'agent.analysis.completed',
    concurrencyLane: 'agent_turn_1',
    parentSpanId: t1Start.eventId,
  });

  mockNow = 56530.0;
  const vStart = recorder.record({
    stage: 'verification',
    event: 'verification.started',
    concurrencyLane: 'verification',
    parentSpanId: rootEv.eventId,
  });

  mockNow = 57890.0;
  const vEnd = recorder.record({
    stage: 'verification',
    event: 'verification.completed',
    concurrencyLane: 'verification',
    parentSpanId: vStart.eventId,
    detail: 'passed',
  });

  mockNow = 57892.0;
  const deliv = recorder.record({
    stage: 'delivery',
    event: 'evidence.delivered',
    concurrencyLane: 'evidence_delivery',
    parentSpanId: rootEv.eventId,
    detail: 'same_session_next_turn',
  });

  mockNow = 57895.0;
  const t2Start = recorder.record({
    stage: 'turn2',
    event: 'agent.review.turn_started',
    concurrencyLane: 'agent_turn_2',
    parentSpanId: deliv.eventId,
  });

  mockNow = 82280.0;
  recorder.record({
    stage: 'turn2',
    event: 'agent.review.completed',
    concurrencyLane: 'agent_turn_2',
    parentSpanId: t2Start.eventId,
  });

  mockNow = 82280.36;
  recorder.record({
    stage: 'complete',
    event: 'run.completed',
    parentSpanId: rootEv.eventId,
    detail: 'complete',
  });

  const events = recorder.events();
  const inv = validateTimelineInvariants(events, { requireSameSessionContinuation: true });
  assert.equal(inv.valid, true, `Expected valid timeline, got errors: ${inv.errors.join('; ')}`);
  assert.equal(inv.checkedEventsCount, 11);
  assert.equal(inv.monotonicNonDecreasing, true);
  assert.equal(inv.uniqueEventIds, true);
  assert.equal(inv.contiguousSequenceNumbers, true);
  assert.equal(inv.validParentSpans, true);
  assert.equal(inv.sessionContinuityVerified, true);

  // Verify detection of lost/duplicated/out-of-order events and broken session continuity
  const brokenEvents: ObservabilityEvent[] = events.map((e) => ({ ...e }));
  brokenEvents[4]!.monotonicMs = 100.0; // out-of-order timestamp
  brokenEvents[5]!.seq = 99; // gap in sequence number
  brokenEvents[8]!.sessionId = 'different-session-id'; // session mismatch
  const brokenInv = validateTimelineInvariants(brokenEvents, { requireSameSessionContinuation: true });
  assert.equal(brokenInv.valid, false);
  assert.equal(brokenInv.monotonicNonDecreasing, false);
  assert.equal(brokenInv.contiguousSequenceNumbers, false);
  assert.equal(brokenInv.sessionContinuityVerified, false);
});

test('computeIntervalAccounting distinguishes E2E monotonic wall time, stage sum, critical path, overlap, and wg.Wait delivery delay', () => {
  const accounting = computeIntervalAccounting({
    runStartedMs: 0,
    runCompletedMs: 82280.36,
    turn1StartMs: 14.0,
    turn1EndMs: 56540.29,
    workerStartMs: 12.0,
    evidenceReadyMs: 3255.14,
    verificationStartMs: 56541.0,
    verificationEndMs: 57891.0,
    evidenceDeliveredMs: 57892.0,
    turn2StartMs: 57893.14,
    turn2EndMs: 82280.36,
    turn1ToolExecutionWallMs: 4120.5,
    turn2ToolExecutionWallMs: 0,
    workerMcpDigestWallMs: 920.0,
    workerCloudflareDecisionWallMs: 1106.0,
    workerMcpExtractionWallMs: 1217.14,
    duplicatedProfilerInvestigationWallMs: 28450.0,
  });

  // 1. E2E is directly observed monotonic interval (82,280.36ms), NOT sum of stages (84,126.65ms)
  assert.equal(accounting.endToEndWallMs, 82280.36);
  assert.equal(accounting.turn1WallMs, 56526.29);
  assert.equal(accounting.turn2WallMs, 24387.22);
  assert.equal(accounting.agentSessionWallMs, 80913.51);
  assert.equal(accounting.evidenceWorkerWallMs, 3243.14);
  assert.equal(accounting.verificationWallMs, 1350.0);

  // 2. Parallel overlap between worker [12.0, 3255.14] and Turn 1 [14.0, 56540.29] is 3241.14ms
  assert.equal(accounting.parallelOverlapMs, 3241.14);

  // 3. Worker finished at 3255.14ms, but Turn 1 ran until 56540.29ms (53,285.15ms blocked on wg.Wait()),
  //    followed by 1350ms verification -> 54,636.86ms total evidence-ready-to-delivery delay!
  assert.equal(accounting.workerBlockedOnTurn1CompletionMs, 53285.15);
  assert.equal(accounting.evidenceReadyToDeliveryDelayMs, 54636.86);
  assert.equal(accounting.deliveryToNextTurnDelayMs, 1.14);

  // 4. Sum of stages exceeds E2E wall because of parallel overlap
  assert.ok(accounting.sumOfStageDurationsMs > accounting.endToEndWallMs);
  assert.equal(accounting.criticalPathWallMs, 82263.51);
  assert.equal(accounting.orchestrationOverheadMs, 16.85);
});

test('reconcileMultiTurnUsageAndDuration proves and reconciles every v2 cell where modelApiDurationMs exceeded endToEndWallMs', async () => {
  // Exact verification on gemini-4-argon-high | cuda_opt_loop | evidence:
  const recArgonCuda = reconcileMultiTurnUsageAndDuration({
    cli: 'agy',
    arm: 'evidence',
    endToEndWallMs: 82280.36,
    turn1WallMs: 56526.29,
    turn2WallMs: 24387.22,
    turn1ReportedTokens: {
      inputTokens: 41258,
      uncachedInputTokens: 21365,
      cacheReadInputTokens: 19893,
      cacheCreationInputTokens: 0,
      outputTokens: 3915,
      thinkingTokens: 2107,
    },
    turn2ReportedTokens: {
      inputTokens: 78465,
      uncachedInputTokens: 39259,
      cacheReadInputTokens: 39206,
      cacheCreationInputTokens: 0,
      outputTokens: 5076,
      thinkingTokens: 3164,
    },
    turn1ReportedApiMs: 54415.0,
    turn2ReportedApiMs: 78801.89,
  });
  assert.equal(recArgonCuda.turn2ReportingSemantics, 'cumulative_session_trajectory');
  assert.equal(recArgonCuda.naiveSummedTokens.inputTokens, 119723);
  assert.equal(recArgonCuda.reconciledTotalTokens.inputTokens, 78465);
  assert.equal(recArgonCuda.turn2IncrementalTokens?.inputTokens, 37207);
  assert.ok(recArgonCuda.naiveApiMinusEndToEndMs > 0);
  assert.ok(recArgonCuda.reconciledApiMinusEndToEndMs <= 0);

  // Exact verification on gemini-3.8-flash-high | linux_perf_cpu | evidence:
  // Turn 1 wall: 62,160.05ms (apiMs=60,000ms), Turn 2 wall: 7,225.83ms (0 tool calls, cumulative apiMs=70,000ms)
  const recFlashPerf = reconcileMultiTurnUsageAndDuration({
    cli: 'agy',
    arm: 'evidence',
    endToEndWallMs: 70350.09,
    turn1WallMs: 62160.05,
    turn2WallMs: 7225.83,
    turn1ReportedTokens: {
      inputTokens: 449172,
      uncachedInputTokens: 97035,
      cacheReadInputTokens: 352137,
      cacheCreationInputTokens: 0,
      outputTokens: 4004,
      thinkingTokens: 1624,
    },
    turn2ReportedTokens: {
      inputTokens: 490975,
      uncachedInputTokens: 106049,
      cacheReadInputTokens: 384926,
      cacheCreationInputTokens: 0,
      outputTokens: 5400,
      thinkingTokens: 2945,
    },
    turn1ReportedApiMs: 60000,
    turn2ReportedApiMs: 70000,
  });

  assert.equal(recFlashPerf.turn2ReportingSemantics, 'cumulative_session_trajectory');
  // Naive sum in v2 was 449,172 + 490,975 = 940,147 input tokens and 60,000 + 70,000 = 130,000ms API duration
  assert.equal(recFlashPerf.naiveSummedTokens.inputTokens, 940147);
  assert.equal(recFlashPerf.naiveSummedApiMs, 130000);
  assert.ok(recFlashPerf.naiveApiMinusEndToEndMs > 0); // +59,649.91ms over E2E wall!

  // Reconciled incremental Turn 2 is 490,975 - 449,172 = 41,803 input tokens (9,014 uncached + 32,789 cache-read) and 10,000ms API duration
  assert.equal(recFlashPerf.turn2IncrementalTokens?.inputTokens, 41803);
  assert.equal(recFlashPerf.turn2IncrementalTokens?.uncachedInputTokens, 9014);
  assert.equal(recFlashPerf.turn2IncrementalTokens?.cacheReadInputTokens, 32789);
  assert.equal(recFlashPerf.turn2IncrementalTokens?.outputTokens, 1396);
  assert.equal(recFlashPerf.turn2IncrementalTokens?.thinkingTokens, 1321);
  assert.equal(recFlashPerf.reconciledTotalTokens.inputTokens, 490975);
  assert.equal(recFlashPerf.reconciledTotalApiMs, 70000);
  assert.ok(recFlashPerf.reconciledApiMinusEndToEndMs <= 0); // -350.09ms <= E2E wall!
});

test('classifyToolCallDuplication identifies when Evidence Turn 1 inspects profiler artifacts already handled by the worker', () => {
  const reports = [
    { id: 'ptxas-codegen', path: 'ptxas_verbose.txt' },
    { id: 'ncu-roofline', path: 'cuda_opt.ncu-rep' },
  ];

  // Reading workload source code in Turn 1 is legitimate architectural investigation, NOT duplication
  const srcCall = classifyToolCallDuplication({
    arm: 'evidence',
    turn: 1,
    toolName: 'read_file',
    sanitizedArgs: { Path: '<WORKSPACE>/cuda_opt_bench.cu' },
    sanitizedResultPreview: '__global__ void kernel_v0_naive...',
    studyReports: reports,
  });
  assert.equal(srcCall.duplicatesWorkerEvidence, false);
  assert.deepEqual(srcCall.accessedSourceFiles, ['cuda_opt_bench.cu']);
  assert.deepEqual(srcCall.accessedProfilerReportIds, []);

  // Reading or running ncu on cuda_opt.ncu-rep / ptxas_verbose.txt in Evidence Turn 1 duplicates the worker
  const dupCall = classifyToolCallDuplication({
    arm: 'evidence',
    turn: 1,
    toolName: 'run_command',
    sanitizedArgs: { CommandLine: 'ncu --import <WORKSPACE>/cuda_opt.ncu-rep --page raw' },
    sanitizedResultPreview: 'kernel_v1_coalesced dram_throughput 90.2%',
    studyReports: reports,
  });
  assert.equal(dupCall.duplicatesWorkerEvidence, true);
  assert.deepEqual(dupCall.accessedProfilerReportIds, ['ncu-roofline']);
  assert.ok(dupCall.duplicationReason?.includes('ncu-roofline'));
  assert.equal(classifyToolCategory('run_command'), 'native_shell');
  assert.equal(classifyToolCategory('mcp_perfdigest_summarize_report'), 'perfdigest_mcp');
  assert.equal(
    JSON.stringify(sanitizeValueForTrace({ secret: 'abc', nested: '/home/hamza-usta/file.txt' })),
    JSON.stringify({ secret: '[REDACTED]', nested: '<HOME>/file.txt' }),
  );
});
