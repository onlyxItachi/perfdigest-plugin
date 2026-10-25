import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

export type CellExecutionStatus =
  | 'complete'
  | 'failed'
  | 'timed_out'
  | 'abstained'
  | 'invalid_incomplete';

export type ProviderExecutionMode =
  | 'none'
  | 'contract_fixture'
  | 'mock_loopback'
  | 'offline_simulation'
  | 'local_daemon'
  | 'live_hosted';

export type AgentExecutionMode =
  | 'none'
  | 'contract_fixture'
  | 'agentic_e2e'
  | 'reconciled_historical_agentic_e2e';

export type UsageReportingSemantics =
  | 'single_turn_only'
  | 'cumulative_session_trajectory'
  | 'incremental_per_turn'
  | 'unavailable';

export const MANDATORY_CELL_CSV_COLUMNS = [
  'run_id',
  'cell_id',
  'study_id',
  'arm',
  'model_id',
  'effort',
  'runner_version',
  'git_sha',
  'workload_sha256',
  'provider',
  'provider_execution_mode',
  'agent_execution_mode',
  'native_tools_enabled',
  'attempt',
  'retries',
  'status',
  'failure_or_invalid_reason',
  'grading_rubric_id',
  'checks_passed',
  'total_checks',
  'accuracy_pct',
  'verification_status',
  'start_monotonic_ms',
  'end_monotonic_ms',
  'e2e_wall_ms',
  'agent_session_wall_ms',
  'turn1_wall_ms',
  'turn2_wall_ms',
  'mcp_digest_wall_ms',
  'decision_latency_ms',
  'mcp_extraction_wall_ms',
  'evidence_worker_wall_ms',
  'verification_wall_ms',
  'evidence_delivery_latency_ms',
  'parallel_overlap_ms',
  'worker_ready_to_consumption_ms',
  'critical_path_wall_ms',
  'stage_sum_wall_ms',
  'service_api_duration_ms',
  'service_duration_semantics',
  'timing_unavailable_reason',
  'usage_reporting_semantics',
  'turn1_input_tokens',
  'turn2_reported_input_tokens',
  'turn2_incremental_input_tokens',
  'agent_input_tokens',
  'agent_uncached_input_tokens',
  'agent_cache_read_tokens',
  'agent_cache_creation_tokens',
  'agent_output_tokens',
  'agent_thinking_tokens',
  'usage_unavailable_reason',
  'decision_requests',
  'decision_input_tokens',
  'decision_output_tokens',
  'decision_model',
  'decision_provenance',
  'agent_cost_usd',
  'agent_cost_basis',
  'agent_cost_unavailable_reason',
  'decision_cost_usd',
  'decision_cost_basis',
  'decision_cost_unavailable_reason',
  'tool_calls_count',
  'turn1_tool_calls_count',
  'turn2_tool_calls_count',
  'source_trace_ref',
  'provenance_count',
  'evidence_delivery_mode',
  'same_session_observed',
  'in_execution_delivery_observed',
  'missing_observation_flags',
] as const;

export const MANDATORY_SUMMARY_CSV_COLUMNS = [
  'run_id',
  'model_id',
  'effort',
  'arm',
  'cells',
  'complete_cells',
  'failed_cells',
  'timed_out_cells',
  'abstained_cells',
  'invalid_incomplete_cells',
  'checks_passed',
  'total_checks',
  'accuracy_pct',
  'mean_e2e_wall_ms',
  'median_e2e_wall_ms',
  'p90_e2e_wall_ms',
  'mean_agent_input_tokens',
  'mean_agent_uncached_input_tokens',
  'mean_agent_cache_read_tokens',
  'mean_agent_output_tokens',
  'mean_agent_thinking_tokens',
  'mean_tool_calls',
  'mean_decision_requests',
  'mean_decision_latency_ms',
  'mean_evidence_worker_wall_ms',
  'mean_parallel_overlap_ms',
  'agent_cost_usd_total',
  'agent_cost_unavailable_reason',
  'decision_cost_usd_total',
  'decision_cost_unavailable_reason',
] as const;

/**
 * Closed set of pre-Issue-#18 historical benchmark artifacts preserved as immutable history.
 * Any new artifact in `bench/results/` outside this frozen list MUST be bound to and validated by
 * a `*-measurement-receipt.json` bundle.
 */
export const FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS = [
  'bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json',
  'bench/results/2026-10-18-lifecycle-and-orchestration.json',
  'bench/results/2026-10-18-mcp-session-reuse.json',
  'bench/results/2026-10-18-real-workload-evaluation.json',
  'bench/results/2026-10-24-multi-model-evaluation.json',
] as const;

/**
 * Pinned SHA-256 digests for all frozen historical benchmark artifacts in `bench/results/`.
 */
export const FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS_SHA256: Readonly<Record<string, string>> = {
  'bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json':
    '6260002be9b4e59af599067acf33dd1c4a9d3d263e7dae83650cb3b2eacfb5fb',
  'bench/results/2026-10-18-lifecycle-and-orchestration.json':
    'b3750be508572e42a0fb2d481571be35401e77b12e7d38dbfbe20f6e241389ef',
  'bench/results/2026-10-18-mcp-session-reuse.json':
    '55f81aa7c3f1244404586ff45ebf762d2c79f017d6051d7d9d6e7d7c18c63ce1',
  'bench/results/2026-10-18-real-workload-evaluation.json':
    'f83be9f8b58be5c9dbba6b2c092a7cd74749f6088a8e10f9adab4aae3d439980',
  'bench/results/2026-10-24-multi-model-evaluation.json':
    '4dd8331acd567bbdbc233cd7b0a2c39dc79bc27cf4f337c0c486e693bf6d71ec',
};

export interface BenchmarkMeasurementReceipt {
  schema: 'perfdigest.benchmark.measurement-receipt.v1';
  experimentId: string;
  generatedAtUtc: string;
  gitSha: string;
  runnerVersion: string;
  reconciledFromSourceArtifact: string | null;
  cellsCsvRef: string;
  summaryCsvRef: string;
  sourceTraceRef: string;
  /** Companion markdown narrative reports (`*.md`) bound to this receipt in the same directory. */
  auxiliaryArtifactRefs?: string[];
  sampleSize: {
    totalCells: number;
    completeCells: number;
    failedCells: number;
    timedOutCells: number;
    abstainedCells: number;
    invalidIncompleteCells: number;
  };
  models: Array<{
    modelId: string;
    effort: string;
  }>;
  arms: Array<'raw' | 'mcp_digest' | 'evidence'>;
  baselineParityVerified: boolean;
  nativeToolsEnabledInRawBaseline: boolean;
  oracleLeakageCheckPassed: boolean;
  limitations: string[];
}

export type IntegrityViolationCode =
  | 'missing_csv_column'
  | 'empty_csv'
  | 'invalid_status'
  | 'missing_critical_telemetry_on_complete_cell'
  | 'invalid_monotonic_interval'
  | 'invalid_stage_overlap_math'
  | 'service_duration_exceeds_wall_without_cumulative_explanation'
  | 'cumulative_session_token_double_count'
  | 'incremental_token_sum_mismatch'
  | 'zero_filled_unobserved_cost'
  | 'missing_cost_unavailable_reason'
  | 'mock_or_offline_mislabeled_as_live_hosted'
  | 'blinded_raw_baseline_native_tools_disabled'
  | 'rubric_mismatch_across_arms'
  | 'oracle_or_answer_leakage_detected'
  | 'unsanitized_path_or_secret_in_artifact'
  | 'summary_cell_count_mismatch'
  | 'summary_dropped_failed_or_abstained_trials'
  | 'summary_metric_reconciliation_mismatch'
  | 'invalid_measurement_receipt'
  | 'invalid_source_trace_format'
  | 'missing_or_unreadable_source_trace'
  | 'source_trace_cell_missing'
  | 'source_trace_identity_mismatch'
  | 'source_trace_telemetry_mismatch'
  | 'source_trace_provenance_mismatch'
  | 'untracked_or_receiptless_benchmark_artifact'
  | 'missing_historical_benchmark_artifact'
  | 'modified_historical_benchmark_artifact';

export interface IntegrityViolation {
  code: IntegrityViolationCode;
  message: string;
  rowOrRef?: string;
}

export interface BenchmarkIntegrityValidationResult {
  valid: boolean;
  violations: IntegrityViolation[];
  checkedCellsCount: number;
  checkedSummaryRowsCount: number;
}

export class BenchmarkIntegrityError extends Error {
  constructor(
    message: string,
    readonly violations: IntegrityViolation[],
  ) {
    super(
      `${message}: ${violations.map((v) => `[${v.code}] ${v.message}`).join('; ')}`,
    );
    this.name = 'BenchmarkIntegrityError';
  }
}

export interface ParsedCsvResult {
  headers: string[];
  rows: Array<Record<string, string>>;
  duplicateHeaders: string[];
  rowColumnCountMismatches: number[];
  unclosedQuote: boolean;
}

/**
 * RFC-4180-compliant CSV parser supporting multiline quoted strings, escaped quotes,
 * duplicate header detection, and per-row column-count validation.
 */
export function parseCsvRecords(csvContent: string): ParsedCsvResult {
  const normalized = csvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.trim().length === 0) {
    return {
      headers: [],
      rows: [],
      duplicateHeaders: [],
      rowColumnCountMismatches: [],
      unclosedQuote: false,
    };
  }

  const rawRecords: string[][] = [];
  let currentRecord: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          currentField += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRecord.push(currentField);
      currentField = '';
    } else if (ch === '\n') {
      currentRecord.push(currentField);
      currentField = '';
      if (currentRecord.length > 1 || (currentRecord.length === 1 && currentRecord[0]!.trim() !== '')) {
        rawRecords.push(currentRecord);
      }
      currentRecord = [];
    } else {
      currentField += ch;
    }
  }

  if (currentField.length > 0 || currentRecord.length > 0) {
    currentRecord.push(currentField);
    if (currentRecord.length > 1 || (currentRecord.length === 1 && currentRecord[0]!.trim() !== '')) {
      rawRecords.push(currentRecord);
    }
  }

  if (rawRecords.length === 0) {
    return {
      headers: [],
      rows: [],
      duplicateHeaders: [],
      rowColumnCountMismatches: [],
      unclosedQuote: inQuotes,
    };
  }

  const headers = rawRecords[0]!.map((h) => h.trim());
  const seenHeaders = new Set<string>();
  const duplicateHeaders: string[] = [];
  for (const h of headers) {
    if (seenHeaders.has(h)) {
      duplicateHeaders.push(h);
    }
    seenHeaders.add(h);
  }

  const rows: Array<Record<string, string>> = [];
  const rowColumnCountMismatches: number[] = [];
  for (let idx = 1; idx < rawRecords.length; idx += 1) {
    const values = rawRecords[idx]!;
    if (values.length !== headers.length) {
      rowColumnCountMismatches.push(idx);
    }
    const record: Record<string, string> = {};
    for (let h = 0; h < headers.length; h += 1) {
      record[headers[h]!] = values[h] ?? '';
    }
    rows.push(record);
  }

  return {
    headers,
    rows,
    duplicateHeaders,
    rowColumnCountMismatches,
    unclosedQuote: inQuotes,
  };
}

