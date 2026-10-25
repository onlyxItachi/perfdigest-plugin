import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  MANDATORY_CELL_CSV_COLUMNS,
  MANDATORY_SUMMARY_CSV_COLUMNS,
  parseCsvRecords,
  validateBenchmarkIntegrityBundle,
  type BenchmarkMeasurementReceipt,
} from '../src/benchmark-integrity.js';

const rootDir = process.cwd();

function serializeCsv(headers: readonly string[], rows: Array<Record<string, string>>): string {
  const esc = (v: string | undefined) => {
    const s = v ?? '';
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(',')),
  ].join('\n') + '\n';
}

describe('Benchmark integrity schema & negative CI gates (Issue #18)', () => {
  it('validates the canonical 24-cell v3 reconciled benchmark bundle and receipt', async () => {
    const cellsCsv = await readFile(
      join(rootDir, 'bench/results/2026-10-25-v3-reconciled-v2-cells.csv'),
      'utf8',
    );
    const summaryCsv = await readFile(
      join(rootDir, 'bench/results/2026-10-25-v3-reconciled-v2-summary.csv'),
      'utf8',
    );
    const sourceTraceText = await readFile(
      join(rootDir, 'bench/results/2026-10-25-v3-timing-and-usage-audit.md'),
      'utf8',
    );
    const receipt = JSON.parse(
      await readFile(
        join(rootDir, 'bench/results/2026-10-25-v3-measurement-receipt.json'),
        'utf8',
      ),
    ) as BenchmarkMeasurementReceipt;

    const result = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTraceText,
      receipt,
    });

    assert.equal(result.valid, true, `Unexpected violations: ${JSON.stringify(result.violations)}`);
    assert.equal(result.checkedCellsCount, 24);
    assert.equal(result.checkedSummaryRowsCount, 6);
  });

  it('validates mixed-status bundles that preserve failed and abstained trials', async () => {
    const cellsCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-cells.csv'),
      'utf8',
    );
    const summaryCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-summary.csv'),
      'utf8',
    );

    const result = validateBenchmarkIntegrityBundle({ cellsCsv, summaryCsv });
    assert.equal(result.valid, true, `Unexpected violations: ${JSON.stringify(result.violations)}`);
    assert.equal(result.checkedCellsCount, 3);
    assert.equal(result.checkedSummaryRowsCount, 2);
  });

  it('rejects missing mandatory columns in per-cell or summary CSVs', async () => {
    const cellsCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-cells.csv'),
      'utf8',
    );
    const summaryCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-summary.csv'),
      'utf8',
    );
    const parsedCells = parseCsvRecords(cellsCsv);
    const truncatedHeaders = parsedCells.headers.filter((h) => h !== 'parallel_overlap_ms');
    const badCellsCsv = serializeCsv(truncatedHeaders, parsedCells.rows);

    const res = validateBenchmarkIntegrityBundle({ cellsCsv: badCellsCsv, summaryCsv });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'missing_csv_column'));
  });

  it('rejects invalid monotonic intervals and inconsistent stage/overlap math', async () => {
    const cellsCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-cells.csv'),
      'utf8',
    );
    const summaryCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-summary.csv'),
      'utf8',
    );
    const parsedCells = parseCsvRecords(cellsCsv);
    parsedCells.rows[0]!.start_monotonic_ms = '5000';
    parsedCells.rows[0]!.end_monotonic_ms = '4000'; // negative interval
    parsedCells.rows[1]!.stage_sum_wall_ms = '90000';
    parsedCells.rows[1]!.parallel_overlap_ms = '1000';
    parsedCells.rows[1]!.critical_path_wall_ms = '50000'; // 90000 - 1000 != 50000

    const res = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedCells.rows),
      summaryCsv,
    });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'invalid_monotonic_interval'));
    assert.ok(res.violations.some((v) => v.code === 'invalid_stage_overlap_math'));
  });

  it('rejects cumulative session token double-counting (Turn 1 + Turn 2 cumulative reported)', async () => {
    const cellsCsv = await readFile(
      join(rootDir, 'bench/results/2026-10-25-v3-reconciled-v2-cells.csv'),
      'utf8',
    );
    const summaryCsv = await readFile(
      join(rootDir, 'bench/results/2026-10-25-v3-reconciled-v2-summary.csv'),
      'utf8',
    );
    const parsedCells = parseCsvRecords(cellsCsv);
    // Corrupt the first evidence cell to use Turn 1 (41258) + Turn 2 reported (78465) = 119723
    const evRow = parsedCells.rows.find((r) => r.arm === 'evidence')!;
    evRow.agent_input_tokens = String(
      Number(evRow.turn1_input_tokens) + Number(evRow.turn2_reported_input_tokens),
    );

    const res = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedCells.rows),
      summaryCsv,
    });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'cumulative_session_token_double_count'));
  });

  it('rejects zero-filled unobserved costs and missing cost unavailable reasons', async () => {
    const cellsCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-cells.csv'),
      'utf8',
    );
    const summaryCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-summary.csv'),
      'utf8',
    );
    const parsedCells = parseCsvRecords(cellsCsv);
    parsedCells.rows[0]!.agent_cost_usd = '0'; // forbidden when basis is unreported_subscription_or_quota
    parsedCells.rows[1]!.agent_cost_usd = '';
    parsedCells.rows[1]!.agent_cost_unavailable_reason = ''; // missing reason for null cost

    const res = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedCells.rows),
      summaryCsv,
    });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'zero_filled_unobserved_cost'));
    assert.ok(res.violations.some((v) => v.code === 'missing_cost_unavailable_reason'));
  });

  it('rejects mock/loopback/offline providers mislabeled as live_hosted', async () => {
    const cellsCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-cells.csv'),
      'utf8',
    );
    const summaryCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-summary.csv'),
      'utf8',
    );
    const parsedCells = parseCsvRecords(cellsCsv);
    parsedCells.rows[1]!.provider_execution_mode = 'mock_loopback';
    parsedCells.rows[1]!.decision_provenance = 'live_hosted_cloudflare_workers_ai';

    const res = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedCells.rows),
      summaryCsv,
    });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'mock_or_offline_mislabeled_as_live_hosted'));
  });

  it('rejects blinded raw baselines, rubric mismatches, and oracle leakage', async () => {
    const cellsCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-cells.csv'),
      'utf8',
    );
    const summaryCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-summary.csv'),
      'utf8',
    );
    const parsedCells = parseCsvRecords(cellsCsv);
    parsedCells.rows[0]!.native_tools_enabled = 'false'; // blinded raw baseline!
    parsedCells.rows[1]!.total_checks = '10'; // rubric mismatch for cuda_opt_loop (5 vs 10)

    const res = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedCells.rows),
      summaryCsv,
      promptsOrInputsToScanForLeakage: ['Hint: EXPECTED_ORACLE_ANSWER=transpose_v1_coalesced'],
    });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'blinded_raw_baseline_native_tools_disabled'));
    assert.ok(res.violations.some((v) => v.code === 'rubric_mismatch_across_arms'));
    assert.ok(res.violations.some((v) => v.code === 'oracle_or_answer_leakage_detected'));
  });

  it('rejects summaries that drop failed or abstained trials from the cell count', async () => {
    const cellsCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-cells.csv'),
      'utf8',
    );
    const summaryCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-summary.csv'),
      'utf8',
    );
    const parsedSummary = parseCsvRecords(summaryCsv);
    // Pretend the evidence arm had 0 cells (dropping the 1 failed and 1 abstained cell)
    parsedSummary.rows[1]!.cells = '0';

    const res = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv: serializeCsv(MANDATORY_SUMMARY_CSV_COLUMNS, parsedSummary.rows),
    });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'summary_dropped_failed_or_abstained_trials'));
  });

  it('rejects unsanitized local paths or secrets in CSV or trace artifacts', async () => {
    const cellsCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-cells.csv'),
      'utf8',
    );
    const summaryCsv = await readFile(
      join(rootDir, 'bench/fixtures/integrity-samples/failed-and-abstained-summary.csv'),
      'utf8',
    );

    const res = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTraceText: 'Trace file loaded from /home/alice/secret-workspace with key sk-1234567890abcdefghij',
    });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'unsanitized_path_or_secret_in_artifact'));
  });
});
