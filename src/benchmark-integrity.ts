import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
  | 'live_hosted';

export type AgentExecutionMode =
  | 'contract_fixture'
  | 'prefetched_stage_benchmark'
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
  /** Companion artifacts (e.g. markdown audit reports or auxiliary tool-call tables) bound to this receipt. */
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
  | 'missing_historical_benchmark_artifact';

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

/**
 * RFC-4180-compatible single-line CSV parser for benchmark CSV artifacts.
 */
export function parseCsvRecords(csvContent: string): {
  headers: string[];
  rows: Array<Record<string, string>>;
} {
  const lines = csvContent
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
  };

  const headers = parseLine(lines[0]!);
  const rows: Array<Record<string, string>> = [];
  for (let idx = 1; idx < lines.length; idx += 1) {
    const values = parseLine(lines[idx]!);
    const record: Record<string, string> = {};
    for (let h = 0; h < headers.length; h += 1) {
      record[headers[h]!] = values[h] ?? '';
    }
    rows.push(record);
  }
  return { headers, rows };
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
  /\/home\/[a-zA-Z0-9_-]+\//,
  /\/Users\/[a-zA-Z0-9_-]+\//,
  /\/tmp\/perfdigest-[a-zA-Z0-9_-]+/,
  /\bsk-[a-zA-Z0-9_-]{16,}\b/,
  /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/i,
];

interface ParsedTraceBundle {
  cellsByKey: Map<string, Record<string, unknown>>;
  rawObjects: Array<Record<string, unknown>>;
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
      cellObjects = trimmed
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
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
  for (const item of cellObjects) {
    const explicitCellId = readTraceString(item, 'cell_id', 'cellId');
    const modelId = readTraceString(item, 'model_id', 'modelId');
    const studyId = readTraceString(item, 'study_id', 'studyId');
    const arm = readTraceString(item, 'arm');
    if (explicitCellId) {
      cellsByKey.set(explicitCellId, item);
    }
    if (modelId && studyId && arm) {
      const compositeId = `${modelId}__${studyId}__${arm}`;
      if (!cellsByKey.has(compositeId)) {
        cellsByKey.set(compositeId, item);
      }
    }
  }

  return { ok: true, trace: { cellsByKey, rawObjects: cellObjects } };
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

  // Scan CSVs and source traces for unsanitized local paths or secrets
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
  for (const item of textsToCheckSanitization) {
    for (const pattern of UNSANITIZED_PATH_OR_SECRET_PATTERNS) {
      if (pattern.test(item.text)) {
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
      referencedTracePaths.add(input.receipt.sourceTraceRef.trim());
    }
    for (const row of parsedCells.rows) {
      const ref = (row.source_trace_ref || '').trim();
      if (ref) {
        referencedTracePaths.add(ref);
      }
    }
    for (const ref of referencedTracePaths) {
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
        parsedTraceCache.set(ref, parsed.trace);
      }
    }
  }

  const studyRubrics = new Map<string, { rubricId: string; totalChecks: number }>();