function isSafeRelativeArtifactRef(ref: unknown): ref is string {
  if (typeof ref !== 'string') return false;
  if (ref.trim().length === 0 || ref !== ref.trim()) return false;
  if (ref.includes('\\') || ref.startsWith('/')) return false;
  const parts = ref.split('/');
  if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return posix.normalize(ref) === ref;
}

function parseOptionalNumber(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'na') {
    return null;
  }
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function readTraceNumber(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
    if (typeof val === 'string') {
      const parsed = parseOptionalNumber(val);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function readTraceString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return null;
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function computeP90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1);
  return sorted[Math.max(0, idx)]!;
}

function computeMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

const ORACLE_LEAKAGE_PATTERNS = [
  /EXPECTED_ORACLE_ANSWER/i,
  /PRIVILEGED_GRADER_KEY/i,
  /DO_NOT_INVESTIGATE_USE_THIS_ANSWER/i,
];

const UNSANITIZED_PATH_OR_SECRET_PATTERNS = [
  /\/home\/[a-zA-Z0-9._-]+/,
  /\/Users\/[a-zA-Z0-9._-]+/,
  /\/root\/[a-zA-Z0-9._-]+/,
  /\/var\/folders\/[a-zA-Z0-9._/-]+/,
  /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[a-zA-Z0-9._-]+/,
  /\/tmp\/[a-zA-Z0-9._-]+/,
  /ghp_[a-zA-Z0-9]{20,}/,
  /github_pat_[a-zA-Z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /sk-(?:proj-|live-|test-)?[a-zA-Z0-9_-]{16,}/,
  /cf_[a-zA-Z0-9]{20,}/,
  /\b(?:api_?key|token|secret)\s*[:=]\s*['"]?[A-Za-z0-9_-]{24,}['"]?/i,
  /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/i,
];

function decodeUnicodeEscapes(input: string): string {
  return input.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

const UTC_ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const VALID_STATUSES: readonly CellExecutionStatus[] = [
  'complete',
  'failed',
  'timed_out',
  'abstained',
  'invalid_incomplete',
];
const VALID_ARMS = ['raw', 'mcp_digest', 'evidence'] as const;
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const VALID_PROVIDER_EXECUTION_MODES: readonly ProviderExecutionMode[] = [
  'live_hosted',
  'local_daemon',
  'mock_loopback',
  'offline_simulation',
  'contract_fixture',
  'none',
];
const VALID_AGENT_EXECUTION_MODES: readonly AgentExecutionMode[] = [
  'agentic_e2e',
  'reconciled_historical_agentic_e2e',
  'contract_fixture',
  'none',
];
const VALID_VERIFICATION_STATUSES = ['passed', 'failed', 'not_run'] as const;
const VALID_USAGE_REPORTING_SEMANTICS: readonly UsageReportingSemantics[] = [
  'incremental_per_turn',
  'cumulative_session_trajectory',
  'single_turn_only',
  'unavailable',
];

interface ParsedTraceBundle {
  cellsByKey: Map<string, Record<string, unknown>>;
  rawObjects: Array<Record<string, unknown>>;
  duplicateKeys: string[];
}

function parseMachineReadableTrace(
  traceRef: string,
  rawContent: string,
): { ok: true; trace: ParsedTraceBundle } | { ok: false; reason: string } {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    return { ok: false, reason: `Source trace "${traceRef}" is empty.` };
  }

  let cellObjects: Array<Record<string, unknown>> = [];
  if (traceRef.endsWith('.jsonl')) {
    try {
      const parsedLines = trimmed
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown);
      if (parsedLines.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
        return {
          ok: false,
          reason: `Source trace "${traceRef}" contains a non-object JSONL record.`,
        };
      }
      cellObjects = parsedLines as Array<Record<string, unknown>>;
    } catch (err) {
      return {
        ok: false,
        reason: `Source trace "${traceRef}" is not valid JSONL: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else if (traceRef.endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return {
        ok: false,
        reason: `Source trace "${traceRef}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (Array.isArray(parsed)) {
      cellObjects = parsed.filter(
        (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)),
      );
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.cells)) {
        cellObjects = obj.cells.filter(
          (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)),
        );
      } else if (Array.isArray(obj.reconciledCells)) {
        cellObjects = obj.reconciledCells.filter(
          (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)),
        );
      } else if (typeof obj.cell_id === 'string' || typeof obj.model_id === 'string') {
        cellObjects = [obj];
      }
    }
  } else {
    return {
      ok: false,
      reason: `Source trace "${traceRef}" must be a machine-readable .json or .jsonl file.`,
    };
  }

  if (cellObjects.length === 0) {
    return {
      ok: false,
      reason: `Source trace "${traceRef}" contains no machine-readable cell trace records.`,
    };
  }

  const cellsByKey = new Map<string, Record<string, unknown>>();
  const seenExplicitCellIds = new Set<string>();
  const seenCompositeIds = new Set<string>();
  const duplicateKeys: string[] = [];

  for (const item of cellObjects) {
    const explicitCellId = readTraceString(item, 'cell_id', 'cellId');
    const modelId = readTraceString(item, 'model_id', 'modelId');
    const effort = readTraceString(item, 'effort') ?? '';
    const studyId = readTraceString(item, 'study_id', 'studyId');
    const arm = readTraceString(item, 'arm');
    const attempt = readTraceNumber(item, 'attempt') ?? 1;

    if (explicitCellId) {
      if (seenExplicitCellIds.has(explicitCellId)) {
        duplicateKeys.push(explicitCellId);
      }
      seenExplicitCellIds.add(explicitCellId);
      cellsByKey.set(explicitCellId, item);
    }
    if (modelId && studyId && arm) {
      const fullCompositeId = `${modelId}__${effort}__${studyId}__${arm}__${attempt}`;
      if (seenCompositeIds.has(fullCompositeId)) {
        duplicateKeys.push(fullCompositeId);
      }
      seenCompositeIds.add(fullCompositeId);
      if (!cellsByKey.has(fullCompositeId)) {
        cellsByKey.set(fullCompositeId, item);
      }
      const shortCompositeId = `${modelId}__${studyId}__${arm}`;
      if (!cellsByKey.has(shortCompositeId)) {
        cellsByKey.set(shortCompositeId, item);
      }
    }
  }

  return { ok: true, trace: { cellsByKey, rawObjects: cellObjects, duplicateKeys } };
}

/**
 * Validates a complete benchmark integrity bundle (Per-Cell CSV, Summary CSV,
 * optional Source Trace map/text, and optional Measurement Receipt).
 */
