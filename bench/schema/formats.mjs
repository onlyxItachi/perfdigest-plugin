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
  arm: z.enum(['A_codex_alone', 'B_codex_perfdigest_mcp', 'C_codex_perfdigest_evidence']),
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
    }).strict(),
  }).strict()).min(4),
  summary: z.object({
    totalStudies: z.int().min(4),
    meanAccuracyByArm: z.object({
      A_codex_alone: z.number().min(0).max(1),
      B_codex_perfdigest_mcp: z.number().min(0).max(1),
      C_codex_perfdigest_evidence: z.number().min(0).max(1),
    }).strict(),
    totalFalseConclusionsByArm: z.object({
      A_codex_alone: z.int().min(0),
      B_codex_perfdigest_mcp: z.int().min(0),
      C_codex_perfdigest_evidence: z.int().min(0),
    }).strict(),
    validatedSpeedups: z.record(z.string(), z.number().positive()),
  }).strict(),
  claims: z.array(nonEmpty).min(1),
  limits: z.array(nonEmpty).min(1),
}).strict();
