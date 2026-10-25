import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  auditBenchmarkResultsDirectory,
  BenchmarkIntegrityError,
  FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS,
  FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS_SHA256,
  MANDATORY_CELL_CSV_COLUMNS,
  MANDATORY_SUMMARY_CSV_COLUMNS,
  parseCsvRecords,
  validateBenchmarkIntegrityBundle,
  writeValidatedBenchmarkBundle,
  type BenchmarkMeasurementReceipt,
} from '../src/benchmark-integrity.js';

const rootDir = process.cwd();
const fixturePrefix = 'bench/fixtures/integrity-samples';

function serializeCsv(headers: readonly string[], rows: Array<Record<string, string>>): string {
  const esc = (v: string | undefined) => {
    const s = v ?? '';
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(',')),
  ].join('\n') + '\n';
}

async function loadCanonicalFixture() {
  const cellsCsv = await readFile(
    join(rootDir, `${fixturePrefix}/failed-and-abstained-cells.csv`),
    'utf8',
  );
  const summaryCsv = await readFile(
    join(rootDir, `${fixturePrefix}/failed-and-abstained-summary.csv`),
    'utf8',
  );
  const sourceTraceText = await readFile(
    join(rootDir, `${fixturePrefix}/failed-and-abstained-trace.json`),
    'utf8',
  );
  const receipt = JSON.parse(
    await readFile(
      join(rootDir, `${fixturePrefix}/failed-and-abstained-measurement-receipt.json`),
      'utf8',
    ),
  ) as BenchmarkMeasurementReceipt;
  return { cellsCsv, summaryCsv, sourceTraceText, receipt };
}