export function validateBenchmarkIntegrityBundle(input: {
  cellsCsv: string;
  summaryCsv: string;
  sourceTraceText?: string;
  sourceTracesByRef?: Record<string, string | null | undefined>;
  requireSourceTraceVerification?: boolean;
  receipt?: BenchmarkMeasurementReceipt;
  promptsOrInputsToScanForLeakage?: string[];
}): BenchmarkIntegrityValidationResult {
  const violations: IntegrityViolation[] = [];

  const parsedCells = parseCsvRecords(input.cellsCsv);
  const parsedSummary = parseCsvRecords(input.summaryCsv);

  if (parsedCells.headers.length === 0 || parsedCells.rows.length === 0) {
    violations.push({
      code: 'empty_csv',
      message: 'Per-cell CSV is empty or has no data rows.',
    });
  }
  if (parsedSummary.headers.length === 0 || parsedSummary.rows.length === 0) {
    violations.push({
      code: 'empty_csv',
      message: 'Summary CSV is empty or has no data rows.',
    });
  }

  if (parsedCells.duplicateHeaders.length > 0) {
    violations.push({
      code: 'missing_csv_column',
      message: `Per-cell CSV contains duplicate column header(s): ${parsedCells.duplicateHeaders.join(', ')}.`,
    });
  }
  if (parsedSummary.duplicateHeaders.length > 0) {
    violations.push({
      code: 'missing_csv_column',
      message: `Summary CSV contains duplicate column header(s): ${parsedSummary.duplicateHeaders.join(', ')}.`,
    });
  }
  if (parsedCells.unclosedQuote || parsedCells.rowColumnCountMismatches.length > 0) {
    violations.push({
      code: 'missing_csv_column',
      message: `Per-cell CSV has malformed row(s) or column count mismatch at row(s) ${parsedCells.rowColumnCountMismatches.join(', ') || 'EOF'}.`,
    });
  }
  if (parsedSummary.unclosedQuote || parsedSummary.rowColumnCountMismatches.length > 0) {
    violations.push({
      code: 'missing_csv_column',
      message: `Summary CSV has malformed row(s) or column count mismatch at row(s) ${parsedSummary.rowColumnCountMismatches.join(', ') || 'EOF'}.`,
    });
  }

  for (const col of MANDATORY_CELL_CSV_COLUMNS) {
    if (!parsedCells.headers.includes(col)) {
      violations.push({
        code: 'missing_csv_column',
        message: `Per-cell CSV is missing mandatory column "${col}".`,
      });
    }
  }

  for (const col of MANDATORY_SUMMARY_CSV_COLUMNS) {
    if (!parsedSummary.headers.includes(col)) {
      violations.push({
        code: 'missing_csv_column',
        message: `Summary CSV is missing mandatory column "${col}".`,
      });
    }
  }

  // Build resolved map of sourceTracesByRef
  const tracesMap: Record<string, string | null | undefined> = {
    ...(input.sourceTracesByRef ?? {}),
  };
  if (input.sourceTraceText !== undefined && input.receipt?.sourceTraceRef) {
    if (tracesMap[input.receipt.sourceTraceRef] === undefined) {
      tracesMap[input.receipt.sourceTraceRef] = input.sourceTraceText;
    }
  }
  const verifyTraces =
    input.requireSourceTraceVerification ??
    (input.receipt !== undefined ||
      input.sourceTracesByRef !== undefined ||
      input.sourceTraceText !== undefined);

  // Scan CSVs, source traces, and receipt for unsanitized local paths or secrets
  const textsToCheckSanitization: Array<{ label: string; text: string }> = [
    { label: 'cellsCsv', text: input.cellsCsv },
    { label: 'summaryCsv', text: input.summaryCsv },
  ];
  if (input.sourceTraceText) {
    textsToCheckSanitization.push({ label: 'sourceTraceText', text: input.sourceTraceText });
  }
  for (const [ref, content] of Object.entries(tracesMap)) {
    if (typeof content === 'string') {
      textsToCheckSanitization.push({ label: `sourceTrace:${ref}`, text: content });
    }
  }
  if (input.receipt !== undefined) {
    textsToCheckSanitization.push({ label: 'receipt', text: JSON.stringify(input.receipt) });
  }
  for (const item of textsToCheckSanitization) {
    const decodedText = decodeUnicodeEscapes(item.text);
    for (const pattern of UNSANITIZED_PATH_OR_SECRET_PATTERNS) {
      if (pattern.test(item.text) || pattern.test(decodedText)) {
        violations.push({
          code: 'unsanitized_path_or_secret_in_artifact',
          message: `Unsanitized local path or secret matching ${pattern.toString()} found in ${item.label}.`,
          rowOrRef: item.label,
        });
      }
    }
  }

  if (input.promptsOrInputsToScanForLeakage) {
    for (const promptText of input.promptsOrInputsToScanForLeakage) {
      for (const pattern of ORACLE_LEAKAGE_PATTERNS) {
        if (pattern.test(promptText)) {
          violations.push({
            code: 'oracle_or_answer_leakage_detected',
            message: `Oracle or privileged grader answer leakage pattern ${pattern.toString()} detected in prompt/input.`,
          });
        }
      }
    }
  }

  // Pre-parse referenced source traces when trace verification is active
  const parsedTraceCache = new Map<string, ParsedTraceBundle | null>();
  if (verifyTraces) {
    const referencedTracePaths = new Set<string>();
    if (input.receipt?.sourceTraceRef) {
      referencedTracePaths.add(String(input.receipt.sourceTraceRef).trim());
    }
    for (const row of parsedCells.rows) {
      const ref = (row.source_trace_ref || '').trim();
      if (ref) {
        referencedTracePaths.add(ref);
      }
    }
    for (const ref of referencedTracePaths) {
      if (!isSafeRelativeArtifactRef(ref)) {
        violations.push({
          code: 'invalid_source_trace_format',
          message: `source_trace_ref "${ref}" must be a safe normalized relative path without "..", leading "/", or backslashes.`,
          rowOrRef: ref,
        });
        parsedTraceCache.set(ref, null);
        continue;
      }
      if (!ref.endsWith('.json') && !ref.endsWith('.jsonl')) {
        violations.push({
          code: 'invalid_source_trace_format',
          message: `source_trace_ref "${ref}" must reference a machine-readable .json or .jsonl trace artifact, not a prose/markdown document.`,
          rowOrRef: ref,
        });
        parsedTraceCache.set(ref, null);
        continue;
      }
      const rawContent = tracesMap[ref];
      if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
        violations.push({
          code: 'missing_or_unreadable_source_trace',
          message: `Referenced machine-readable source trace "${ref}" does not exist or was not provided.`,
          rowOrRef: ref,
        });
        parsedTraceCache.set(ref, null);
        continue;
      }
      const parsed = parseMachineReadableTrace(ref, rawContent);
      if (!parsed.ok) {
        violations.push({
          code: 'missing_or_unreadable_source_trace',
          message: parsed.reason,
          rowOrRef: ref,
        });
        parsedTraceCache.set(ref, null);
      } else {
        if (parsed.trace.duplicateKeys.length > 0) {
          violations.push({
            code: 'source_trace_identity_mismatch',
            message: `Source trace "${ref}" contains duplicate cell key(s): ${parsed.trace.duplicateKeys.join(', ')}.`,
            rowOrRef: ref,
          });
        }
        parsedTraceCache.set(ref, parsed.trace);
      }
    }
  }

  const studyRubrics = new Map<string, { rubricId: string; totalChecks: number }>();
  const seenCellIds = new Set<string>();
  const seenTrialCompositeKeys = new Set<string>();

  for (const row of parsedCells.rows) {
    const cellId = (row.cell_id || '').trim() || '<unknown_cell>';
    if (seenCellIds.has(cellId)) {
      violations.push({
        code: 'invalid_status',
        message: `Per-cell CSV contains duplicate cell_id "${cellId}".`,
        rowOrRef: cellId,
      });
    }
    seenCellIds.add(cellId);

    const trialCompositeKey = `${row.model_id || ''}__${row.effort || ''}__${row.study_id || ''}__${row.arm || ''}__${row.attempt || '1'}`;
    if (seenTrialCompositeKeys.has(trialCompositeKey)) {
      violations.push({
        code: 'invalid_status',
        message: `Per-cell CSV contains duplicate trial key "${trialCompositeKey}".`,
        rowOrRef: cellId,
      });
    }
    seenTrialCompositeKeys.add(trialCompositeKey);

    const status = row.status as CellExecutionStatus;
    if (!VALID_STATUSES.includes(status)) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has invalid status "${row.status}".`,
        rowOrRef: cellId,
      });
      continue;
    }

    // Per-cell enum validation
    if (!VALID_ARMS.includes(row.arm as (typeof VALID_ARMS)[number])) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has invalid arm "${row.arm}".`,
        rowOrRef: cellId,
      });
    }
    if (!VALID_EFFORTS.includes(row.effort as (typeof VALID_EFFORTS)[number])) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has invalid effort "${row.effort}".`,
        rowOrRef: cellId,
      });
    }
    if (!VALID_PROVIDER_EXECUTION_MODES.includes(row.provider_execution_mode as ProviderExecutionMode)) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has invalid provider_execution_mode "${row.provider_execution_mode}".`,
        rowOrRef: cellId,
      });
    }
    if (!VALID_AGENT_EXECUTION_MODES.includes(row.agent_execution_mode as AgentExecutionMode)) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has invalid agent_execution_mode "${row.agent_execution_mode}".`,
        rowOrRef: cellId,
      });
    }
    if (!VALID_VERIFICATION_STATUSES.includes(row.verification_status as (typeof VALID_VERIFICATION_STATUSES)[number])) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has invalid verification_status "${row.verification_status}".`,
        rowOrRef: cellId,
      });
    }
    if (!VALID_USAGE_REPORTING_SEMANTICS.includes(row.usage_reporting_semantics as UsageReportingSemantics)) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has invalid usage_reporting_semantics "${row.usage_reporting_semantics}".`,
        rowOrRef: cellId,
      });
    }
    if (row.native_tools_enabled !== 'true' && row.native_tools_enabled !== 'false') {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has invalid native_tools_enabled "${row.native_tools_enabled}" (must be "true" or "false").`,
        rowOrRef: cellId,
      });
    }

    // Per-cell checks_passed, total_checks, and accuracy_pct consistency
    const checksPassed = parseOptionalNumber(row.checks_passed);
    const totalChecks = parseOptionalNumber(row.total_checks);
    const accuracyPct = parseOptionalNumber(row.accuracy_pct);
    if (
      checksPassed === null ||
      totalChecks === null ||
      accuracyPct === null ||
      totalChecks <= 0 ||
      checksPassed < 0 ||
      checksPassed > totalChecks ||
      Math.abs(accuracyPct - (checksPassed / totalChecks) * 100) > 0.5
    ) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has invalid grading check math: checks_passed=${row.checks_passed}, total_checks=${row.total_checks}, accuracy_pct=${row.accuracy_pct}.`,
        rowOrRef: cellId,
      });
    }

    // Non-complete cells must record a reason
    if (status !== 'complete' && (!row.failure_or_invalid_reason || row.failure_or_invalid_reason.trim() === '')) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has status "${status}" but empty failure_or_invalid_reason.`,
        rowOrRef: cellId,
      });
    }

    // Fair baseline check: raw arm in agentic_e2e must have native_tools_enabled === 'true'
    const agentMode = row.agent_execution_mode as AgentExecutionMode;
    if (
      row.arm === 'raw' &&
      (agentMode === 'agentic_e2e' || agentMode === 'reconciled_historical_agentic_e2e') &&
      row.native_tools_enabled !== 'true'
    ) {
      violations.push({
        code: 'blinded_raw_baseline_native_tools_disabled',
        message: `Cell "${cellId}" is a raw baseline in ${agentMode} mode with native_tools_enabled="${row.native_tools_enabled}". Blinding native tools in raw baseline is forbidden.`,
        rowOrRef: cellId,
      });
    }

    // Rubric parity across arms for the same study_id
    const studyId = row.study_id;
    const rubricId = row.grading_rubric_id;
    if (studyId && rubricId && totalChecks !== null) {
      const existing = studyRubrics.get(studyId);
      if (!existing) {
        studyRubrics.set(studyId, { rubricId, totalChecks });
      } else if (existing.rubricId !== rubricId || existing.totalChecks !== totalChecks) {
        violations.push({
          code: 'rubric_mismatch_across_arms',
          message: `Cell "${cellId}" in study "${studyId}" uses rubric (${rubricId}, total_checks=${totalChecks}) which differs from (${existing.rubricId}, total_checks=${existing.totalChecks}).`,
          rowOrRef: cellId,
        });
      }
    }

    // Provider truth check: mock_loopback / offline_simulation must not claim live_hosted provenance
    const providerMode = row.provider_execution_mode as ProviderExecutionMode;
    const decisionProvenance = (row.decision_provenance || '').toLowerCase();
    if (
      (providerMode === 'mock_loopback' || providerMode === 'offline_simulation' || providerMode === 'contract_fixture') &&
      (decisionProvenance.includes('live_hosted') || decisionProvenance.includes('hosted_cloudflare_live'))
    ) {
      violations.push({
        code: 'mock_or_offline_mislabeled_as_live_hosted',
        message: `Cell "${cellId}" has provider_execution_mode="${providerMode}" but claims live hosted provenance "${row.decision_provenance}".`,
        rowOrRef: cellId,
      });
    }
    if (
      providerMode === 'live_hosted' &&
      (decisionProvenance.includes('mock') || decisionProvenance.includes('loopback') || decisionProvenance.includes('offline'))
    ) {
      violations.push({
        code: 'mock_or_offline_mislabeled_as_live_hosted',
        message: `Cell "${cellId}" claims provider_execution_mode="live_hosted" while decision_provenance="${row.decision_provenance}" indicates mock/loopback/offline.`,
        rowOrRef: cellId,
      });
    }

    // Symmetric cost honesty & non-negativity checks (`null` != `0.0`)
    const agentCostUsd = parseOptionalNumber(row.agent_cost_usd);
    const agentCostBasis = (row.agent_cost_basis || '').trim();
    const agentCostReason = (row.agent_cost_unavailable_reason || '').trim();
    if (agentCostUsd === null) {
      if (!agentCostReason) {
        violations.push({
          code: 'missing_cost_unavailable_reason',
          message: `Cell "${cellId}" has null/empty agent_cost_usd but no agent_cost_unavailable_reason.`,
          rowOrRef: cellId,
        });
      }
    } else if (agentCostUsd < 0) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has negative agent_cost_usd=${agentCostUsd}.`,
        rowOrRef: cellId,
      });
    } else if (
      agentCostUsd === 0 &&
      (agentCostBasis === 'unreported_subscription_or_quota' ||
        agentCostBasis === 'unavailable' ||
        agentCostBasis === 'none' ||
        agentCostReason !== '')
    ) {
      violations.push({
        code: 'zero_filled_unobserved_cost',
        message: `Cell "${cellId}" zero-filled agent_cost_usd=0 despite unobserved billing basis "${agentCostBasis}" or reason "${agentCostReason}". Unobserved cost must be null/empty, never 0.`,
        rowOrRef: cellId,
      });
    }

    const decisionCostUsd = parseOptionalNumber(row.decision_cost_usd);
    const decisionCostBasis = (row.decision_cost_basis || '').trim();
    const decisionCostReason = (row.decision_cost_unavailable_reason || '').trim();
    if (decisionCostUsd === null) {
      if (!decisionCostReason) {
        violations.push({
          code: 'missing_cost_unavailable_reason',
          message: `Cell "${cellId}" has null/empty decision_cost_usd but no decision_cost_unavailable_reason.`,
          rowOrRef: cellId,
        });
      }
    } else if (decisionCostUsd < 0) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has negative decision_cost_usd=${decisionCostUsd}.`,
        rowOrRef: cellId,
      });
    } else if (
      decisionCostUsd === 0 &&
      (decisionCostBasis === 'unreported_subscription_or_quota' ||
        decisionCostBasis === 'unavailable' ||
        decisionCostBasis === 'none' ||
        decisionCostReason !== '')
    ) {
      violations.push({
        code: 'zero_filled_unobserved_cost',
        message: `Cell "${cellId}" zero-filled decision_cost_usd=0 despite unobserved billing basis "${decisionCostBasis}" or reason "${decisionCostReason}". Unobserved cost must be null/empty, never 0.`,
        rowOrRef: cellId,
      });
    }

    // Complete cells must have timing, usage, and source trace telemetry
    const startMs = parseOptionalNumber(row.start_monotonic_ms);
    const endMs = parseOptionalNumber(row.end_monotonic_ms);
    const e2eMs = parseOptionalNumber(row.e2e_wall_ms);
    const agentInputTokens = parseOptionalNumber(row.agent_input_tokens);
    const agentOutputTokens = parseOptionalNumber(row.agent_output_tokens);
    const sourceTraceRef = (row.source_trace_ref || '').trim();

    if (status === 'complete') {
      if (
        startMs === null ||
        endMs === null ||
        e2eMs === null ||
        e2eMs <= 0 ||
        agentInputTokens === null ||
        agentOutputTokens === null ||
        row.usage_reporting_semantics === 'unavailable' ||
        !sourceTraceRef
      ) {
        violations.push({
          code: 'missing_critical_telemetry_on_complete_cell',
          message: `Cell "${cellId}" is marked "complete" but is missing critical timing, token usage, or source_trace_ref telemetry.`,
          rowOrRef: cellId,
        });
      }
    }

    if (verifyTraces && !sourceTraceRef) {
      violations.push({
        code: 'missing_or_unreadable_source_trace',
        message: `Cell "${cellId}" has an empty source_trace_ref while source trace verification is required.`,
        rowOrRef: cellId,
      });
    }

    // Verify cell against its machine-readable source trace when trace verification is active
    if (verifyTraces && sourceTraceRef) {
      const parsedTrace = parsedTraceCache.get(sourceTraceRef);
      if (parsedTrace) {
        const fullCompositeKey = `${row.model_id || ''}__${row.effort || ''}__${row.study_id || ''}__${row.arm || ''}__${row.attempt || '1'}`;
        const shortCompositeKey = `${row.model_id || ''}__${row.study_id || ''}__${row.arm || ''}`;
        const traceCell =
          parsedTrace.cellsByKey.get(cellId) ??
          parsedTrace.cellsByKey.get(fullCompositeKey) ??
          parsedTrace.cellsByKey.get(shortCompositeKey);
        if (!traceCell) {
          violations.push({
            code: 'source_trace_cell_missing',
            message: `Cell "${cellId}" is not present in its declared source_trace_ref "${sourceTraceRef}".`,
            rowOrRef: cellId,
          });
        } else {
          // 1. Mandatory non-empty identity fields
          const traceCellId = readTraceString(traceCell, 'cell_id', 'cellId');
          const traceModelId = readTraceString(traceCell, 'model_id', 'modelId');
          const traceStudyId = readTraceString(traceCell, 'study_id', 'studyId');
          const traceArm = readTraceString(traceCell, 'arm');
          const traceStatus = readTraceString(traceCell, 'status');
          if (
            !traceCellId ||
            traceCellId !== cellId ||
            !traceModelId ||
            traceModelId !== row.model_id ||
            !traceStudyId ||
            traceStudyId !== row.study_id ||
            !traceArm ||
            traceArm !== row.arm ||
            !traceStatus ||
            traceStatus !== row.status
          ) {
            violations.push({
              code: 'source_trace_identity_mismatch',
              message: `Cell "${cellId}" identity (${cellId}/${row.model_id}/${row.study_id}/${row.arm}/${row.status}) is missing or mismatched in trace record (${traceCellId}/${traceModelId}/${traceStudyId}/${traceArm}/${traceStatus}).`,
              rowOrRef: cellId,
            });
          }

          // 2. Mandatory provenance fields on every cell
          const traceWorkloadSha = readTraceString(traceCell, 'workload_sha256', 'workloadSha256');
          const rowProvCount = parseOptionalNumber(row.provenance_count);
          const traceProvCount = readTraceNumber(traceCell, 'provenance_count', 'provenanceCount');
          if (
            !traceWorkloadSha ||
            !row.workload_sha256 ||
            traceWorkloadSha !== row.workload_sha256 ||
            rowProvCount === null ||
            traceProvCount === null ||
            rowProvCount !== traceProvCount
          ) {
            violations.push({
              code: 'source_trace_provenance_mismatch',
              message: `Cell "${cellId}" provenance (workload_sha256=${row.workload_sha256}, provenance_count=${rowProvCount}) is missing or mismatched in source trace (workload_sha256=${traceWorkloadSha}, provenance_count=${traceProvCount}).`,
              rowOrRef: cellId,
            });
          }

          // 3. Mandatory decision_requests on every cell
          const rowDecisionReqs = parseOptionalNumber(row.decision_requests);
          const traceDecisionReqs = readTraceNumber(
            traceCell,
            'decision_requests',
            'clef_requests',
            'decisionRequests',
          );
          if (
            rowDecisionReqs === null ||
            traceDecisionReqs === null ||
            rowDecisionReqs !== traceDecisionReqs
          ) {
            violations.push({
              code: 'source_trace_telemetry_mismatch',
              message: `Cell "${cellId}" decision_requests (${rowDecisionReqs}) is missing or mismatched in source trace (${traceDecisionReqs}).`,
              rowOrRef: cellId,
            });
          }

          // 4. Mandatory timing, tokens, and checks_passed on complete/observed cells
          const traceE2eMs = readTraceNumber(traceCell, 'e2e_wall_ms', 'e2eWallMs', 'wallMs');
          if (status === 'complete' || e2eMs !== null) {
            if (e2eMs === null || traceE2eMs === null || Math.abs(e2eMs - traceE2eMs) > 1.5) {
              violations.push({
                code: 'source_trace_telemetry_mismatch',
                message: `Cell "${cellId}" e2e_wall_ms (${e2eMs}) is missing or mismatched in source trace (${traceE2eMs}).`,
                rowOrRef: cellId,
              });
            }
          }

          const traceInputTokens = readTraceNumber(
            traceCell,
            'reconciled_total_input_tokens',
            'agent_input_tokens',
            'agentInputTokens',
          );
          if (status === 'complete' || agentInputTokens !== null) {
            if (
              agentInputTokens === null ||
              traceInputTokens === null ||
              Math.abs(agentInputTokens - traceInputTokens) > 1
            ) {
              violations.push({
                code: 'source_trace_telemetry_mismatch',
                message: `Cell "${cellId}" agent_input_tokens (${agentInputTokens}) is missing or mismatched in source trace (${traceInputTokens}).`,
                rowOrRef: cellId,
              });
            }
          }

          const traceOutputTokens = readTraceNumber(
            traceCell,
            'reconciled_total_output_tokens',
            'agent_output_tokens',
            'agentOutputTokens',
          );
          if (status === 'complete' || agentOutputTokens !== null) {
            if (
              agentOutputTokens === null ||
              traceOutputTokens === null ||
              Math.abs(agentOutputTokens - traceOutputTokens) > 1
            ) {
              violations.push({
                code: 'source_trace_telemetry_mismatch',
                message: `Cell "${cellId}" agent_output_tokens (${agentOutputTokens}) is missing or mismatched in source trace (${traceOutputTokens}).`,
                rowOrRef: cellId,
              });
            }
          }

          const traceChecksPassed = readTraceNumber(traceCell, 'checks_passed', 'checksPassed');
          if (status === 'complete' || checksPassed !== null) {
            if (
              checksPassed === null ||
              traceChecksPassed === null ||
              checksPassed !== traceChecksPassed
            ) {
              violations.push({
                code: 'source_trace_telemetry_mismatch',
                message: `Cell "${cellId}" checks_passed (${checksPassed}) is missing or mismatched in source trace (${traceChecksPassed}).`,
                rowOrRef: cellId,
              });
            }
          }

          // 5. Mandatory non-empty events[] on complete cells, plus timestamp & monotonicity validation
          if (status === 'complete' && (!Array.isArray(traceCell.events) || traceCell.events.length < 2)) {
            violations.push({
              code: 'source_trace_telemetry_mismatch',
              message: `Cell "${cellId}" has status="complete" but is missing a multi-event (>= 2) events array in its source trace.`,
              rowOrRef: cellId,
            });
          } else if (traceCell.events !== undefined && !Array.isArray(traceCell.events)) {
            violations.push({
              code: 'source_trace_telemetry_mismatch',
              message: `Cell "${cellId}" has a non-array events field in its source trace.`,
              rowOrRef: cellId,
            });
          } else if (Array.isArray(traceCell.events)) {
            let prevElapsed = -1;
            let prevUtcMs = -1;
            let maxElapsed = 0;
            let eventListValid = true;
            for (const rawEv of traceCell.events) {
              if (!rawEv || typeof rawEv !== 'object' || Array.isArray(rawEv)) {
                violations.push({
                  code: 'source_trace_telemetry_mismatch',
                  message: `Cell "${cellId}" source trace contains a non-object event entry.`,
                  rowOrRef: cellId,
                });
                eventListValid = false;
                break;
              }
              const ev = rawEv as Record<string, unknown>;
              const evName = readTraceString(ev, 'event', 'type', 'name');
              const el = readTraceNumber(ev, 'elapsedMs', 'elapsed_ms', 'monotonicMs', 'monotonic_ms');
              const utcIso = readTraceString(ev, 'utcIso', 'utc_iso', 'timestamp');
              const utcMs = utcIso ? Date.parse(utcIso) : NaN;
              if (
                !evName ||
                el === null ||
                el < 0 ||
                !utcIso ||
                !UTC_ISO_TIMESTAMP_REGEX.test(utcIso) ||
                !Number.isFinite(utcMs)
              ) {
                violations.push({
                  code: 'source_trace_telemetry_mismatch',
                  message: `Cell "${cellId}" source trace event is missing a valid event name, non-negative elapsedMs/monotonicMs, or UTC ISO-8601 utcIso timestamp.`,
                  rowOrRef: cellId,
                });
                eventListValid = false;
                break;
              }
              if (el + 0.05 < prevElapsed || (prevUtcMs >= 0 && utcMs + 5 < prevUtcMs)) {
                violations.push({
                  code: 'source_trace_telemetry_mismatch',
                  message: `Cell "${cellId}" source trace has non-monotonic event timestamps (elapsedMs ${el} vs ${prevElapsed}, or utcIso regression).`,
                  rowOrRef: cellId,
                });
                eventListValid = false;
                break;
              }
              prevElapsed = el;
              prevUtcMs = utcMs;
              if (el > maxElapsed) {
                maxElapsed = el;
              }
            }
            if (
              eventListValid &&
              status === 'complete' &&
              e2eMs !== null &&
              Math.abs(maxElapsed - e2eMs) > Math.max(1500, e2eMs * 0.25)
            ) {
              violations.push({
                code: 'source_trace_telemetry_mismatch',
                message: `Cell "${cellId}" source trace max event elapsedMs (${maxElapsed}) does not align with cell e2e_wall_ms (${e2eMs}).`,
                rowOrRef: cellId,
              });
            }
          }
        }
      }
    }

    // Monotonic interval consistency
    if (startMs !== null && endMs !== null && e2eMs !== null) {
      const expectedE2e = endMs - startMs;
      if (endMs < startMs || Math.abs(expectedE2e - e2eMs) > 1.5) {
        violations.push({
          code: 'invalid_monotonic_interval',
          message: `Cell "${cellId}" has e2e_wall_ms=${e2eMs} which does not match end_monotonic_ms - start_monotonic_ms (${endMs} - ${startMs} = ${expectedE2e}).`,
          rowOrRef: cellId,
        });
      }
    }

    // Stage sum, parallel overlap, and critical path consistency
    const stageSumMs = parseOptionalNumber(row.stage_sum_wall_ms);
    const overlapMs = parseOptionalNumber(row.parallel_overlap_ms);
    const criticalPathMs = parseOptionalNumber(row.critical_path_wall_ms);
    if (stageSumMs !== null && overlapMs !== null && criticalPathMs !== null && e2eMs !== null) {
      const expectedCritical = stageSumMs - overlapMs;
      if (overlapMs < -0.5 || Math.abs(expectedCritical - criticalPathMs) > 2.0 || criticalPathMs > e2eMs + 2.0) {
        violations.push({
          code: 'invalid_stage_overlap_math',
          message: `Cell "${cellId}" has inconsistent stage/overlap math: stage_sum_wall_ms=${stageSumMs}, parallel_overlap_ms=${overlapMs}, critical_path_wall_ms=${criticalPathMs}, e2e_wall_ms=${e2eMs}.`,
          rowOrRef: cellId,
        });
      }
    }

    // Service API duration vs E2E wall check
    const serviceDurationMs = parseOptionalNumber(row.service_api_duration_ms);
    const serviceSemantics = (row.service_duration_semantics || '').trim();
    if (serviceDurationMs !== null && e2eMs !== null && serviceDurationMs > e2eMs + 50) {
      if (serviceSemantics !== 'cumulative_session_trajectory_reconciled') {
        violations.push({
          code: 'service_duration_exceeds_wall_without_cumulative_explanation',
          message: `Cell "${cellId}" reports service_api_duration_ms=${serviceDurationMs} > e2e_wall_ms=${e2eMs} without service_duration_semantics="cumulative_session_trajectory_reconciled".`,
          rowOrRef: cellId,
        });
      }
    }

    // Multi-turn usage reconciliation check
    const usageSemantics = row.usage_reporting_semantics as UsageReportingSemantics;
    const t1Input = parseOptionalNumber(row.turn1_input_tokens);
    const t2Reported = parseOptionalNumber(row.turn2_reported_input_tokens);
    const t2Incremental = parseOptionalNumber(row.turn2_incremental_input_tokens);
    if (
      usageSemantics === 'cumulative_session_trajectory' &&
      t1Input !== null &&
      t2Reported !== null &&
      t2Incremental !== null &&
      agentInputTokens !== null
    ) {
      if (t1Input > 0 && t2Reported >= t1Input && agentInputTokens === t1Input + t2Reported) {
        violations.push({
          code: 'cumulative_session_token_double_count',
          message: `Cell "${cellId}" summed Turn 1 (${t1Input}) + Turn 2 cumulative reported (${t2Reported}) = ${agentInputTokens}, double-counting Turn 1 tokens under cumulative_session_trajectory semantics.`,
          rowOrRef: cellId,
        });
      }
      const expectedTotal = t1Input + t2Incremental;
      if (Math.abs(agentInputTokens - expectedTotal) > 1) {
        violations.push({
          code: 'incremental_token_sum_mismatch',
          message: `Cell "${cellId}" agent_input_tokens (${agentInputTokens}) does not equal turn1_input_tokens (${t1Input}) + turn2_incremental_input_tokens (${t2Incremental}) = ${expectedTotal}.`,
          rowOrRef: cellId,
        });
      }
    }
  }

  // Reconcile Summary CSV against Per-Cell CSV
  if (parsedCells.rows.length > 0 && parsedSummary.rows.length > 0) {
    const expectedCellGroups = new Set<string>(
      parsedCells.rows.map((r) => `${r.model_id || ''}|${r.effort || ''}|${r.arm || ''}`),
    );
    const seenSummaryGroups = new Set<string>();

    for (const summaryRow of parsedSummary.rows) {
      const modelId = summaryRow.model_id || '';
      const effort = summaryRow.effort || '';
      const arm = summaryRow.arm || '';
      const groupKey = `${modelId}|${effort}|${arm}`;

      if (seenSummaryGroups.has(groupKey)) {
        violations.push({
          code: 'summary_cell_count_mismatch',
          message: `Summary CSV contains duplicate row for group "${groupKey}".`,
          rowOrRef: groupKey,
        });
      }
      seenSummaryGroups.add(groupKey);

      const matchingCells = parsedCells.rows.filter(
        (r) => r.model_id === modelId && r.effort === effort && r.arm === arm,
      );

      if (matchingCells.length === 0 || !expectedCellGroups.has(groupKey)) {
        violations.push({
          code: 'summary_cell_count_mismatch',
          message: `Summary row "${groupKey}" references a group with 0 matching rows in per-cell CSV.`,
          rowOrRef: groupKey,
        });
        continue;
      }

      const reportedCells = parseOptionalNumber(summaryRow.cells) ?? -1;
      const completeCount = matchingCells.filter((r) => r.status === 'complete').length;
      const failedCount = matchingCells.filter((r) => r.status === 'failed').length;
      const timedOutCount = matchingCells.filter((r) => r.status === 'timed_out').length;
      const abstainedCount = matchingCells.filter((r) => r.status === 'abstained').length;
      const invalidCount = matchingCells.filter((r) => r.status === 'invalid_incomplete').length;

      if (reportedCells !== matchingCells.length) {
        const nonComplete = failedCount + timedOutCount + abstainedCount + invalidCount;
        if (nonComplete > 0 && reportedCells === completeCount) {
          violations.push({
            code: 'summary_dropped_failed_or_abstained_trials',
            message: `Summary row "${groupKey}" reports cells=${reportedCells} (only complete cells) and dropped ${nonComplete} failed/timed_out/abstained/invalid trial(s) present in per-cell CSV.`,
            rowOrRef: groupKey,
          });
        } else {
          violations.push({
            code: 'summary_cell_count_mismatch',
            message: `Summary row "${groupKey}" reports cells=${reportedCells} but per-cell CSV has ${matchingCells.length} rows.`,
            rowOrRef: groupKey,
          });
        }
        continue;
      }

      const repComplete = parseOptionalNumber(summaryRow.complete_cells) ?? -1;
      const repFailed = parseOptionalNumber(summaryRow.failed_cells) ?? -1;
      const repTimedOut = parseOptionalNumber(summaryRow.timed_out_cells) ?? -1;
      const repAbstained = parseOptionalNumber(summaryRow.abstained_cells) ?? -1;
      const repInvalid = parseOptionalNumber(summaryRow.invalid_incomplete_cells) ?? -1;

      if (
        repComplete !== completeCount ||
        repFailed !== failedCount ||
        repTimedOut !== timedOutCount ||
        repAbstained !== abstainedCount ||
        repInvalid !== invalidCount
      ) {
        violations.push({
          code: 'summary_cell_count_mismatch',
          message: `Summary row "${groupKey}" status breakdown (${repComplete}/${repFailed}/${repTimedOut}/${repAbstained}/${repInvalid}) does not match per-cell counts (${completeCount}/${failedCount}/${timedOutCount}/${abstainedCount}/${invalidCount}).`,
          rowOrRef: groupKey,
        });
      }

      // Check checks_passed, total_checks, accuracy_pct across all cells in group
      const sumChecksPassed = matchingCells.reduce(
        (acc, r) => acc + (parseOptionalNumber(r.checks_passed) ?? 0),
        0,
      );
      const sumTotalChecks = matchingCells.reduce(
        (acc, r) => acc + (parseOptionalNumber(r.total_checks) ?? 0),
        0,
      );
      const expectedAccuracyPct = sumTotalChecks > 0 ? (sumChecksPassed / sumTotalChecks) * 100 : 0;

      const repChecksPassed = parseOptionalNumber(summaryRow.checks_passed) ?? -1;
      const repTotalChecks = parseOptionalNumber(summaryRow.total_checks) ?? -1;
      const repAccuracyPct = parseOptionalNumber(summaryRow.accuracy_pct) ?? -1;

      if (
        repChecksPassed !== sumChecksPassed ||
        repTotalChecks !== sumTotalChecks ||
        Math.abs(repAccuracyPct - expectedAccuracyPct) > 0.2
      ) {
        violations.push({
          code: 'summary_metric_reconciliation_mismatch',
          message: `Summary row "${groupKey}" accuracy metrics (${repChecksPassed}/${repTotalChecks} = ${repAccuracyPct}%) do not match per-cell sum (${sumChecksPassed}/${sumTotalChecks} = ${expectedAccuracyPct.toFixed(1)}%).`,
          rowOrRef: groupKey,
        });
      }

      // Reconcile E2E latency stats (mean, median, p90)
      const e2eValues = matchingCells
        .map((r) => parseOptionalNumber(r.e2e_wall_ms))
        .filter((v): v is number => v !== null);
      const repMeanE2e = parseOptionalNumber(summaryRow.mean_e2e_wall_ms);
      const repMedianE2e = parseOptionalNumber(summaryRow.median_e2e_wall_ms);
      const repP90E2e = parseOptionalNumber(summaryRow.p90_e2e_wall_ms);
      if (e2eValues.length > 0) {
        const expectedMeanE2e = computeMean(e2eValues);
        const expectedMedianE2e = computeMedian(e2eValues);
        const expectedP90E2e = computeP90(e2eValues);
        if (
          repMeanE2e === null ||
          Math.abs(repMeanE2e - expectedMeanE2e) > 1.0 ||
          repMedianE2e === null ||
          Math.abs(repMedianE2e - expectedMedianE2e) > 1.0 ||
          repP90E2e === null ||
          Math.abs(repP90E2e - expectedP90E2e) > 1.0
        ) {
          violations.push({
            code: 'summary_metric_reconciliation_mismatch',
            message: `Summary row "${groupKey}" E2E latency stats (${repMeanE2e}/${repMedianE2e}/${repP90E2e}) do not reconcile with per-cell values (${expectedMeanE2e.toFixed(1)}/${expectedMedianE2e.toFixed(1)}/${expectedP90E2e.toFixed(1)}).`,
            rowOrRef: groupKey,
          });
        }
      } else if (repMeanE2e !== null || repMedianE2e !== null || repP90E2e !== null) {
        violations.push({
          code: 'summary_metric_reconciliation_mismatch',
          message: `Summary row "${groupKey}" reports non-null E2E latency stats (${repMeanE2e}/${repMedianE2e}/${repP90E2e}) when no per-cell e2e_wall_ms values were observed.`,
          rowOrRef: groupKey,
        });
      }

      // Reconcile all remaining mean_* numeric columns
      const meanColumnPairs: ReadonlyArray<readonly [string, string]> = [
        ['mean_agent_input_tokens', 'agent_input_tokens'],
        ['mean_agent_uncached_input_tokens', 'agent_uncached_input_tokens'],
        ['mean_agent_cache_read_tokens', 'agent_cache_read_tokens'],
        ['mean_agent_output_tokens', 'agent_output_tokens'],
        ['mean_agent_thinking_tokens', 'agent_thinking_tokens'],
        ['mean_tool_calls', 'tool_calls_count'],
        ['mean_decision_requests', 'decision_requests'],
        ['mean_decision_latency_ms', 'decision_latency_ms'],
        ['mean_evidence_worker_wall_ms', 'evidence_worker_wall_ms'],
        ['mean_parallel_overlap_ms', 'parallel_overlap_ms'],
      ];
      for (const [summaryCol, cellCol] of meanColumnPairs) {
        const cellVals = matchingCells
          .map((r) => parseOptionalNumber(r[cellCol]))
          .filter((v): v is number => v !== null);
        const repMean = parseOptionalNumber(summaryRow[summaryCol]);
        if (cellVals.length > 0) {
          const expectedMean = computeMean(cellVals);
          const tol = Math.max(0.1, Math.min(1.0, Math.abs(expectedMean) * 0.02));
          if (repMean === null || Math.abs(repMean - expectedMean) > tol) {
            violations.push({
              code: 'summary_metric_reconciliation_mismatch',
              message: `Summary row "${groupKey}" ${summaryCol} (${repMean}) does not reconcile with per-cell ${cellCol} mean (${expectedMean.toFixed(2)}).`,
              rowOrRef: groupKey,
            });
          }
        } else if (repMean !== null) {
          violations.push({
            code: 'summary_metric_reconciliation_mismatch',
            message: `Summary row "${groupKey}" reports non-null ${summaryCol}=${repMean} when no per-cell ${cellCol} values were observed.`,
            rowOrRef: groupKey,
          });
        }
      }

      // Reconcile agent_cost_usd_total and decision_cost_usd_total
      const agentCostVals = matchingCells
        .map((r) => parseOptionalNumber(r.agent_cost_usd))
        .filter((v): v is number => v !== null);
      const repAgentCostTotal = parseOptionalNumber(summaryRow.agent_cost_usd_total);
      const repAgentCostReason = (summaryRow.agent_cost_unavailable_reason || '').trim();
      if (agentCostVals.length > 0) {
        const expectedTotal = agentCostVals.reduce((acc, v) => acc + v, 0);
        if (repAgentCostTotal === null || Math.abs(repAgentCostTotal - expectedTotal) > 0.001) {
          violations.push({
            code: 'summary_metric_reconciliation_mismatch',
            message: `Summary row "${groupKey}" agent_cost_usd_total (${repAgentCostTotal}) does not match per-cell sum (${expectedTotal.toFixed(4)}).`,
            rowOrRef: groupKey,
          });
        }
      } else {
        if (repAgentCostTotal !== null) {
          violations.push({
            code: 'summary_metric_reconciliation_mismatch',
            message: `Summary row "${groupKey}" reports agent_cost_usd_total=${repAgentCostTotal} when all per-cell agent_cost_usd values are null.`,
            rowOrRef: groupKey,
          });
        }
        if (!repAgentCostReason) {
          violations.push({
            code: 'missing_cost_unavailable_reason',
            message: `Summary row "${groupKey}" has null agent_cost_usd_total but empty agent_cost_unavailable_reason.`,
            rowOrRef: groupKey,
          });
        }
      }

      const decisionCostVals = matchingCells
        .map((r) => parseOptionalNumber(r.decision_cost_usd))
        .filter((v): v is number => v !== null);
      const repDecisionCostTotal = parseOptionalNumber(summaryRow.decision_cost_usd_total);
      const repDecisionCostReason = (summaryRow.decision_cost_unavailable_reason || '').trim();
      if (decisionCostVals.length > 0) {
        const expectedTotal = decisionCostVals.reduce((acc, v) => acc + v, 0);
        if (repDecisionCostTotal === null || Math.abs(repDecisionCostTotal - expectedTotal) > 0.001) {
          violations.push({
            code: 'summary_metric_reconciliation_mismatch',
            message: `Summary row "${groupKey}" decision_cost_usd_total (${repDecisionCostTotal}) does not match per-cell sum (${expectedTotal.toFixed(4)}).`,
            rowOrRef: groupKey,
          });
        }
      } else {
        if (repDecisionCostTotal !== null) {
          violations.push({
            code: 'summary_metric_reconciliation_mismatch',
            message: `Summary row "${groupKey}" reports decision_cost_usd_total=${repDecisionCostTotal} when all per-cell decision_cost_usd values are null.`,
            rowOrRef: groupKey,
          });
        }
        if (!repDecisionCostReason) {
          violations.push({
            code: 'missing_cost_unavailable_reason',
            message: `Summary row "${groupKey}" has null decision_cost_usd_total but empty decision_cost_unavailable_reason.`,
            rowOrRef: groupKey,
          });
        }
      }
    }

    for (const expectedGroup of expectedCellGroups) {
      if (!seenSummaryGroups.has(expectedGroup)) {
        violations.push({
          code: 'summary_cell_count_mismatch',
          message: `Per-cell CSV group "${expectedGroup}" is missing from summary CSV.`,
          rowOrRef: expectedGroup,
        });
      }
    }
  }

  // Validate Measurement Receipt if provided
  if (input.receipt) {
    const r = input.receipt;
    const hasValidSampleSizeObj = Boolean(
      r.sampleSize &&
        typeof r.sampleSize === 'object' &&
        typeof r.sampleSize.totalCells === 'number' &&
        typeof r.sampleSize.completeCells === 'number' &&
        typeof r.sampleSize.failedCells === 'number' &&
        typeof r.sampleSize.timedOutCells === 'number' &&
        typeof r.sampleSize.abstainedCells === 'number' &&
        typeof r.sampleSize.invalidIncompleteCells === 'number',
    );
    const hasValidModels =
      Array.isArray(r.models) &&
      r.models.length > 0 &&
      r.models.every(
        (m) =>
          Boolean(m && typeof m === 'object' && typeof m.modelId === 'string' && m.modelId.trim() && typeof m.effort === 'string' && m.effort.trim()),
      );
    const hasValidArms =
      Array.isArray(r.arms) &&
      r.arms.length > 0 &&
      r.arms.every((a) => VALID_ARMS.includes(a as (typeof VALID_ARMS)[number]));

    if (
      r.schema !== 'perfdigest.benchmark.measurement-receipt.v1' ||
      !r.experimentId ||
      !r.gitSha ||
      !r.runnerVersion ||
      !isSafeRelativeArtifactRef(r.cellsCsvRef) ||
      !r.cellsCsvRef.endsWith('.csv') ||
      !isSafeRelativeArtifactRef(r.summaryCsvRef) ||
      !r.summaryCsvRef.endsWith('.csv') ||
      !isSafeRelativeArtifactRef(r.sourceTraceRef) ||
      (!r.sourceTraceRef.endsWith('.json') && !r.sourceTraceRef.endsWith('.jsonl')) ||
      r.baselineParityVerified !== true ||
      r.nativeToolsEnabledInRawBaseline !== true ||
      r.oracleLeakageCheckPassed !== true ||
      !Array.isArray(r.limitations) ||
      r.limitations.length === 0 ||
      !hasValidSampleSizeObj ||
      !hasValidModels ||
      !hasValidArms
    ) {
      violations.push({
        code: 'invalid_measurement_receipt',
        message:
          'Measurement receipt is missing mandatory fields, safe relative artifact refs, parity attestations, sampleSize breakdown, models, arms, or explicit limitations.',
      });
    } else {
      const bundleDir = posix.dirname(r.cellsCsvRef);
      if (
        posix.dirname(r.summaryCsvRef) !== bundleDir ||
        posix.dirname(r.sourceTraceRef) !== bundleDir
      ) {
        violations.push({
          code: 'invalid_measurement_receipt',
          message: `Receipt artifact refs (${r.cellsCsvRef}, ${r.summaryCsvRef}, ${r.sourceTraceRef}) must reside in the same directory.`,
        });
      }

      if (r.auxiliaryArtifactRefs !== undefined) {
        if (!Array.isArray(r.auxiliaryArtifactRefs)) {
          violations.push({
            code: 'invalid_measurement_receipt',
            message: 'Receipt auxiliaryArtifactRefs must be an array of relative .md paths.',
          });
        } else {
          for (const auxRef of r.auxiliaryArtifactRefs) {
            if (
              !isSafeRelativeArtifactRef(auxRef) ||
              !auxRef.endsWith('.md') ||
              posix.dirname(auxRef) !== bundleDir
            ) {
              violations.push({
                code: 'invalid_measurement_receipt',
                message: `Receipt auxiliaryArtifactRef "${String(auxRef)}" must be a safe relative .md narrative path in "${bundleDir}" (never .csv/.json/.jsonl or outside the bundle directory).`,
                rowOrRef: String(auxRef),
              });
            }
          }
        }
      }

      // Cross-check sampleSize breakdown against per-cell CSV
      const actualComplete = parsedCells.rows.filter((c) => c.status === 'complete').length;
      const actualFailed = parsedCells.rows.filter((c) => c.status === 'failed').length;
      const actualTimedOut = parsedCells.rows.filter((c) => c.status === 'timed_out').length;
      const actualAbstained = parsedCells.rows.filter((c) => c.status === 'abstained').length;
      const actualInvalid = parsedCells.rows.filter((c) => c.status === 'invalid_incomplete').length;
      if (
        r.sampleSize.totalCells !== parsedCells.rows.length ||
        r.sampleSize.completeCells !== actualComplete ||
        r.sampleSize.failedCells !== actualFailed ||
        r.sampleSize.timedOutCells !== actualTimedOut ||
        r.sampleSize.abstainedCells !== actualAbstained ||
        r.sampleSize.invalidIncompleteCells !== actualInvalid
      ) {
        violations.push({
          code: 'invalid_measurement_receipt',
          message: `Measurement receipt sampleSize (${JSON.stringify(r.sampleSize)}) does not match per-cell CSV counts (total=${parsedCells.rows.length}, complete=${actualComplete}, failed=${actualFailed}, timedOut=${actualTimedOut}, abstained=${actualAbstained}, invalidIncomplete=${actualInvalid}).`,
        });
      }

      // Cross-check experimentId, gitSha, runnerVersion, and sourceTraceRef against cells and summary
      for (const row of parsedCells.rows) {
        if (
          row.run_id !== r.experimentId ||
          row.git_sha !== r.gitSha ||
          row.runner_version !== r.runnerVersion ||
          (row.source_trace_ref && row.source_trace_ref.trim() !== r.sourceTraceRef)
        ) {
          violations.push({
            code: 'invalid_measurement_receipt',
            message: `Cell "${row.cell_id}" metadata (run_id=${row.run_id}, git_sha=${row.git_sha}, runner_version=${row.runner_version}, source_trace_ref=${row.source_trace_ref}) does not match measurement receipt (${r.experimentId}, ${r.gitSha}, ${r.runnerVersion}, ${r.sourceTraceRef}).`,
            rowOrRef: row.cell_id || '<unknown_cell>',
          });
          break;
        }
      }
      for (const summaryRow of parsedSummary.rows) {
        if (summaryRow.run_id !== r.experimentId) {
          violations.push({
            code: 'invalid_measurement_receipt',
            message: `Summary row run_id "${summaryRow.run_id}" does not match receipt experimentId "${r.experimentId}".`,
          });
          break;
        }
      }

      // Cross-check receipt models and arms against per-cell CSV
      const receiptModelKeys = new Set(r.models.map((m) => `${m.modelId}|${m.effort}`));
      const cellModelKeys = new Set(parsedCells.rows.map((c) => `${c.model_id || ''}|${c.effort || ''}`));
      if (
        receiptModelKeys.size !== r.models.length ||
        receiptModelKeys.size !== cellModelKeys.size ||
        [...cellModelKeys].some((k) => !receiptModelKeys.has(k))
      ) {
        violations.push({
          code: 'invalid_measurement_receipt',
          message: `Measurement receipt models (${[...receiptModelKeys].join(', ')}) do not match per-cell CSV models (${[...cellModelKeys].join(', ')}).`,
        });
      }

      const receiptArmSet = new Set<string>(r.arms);
      const cellArmSet = new Set<string>(parsedCells.rows.map((c) => c.arm || ''));
      if (
        receiptArmSet.size !== r.arms.length ||
        receiptArmSet.size !== cellArmSet.size ||
        [...cellArmSet].some((a) => !receiptArmSet.has(a))
      ) {
        violations.push({
          code: 'invalid_measurement_receipt',
          message: `Measurement receipt arms (${[...receiptArmSet].join(', ')}) do not match per-cell CSV arms (${[...cellArmSet].join(', ')}).`,
        });
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    checkedCellsCount: parsedCells.rows.length,
    checkedSummaryRowsCount: parsedSummary.rows.length,
  };
}

/**
 * Producer/output boundary gate: validates a complete benchmark bundle (Cells CSV, Summary CSV,
 * Machine-Readable Source Trace JSON, and Measurement Receipt) BEFORE writing any file to disk.
 * Throws `BenchmarkIntegrityError` if any violation is detected so no invalid or unreceipted
 * benchmark result can ever be emitted by a producer.
 */
export async function writeValidatedBenchmarkBundle(options: {
  rootDir: string;
  receiptRelPath: string;
  cellsCsv: string;
  summaryCsv: string;
  sourceTraceContent: string;
  receipt: BenchmarkMeasurementReceipt;
  promptsOrInputsToScanForLeakage?: string[];
}): Promise<BenchmarkIntegrityValidationResult> {
  const { rootDir, receiptRelPath, cellsCsv, summaryCsv, sourceTraceContent, receipt } = options;
  if (
    !isSafeRelativeArtifactRef(receiptRelPath) ||
    !receiptRelPath.endsWith('-measurement-receipt.json')
  ) {
    throw new BenchmarkIntegrityError('Invalid measurement receipt path', [
      {
        code: 'invalid_measurement_receipt',
        message: `Receipt path "${receiptRelPath}" must be a safe normalized relative path ending with "-measurement-receipt.json".`,
        rowOrRef: receiptRelPath,
      },
    ]);
  }

  const receiptDir = posix.dirname(receiptRelPath);
  const candidateRefs = [
    receiptRelPath,
    receipt.cellsCsvRef,
    receipt.summaryCsvRef,
    receipt.sourceTraceRef,
    ...(Array.isArray(receipt.auxiliaryArtifactRefs) ? receipt.auxiliaryArtifactRefs : []),
  ];
  const frozenBasenames = new Set(
    FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS.map((f) => posix.basename(f)),
  );
  for (const ref of candidateRefs) {
    if (!isSafeRelativeArtifactRef(ref) || posix.dirname(ref) !== receiptDir) {
      throw new BenchmarkIntegrityError('Path traversal or directory mismatch in benchmark bundle refs', [
        {
          code: 'invalid_measurement_receipt',
          message: `Artifact ref "${String(ref)}" must be a safe relative path within "${receiptDir}".`,
          rowOrRef: String(ref),
        },
      ]);
    }
    if (
      (FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS as readonly string[]).includes(ref) ||
      frozenBasenames.has(posix.basename(ref))
    ) {
      throw new BenchmarkIntegrityError('Refusing to overwrite frozen historical benchmark artifact', [
        {
          code: 'modified_historical_benchmark_artifact',
          message: `Artifact ref "${ref}" targets a frozen historical benchmark artifact.`,
          rowOrRef: ref,
        },
      ]);
    }
  }

  const validation = validateBenchmarkIntegrityBundle({
    cellsCsv,
    summaryCsv,
    sourceTracesByRef: {
      [receipt.sourceTraceRef]: sourceTraceContent,
    },
    requireSourceTraceVerification: true,
    receipt,
    ...(options.promptsOrInputsToScanForLeakage
      ? { promptsOrInputsToScanForLeakage: options.promptsOrInputsToScanForLeakage }
      : {}),
  });

  if (!validation.valid) {
    throw new BenchmarkIntegrityError(
      `Refusing to write benchmark bundle "${receipt.experimentId}" at producer boundary`,
      validation.violations,
    );
  }

  const targetFiles: Array<{ path: string; content: string }> = [
    { path: join(rootDir, receipt.cellsCsvRef), content: cellsCsv },
    { path: join(rootDir, receipt.summaryCsvRef), content: summaryCsv },
    { path: join(rootDir, receipt.sourceTraceRef), content: sourceTraceContent },
    { path: join(rootDir, receiptRelPath), content: `${JSON.stringify(receipt, null, 2)}\n` },
  ];

  const tmpSuffix = `.tmp-${process.pid}-${Date.now()}`;
  const writtenTmpPaths: string[] = [];
  try {
    for (const item of targetFiles) {
      await mkdir(dirname(item.path), { recursive: true });
      const tmpPath = `${item.path}${tmpSuffix}`;
      await writeFile(tmpPath, item.content, 'utf8');
      writtenTmpPaths.push(tmpPath);
    }
    for (let i = 0; i < targetFiles.length; i += 1) {
      await rename(writtenTmpPaths[i]!, targetFiles[i]!.path);
    }
  } catch (err) {
    for (const tmpPath of writtenTmpPaths) {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
    throw err;
  }

  return validation;
}

export interface BenchmarkDirectoryAuditResult {
  valid: boolean;
  violations: IntegrityViolation[];
  receiptsValidated: string[];
  historicalFilesVerified: string[];
  untrackedFiles: string[];
}

/**
 * Directory-level benchmark integrity audit:
 * 1. Verifies that all frozen pre-Issue-#18 historical benchmark artifacts remain intact and match
 *    their pinned SHA-256 digests (`FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS_SHA256`).
 * 2. Recursively scans `resultsRelDir` (rejecting symlinks and unreceipted subdirectory files).
 * 3. Discovers and validates all `*-measurement-receipt.json` bundles (including machine-readable
 *    `source_trace_ref` existence, cell identity, provenance, events, and telemetry reconciliation).
 * 4. Fails closed (`untracked_or_receiptless_benchmark_artifact`) if ANY file in `resultsRelDir`
 *    is neither in `frozenHistoricalArtifacts` nor bound to a valid measurement receipt.
 */
export async function auditBenchmarkResultsDirectory(
  rootDir: string,
  resultsRelDir = 'bench/results',
  frozenHistoricalArtifacts: readonly string[] = FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS,
  frozenHistoricalHashes: Readonly<Record<string, string>> = FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS_SHA256,
  options?: { allowReceiptedBundles?: boolean },
): Promise<BenchmarkDirectoryAuditResult> {
  const allowReceiptedBundles =
    options?.allowReceiptedBundles ?? frozenHistoricalArtifacts.length === 0;
  const violations: IntegrityViolation[] = [];
  const receiptsValidated: string[] = [];
  const historicalFilesVerified: string[] = [];
  const coveredRelPaths = new Set<string>();
  const untrackedFiles: string[] = [];
  const symlinkRelPaths = new Set<string>();

  const normalizedResultsRelDir = posix.normalize(resultsRelDir.replace(/\\/g, '/'));

  for (const histRel of frozenHistoricalArtifacts) {
    const normalized = posix.normalize(histRel.replace(/\\/g, '/'));
    const fullHistPath = join(rootDir, normalized);
    let st;
    try {
      st = await lstat(fullHistPath);
    } catch {
      violations.push({
        code: 'missing_historical_benchmark_artifact',
        message: `Frozen historical benchmark artifact is missing: "${normalized}".`,
        rowOrRef: normalized,
      });
      continue;
    }

    if (st.isSymbolicLink() || !st.isFile()) {
      symlinkRelPaths.add(normalized);
      untrackedFiles.push(normalized);
      violations.push({
        code: 'untracked_or_receiptless_benchmark_artifact',
        message: `Symlink "${normalized}" is forbidden in benchmark results directory.`,
        rowOrRef: normalized,
      });
      continue;
    }

    coveredRelPaths.add(normalized);
    const expectedSha = frozenHistoricalHashes[normalized];
    if (expectedSha) {
      const contentBuf = await readFile(fullHistPath);
      const actualSha = createHash('sha256').update(contentBuf).digest('hex');
      if (actualSha !== expectedSha) {
        violations.push({
          code: 'modified_historical_benchmark_artifact',
          message: `Frozen historical benchmark artifact "${normalized}" was modified (expected SHA-256 ${expectedSha}, got ${actualSha}).`,
          rowOrRef: normalized,
        });
        continue;
      }
    }
    historicalFilesVerified.push(normalized);
  }

  const allRelFiles: string[] = [];
  const walkDir = async (currentRelDir: string): Promise<void> => {
    const currentFullDir = join(rootDir, currentRelDir);
    const entries = await readdir(currentFullDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryRel = posix.join(currentRelDir, entry.name);
      const entryFull = join(rootDir, entryRel);
      const st = await lstat(entryFull).catch(() => null);
      if (!st || entry.isSymbolicLink() || st.isSymbolicLink()) {
        if (!symlinkRelPaths.has(entryRel)) {
          symlinkRelPaths.add(entryRel);
          untrackedFiles.push(entryRel);
          violations.push({
            code: 'untracked_or_receiptless_benchmark_artifact',
            message: `Symlink "${entryRel}" is forbidden in benchmark results directory.`,
            rowOrRef: entryRel,
          });
        }
      } else if (entry.isDirectory() || st.isDirectory()) {
        untrackedFiles.push(entryRel);
        violations.push({
          code: 'untracked_or_receiptless_benchmark_artifact',
          message: `Subdirectory "${entryRel}" is forbidden in benchmark results directory.`,
          rowOrRef: entryRel,
        });
        await walkDir(entryRel);
      } else if (entry.isFile() || st.isFile()) {
        allRelFiles.push(entryRel);
      } else {
        untrackedFiles.push(entryRel);
        violations.push({
          code: 'untracked_or_receiptless_benchmark_artifact',
          message: `Non-regular file "${entryRel}" is forbidden in benchmark results directory.`,
          rowOrRef: entryRel,
        });
      }
    }
  };

  await walkDir(normalizedResultsRelDir);
  allRelFiles.sort();

  const receiptRelFiles = allowReceiptedBundles
    ? allRelFiles.filter(
        (f) => f.endsWith('-measurement-receipt.json') && posix.dirname(f) === normalizedResultsRelDir,
      )
    : [];

  if (allRelFiles.length === 0 && frozenHistoricalArtifacts.length === 0) {
    violations.push({
      code: 'invalid_measurement_receipt',
      message: `No "*-measurement-receipt.json" files found in "${normalizedResultsRelDir}".`,
      rowOrRef: normalizedResultsRelDir,
    });
  }

  for (const receiptRel of receiptRelFiles) {
    coveredRelPaths.add(receiptRel);
    let receipt: BenchmarkMeasurementReceipt;
    try {
      receipt = JSON.parse(await readFile(join(rootDir, receiptRel), 'utf8')) as BenchmarkMeasurementReceipt;
    } catch (err) {
      violations.push({
        code: 'invalid_measurement_receipt',
        message: `Failed to parse receipt "${receiptRel}": ${err instanceof Error ? err.message : String(err)}`,
        rowOrRef: receiptRel,
      });
      continue;
    }

    const isSameDirSafeRef = (ref: unknown): ref is string =>
      isSafeRelativeArtifactRef(ref) && posix.dirname(ref) === normalizedResultsRelDir;

    if (isSameDirSafeRef(receipt.cellsCsvRef) && receipt.cellsCsvRef.endsWith('.csv')) {
      coveredRelPaths.add(receipt.cellsCsvRef);
    } else {
      violations.push({
        code: 'invalid_measurement_receipt',
        message: `Receipt "${receiptRel}" has invalid cellsCsvRef "${String(receipt.cellsCsvRef)}".`,
        rowOrRef: receiptRel,
      });
    }

    if (isSameDirSafeRef(receipt.summaryCsvRef) && receipt.summaryCsvRef.endsWith('.csv')) {
      coveredRelPaths.add(receipt.summaryCsvRef);
    } else {
      violations.push({
        code: 'invalid_measurement_receipt',
        message: `Receipt "${receiptRel}" has invalid summaryCsvRef "${String(receipt.summaryCsvRef)}".`,
        rowOrRef: receiptRel,
      });
    }

    if (
      isSameDirSafeRef(receipt.sourceTraceRef) &&
      (receipt.sourceTraceRef.endsWith('.json') || receipt.sourceTraceRef.endsWith('.jsonl'))
    ) {
      coveredRelPaths.add(receipt.sourceTraceRef);
    } else {
      violations.push({
        code: 'invalid_measurement_receipt',
        message: `Receipt "${receiptRel}" has invalid sourceTraceRef "${String(receipt.sourceTraceRef)}".`,
        rowOrRef: receiptRel,
      });
    }

    if (receipt.auxiliaryArtifactRefs !== undefined) {
      if (!Array.isArray(receipt.auxiliaryArtifactRefs)) {
        violations.push({
          code: 'invalid_measurement_receipt',
          message: `Receipt "${receiptRel}" auxiliaryArtifactRefs must be an array.`,
          rowOrRef: receiptRel,
        });
      } else {
        for (const auxRef of receipt.auxiliaryArtifactRefs) {
          if (!isSameDirSafeRef(auxRef) || !auxRef.endsWith('.md')) {
            violations.push({
              code: 'invalid_measurement_receipt',
              message: `Receipt "${receiptRel}" auxiliaryArtifactRef "${String(auxRef)}" must be a relative .md file in "${normalizedResultsRelDir}" (laundering .csv/.json/.jsonl via auxiliaryArtifactRefs is forbidden).`,
              rowOrRef: String(auxRef),
            });
            continue;
          }
          coveredRelPaths.add(auxRef);
          const auxContent = await readFile(join(rootDir, auxRef), 'utf8').catch(() => null);
          if (auxContent === null) {
            violations.push({
              code: 'invalid_measurement_receipt',
              message: `Receipt "${receiptRel}" references missing auxiliaryArtifactRef "${auxRef}".`,
              rowOrRef: auxRef,
            });
          } else {
            for (const pattern of UNSANITIZED_PATH_OR_SECRET_PATTERNS) {
              if (pattern.test(auxContent)) {
                violations.push({
                  code: 'unsanitized_path_or_secret_in_artifact',
                  message: `Unsanitized local path or secret matching ${pattern.toString()} found in auxiliary artifact "${auxRef}".`,
                  rowOrRef: auxRef,
                });
              }
            }
          }
        }
      }
    }

    const cellsCsv = isSameDirSafeRef(receipt.cellsCsvRef)
      ? await readFile(join(rootDir, receipt.cellsCsvRef), 'utf8').catch(() => '')
      : '';
    const summaryCsv = isSameDirSafeRef(receipt.summaryCsvRef)
      ? await readFile(join(rootDir, receipt.summaryCsvRef), 'utf8').catch(() => '')
      : '';

    const traceRefs = new Set<string>();
    if (isSameDirSafeRef(receipt.sourceTraceRef)) {
      traceRefs.add(receipt.sourceTraceRef);
    }
    for (const row of parseCsvRecords(cellsCsv).rows) {
      const ref = (row.source_trace_ref || '').trim();
      if (isSameDirSafeRef(ref) && (ref.endsWith('.json') || ref.endsWith('.jsonl'))) {
        traceRefs.add(ref);
        coveredRelPaths.add(ref);
      }
    }

    const sourceTracesByRef: Record<string, string | null> = {};
    for (const ref of traceRefs) {
      sourceTracesByRef[ref] = await readFile(join(rootDir, ref), 'utf8').catch(() => null);
    }

    const bundleRes = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTracesByRef,
      requireSourceTraceVerification: true,
      receipt,
    });

    if (!bundleRes.valid) {
      violations.push(...bundleRes.violations);
    } else {
      receiptsValidated.push(receiptRel);
    }
  }

  for (const relFile of allRelFiles) {
    if (!coveredRelPaths.has(relFile)) {
      untrackedFiles.push(relFile);
      violations.push({
        code: 'untracked_or_receiptless_benchmark_artifact',
        message: `Benchmark result artifact "${relFile}" is not bound to any "*-measurement-receipt.json" bundle and is not in FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS. Publishing unreceipted benchmark results is forbidden.`,
        rowOrRef: relFile,
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    receiptsValidated,
    historicalFilesVerified,
    untrackedFiles,
  };
}
