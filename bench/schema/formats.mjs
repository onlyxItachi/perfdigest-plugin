// Source of truth for the benchmark result + manifest formats (zod 4, already a
// production dependency). The committed JSON Schema files next to this module are
// GENERATED from these definitions by `node bench/schema/build-schema.mjs` so that
// non-JS consumers (e.g. PerfDigest-MCP-Bench's Python drivers) can validate the
// same documents without zod.
import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmpty = z.string().min(1);

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

export const cellSchema = z.object({
  id: nonEmpty,
  group: z.enum(['build', 'runtime', 'worker']),
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
  /** Median user / system CPU per repetition (GNU time). */
  cpu: z.object({ unit: z.literal('ms'), n: z.int().min(1), userMedian: z.number(), sysMedian: z.number() }).strict().optional(),
  peakRssKb: statsSchema.optional(),
  parity: paritySchema,
  extra: z.record(z.string(), z.unknown()).optional(),
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
  cells: z.array(cellSchema).min(1),
  /** What these numbers DO support. Keep each claim falsifiable and scoped to this host. */
  claims: z.array(nonEmpty),
  /** What these numbers do NOT support (generalization, noise, missing controls). Never empty. */
  limits: z.array(nonEmpty).min(1),
}).strict();

export const manifestCellSchema = z.object({
  id: nonEmpty,
  group: z.enum(['build', 'runtime', 'worker']),
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
