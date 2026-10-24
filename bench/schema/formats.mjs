// Source of truth for the benchmark result + manifest + MCP-reuse formats (zod 4, already a
// production dependency). The committed JSON Schema files next to this module are
// GENERATED from these definitions by `node bench/schema/build-schema.mjs` so that
// non-JS consumers (e.g. PerfDigest-MCP-Bench's Python drivers) can validate the
// same documents without zod.
import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmpty = z.string().min(1);

/** Explicit architectural layer separating MCP engine, plugin orchestration, and E2E agent flows. */
export const layerSchema = z.enum(['engine', 'orchestration', 'agent_e2e']);
export const groupSchema = z.enum(['build', 'runtime', 'worker', 'agent']);
export const memoryCoverageSchema = z.enum([
  'cgroup_v2_tree_peak',
  'max_single_process_only_incomplete_tree',
  'none',
]);

/** Order statistics for one metric across N repetitions. All values share `unit`. */
export const statsSchema = z.object({
  unit: z.enum(['ms', 'us', 's', 'kb']),
  n: z.int().min(1),
  median: z.number(),
  min: z.number(),
  max: z.number(),
  mean: z.number(),
  stdev: z.number().min(0),
  q1: z.number().optional(),
  q3: z.number().optional(),
}).strict();

export const toolSchema = z.object({
  name: nonEmpty,
  version: z.string().nullable(),
  /** SHA-256 of the executable actually run, when it was downloaded rather than system-installed. */
  sha256: sha256.optional(),
  source: z.string().optional(),
}).strict();

export const parityCheckSchema = z.object({ name: nonEmpty, pass: z.boolean(), detail: z.string().optional() }).strict();

export const paritySchema = z.object({
  status: z.enum(['pass', 'fail', 'not-checked', 'not-applicable']),
  checks: z.array(parityCheckSchema),
}).strict();

export const cpuStatsSchema = z.object({
  unit: z.literal('ms'),
  n: z.int().min(1),
  userMedian: z.number(),
  sysMedian: z.number(),
  cgroupUserMedianMs: z.number().optional(),
  cgroupSysMedianMs: z.number().optional(),
}).strict();

