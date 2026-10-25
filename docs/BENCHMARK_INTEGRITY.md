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

## 2. Mandatory Artifact Bundle

Every benchmark evaluation must produce four coordinated artifacts:

1. **Per-Cell CSV (`*-cells.csv`)**: One row per `(model_id, study_id, arm, attempt)` trial containing all 63 mandatory columns defined in `MANDATORY_CELL_CSV_COLUMNS`.
2. **Aggregate Summary CSV (`*-summary.csv`)**: One row per `(model_id, effort, arm)` group containing all 30 mandatory columns defined in `MANDATORY_SUMMARY_CSV_COLUMNS`, mathematically reconciled with `*-cells.csv`.
3. **Source Trace (`*.json` / `*.jsonl` / `*.md`)**: Sanitized event-level trace (`<WORKSPACE>`, `<HOME>`, `<TMP>`, `[REDACTED]`) linking every cell row (`source_trace_ref`) to its underlying timeline and tool audit.
4. **Measurement Receipt (`*-measurement-receipt.json`)**: Validated by `perfdigest.benchmark.measurement-receipt.v1` (`bench/schema/measurement-receipt.v1.schema.json`), recording `experimentId`, `gitSha`, `runnerVersion`, `reconciledFromSourceArtifact`, `sampleSize`, `models`, `arms`, parity attestations, and explicit `limitations`.

---

## 3. Running Validation Locally and in CI

```bash
npm run test:bench-integrity
node bench/schema/build-schema.mjs --check
node bench/validate.mjs
```