describe('Benchmark integrity schema & negative CI gates (Issue #18)', () => {
  it('validates the canonical 3-cell fixture bundle, receipt, and machine-readable trace end-to-end', async () => {
    const { cellsCsv, summaryCsv, sourceTraceText, receipt } = await loadCanonicalFixture();

    const result = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTraceText,
      receipt,
      requireSourceTraceVerification: true,
    });

    assert.equal(result.valid, true, `Unexpected violations: ${JSON.stringify(result.violations)}`);
    assert.equal(result.checkedCellsCount, 3);
    assert.equal(result.checkedSummaryRowsCount, 2);
  });

  it('supports RFC-4180 multiline quoted strings and rejects duplicate headers or column count mismatches', async () => {
    const multilineCsv = 'col_a,col_b\n"line1\nline2,with""quote""",val2\n';
    const parsedMulti = parseCsvRecords(multilineCsv);
    assert.equal(parsedMulti.rows.length, 1);
    assert.equal(parsedMulti.rows[0]!.col_a, 'line1\nline2,with"quote"');
    assert.equal(parsedMulti.rows[0]!.col_b, 'val2');
    assert.equal(parsedMulti.duplicateHeaders.length, 0);
    assert.equal(parsedMulti.rowColumnCountMismatches.length, 0);

    const { cellsCsv, summaryCsv } = await loadCanonicalFixture();

    // Isolated: duplicate column header
    const dupHeaderCsv = `run_id,${cellsCsv}`;
    const resDupHeader = validateBenchmarkIntegrityBundle({
      cellsCsv: dupHeaderCsv,
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resDupHeader.valid, false);
    assert.ok(resDupHeader.violations.some((v) => v.code === 'missing_csv_column'));

    // Isolated: row column count mismatch
    const badRowCountCsv = `${cellsCsv.trimEnd()},extra_unheaded_field\n`;
    const resRowCount = validateBenchmarkIntegrityBundle({
      cellsCsv: badRowCountCsv,
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resRowCount.valid, false);
    assert.ok(resRowCount.violations.some((v) => v.code === 'missing_csv_column'));
  });

  it('rejects missing mandatory columns in per-cell or summary CSVs', async () => {
    const { cellsCsv, summaryCsv } = await loadCanonicalFixture();
    const parsedCells = parseCsvRecords(cellsCsv);
    const truncatedHeaders = parsedCells.headers.filter((h) => h !== 'parallel_overlap_ms');
    const badCellsCsv = serializeCsv(truncatedHeaders, parsedCells.rows);

    const res = validateBenchmarkIntegrityBundle({
      cellsCsv: badCellsCsv,
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'missing_csv_column'));
  });

  it('rejects invalid monotonic intervals and inconsistent stage/overlap math in isolated checks', async () => {
    const { cellsCsv, summaryCsv } = await loadCanonicalFixture();

    // 1. Isolated invalid monotonic interval
    const parsedMonotonic = parseCsvRecords(cellsCsv);
    parsedMonotonic.rows[0]!.start_monotonic_ms = '5000';
    parsedMonotonic.rows[0]!.end_monotonic_ms = '4000';
    const resMonotonic = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedMonotonic.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resMonotonic.valid, false);
    assert.ok(resMonotonic.violations.some((v) => v.code === 'invalid_monotonic_interval'));

    // 2. Isolated invalid stage/overlap math
    const parsedOverlap = parseCsvRecords(cellsCsv);
    parsedOverlap.rows[1]!.stage_sum_wall_ms = '90000';
    parsedOverlap.rows[1]!.parallel_overlap_ms = '1000';
    parsedOverlap.rows[1]!.critical_path_wall_ms = '50000';
    const resOverlap = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedOverlap.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resOverlap.valid, false);
    assert.ok(resOverlap.violations.some((v) => v.code === 'invalid_stage_overlap_math'));
  });

  it('rejects cumulative session token double-counting (Turn 1 + Turn 2 cumulative reported)', async () => {
    const { cellsCsv, summaryCsv } = await loadCanonicalFixture();
    const parsedCells = parseCsvRecords(cellsCsv);
    const evRow = parsedCells.rows.find((r) => r.arm === 'evidence')!;
    evRow.agent_input_tokens = String(
      Number(evRow.turn1_input_tokens) + Number(evRow.turn2_reported_input_tokens),
    );

    const res = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedCells.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'cumulative_session_token_double_count'));
  });

  it('rejects zero-filled unobserved costs, symmetric decision cost zero-filling, negative costs, and missing cost reasons in isolated checks', async () => {
    const { cellsCsv, summaryCsv } = await loadCanonicalFixture();

    // 1. Isolated zero-filled agent_cost_usd
    const parsedZeroAgent = parseCsvRecords(cellsCsv);
    parsedZeroAgent.rows[0]!.agent_cost_usd = '0';
    const resZeroAgent = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedZeroAgent.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resZeroAgent.valid, false);
    assert.ok(resZeroAgent.violations.some((v) => v.code === 'zero_filled_unobserved_cost'));

    // 2. Isolated symmetric zero-filled decision_cost_usd when decision_cost_unavailable_reason is non-empty
    const parsedZeroDecision = parseCsvRecords(cellsCsv);
    parsedZeroDecision.rows[1]!.decision_cost_usd = '0';
    parsedZeroDecision.rows[1]!.decision_cost_basis = 'per_token_published_pricing';
    parsedZeroDecision.rows[1]!.decision_cost_unavailable_reason = 'billing_not_returned_by_router';
    const resZeroDecision = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedZeroDecision.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resZeroDecision.valid, false);
    assert.ok(resZeroDecision.violations.some((v) => v.code === 'zero_filled_unobserved_cost'));

    // 3. Isolated missing agent_cost_unavailable_reason
    const parsedMissingReason = parseCsvRecords(cellsCsv);
    parsedMissingReason.rows[1]!.agent_cost_usd = '';
    parsedMissingReason.rows[1]!.agent_cost_unavailable_reason = '';
    const resMissingReason = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedMissingReason.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resMissingReason.valid, false);
    assert.ok(resMissingReason.violations.some((v) => v.code === 'missing_cost_unavailable_reason'));

    // 4. Isolated negative cost
    const parsedNegativeCost = parseCsvRecords(cellsCsv);
    parsedNegativeCost.rows[0]!.agent_cost_usd = '-0.25';
    parsedNegativeCost.rows[0]!.agent_cost_basis = 'direct_api_billing';
    parsedNegativeCost.rows[0]!.agent_cost_unavailable_reason = '';
    const resNegativeCost = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedNegativeCost.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resNegativeCost.valid, false);
    assert.ok(resNegativeCost.violations.some((v) => v.code === 'invalid_status'));
  });

  it('rejects mock/loopback/offline providers mislabeled as live_hosted', async () => {
    const { cellsCsv, summaryCsv } = await loadCanonicalFixture();
    const parsedCells = parseCsvRecords(cellsCsv);
    parsedCells.rows[1]!.provider_execution_mode = 'mock_loopback';
    parsedCells.rows[1]!.decision_provenance = 'live_hosted_cloudflare_workers_ai';

    const res = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedCells.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(res.valid, false);
    assert.ok(res.violations.some((v) => v.code === 'mock_or_offline_mislabeled_as_live_hosted'));
  });

  it('rejects blinded raw baselines, out-of-enum execution modes, accuracy_pct mismatches, rubric mismatches, and oracle leakage in isolated checks', async () => {
    const { cellsCsv, summaryCsv } = await loadCanonicalFixture();

    // 1. Isolated blinded raw baseline
    const parsedBlinded = parseCsvRecords(cellsCsv);
    parsedBlinded.rows[0]!.native_tools_enabled = 'false';
    const resBlinded = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedBlinded.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resBlinded.valid, false);
    assert.ok(resBlinded.violations.some((v) => v.code === 'blinded_raw_baseline_native_tools_disabled'));

    // 2. Isolated out-of-enum agent_execution_mode ('agentic-e2e' with hyphen)
    const parsedEnum = parseCsvRecords(cellsCsv);
    parsedEnum.rows[0]!.agent_execution_mode = 'agentic-e2e';
    const resEnum = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedEnum.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resEnum.valid, false);
    assert.ok(resEnum.violations.some((v) => v.code === 'invalid_status'));

    // 3. Isolated per-cell accuracy_pct mismatch
    const parsedAcc = parseCsvRecords(cellsCsv);
    parsedAcc.rows[0]!.accuracy_pct = '40'; // checks_passed=5, total_checks=5 -> 100%
    const resAcc = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedAcc.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resAcc.valid, false);
    assert.ok(resAcc.violations.some((v) => v.code === 'invalid_status'));

    // 4. Isolated rubric mismatch across arms for same study_id
    const parsedRubric = parseCsvRecords(cellsCsv);
    parsedRubric.rows[1]!.total_checks = '10';
    parsedRubric.rows[1]!.accuracy_pct = '30';
    const resRubric = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedRubric.rows),
      summaryCsv,
      requireSourceTraceVerification: false,
    });
    assert.equal(resRubric.valid, false);
    assert.ok(resRubric.violations.some((v) => v.code === 'rubric_mismatch_across_arms'));

    // 5. Isolated oracle leakage
    const resOracle = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      requireSourceTraceVerification: false,
      promptsOrInputsToScanForLeakage: ['Hint: EXPECTED_ORACLE_ANSWER=transpose_v1_coalesced'],
    });
    assert.equal(resOracle.valid, false);
    assert.ok(resOracle.violations.some((v) => v.code === 'oracle_or_answer_leakage_detected'));
  });

  it('rejects summaries that drop failed/abstained trials, omit a group, duplicate a group, or fabricate mean_agent_output_tokens / mean_tool_calls in isolated checks', async () => {
    const { cellsCsv, summaryCsv } = await loadCanonicalFixture();

    // 1. Isolated dropped failed/abstained trials
    const parsedDrop = parseCsvRecords(summaryCsv);
    parsedDrop.rows[1]!.cells = '0';
    const resDrop = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv: serializeCsv(MANDATORY_SUMMARY_CSV_COLUMNS, parsedDrop.rows),
      requireSourceTraceVerification: false,
    });
    assert.equal(resDrop.valid, false);
    assert.ok(resDrop.violations.some((v) => v.code === 'summary_dropped_failed_or_abstained_trials'));

    // 2. Isolated omitted summary group
    const parsedOmit = parseCsvRecords(summaryCsv);
    parsedOmit.rows.pop();
    const resOmit = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv: serializeCsv(MANDATORY_SUMMARY_CSV_COLUMNS, parsedOmit.rows),
      requireSourceTraceVerification: false,
    });
    assert.equal(resOmit.valid, false);
    assert.ok(resOmit.violations.some((v) => v.code === 'summary_cell_count_mismatch'));

    // 3. Isolated duplicate summary group
    const parsedDup = parseCsvRecords(summaryCsv);
    parsedDup.rows.push({ ...parsedDup.rows[0]! });
    const resDup = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv: serializeCsv(MANDATORY_SUMMARY_CSV_COLUMNS, parsedDup.rows),
      requireSourceTraceVerification: false,
    });
    assert.equal(resDup.valid, false);
    assert.ok(resDup.violations.some((v) => v.code === 'summary_cell_count_mismatch'));

    // 4. Isolated fabricated mean_agent_output_tokens
    const parsedOutTok = parseCsvRecords(summaryCsv);
    parsedOutTok.rows[0]!.mean_agent_output_tokens = '99999';
    const resOutTok = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv: serializeCsv(MANDATORY_SUMMARY_CSV_COLUMNS, parsedOutTok.rows),
      requireSourceTraceVerification: false,
    });
    assert.equal(resOutTok.valid, false);
    assert.ok(resOutTok.violations.some((v) => v.code === 'summary_metric_reconciliation_mismatch'));

    // 5. Isolated fabricated mean_tool_calls (+0.5 perturbation caught by relative tolerance)
    const parsedTools = parseCsvRecords(summaryCsv);
    parsedTools.rows[0]!.mean_tool_calls = String(Number(parsedTools.rows[0]!.mean_tool_calls) + 0.5);
    const resTools = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv: serializeCsv(MANDATORY_SUMMARY_CSV_COLUMNS, parsedTools.rows),
      requireSourceTraceVerification: false,
    });
    assert.equal(resTools.valid, false);
    assert.ok(resTools.violations.some((v) => v.code === 'summary_metric_reconciliation_mismatch'));

    // 6. Isolated phantom summary group with cells=0
    const parsedPhantom = parseCsvRecords(summaryCsv);
    parsedPhantom.rows.push({
      ...parsedPhantom.rows[0]!,
      arm: 'mcp_digest',
      cells: '0',
      complete_cells: '0',
      failed_cells: '0',
      timed_out_cells: '0',
      abstained_cells: '0',
      invalid_incomplete_cells: '0',
    });
    const resPhantom = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv: serializeCsv(MANDATORY_SUMMARY_CSV_COLUMNS, parsedPhantom.rows),
      requireSourceTraceVerification: false,
    });
    assert.equal(resPhantom.valid, false);
    assert.ok(resPhantom.violations.some((v) => v.code === 'summary_cell_count_mismatch'));
  });

  it('rejects unsanitized local paths (/home/alice without trailing slash, /var/folders, C:\\Users) or secrets (ghp_, AKIA, sk-, cf_) in CSV, trace, or receipt JSON', async () => {
    const { cellsCsv, summaryCsv, sourceTraceText, receipt } = await loadCanonicalFixture();

    for (const secretSample of [
      'Loaded from /home/alice',
      'Root dir /root/work',
      'Unicode escaped \\u002fhome\\u002falice',
      'Temp dir /var/folders/xx/12345/T',
      'Windows dir C:\\Users\\alice',
      'GitHub token ghp_1234567890abcdefghijklmnop',
      'AWS key AKIAIOSFODNN7EXAMPLE',
      'Google key AIzaSyA1234567890abcdefghijklmnop',
      'Cloudflare token cf_1234567890abcdefghijklmnop',
    ]) {
      const resTraceSecret = validateBenchmarkIntegrityBundle({
        cellsCsv,
        summaryCsv,
        sourceTraceText: `${sourceTraceText}\n// ${secretSample}`,
        requireSourceTraceVerification: false,
      });
      assert.equal(resTraceSecret.valid, false, `Expected failure for sample: ${secretSample}`);
      assert.ok(
        resTraceSecret.violations.some((v) => v.code === 'unsanitized_path_or_secret_in_artifact'),
      );
    }

    // Isolated: secret/path inside receipt JSON
    const taintedReceipt: BenchmarkMeasurementReceipt = {
      ...receipt,
      limitations: ['Executed in /home/alice with ghp_1234567890abcdefghijklmnop'],
    };
    const resReceiptSecret = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTraceText,
      receipt: taintedReceipt,
      requireSourceTraceVerification: true,
    });
    assert.equal(resReceiptSecret.valid, false);
    assert.ok(
      resReceiptSecret.violations.some(
        (v) => v.code === 'unsanitized_path_or_secret_in_artifact' && v.rowOrRef === 'receipt',
      ),
    );
  });

  it('enforces strict source_trace_ref verification against skeletal traces, missing events[], missing utcIso, and non-monotonic events in isolated checks', async () => {
    const { cellsCsv, summaryCsv, sourceTraceText } = await loadCanonicalFixture();
    const traceRef = `${fixturePrefix}/failed-and-abstained-trace.json`;

    // 1. Isolated non-machine-readable markdown source_trace_ref
    const parsedMd = parseCsvRecords(cellsCsv);
    parsedMd.rows[0]!.source_trace_ref = `${fixturePrefix}/SOME_REPORT.md`;
    const resMd = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedMd.rows),
      summaryCsv,
      sourceTracesByRef: {
        [traceRef]: sourceTraceText,
        [`${fixturePrefix}/SOME_REPORT.md`]: '# Not a machine-readable trace',
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resMd.valid, false);
    assert.ok(resMd.violations.some((v) => v.code === 'invalid_source_trace_format'));

    // 2. Isolated nonexistent JSON source_trace_ref
    const parsedMissing = parseCsvRecords(cellsCsv);
    parsedMissing.rows[0]!.source_trace_ref = `${fixturePrefix}/nonexistent-trace.json`;
    const resMissing = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedMissing.rows),
      summaryCsv,
      sourceTracesByRef: {
        [traceRef]: sourceTraceText,
        [`${fixturePrefix}/nonexistent-trace.json`]: null,
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resMissing.valid, false);
    assert.ok(resMissing.violations.some((v) => v.code === 'missing_or_unreadable_source_trace'));

    // 3. Isolated cell missing from trace
    const traceMissingCell = JSON.parse(sourceTraceText) as {
      cells: Array<Record<string, unknown>>;
    };
    traceMissingCell.cells.shift();
    const resCellMissing = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTracesByRef: {
        [traceRef]: JSON.stringify(traceMissingCell),
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resCellMissing.valid, false);
    assert.ok(resCellMissing.violations.some((v) => v.code === 'source_trace_cell_missing'));

    // 4. Isolated skeletal trace containing only {"cell_id": "..."}
    const skeletalTrace = {
      schema: 'perfdigest.benchmark.source-trace.v1',
      cells: [
        { cell_id: 'c1_raw_ok' },
        { cell_id: 'c2_evidence_abstained' },
        { cell_id: 'c3_evidence_failed' },
      ],
    };
    const resSkeletal = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTracesByRef: {
        [traceRef]: JSON.stringify(skeletalTrace),
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resSkeletal.valid, false);
    assert.ok(resSkeletal.violations.some((v) => v.code === 'source_trace_identity_mismatch'));
    assert.ok(resSkeletal.violations.some((v) => v.code === 'source_trace_provenance_mismatch'));
    assert.ok(resSkeletal.violations.some((v) => v.code === 'source_trace_telemetry_mismatch'));

    // 5. Isolated trace missing events[] on a complete cell
    const traceNoEvents = JSON.parse(sourceTraceText) as {
      cells: Array<Record<string, unknown>>;
    };
    delete traceNoEvents.cells[0]!.events;
    const resNoEvents = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTracesByRef: {
        [traceRef]: JSON.stringify(traceNoEvents),
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resNoEvents.valid, false);
    assert.deepEqual(
      resNoEvents.violations.map((v) => v.code),
      ['source_trace_telemetry_mismatch'],
    );

    // 6. Isolated trace event missing utcIso
    const traceNoUtc = JSON.parse(sourceTraceText) as {
      cells: Array<{ events: Array<Record<string, unknown>> }>;
    };
    delete traceNoUtc.cells[0]!.events[0]!.utcIso;
    const resNoUtc = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTracesByRef: {
        [traceRef]: JSON.stringify(traceNoUtc),
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resNoUtc.valid, false);
    assert.deepEqual(
      resNoUtc.violations.map((v) => v.code),
      ['source_trace_telemetry_mismatch'],
    );

    // 7. Isolated non-monotonic trace events on an otherwise valid trace
    const traceNonMonotonic = JSON.parse(sourceTraceText) as {
      cells: Array<{ events: Array<Record<string, unknown>> }>;
    };
    traceNonMonotonic.cells[0]!.events = [
      { event: 'run.started', elapsedMs: 50, utcIso: '2026-10-25T17:50:00.050Z' },
      { event: 'turn1.started', elapsedMs: 10, utcIso: '2026-10-25T17:50:00.010Z' },
    ];
    const resNonMonotonic = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTracesByRef: {
        [traceRef]: JSON.stringify(traceNonMonotonic),
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resNonMonotonic.valid, false);
    assert.deepEqual(
      resNonMonotonic.violations.map((v) => v.code),
      ['source_trace_telemetry_mismatch'],
    );

    // 8. Isolated single-event complete cell rejected
    const traceSingleEvent = JSON.parse(sourceTraceText) as {
      cells: Array<{ events: Array<Record<string, unknown>> }>;
    };
    traceSingleEvent.cells[0]!.events = [
      { event: 'run.started', elapsedMs: 0, utcIso: '2026-10-25T17:50:00.000Z' },
    ];
    const resSingleEvent = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTracesByRef: {
        [traceRef]: JSON.stringify(traceSingleEvent),
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resSingleEvent.valid, false);
    assert.deepEqual(
      resSingleEvent.violations.map((v) => v.code),
      ['source_trace_telemetry_mismatch'],
    );

    // 9. Isolated utcIso regression and max elapsedMs mismatch vs e2e_wall_ms
    const traceUtcRegression = JSON.parse(sourceTraceText) as {
      cells: Array<{ events: Array<Record<string, unknown>> }>;
    };
    traceUtcRegression.cells[0]!.events = [
      { event: 'run.started', elapsedMs: 0, utcIso: '2026-10-25T17:50:00.000Z' },
      { event: 'run.completed', elapsedMs: 106389.37, utcIso: '2020-01-01T00:00:00.000Z' },
    ];
    const resUtcRegression = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTracesByRef: {
        [traceRef]: JSON.stringify(traceUtcRegression),
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resUtcRegression.valid, false);
    assert.deepEqual(
      resUtcRegression.violations.map((v) => v.code),
      ['source_trace_telemetry_mismatch'],
    );

    const traceElapsedMismatch = JSON.parse(sourceTraceText) as {
      cells: Array<{ events: Array<Record<string, unknown>> }>;
    };
    traceElapsedMismatch.cells[0]!.events = [
      { event: 'run.started', elapsedMs: 0, utcIso: '2026-10-25T17:50:00.000Z' },
      { event: 'run.completed', elapsedMs: 9999999, utcIso: '2026-10-25T17:51:46.389Z' },
    ];
    const resElapsedMismatch = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTracesByRef: {
        [traceRef]: JSON.stringify(traceElapsedMismatch),
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resElapsedMismatch.valid, false);
    assert.deepEqual(
      resElapsedMismatch.violations.map((v) => v.code),
      ['source_trace_telemetry_mismatch'],
    );

    // 10. Isolated JSONL trace with a null line fails cleanly without throwing TypeError
    const parsedJsonl = parseCsvRecords(cellsCsv);
    for (const r of parsedJsonl.rows) {
      r.source_trace_ref = `${fixturePrefix}/bad-trace.jsonl`;
    }
    const resNullJsonl = validateBenchmarkIntegrityBundle({
      cellsCsv: serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedJsonl.rows),
      summaryCsv,
      sourceTracesByRef: {
        [`${fixturePrefix}/bad-trace.jsonl`]: 'null\n{"cell_id":"c1_raw_ok"}\n',
      },
      requireSourceTraceVerification: true,
    });
    assert.equal(resNullJsonl.valid, false);
    assert.ok(resNullJsonl.violations.some((v) => v.code === 'missing_or_unreadable_source_trace'));
  });

  it('validates measurement receipt sampleSize breakdown, models, arms, gitSha, and missing sampleSize without throwing TypeError', async () => {
    const { cellsCsv, summaryCsv, sourceTraceText, receipt } = await loadCanonicalFixture();

    // 1. Isolated missing sampleSize object (must not throw TypeError)
    const missingSampleSizeReceipt = { ...receipt } as Record<string, unknown>;
    delete missingSampleSizeReceipt.sampleSize;
    const resMissingSampleSize = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTraceText,
      receipt: missingSampleSizeReceipt as unknown as BenchmarkMeasurementReceipt,
    });
    assert.equal(resMissingSampleSize.valid, false);
    assert.ok(resMissingSampleSize.violations.some((v) => v.code === 'invalid_measurement_receipt'));

    // 2. Isolated sampleSize breakdown mismatch (completeCells / failedCells swapped)
    const badBreakdownReceipt: BenchmarkMeasurementReceipt = {
      ...receipt,
      sampleSize: {
        ...receipt.sampleSize,
        completeCells: 2,
        failedCells: 0,
      },
    };
    const resBreakdown = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTraceText,
      receipt: badBreakdownReceipt,
    });
    assert.equal(resBreakdown.valid, false);
    assert.ok(resBreakdown.violations.some((v) => v.code === 'invalid_measurement_receipt'));

    // 3. Isolated receipt gitSha mismatch against cells CSV
    const badGitShaReceipt: BenchmarkMeasurementReceipt = {
      ...receipt,
      gitSha: '0000000000000000000000000000000000000000',
    };
    const resGitSha = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTraceText,
      receipt: badGitShaReceipt,
    });
    assert.equal(resGitSha.valid, false);
    assert.ok(resGitSha.violations.some((v) => v.code === 'invalid_measurement_receipt'));

    // 4. Isolated receipt models mismatch
    const badModelsReceipt: BenchmarkMeasurementReceipt = {
      ...receipt,
      models: [{ modelId: 'claude-sonnet-4-5', effort: 'high' }],
    };
    const resModels = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTraceText,
      receipt: badModelsReceipt,
    });
    assert.equal(resModels.valid, false);
    assert.ok(resModels.violations.some((v) => v.code === 'invalid_measurement_receipt'));

    // 5. Isolated receipt arms mismatch
    const badArmsReceipt: BenchmarkMeasurementReceipt = {
      ...receipt,
      arms: ['raw', 'mcp_digest', 'evidence'],
    };
    const resArms = validateBenchmarkIntegrityBundle({
      cellsCsv,
      summaryCsv,
      sourceTraceText,
      receipt: badArmsReceipt,
    });
    assert.equal(resArms.valid, false);
    assert.ok(resArms.violations.some((v) => v.code === 'invalid_measurement_receipt'));
  });

  it('closes all 4 directory-audit evasions (subdirectories, symlinks, modified historical artifacts, auxiliaryArtifactRefs laundering, and path traversal)', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'pd-bench-audit-'));
    try {
      const resultsRelDir = 'bench/results';
      const resultsDir = join(tmpRoot, resultsRelDir);
      await mkdir(resultsDir, { recursive: true });

      const { cellsCsv: rawCellsCsv, summaryCsv, sourceTraceText, receipt: rawReceipt } =
        await loadCanonicalFixture();

      // Re-home the fixture bundle into bench/results/ inside tmpRoot
      const parsedCells = parseCsvRecords(rawCellsCsv);
      for (const r of parsedCells.rows) {
        r.source_trace_ref = 'bench/results/sample-trace.json';
      }
      const cellsCsv = serializeCsv(MANDATORY_CELL_CSV_COLUMNS, parsedCells.rows);
      const receipt: BenchmarkMeasurementReceipt = {
        ...rawReceipt,
        cellsCsvRef: 'bench/results/sample-cells.csv',
        summaryCsvRef: 'bench/results/sample-summary.csv',
        sourceTraceRef: 'bench/results/sample-trace.json',
      };

      // 1. Producer boundary rejects path traversal ("..") in refs
      await assert.rejects(
        () =>
          writeValidatedBenchmarkBundle({
            rootDir: tmpRoot,
            receiptRelPath: 'bench/results/sample-measurement-receipt.json',
            cellsCsv,
            summaryCsv,
            sourceTraceContent: sourceTraceText,
            receipt: {
              ...receipt,
              cellsCsvRef: 'bench/results/../escaped-cells.csv',
            },
          }),
        (err: unknown) => err instanceof BenchmarkIntegrityError,
      );

      // 2. Producer boundary writes valid bundle cleanly
      await writeValidatedBenchmarkBundle({
        rootDir: tmpRoot,
        receiptRelPath: 'bench/results/sample-measurement-receipt.json',
        cellsCsv,
        summaryCsv,
        sourceTraceContent: sourceTraceText,
        receipt,
      });

      const cleanAudit = await auditBenchmarkResultsDirectory(tmpRoot, resultsRelDir, [], {});
      assert.equal(cleanAudit.valid, true, `Unexpected violations: ${JSON.stringify(cleanAudit.violations)}`);

      // 3. Evasion A: Subdirectory file under bench/results/sub/file.csv
      await mkdir(join(resultsDir, 'sub'), { recursive: true });
      await writeFile(join(resultsDir, 'sub', 'file.csv'), cellsCsv, 'utf8');
      const subAudit = await auditBenchmarkResultsDirectory(tmpRoot, resultsRelDir, [], {});
      assert.equal(subAudit.valid, false);
      assert.ok(
        subAudit.violations.some(
          (v) =>
            v.code === 'untracked_or_receiptless_benchmark_artifact' &&
            v.rowOrRef === 'bench/results/sub/file.csv',
        ),
      );
      await rm(join(resultsDir, 'sub'), { recursive: true, force: true });

      // 4. Evasion D: Symlink under bench/results/link.json
      const outsideTarget = join(tmpRoot, 'outside.json');
      await writeFile(outsideTarget, '{}', 'utf8');
      await symlink(outsideTarget, join(resultsDir, 'link.json'));
      const symlinkAudit = await auditBenchmarkResultsDirectory(tmpRoot, resultsRelDir, [], {});
      assert.equal(symlinkAudit.valid, false);
      assert.ok(
        symlinkAudit.violations.some(
          (v) =>
            v.code === 'untracked_or_receiptless_benchmark_artifact' &&
            v.rowOrRef === 'bench/results/link.json',
        ),
      );
      await rm(join(resultsDir, 'link.json'), { force: true });

      // 5. Evasion C: Laundering non-.md file (extra.json / extra.csv) via auxiliaryArtifactRefs
      await writeFile(join(resultsDir, 'extra.json'), '{"laundered":true}', 'utf8');
      const launderingReceipt: BenchmarkMeasurementReceipt = {
        ...receipt,
        auxiliaryArtifactRefs: ['bench/results/extra.json'],
      };
      await writeFile(
        join(resultsDir, 'sample-measurement-receipt.json'),
        `${JSON.stringify(launderingReceipt, null, 2)}\n`,
        'utf8',
      );
      const launderAudit = await auditBenchmarkResultsDirectory(tmpRoot, resultsRelDir, [], {});
      assert.equal(launderAudit.valid, false);
      assert.ok(launderAudit.violations.some((v) => v.code === 'invalid_measurement_receipt'));
      assert.ok(
        launderAudit.violations.some(
          (v) =>
            v.code === 'untracked_or_receiptless_benchmark_artifact' &&
            v.rowOrRef === 'bench/results/extra.json',
        ),
      );
      await rm(join(resultsDir, 'extra.json'), { force: true });
      await writeFile(
        join(resultsDir, 'sample-measurement-receipt.json'),
        `${JSON.stringify(receipt, null, 2)}\n`,
        'utf8',
      );

      // 6. Evasion B: Modified frozen historical artifact SHA-256 mismatch
      const frozenRel = FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS[0];
      await writeFile(join(tmpRoot, frozenRel), '{"tampered":true}\n', 'utf8');
      const tamperedAudit = await auditBenchmarkResultsDirectory(
        tmpRoot,
        resultsRelDir,
        [frozenRel],
        FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS_SHA256,
      );
      assert.equal(tamperedAudit.valid, false);
      assert.ok(
        tamperedAudit.violations.some(
          (v) => v.code === 'modified_historical_benchmark_artifact' && v.rowOrRef === frozenRel,
        ),
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