  for (const row of parsedCells.rows) {
    const cellId = row.cell_id || '<unknown_cell>';
    const status = row.status as CellExecutionStatus;
    const validStatuses: CellExecutionStatus[] = [
      'complete',
      'failed',
      'timed_out',
      'abstained',
      'invalid_incomplete',
    ];
    if (!validStatuses.includes(status)) {
      violations.push({
        code: 'invalid_status',
        message: `Cell "${cellId}" has invalid status "${row.status}".`,
        rowOrRef: cellId,
      });
      continue;
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
    const totalChecks = parseOptionalNumber(row.total_checks);
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

    // Cost honesty checks (`null` != `0.0`)
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
    } else if (
      agentCostUsd === 0 &&
      (agentCostBasis === 'unreported_subscription_or_quota' || agentCostBasis === 'unavailable' || agentCostReason !== '')
    ) {
      violations.push({
        code: 'zero_filled_unobserved_cost',
        message: `Cell "${cellId}" zero-filled agent_cost_usd=0 despite unobserved billing basis "${agentCostBasis}". Unobserved cost must be null/empty, never 0.`,
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
    } else if (
      decisionCostUsd === 0 &&
      (decisionCostBasis === 'unreported_subscription_or_quota' || decisionCostBasis === 'unavailable')
    ) {
      violations.push({
        code: 'zero_filled_unobserved_cost',
        message: `Cell "${cellId}" zero-filled decision_cost_usd=0 despite unobserved billing basis "${decisionCostBasis}".`,
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
        !sourceTraceRef
      ) {
        violations.push({
          code: 'missing_critical_telemetry_on_complete_cell',
          message: `Cell "${cellId}" is marked "complete" but is missing critical timing, token usage, or source_trace_ref telemetry.`,
          rowOrRef: cellId,
        });
      }
    }

    // Verify cell against its machine-readable source trace when trace verification is active
    if (verifyTraces && sourceTraceRef) {
      const parsedTrace = parsedTraceCache.get(sourceTraceRef);
      if (parsedTrace) {
        const compositeKey = `${row.model_id || ''}__${row.study_id || ''}__${row.arm || ''}`;
        const traceCell =
          parsedTrace.cellsByKey.get(cellId) ?? parsedTrace.cellsByKey.get(compositeKey);
        if (!traceCell) {
          violations.push({
            code: 'source_trace_cell_missing',
            message: `Cell "${cellId}" is not present in its declared source_trace_ref "${sourceTraceRef}".`,
            rowOrRef: cellId,
          });
        } else {
          const traceModelId = readTraceString(traceCell, 'model_id', 'modelId');
          const traceStudyId = readTraceString(traceCell, 'study_id', 'studyId');
          const traceArm = readTraceString(traceCell, 'arm');
          const traceStatus = readTraceString(traceCell, 'status');
          if (
            (traceModelId && traceModelId !== row.model_id) ||
            (traceStudyId && traceStudyId !== row.study_id) ||
            (traceArm && traceArm !== row.arm) ||
            (traceStatus && traceStatus !== row.status)
          ) {
            violations.push({
              code: 'source_trace_identity_mismatch',
              message: `Cell "${cellId}" identity (${row.model_id}/${row.study_id}/${row.arm}/${row.status}) does not match trace record (${traceModelId}/${traceStudyId}/${traceArm}/${traceStatus}).`,
              rowOrRef: cellId,
            });
          }

          const traceE2eMs = readTraceNumber(traceCell, 'e2e_wall_ms', 'e2eWallMs', 'wallMs');
          if (e2eMs !== null && traceE2eMs !== null && Math.abs(e2eMs - traceE2eMs) > 1.5) {
            violations.push({
              code: 'source_trace_telemetry_mismatch',
              message: `Cell "${cellId}" e2e_wall_ms (${e2eMs}) does not match source trace e2e_wall_ms (${traceE2eMs}).`,
              rowOrRef: cellId,
            });
          }

          const traceInputTokens = readTraceNumber(
            traceCell,
            'reconciled_total_input_tokens',
            'agent_input_tokens',
            'agentInputTokens',
          );
          if (
            agentInputTokens !== null &&
            traceInputTokens !== null &&
            Math.abs(agentInputTokens - traceInputTokens) > 1
          ) {
            violations.push({
              code: 'source_trace_telemetry_mismatch',
              message: `Cell "${cellId}" agent_input_tokens (${agentInputTokens}) does not match source trace input tokens (${traceInputTokens}).`,
              rowOrRef: cellId,
            });
          }

          const traceOutputTokens = readTraceNumber(
            traceCell,
            'reconciled_total_output_tokens',
            'agent_output_tokens',
            'agentOutputTokens',
          );
          if (
            agentOutputTokens !== null &&
            traceOutputTokens !== null &&
            Math.abs(agentOutputTokens - traceOutputTokens) > 1
          ) {
            violations.push({
              code: 'source_trace_telemetry_mismatch',
              message: `Cell "${cellId}" agent_output_tokens (${agentOutputTokens}) does not match source trace output tokens (${traceOutputTokens}).`,
              rowOrRef: cellId,
            });
          }

          const rowChecksPassed = parseOptionalNumber(row.checks_passed);
          const traceChecksPassed = readTraceNumber(traceCell, 'checks_passed', 'checksPassed');
          if (
            rowChecksPassed !== null &&
            traceChecksPassed !== null &&
            rowChecksPassed !== traceChecksPassed
          ) {
            violations.push({
              code: 'source_trace_telemetry_mismatch',
              message: `Cell "${cellId}" checks_passed (${rowChecksPassed}) does not match source trace checks_passed (${traceChecksPassed}).`,
              rowOrRef: cellId,
            });
          }

          const traceWorkloadSha = readTraceString(traceCell, 'workload_sha256', 'workloadSha256');
          if (traceWorkloadSha && row.workload_sha256 && traceWorkloadSha !== row.workload_sha256) {
            violations.push({
              code: 'source_trace_provenance_mismatch',
              message: `Cell "${cellId}" workload_sha256 (${row.workload_sha256}) does not match source trace workload_sha256 (${traceWorkloadSha}).`,
              rowOrRef: cellId,
            });
          }

          const rowProvCount = parseOptionalNumber(row.provenance_count);
          const traceProvCount = readTraceNumber(traceCell, 'provenance_count', 'provenanceCount');
          if (
            rowProvCount !== null &&
            traceProvCount !== null &&
            rowProvCount !== traceProvCount
          ) {
            violations.push({
              code: 'source_trace_provenance_mismatch',
              message: `Cell "${cellId}" provenance_count (${rowProvCount}) does not match source trace provenance_count (${traceProvCount}).`,
              rowOrRef: cellId,
            });
          }

          const rowDecisionReqs = parseOptionalNumber(row.decision_requests);
          const traceDecisionReqs = readTraceNumber(
            traceCell,
            'decision_requests',
            'clef_requests',
            'decisionRequests',
          );
          if (
            rowDecisionReqs !== null &&
            traceDecisionReqs !== null &&
            rowDecisionReqs !== traceDecisionReqs
          ) {
            violations.push({
              code: 'source_trace_telemetry_mismatch',
              message: `Cell "${cellId}" decision_requests (${rowDecisionReqs}) does not match source trace decision requests (${traceDecisionReqs}).`,
              rowOrRef: cellId,
            });
          }

          if (Array.isArray(traceCell.events)) {
            const evs = traceCell.events as Array<Record<string, unknown>>;
            if (status === 'complete' && evs.length === 0) {
              violations.push({
                code: 'source_trace_telemetry_mismatch',
                message: `Cell "${cellId}" has an empty events array in its source trace.`,
                rowOrRef: cellId,
              });
            }
            let prevElapsed = -1;
            for (const ev of evs) {
              const el = readTraceNumber(ev, 'elapsedMs', 'elapsed_ms', 'monotonicMs');
              if (el !== null) {
                if (el + 0.05 < prevElapsed) {
                  violations.push({
                    code: 'source_trace_telemetry_mismatch',
                    message: `Cell "${cellId}" source trace has non-monotonic event timestamps (${el} < ${prevElapsed}).`,
                    rowOrRef: cellId,
                  });
                  break;
                }
                prevElapsed = el;
              }
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
    for (const summaryRow of parsedSummary.rows) {
      const modelId = summaryRow.model_id || '';
      const effort = summaryRow.effort || '';
      const arm = summaryRow.arm || '';
      const groupKey = `${modelId}|${effort}|${arm}`;

      const matchingCells = parsedCells.rows.filter(
        (r) => r.model_id === modelId && r.effort === effort && r.arm === arm,
      );

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

      // Check mean E2E wall ms and mean input tokens across cells with observed values
      const e2eValues = matchingCells
        .map((r) => parseOptionalNumber(r.e2e_wall_ms))
        .filter((v): v is number => v !== null);
      if (e2eValues.length > 0) {
        const expectedMeanE2e = computeMean(e2eValues);
        const expectedMedianE2e = computeMedian(e2eValues);
        const expectedP90E2e = computeP90(e2eValues);
        const repMeanE2e = parseOptionalNumber(summaryRow.mean_e2e_wall_ms);
        const repMedianE2e = parseOptionalNumber(summaryRow.median_e2e_wall_ms);
        const repP90E2e = parseOptionalNumber(summaryRow.p90_e2e_wall_ms);
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
      }

      const inputTokenValues = matchingCells
        .map((r) => parseOptionalNumber(r.agent_input_tokens))
        .filter((v): v is number => v !== null);
      if (inputTokenValues.length > 0) {
        const expectedMeanInput = computeMean(inputTokenValues);
        const repMeanInput = parseOptionalNumber(summaryRow.mean_agent_input_tokens);
        if (repMeanInput === null || Math.abs(repMeanInput - expectedMeanInput) > 1.0) {
          violations.push({
            code: 'summary_metric_reconciliation_mismatch',
            message: `Summary row "${groupKey}" mean_agent_input_tokens (${repMeanInput}) does not reconcile with per-cell mean (${expectedMeanInput.toFixed(1)}).`,
            rowOrRef: groupKey,
          });
        }
      }
    }
  }

  // Validate Measurement Receipt if provided
  if (input.receipt) {
    const r = input.receipt;
    if (
      r.schema !== 'perfdigest.benchmark.measurement-receipt.v1' ||
      !r.experimentId ||
      !r.gitSha ||
      !r.runnerVersion ||
      !r.cellsCsvRef ||
      !r.summaryCsvRef ||
      !r.sourceTraceRef ||
      !r.baselineParityVerified ||
      !r.nativeToolsEnabledInRawBaseline ||
      !r.oracleLeakageCheckPassed ||
      !Array.isArray(r.limitations) ||
      r.limitations.length === 0
    ) {
      violations.push({
        code: 'invalid_measurement_receipt',
        message: 'Measurement receipt is missing mandatory fields, parity attestations, or explicit limitations.',
      });
    } else if (r.sampleSize.totalCells !== parsedCells.rows.length) {
      violations.push({
        code: 'invalid_measurement_receipt',
        message: `Measurement receipt sampleSize.totalCells (${r.sampleSize.totalCells}) does not match per-cell CSV row count (${parsedCells.rows.length}).`,
      });
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
  if (!receiptRelPath.endsWith('-measurement-receipt.json')) {
    throw new BenchmarkIntegrityError('Invalid measurement receipt path', [
      {
        code: 'invalid_measurement_receipt',
        message: `Receipt path "${receiptRelPath}" must end with "-measurement-receipt.json".`,
        rowOrRef: receiptRelPath,
      },
    ]);
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

  const cellsPath = join(rootDir, receipt.cellsCsvRef);
  const summaryPath = join(rootDir, receipt.summaryCsvRef);
  const tracePath = join(rootDir, receipt.sourceTraceRef);
  const receiptPath = join(rootDir, receiptRelPath);

  await mkdir(dirname(cellsPath), { recursive: true });
  await mkdir(dirname(summaryPath), { recursive: true });
  await mkdir(dirname(tracePath), { recursive: true });
  await mkdir(dirname(receiptPath), { recursive: true });

  await writeFile(cellsPath, cellsCsv, 'utf8');
  await writeFile(summaryPath, summaryCsv, 'utf8');
  await writeFile(tracePath, sourceTraceContent, 'utf8');
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

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
 * 1. Verifies that all frozen pre-Issue-#18 historical benchmark artifacts remain intact.
 * 2. Discovers and validates all `*-measurement-receipt.json` bundles (including machine-readable
 *    `source_trace_ref` existence, cell identity, and telemetry reconciliation).
 * 3. Fails closed (`untracked_or_receiptless_benchmark_artifact`) if ANY file in `bench/results/`
 *    is neither in `FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS` nor bound to a valid measurement receipt.
 */
export async function auditBenchmarkResultsDirectory(
  rootDir: string,
  resultsRelDir = 'bench/results',
  frozenHistoricalArtifacts: readonly string[] = FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS,
): Promise<BenchmarkDirectoryAuditResult> {
  const violations: IntegrityViolation[] = [];
  const receiptsValidated: string[] = [];
  const historicalFilesVerified: string[] = [];
  const coveredRelPaths = new Set<string>();

  for (const histRel of frozenHistoricalArtifacts) {
    const normalized = histRel.replace(/\\/g, '/');
    try {
      await access(join(rootDir, normalized));
      historicalFilesVerified.push(normalized);
      coveredRelPaths.add(normalized);
    } catch {
      violations.push({
        code: 'missing_historical_benchmark_artifact',
        message: `Frozen historical benchmark artifact is missing: "${normalized}".`,
        rowOrRef: normalized,
      });
    }
  }

  const resultsDir = join(rootDir, resultsRelDir);
  const entries = await readdir(resultsDir, { withFileTypes: true }).catch(() => []);
  const allRelFiles = entries
    .filter((e) => e.isFile())
    .map((e) => posix.join(resultsRelDir.replace(/\\/g, '/'), e.name))
    .sort();

  const receiptRelFiles = allRelFiles.filter((f) => f.endsWith('-measurement-receipt.json'));
  if (receiptRelFiles.length === 0) {
    violations.push({
      code: 'invalid_measurement_receipt',
      message: `No "*-measurement-receipt.json" files found in "${resultsRelDir}".`,
      rowOrRef: resultsRelDir,
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

    if (receipt.cellsCsvRef) coveredRelPaths.add(receipt.cellsCsvRef.replace(/\\/g, '/'));
    if (receipt.summaryCsvRef) coveredRelPaths.add(receipt.summaryCsvRef.replace(/\\/g, '/'));
    if (receipt.sourceTraceRef) coveredRelPaths.add(receipt.sourceTraceRef.replace(/\\/g, '/'));
    if (Array.isArray(receipt.auxiliaryArtifactRefs)) {
      for (const auxRef of receipt.auxiliaryArtifactRefs) {
        const normAux = auxRef.replace(/\\/g, '/');
        coveredRelPaths.add(normAux);
        const auxContent = await readFile(join(rootDir, normAux), 'utf8').catch(() => null);
        if (auxContent === null) {
          violations.push({
            code: 'invalid_measurement_receipt',
            message: `Receipt "${receiptRel}" references missing auxiliaryArtifactRef "${normAux}".`,
            rowOrRef: normAux,
          });
        } else {
          for (const pattern of UNSANITIZED_PATH_OR_SECRET_PATTERNS) {
            if (pattern.test(auxContent)) {
              violations.push({
                code: 'unsanitized_path_or_secret_in_artifact',
                message: `Unsanitized local path or secret matching ${pattern.toString()} found in auxiliary artifact "${normAux}".`,
                rowOrRef: normAux,
              });
            }
          }
        }
      }
    }

    const cellsCsv = await readFile(join(rootDir, receipt.cellsCsvRef || ''), 'utf8').catch(() => '');
    const summaryCsv = await readFile(join(rootDir, receipt.summaryCsvRef || ''), 'utf8').catch(() => '');

    // Collect all referenced source_trace_ref paths from receipt + cells CSV
    const traceRefs = new Set<string>();
    if (receipt.sourceTraceRef) {
      traceRefs.add(receipt.sourceTraceRef.replace(/\\/g, '/'));
    }
    for (const row of parseCsvRecords(cellsCsv).rows) {
      const ref = (row.source_trace_ref || '').trim();
      if (ref) {
        const normRef = ref.replace(/\\/g, '/');
        traceRefs.add(normRef);
        coveredRelPaths.add(normRef);
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

  const untrackedFiles: string[] = [];
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