export const cellSchema = z.object({
  id: nonEmpty,
  layer: layerSchema,
  group: groupSchema,
  backend: nonEmpty,
  scenario: nonEmpty,
  /** Is this the reference baseline for its (group, scenario)? */
  baseline: z.boolean(),
  status: z.enum(['measured', 'not-run', 'failed']),
  reason: z.string().optional(),
  /** argv of the measured command (no shell), with host-specific paths replaced by placeholders. */
  command: z.array(z.string()),
  method: z.string().optional(),
  warmup: z.int().min(0).optional(),
  /** Wall time: per-repetition when measured by hyperfine; per-operation when `method` says so. */
  wall: statsSchema.optional(),
  /** Median user / system CPU per repetition (GNU time + optional cgroup v2 cpu.stat). */
  cpu: cpuStatsSchema.optional(),
  /**
   * Explicitly records whether memory metrics cover the concurrent process tree via Linux cgroup v2
   * (`cgroup_v2_tree_peak`), only the single largest individual process via GNU time `ru_maxrss`
   * (`max_single_process_only_incomplete_tree`), or `none`.
   */
  memoryCoverage: memoryCoverageSchema.optional(),
  /**
   * Peak RSS of the single largest child process from GNU `/usr/bin/time -f '%M'` (`ru_maxrss`);
   * NOT aggregate concurrent process-tree memory.
   */
  peakRssKb: statsSchema.optional(),
  /**
   * Linux kernel cgroup v2 `memory.peak` (in KB) across the entire concurrent process tree inside a
   * transient `systemd-run --user --scope` unit. Present when `memoryCoverage === "cgroup_v2_tree_peak"`.
   */
  cgroupTreePeakKb: statsSchema.optional(),
  parity: paritySchema,
  extra: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const layerCountsSchema = z.object({
  total: z.int().min(0),
  measured: z.int().min(0),
  notRun: z.int().min(0),
  failed: z.int().min(0),
  parityPass: z.int().min(0),
  parityFail: z.int().min(0),
  parityNotApplicable: z.int().min(0),
}).strict();

export const layerSummarySchema = z.object({
  engine: layerCountsSchema,
  orchestration: layerCountsSchema,
  agent_e2e: layerCountsSchema,
}).strict();

export const benchCompatibilitySchema = z.object({
  upstreamRepo: nonEmpty,
  rawResultDirs: z.array(nonEmpty).min(1),
  fieldMapping: z.object({
    latencyJson: nonEmpty,
    identityJson: nonEmpty,
    startupJson: nonEmpty,
    concurrencyJson: nonEmpty,
    loadavgJson: nonEmpty,
  }).strict(),
}).strict();

export const resultSchema = z.object({
  schema: z.literal('perfdigest.benchmark-result.v1'),
  createdAt: z.iso.datetime(),
  manifest: z.object({ id: nonEmpty, path: z.string(), sha256 }).strict(),
  subject: z.object({ repo: nonEmpty, gitSha: z.string().regex(/^[a-f0-9]{40}$/), dirty: z.boolean(), ref: z.string().optional() }).strict(),
  host: z.object({
    label: nonEmpty,
    os: nonEmpty, kernel: nonEmpty, arch: nonEmpty,
    cpuModel: nonEmpty, logicalCpus: z.int().min(1), memTotalKb: z.int().min(1),
    loadavg1AtStart: z.number().min(0),
  }).strict(),
  tools: z.array(toolSchema),
  mode: z.enum(['full', 'smoke']),
  layerSummary: layerSummarySchema,
  benchCompatibility: benchCompatibilitySchema,
  cells: z.array(cellSchema).min(1),
  /** What these numbers DO support. Keep each claim falsifiable and scoped to this host. */
  claims: z.array(nonEmpty),
  /** What these numbers do NOT support (generalization, noise, missing controls). Never empty. */
  limits: z.array(nonEmpty).min(1),
}).strict();

export const manifestCellSchema = z.object({
  id: nonEmpty,
  layer: layerSchema,
  group: groupSchema,
  backend: nonEmpty,
  scenario: nonEmpty,
  baseline: z.boolean().default(false),
  runs: z.int().min(1).optional(),
  warmup: z.int().min(0).optional(),
  smoke: z.boolean().default(false),
}).strict();

export const manifestSchema = z.object({
  schema: z.literal('perfdigest.benchmark-manifest.v1'),
  id: nonEmpty,
  description: z.string(),
  defaults: z.object({ runs: z.int().min(1), warmup: z.int().min(0), rssRuns: z.int().min(1), spawnIterations: z.int().min(1) }).strict(),
  smokeDefaults: z.object({ runs: z.int().min(1), warmup: z.int().min(0), rssRuns: z.int().min(1), spawnIterations: z.int().min(1) }).strict(),
  cells: z.array(manifestCellSchema).min(1),
}).strict();

const mcpReuseSubprocessRunSchema = z.object({
  runs: z.int().min(1),
  warmup: z.int().min(0),
  wallMs: statsSchema,
  userCpuMs: statsSchema,
  sysCpuMs: statsSchema,
  cgroupUserCpuMs: statsSchema.optional(),
  cgroupSysCpuMs: statsSchema.optional(),
  memoryCoverage: memoryCoverageSchema,
  maxSingleProcessRssKb: statsSchema,
  cgroupTreePeakKb: statsSchema.optional(),
  sessionStats: z.object({
    spawns: z.int().min(1),
    calls: z.int().min(1),
    reusedCalls: z.int().min(0),
    closed: z.boolean(),
    tainted: z.boolean(),
  }).strict(),
}).strict();

const mcpReuseWorkflowComparisonSchema = z.object({
  reportCount: z.int().min(1),
  runtime: nonEmpty,
  status: z.enum(['measured', 'not-run']),
  reason: z.string().optional(),
  note: z.string().optional(),
  evidenceParity: z.object({
    status: z.enum(['pass', 'fail', 'not-checked']),
    detail: nonEmpty,
  }).strict(),
  beforePerReportSpawn: mcpReuseSubprocessRunSchema.optional(),
  afterSessionReuse: mcpReuseSubprocessRunSchema.optional(),
  delta: z.object({
    savedWallMs: z.number(),
    speedupRatio: z.number(),
    savedCgroupUserCpuMs: z.number().optional(),
    savedCgroupSysCpuMs: z.number().optional(),
  }).strict().optional(),
}).strict();

const singleCallPairSchema = z.object({
  command: z.array(nonEmpty),
  reportSequenceCount: z.int().min(1),
  digestParityPass: z.boolean(),
  coldSpawn: statsSchema,
  warmSessionReuse: statsSchema,
  savedPerReusedCallMs: z.number(),
  speedupRatio: z.number(),
}).strict();

export const mcpReuseResultSchema = z.object({
  schema: z.literal('perfdigest.mcp-reuse-result.v1'),
  createdAt: z.iso.datetime(),
  subject: z.object({
    repo: nonEmpty,
    gitSha: z.string().regex(/^[a-f0-9]{40}$/),
    dirty: z.boolean(),
    ref: z.string().optional(),
  }).strict(),
  host: z.object({
    label: nonEmpty,
    os: nonEmpty,
    kernel: nonEmpty,
    arch: nonEmpty,
    cpuModel: nonEmpty,
    logicalCpus: z.int().min(1),
    memTotalKb: z.int().min(1),
    loadavg1AtStart: z.number().min(0),
    node: nonEmpty,
  }).strict(),
  singleCallLatencyMs: z.object({
    perfdigestMcp120: singleCallPairSchema,
    perfdigestMcp130: singleCallPairSchema.optional(),
  }).strict(),
  multiReportWorkflows: z.record(z.string(), mcpReuseWorkflowComparisonSchema),
  claims: z.array(nonEmpty).min(1),
  limits: z.array(nonEmpty).min(1),
}).strict();

const workloadArmResultSchema = z.object({
  arm: z.enum(['A_codex_alone', 'B_codex_perfdigest_mcp', 'C_codex_perfdigest_evidence', 'C_opt_single_turn_compact']),
  executionMode: z.enum(['codex_chatgpt_login', 'agy_gemini_cli', 'deterministic_offline_fallback']),
  wallMs: z.number().min(0),
  costBreakdownMs: z.object({
    agentExecutionOverheadMs: z.number().min(0),
    modelInferenceMs: z.number().min(0),
    mcpEngineMs: z.number().min(0),
    verificationMs: z.number().min(0),
    evidenceModelOverlapMs: z.number().min(0),
  }).strict(),
  resources: z.object({
    memoryCoverage: memoryCoverageSchema,
    cgroupTreePeakKb: z.int().min(1).optional(),
    maxSingleProcessRssKb: z.int().min(1),
    cgroupUserCpuMs: z.number().min(0).optional(),
    cgroupSysCpuMs: z.number().min(0).optional(),
  }).strict(),
  tokens: z.object({
    evidencePayloadBytes: z.int().min(0),
    evidencePayloadTokensEst: z.int().min(0),
    modelInputTokens: z.int().min(0).nullable(),
    modelOutputTokens: z.int().min(0).nullable(),
    modelCachedInputTokens: z.int().min(0).nullable(),
  }).strict(),
  evidenceAndRouting: z.object({
    mcpSessionSpawns: z.int().min(0),
    mcpToolCalls: z.int().min(0),
    mcpReusedCalls: z.int().min(0),
    decisionOutcome: z.enum(['not_used', 'accepted', 'abstained', 'rejected', 'failed']),
    selectedReportId: z.string().nullable(),
    provenanceCount: z.int().min(0),
    verificationExecuted: z.boolean(),
    verificationPassed: z.boolean().nullable(),
  }).strict(),
  diagnostics: z.object({
    checksPassed: z.int().min(0),
    totalChecks: z.int().min(1),
    accuracyScore: z.number().min(0).max(1),
    falseConclusionsCount: z.int().min(0),
    falseConclusions: z.array(z.string()),
    checks: z.record(z.string(), z.boolean()),
    summary: nonEmpty,
  }).strict(),
}).strict();

const studyOptimizationBreakdownSchema = z.object({
  envelopeCompaction: z.object({
    verboseEvidenceBytes: z.int().min(1),
    compactEvidenceBytes: z.int().min(1),
    savedBytes: z.int(),
    byteReductionPct: z.number(),
    verboseTokensEst: z.int().min(1),
    compactTokensEst: z.int().min(1),
    savedTokensEst: z.int(),
    preservesAllUnitsMetricsNullsAndVerification: z.boolean(),
  }).strict(),
  singleTurnDelivery: z.object({
    twoTurnWallMs: z.number().min(0),
    singleTurnWallMs: z.number().min(0),
    savedWallMs: z.number(),
    wallSpeedupRatio: z.number().positive(),
    twoTurnModelInferenceMs: z.number().min(0),
    singleTurnModelInferenceMs: z.number().min(0),
    savedModelInferenceMs: z.number(),
    twoTurnModelInputTokens: z.int().min(0).nullable(),
    singleTurnModelInputTokens: z.int().min(0).nullable(),
    savedModelInputTokens: z.int().nullable(),
    inputTokenReductionPct: z.number().nullable(),
    twoTurnAccuracyScore: z.number().min(0).max(1),
    singleTurnAccuracyScore: z.number().min(0).max(1),
  }).strict(),
}).strict();

export const realWorkloadEvalResultSchema = z.object({
  schema: z.literal('perfdigest.real-workload-eval.v1'),
  createdAt: z.iso.datetime(),
  subject: z.object({
    repo: nonEmpty,
    gitSha: z.string().regex(/^[a-f0-9]{40}$/),
    dirty: z.boolean(),
    ref: z.string().optional(),
  }).strict(),
  host: z.object({
    label: nonEmpty,
    os: nonEmpty,
    kernel: nonEmpty,
    arch: nonEmpty,
    cpuModel: nonEmpty,
    logicalCpus: z.int().min(1),
    memTotalKb: z.int().min(1),
    gpuModel: nonEmpty,
    loadavg1AtStart: z.number().min(0),
    node: nonEmpty,
    codexCli: nonEmpty,
  }).strict(),
  studies: z.array(z.object({
    id: nonEmpty,
    title: nonEmpty,
    benchStudyRef: nonEmpty,
    captureMode: z.enum(['live_hardware_capture', 'artifact_and_live_toolchain', 'artifact_level_boundary']),
    boundaryNote: z.string().optional(),
    candidateReports: z.array(z.object({
      id: nonEmpty,
      format: nonEmpty,
      rawBytes: z.int().min(1),
      rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
      digestBytes: z.int().min(1),
      compressionRatio: z.number().min(0),
    }).strict()).min(1),
    validatedFix: z.object({
      attempted: z.boolean(),
      description: nonEmpty,
      verificationCommand: nonEmpty,
      verificationExitCode: z.int(),
      correctnessPassed: z.boolean(),
      baselineMetric: z.object({
        name: nonEmpty,
        unit: nonEmpty,
        median: z.number().positive(),
        samples: z.array(z.number().positive()).min(1),
      }).strict(),
      fixedMetric: z.object({
        name: nonEmpty,
        unit: nonEmpty,
        median: z.number().positive(),
        samples: z.array(z.number().positive()).min(1),
      }).strict(),
      speedupRatio: z.number().positive(),
    }).strict(),
    abstentionGuardCheck: z.object({
      testedLowConfidence: z.number().min(0).max(1),
      policyThreshold: z.number().min(0).max(1),
      decisionOutcome: z.literal('abstained'),
      pipelineStatus: z.literal('needs_review'),
      evidenceDeliveredCount: z.literal(0),
      provenanceRetainedCount: z.int().min(1),
      provenanceHashesMatch: z.boolean(),
    }).strict(),
    arms: z.object({
      A_codex_alone: workloadArmResultSchema,
      B_codex_perfdigest_mcp: workloadArmResultSchema,
      C_codex_perfdigest_evidence: workloadArmResultSchema,
      C_opt_single_turn_compact: workloadArmResultSchema.optional(),
    }).strict(),
    optimizationBreakdown: studyOptimizationBreakdownSchema.optional(),
  }).strict()).min(4),
  summary: z.object({
    totalStudies: z.int().min(4),
    meanAccuracyByArm: z.object({
      A_codex_alone: z.number().min(0).max(1),
      B_codex_perfdigest_mcp: z.number().min(0).max(1),
      C_codex_perfdigest_evidence: z.number().min(0).max(1),
      C_opt_single_turn_compact: z.number().min(0).max(1).optional(),
    }).strict(),
    totalFalseConclusionsByArm: z.object({
      A_codex_alone: z.int().min(0),
      B_codex_perfdigest_mcp: z.int().min(0),
      C_codex_perfdigest_evidence: z.int().min(0),
      C_opt_single_turn_compact: z.int().min(0).optional(),
    }).strict(),
    validatedSpeedups: z.record(z.string(), z.number().positive()),
    optimizationSummary: z.object({
      trialsPerStudy: z.int().min(1),
      envelopeCompaction: z.object({
        meanVerboseEvidenceBytes: z.number().positive(),
        meanCompactEvidenceBytes: z.number().positive(),
        meanSavedBytes: z.number(),
        meanByteReductionPct: z.number(),
        meanVerboseTokensEst: z.number().positive(),
        meanCompactTokensEst: z.number().positive(),
        meanSavedTokensEst: z.number(),
        smallerThanUnroutedArmBMcp: z.boolean(),
      }).strict(),
      singleTurnDelivery: z.object({
        meanTwoTurnWallMs: z.number().positive(),
        meanSingleTurnWallMs: z.number().positive(),
        meanSavedWallMs: z.number(),
        meanWallSpeedupRatio: z.number().positive(),
        meanTwoTurnModelInferenceMs: z.number().positive(),
        meanSingleTurnModelInferenceMs: z.number().positive(),
        meanSavedModelInferenceMs: z.number(),
        meanTwoTurnModelInputTokens: z.number().positive(),
        meanSingleTurnModelInputTokens: z.number().positive(),
        meanSavedModelInputTokens: z.number(),
        meanInputTokenReductionPct: z.number(),
        meanAccuracyTwoTurn: z.number().min(0).max(1),
        meanAccuracySingleTurn: z.number().min(0).max(1),
        totalFalseConclusionsSingleTurn: z.int().min(0),
      }).strict(),
    }).strict().optional(),
  }).strict(),
  claims: z.array(nonEmpty).min(1),
  limits: z.array(nonEmpty).min(1),
}).strict();

export const workerReceiptCellSchema = z.object({
  id: nonEmpty,
  backend: z.enum(['node22', 'bun', 'deno', 'go']),
  lifecycle: z.enum(['one_shot', 'persistent']),
  runs: z.int().min(1),
  warmup: z.int().min(0),
  wallMs: statsSchema,
  resources: z.object({
    memoryCoverage: memoryCoverageSchema,
    cgroupTreePeakKb: z.number().optional(),
    maxSingleProcessRssKb: z.number().optional(),
    cgroupUserCpuMs: z.number().optional(),
    cgroupSysCpuMs: z.number().optional(),
  }).strict(),
  parity: paritySchema,
  reportsCount: z.int().min(1),
  commandCount: z.int().min(1),
}).strict();

export const investigateOrchestrationCellSchema = z.object({
  id: nonEmpty,
  backend: z.enum(['node22', 'bun', 'deno', 'go']),
  lifecycle: z.enum(['one_shot', 'persistent']),
  reuseMcpSession: z.boolean(),
  runs: z.int().min(1),
  warmup: z.int().min(0),
  wallMs: statsSchema,
  resources: z.object({
    memoryCoverage: memoryCoverageSchema,
    cgroupTreePeakKb: z.number().optional(),
    maxSingleProcessRssKb: z.number().optional(),
    cgroupUserCpuMs: z.number().optional(),
    cgroupSysCpuMs: z.number().optional(),
  }).strict(),
  parity: paritySchema,
  mcpSpawns: z.int().min(0),
  mcpCalls: z.int().min(0),
  mcpReusedCalls: z.int().min(0),
}).strict();

export const mcpServerLifecycleCellSchema = z.object({
  id: nonEmpty,
  backend: z.enum(['node22', 'bun', 'deno', 'go']),
  lifecycle: z.enum(['one_shot', 'persistent']),
  runs: z.int().min(1),
  warmup: z.int().min(0),
  wallMs: statsSchema,
  resources: z.object({
    memoryCoverage: memoryCoverageSchema,
    cgroupTreePeakKb: z.number().optional(),
    maxSingleProcessRssKb: z.number().optional(),
    cgroupUserCpuMs: z.number().optional(),
    cgroupSysCpuMs: z.number().optional(),
  }).strict(),
  parity: paritySchema,
  toolsCount: z.int().min(1),
  reportsCount: z.int().min(1),
}).strict();

export const costSeparationEntrySchema = z.object({
  backend: z.enum(['node22', 'bun', 'deno', 'go']),
  runtimeColdStartMs: z.number(),
  orchestrationOnlyMs: z.number(),
  mcpEngineColdSpawnMs: z.number(),
  mcpEngineWarmReusePerReportMs: z.number(),
  e2eEstimatedWithSessionReuseMs: z.number(),
  e2eEstimatedWithoutSessionReuseMs: z.number(),
  speedupRatioSessionReuse: z.number(),
}).strict();

export const lifecycleBenchmarkResultSchema = z.object({
  schema: z.literal('perfdigest.lifecycle-benchmark.v1'),
  createdAt: z.iso.datetime(),
  subject: z.object({
    repo: nonEmpty,
    gitSha: z.string().regex(/^[a-f0-9]{40}$/),
    dirty: z.boolean(),
    ref: z.string().optional(),
  }).strict(),
  host: z.object({
    label: nonEmpty,
    os: nonEmpty,
    kernel: nonEmpty,
    arch: nonEmpty,
    cpuModel: nonEmpty,
    logicalCpus: z.int().min(1),
    memTotalKb: z.int().min(1),
    loadavg1AtStart: z.number().min(0),
    node: nonEmpty,
    bun: z.string().nullable(),
    deno: z.string().nullable(),
    go: z.string().nullable(),
  }).strict(),
  tools: z.record(z.string(), toolSchema),
  workload: z.object({
    reportCount: z.int().min(1),
    reports: z.array(z.object({
      id: nonEmpty,
      path: nonEmpty,
      format: nonEmpty,
      bytes: z.int().min(1),
      sha256: sha256,
    }).strict()).min(4),
    verificationCommand: z.array(z.string()),
  }).strict(),
  tableA_workerReceipt: z.array(workerReceiptCellSchema).min(8),
  tableB_investigateOrchestration: z.array(investigateOrchestrationCellSchema).min(16),
  tableB2_liveMcpEndToEnd: z.array(investigateOrchestrationCellSchema).min(8),
  tableC_costSeparation: z.array(costSeparationEntrySchema).min(4),
  tableD_mcpServerLifecycle: z.array(mcpServerLifecycleCellSchema).min(8),
  claims: z.array(nonEmpty).min(1),
  limits: z.array(nonEmpty).min(1),
}).strict();

export const regressionCorpusSchema = z.object({
  schema: z.literal('perfdigest.regression-corpus.v1'),
  createdAt: z.iso.datetime(),
  upstreamRepo: z.literal('onlyxItachi/PerfDigest-MCP-Bench'),
  studies: z.array(z.object({
    id: nonEmpty,
    title: nonEmpty,
    studyDoc: nonEmpty,
    rawDir: nonEmpty,
    question: nonEmpty,
    expectedSelectedReportId: nonEmpty,
    reports: z.array(z.object({
      id: nonEmpty,
      path: nonEmpty,
      format: nonEmpty,
      bytes: z.int().min(1),
      sha256: sha256,
      expectedDigest: z.object({
        totalUnits: z.int().min(1),
        topUnitName: nonEmpty,
        topUnitIndex: z.int().min(0),
        topUnitDomain: nonEmpty,
        topUnitMetrics: z.record(z.string(), z.number().nullable()),
      }).strict(),
    }).strict()).min(1),
  }).strict()).min(1),
}).strict();

export const multiModelIdSchema = z.enum([
  'gemini-4-argon-high',
  'gemini-3.8-flash-high',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
]);

export const multiModelArmSchema = z.enum(['raw', 'mcp_digest', 'compact_evidence']);

const resourceSnapshotSchema = z.object({
  memoryCoverage: memoryCoverageSchema,
  cgroupTreePeakKb: z.int().min(1).optional(),
  maxSingleProcessRssKb: z.int().min(1),
  cgroupUserCpuMs: z.number().min(0).optional(),
  cgroupSysCpuMs: z.number().min(0).optional(),
}).strict();

const multiModelEvaluationCellSchema = z.object({
  modelId: multiModelIdSchema,
  cli: z.enum(['agy', 'claude']),
  effort: z.enum(['high', 'max']),
  arm: multiModelArmSchema,
  timingsMs: z.object({
    orchestrationMs: z.number().min(0),
    mcpMs: z.number().min(0),
    routingMs: z.number().min(0),
    verificationMs: z.number().min(0),
    cliStartupMs: z.number().min(0),
    cliTimeToRequestMs: z.number().min(0).nullable(),
    modelFirstResponseMs: z.number().min(0),
    cliReportedTtftMs: z.number().min(0).nullable(),
    thinkingStreamMs: z.number().min(0).nullable(),
    textOutputStreamMs: z.number().min(0),
    reasoningAndOutputStreamingMs: z.number().min(0),
    modelApiDurationMs: z.number().min(0),
    modelCliTotalWallMs: z.number().min(0),
    totalE2eWallMs: z.number().min(0),
  }).strict(),
  tokens: z.object({
    evidencePayloadBytes: z.int().min(0),
    evidencePayloadTokensEst: z.int().min(0),
    inputTokens: z.int().min(0),
    outputTokens: z.int().min(0),
    thinkingTokens: z.int().min(0),
    cacheReadInputTokens: z.int().min(0),
    cacheCreationInputTokens: z.int().min(0),
  }).strict(),
  cost: z.object({
    costUsd: z.number().min(0).nullable(),
    costBasis: z.enum(['list', 'unreported_subscription_or_quota']),
  }).strict(),
  resources: resourceSnapshotSchema,
  diagnostics: z.object({
    checksPassed: z.int().min(0),
    totalChecks: z.int().min(1),
    accuracyScore: z.number().min(0).max(1),
    falseConclusionsCount: z.int().min(0),
    falseConclusions: z.array(z.string()),
    checks: z.record(z.string(), z.boolean()),
    summary: nonEmpty,
  }).strict(),
}).strict();

export const multiModelEvalResultSchema = z.object({
  schema: z.literal('perfdigest.multi-model-eval.v1'),
  createdAt: z.iso.datetime(),
  subject: z.object({
    repo: nonEmpty,
    gitSha: z.string().regex(/^[a-f0-9]{40}$/),
    dirty: z.boolean(),
    ref: z.string().optional(),
  }).strict(),
  host: z.object({
    label: nonEmpty,
    os: nonEmpty,
    kernel: nonEmpty,
    arch: nonEmpty,
    cpuModel: nonEmpty,
    logicalCpus: z.int().min(1),
    memTotalKb: z.int().min(1),
    gpuModel: nonEmpty,
    loadavg1AtStart: z.number().min(0),
    node: nonEmpty,
    agyCli: nonEmpty,
    claudeCli: nonEmpty,
    go: nonEmpty,
  }).strict(),
  preflightSmokeTests: z.object({
    agyGemini38Flash: z.object({
      passed: z.boolean(),
      cliVersion: nonEmpty,
      modelId: z.literal('gemini-3.8-flash-high'),
      supportedEfforts: z.array(z.enum(['low', 'medium', 'high'])).min(3),
      highestSupportedEffort: z.literal('high'),
      unsupportedMaxEffortError: nonEmpty,
      streamingTelemetryVerified: z.boolean(),
      observedEvents: z.array(nonEmpty).min(4),
      smokeTimingsMs: z.object({
        cliInitMs: z.number().min(0),
        promptSubmittedMs: z.number().min(0),
        firstResponseDeltaMs: z.number().min(0),
        streamDoneMs: z.number().min(0),
        serverReportedDurationMs: z.number().min(0),
        totalProcessWallMs: z.number().min(0),
      }).strict(),
      smokeUsage: z.object({
        inputTokens: z.int().min(0),
        outputTokens: z.int().min(0),
        thinkingTokens: z.int().min(0),
        cacheReadTokens: z.int().min(0),
        totalTokens: z.int().min(0),
      }).strict(),
    }).strict(),
    claudeCodeIsolation: z.object({
      passed: z.boolean(),
      cliVersion: nonEmpty,
      authMethod: nonEmpty,
      apiProvider: nonEmpty,
      isolationFlags: z.array(z.string()).min(6),
      isolationEnv: z.record(z.string(), z.string()),
      plantedCanaries: z.object({
        claudeMdCanary: nonEmpty,
        dotClaudeMdCanary: nonEmpty,
        mcpJsonCanaryServer: nonEmpty,
        userPromptSubmitHookExit2: z.boolean(),
      }).strict(),
      observedInitState: z.object({
        toolsCount: z.literal(0),
        mcpServersCount: z.literal(0),
        slashCommandsCount: z.literal(0),
        skillsCount: z.literal(0),
        hookExecuted: z.literal(false),
        canaryLeakedInResponse: z.literal(false),
        responseText: z.literal('ISOLATED'),
      }).strict(),
      smokeCostUsd: z.number().min(0),
    }).strict(),
  }).strict(),
  models: z.array(z.object({
    id: multiModelIdSchema,
    displayName: nonEmpty,
    cli: z.enum(['agy', 'claude']),
    modelArg: nonEmpty,
    highestSupportedEffort: z.enum(['high', 'max']),
    isolationMode: nonEmpty,
    cliResources: resourceSnapshotSchema,
  }).strict()).length(6),
  studies: z.array(z.object({
    id: nonEmpty,
    title: nonEmpty,
    benchStudyRef: nonEmpty,
    captureMode: z.enum(['live_hardware_capture', 'artifact_and_live_toolchain', 'artifact_level_boundary']),
    boundaryNote: z.string().optional(),
    candidateReports: z.array(z.object({
      id: nonEmpty,
      format: nonEmpty,
      rawBytes: z.int().min(1),
      rawSha256: sha256,
      digestBytes: z.int().min(1),
      compressionRatio: z.number().min(0),
    }).strict()).min(1),
    validatedFix: z.object({
      attempted: z.boolean(),
      description: nonEmpty,
      verificationCommand: nonEmpty,
      verificationExitCode: z.int(),
      correctnessPassed: z.boolean(),
      baselineMetric: z.object({
        name: nonEmpty,
        unit: nonEmpty,
        median: z.number().positive(),
        samples: z.array(z.number().positive()).min(1),
      }).strict(),
      fixedMetric: z.object({
        name: nonEmpty,
        unit: nonEmpty,
        median: z.number().positive(),
        samples: z.array(z.number().positive()).min(1),
      }).strict(),
      speedupRatio: z.number().positive(),
    }).strict(),
    armPipelines: z.object({
      raw: z.object({
        payloadBytes: z.int().min(1),
        payloadTokensEst: z.int().min(1),
        orchestrationMs: z.number().min(0),
        mcpMs: z.literal(0),
        routingMs: z.literal(0),
        verificationMs: z.literal(0),
        resources: resourceSnapshotSchema,
      }).strict(),
      mcp_digest: z.object({
        payloadBytes: z.int().min(1),
        payloadTokensEst: z.int().min(1),
        orchestrationMs: z.number().min(0),
        mcpMs: z.number().min(0),
        routingMs: z.literal(0),
        verificationMs: z.literal(0),
        mcpSpawns: z.int().min(1),
        mcpCalls: z.int().min(1),
        mcpReusedCalls: z.int().min(0),
        resources: resourceSnapshotSchema,
      }).strict(),
      compact_evidence: z.object({
        verbosePayloadBytes: z.int().min(1),
        compactPayloadBytes: z.int().min(1),
        byteReductionPct: z.number(),
        payloadTokensEst: z.int().min(1),
        orchestrationMs: z.number().min(0),
        mcpMs: z.number().min(0),
        routingMs: z.number().min(0),
        verificationMs: z.number().min(0),
        mcpSpawns: z.int().min(1),
        mcpCalls: z.int().min(1),
        mcpReusedCalls: z.int().min(0),
        selectedReportId: nonEmpty,
        provenanceCount: z.int().min(1),
        verificationPassed: z.boolean(),
        resources: resourceSnapshotSchema,
      }).strict(),
    }).strict(),
    evaluations: z.array(multiModelEvaluationCellSchema).length(18),
  }).strict()).length(4),
  summary: z.object({
    totalStudies: z.literal(4),
    totalModels: z.literal(6),
    totalEvaluations: z.literal(72),
    totalClaudeApiCostUsd: z.number().min(0),
    perModelSummary: z.array(z.object({
      modelId: multiModelIdSchema,
      cli: z.enum(['agy', 'claude']),
      effort: z.enum(['high', 'max']),
      arms: z.record(multiModelArmSchema, z.object({
        meanAccuracyScore: z.number().min(0).max(1),
        totalChecksPassed: z.int().min(0),
        totalChecks: z.literal(20),
        totalFalseConclusions: z.int().min(0),
        meanCliStartupMs: z.number().min(0),
        meanModelFirstResponseMs: z.number().min(0),
        meanReasoningAndOutputStreamingMs: z.number().min(0),
        meanModelApiDurationMs: z.number().min(0),
        meanTotalE2eWallMs: z.number().min(0),
        meanInputTokens: z.number().min(0),
        meanOutputTokens: z.number().min(0),
        meanThinkingTokens: z.number().min(0),
        totalCostUsd: z.number().min(0).nullable(),
      }).strict()),
    }).strict()).length(6),
  }).strict(),
  claims: z.array(nonEmpty).min(1),
  limits: z.array(nonEmpty).min(1),
}).strict();


