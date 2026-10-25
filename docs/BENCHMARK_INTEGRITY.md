# Benchmark Integrity & Telemetry Contract

This document specifies the repository-wide benchmark integrity schema, boundary definitions, and automated CI validation gates enforced by [`src/benchmark-integrity.ts`](../src/benchmark-integrity.ts), [`src/observability.ts`](../src/observability.ts), and [`scripts/check-benchmark-integrity.mjs`](../scripts/check-benchmark-integrity.mjs).

---

## 1. Core Principles

1. **Absence Honesty (`null` $\neq$ `0`)**: Missing or unobserved measurements (such as USD billing on subscription/quota CLIs, or timing/token fields on an aborted trial) must be recorded as `null` (empty string in CSV) with an explicit `*_unavailable_reason`—never zero-filled.
2. **Directly Observed Monotonic E2E Intervals**: `e2e_wall_ms` must be measured from a single runner process's monotonic clock (`end_monotonic_ms - start_monotonic_ms`), never synthesized by adding sequential stage medians.
3. **Explicit Overlap & Critical-Path Accounting**:
   $$\text{critical\_path\_wall\_ms} = \text{stage\_sum\_wall\_ms} - \text{parallel\_overlap\_ms} \le \text{e2e\_wall\_ms}$$
4. **Multi-Turn Cumulative Session Reconciliation**:
   Runtimes such as `agy --conversation <sessionId>` report cumulative session trajectory usage (`Turn 1 + Turn 2`) in Turn 2's `result.usage` and `result.duration_seconds`. Benchmarks must declare `usage_reporting_semantics = "cumulative_session_trajectory"`, record `turn1_input_tokens`, `turn2_reported_input_tokens`, and `turn2_incremental_input_tokens`, and verify:
   $$\text{agent\_input\_tokens} = \text{turn1\_input\_tokens} + \text{turn2\_incremental\_input\_tokens}$$
5. **Preservation of Failed, Timed-Out, and Abstained Trials**:
   Aggregate summaries (`*-summary.csv`) must account for every cell in `*-cells.csv` (`cells == complete_cells + failed_cells + timed_out_cells + abstained_cells + invalid_incomplete_cells`). Dropping failed or abstained cells from the denominator fails CI.
6. **Baseline Tool Autonomy & Rubric Parity**:
   `raw` baseline cells in `agentic_e2e` evaluations must keep native file/shell/search tools enabled (`native_tools_enabled = true`) and be graded against the exact same `grading_rubric_id` and `total_checks` as `mcp_digest` and `evidence`.

---

## 2. Mandatory Artifact Bundle & Machine-Readable Trace Verification

Every benchmark evaluation must produce four coordinated artifacts via `writeValidatedBenchmarkBundle`:

1. **Per-Cell CSV (`*-cells.csv`)**: One row per `(model_id, study_id, arm, attempt)` trial containing all 73 mandatory columns defined in `MANDATORY_CELL_CSV_COLUMNS`.
2. **Aggregate Summary CSV (`*-summary.csv`)**: One row per `(model_id, effort, arm)` group containing all 30 mandatory columns defined in `MANDATORY_SUMMARY_CSV_COLUMNS`, mathematically reconciled with `*-cells.csv`.
3. **Machine-Readable Source Trace (`*.json` / `*.jsonl`)**: Sanitized cell/event trace (`<WORKSPACE>`, `<HOME>`, `<TMP>`, `[REDACTED]`) referenced by `source_trace_ref` (prose `.md` files are rejected as `invalid_source_trace_format`). For every completed cell in `*-cells.csv`, `validateBenchmarkIntegrityBundle` verifies:
   - The referenced `.json`/`.jsonl` trace exists and parses cleanly (`missing_or_unreadable_source_trace`).
   - A matching cell record (`cell_id` or `${model_id}__${study_id}__${arm}`) exists in the trace (`source_trace_cell_missing`).
   - Cell identity (`model_id`, `study_id`, `arm`, `status`) matches between the CSV and trace (`source_trace_identity_mismatch`).
   - Telemetry (`e2e_wall_ms`, `agent_input_tokens`, `agent_output_tokens`, `checks_passed`, `decision_requests`) and monotonic event ordering match (`source_trace_telemetry_mismatch`).
   - Provenance (`workload_sha256`, `provenance_count`) matches (`source_trace_provenance_mismatch`).
4. **Measurement Receipt (`*-measurement-receipt.json`)**: Validated by `perfdigest.benchmark.measurement-receipt.v1` (`bench/schema/measurement-receipt.v1.schema.json`), recording `experimentId`, `gitSha`, `runnerVersion`, `reconciledFromSourceArtifact`, `cellsCsvRef`, `summaryCsvRef`, `sourceTraceRef`, optional `auxiliaryArtifactRefs`, `sampleSize`, `models`, `arms`, parity attestations, and explicit `limitations`.

---

## 3. Producer Boundary & Unreceipted Artifact Enforcement

- **Producer / Output Boundary (`writeValidatedBenchmarkBundle`)**: Benchmark producers must call `writeValidatedBenchmarkBundle` to emit results. It runs `validateBenchmarkIntegrityBundle` (including machine-readable source-trace reconciliation) **before** writing any file to disk and throws `BenchmarkIntegrityError` on any violation.
- **Directory Audit (`auditBenchmarkResultsDirectory`)**: `scripts/check-benchmark-integrity.mjs` scans every file in `bench/results/`. Any artifact outside `FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS` that is not bound to a valid `*-measurement-receipt.json` bundle fails CI with `untracked_or_receiptless_benchmark_artifact`, preventing unreceipted benchmarks from evading validation.

---

## 4. Cross-PR Coordination (`Refs #18` & `Refs #19`)

PR #20 (`Refs #18`) is the canonical owner of `src/benchmark-integrity.ts`, `src/observability.ts`, and `bench/schema/measurement-receipt.v1.schema.json`. PR #21 (`Refs #19`) keeps byte-identical copies of those shared modules so PR #21's delivery-mode evaluation bundle is validated by the exact same #20 gates prior to merge.

---

## 5. Running Validation Locally and in CI

```bash
npm run test:bench-integrity
node bench/schema/build-schema.mjs --check
node bench/validate.mjs
```
