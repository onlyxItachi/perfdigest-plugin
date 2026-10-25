# AGENTS.md — Repository Engineering & Benchmark Integrity Policy

This document defines **mandatory, repository-wide engineering and measurement rules** for all AI coding agents and human contributors working in `perfdigest-plugin`. These rules are enforced in code and CI (`npm run test:bench-integrity`, `node bench/validate.mjs`, `npm test`).

The scientific question in this repository is **whether a workflow works**, not how to produce favorable benchmark scores. Negative findings, regressions, unsupported runtimes, abstentions, and incomplete measurements are valid engineering results—never reasons to alter baselines, prompts, or grading rubrics.

---

## 1. Six Non-Negotiable Engineering Pillars

### 1.1 Reproducible Experiments
Every benchmark, evaluation, or performance measurement run **must** pin and report:
- Exact `model_id` and reasoning `effort` (`low`, `medium`, `high`, `xhigh`, `max`).
- Runner version (`runner_version`) and git commit (`git_sha`, plus `dirty` state).
- Experiment ID (`run_id`), cell ID (`cell_id`), `study_id`, and `arm` (`raw`, `mcp_digest`, `evidence`).
- Workload/artifact identities and SHA-256 digests (`workload_sha256`).
- Trial/attempt number (`attempt`) and `retries`.
- Tool permissions (`native_tools_enabled`, registered MCP servers, CLI flags).
- Decision provider identity (`provider`, `decision_model`, `provider_execution_mode`, transport) and resource budget.
- **Never** silently change models, efforts, prompts, timeouts, or budgets mid-experiment to rescue an outcome.

### 1.2 Fair Baselines & Access Parity
- **Native tool autonomy**: `raw` agents retain their full authorized native file, search, and shell tool discovery and investigation capabilities (`read_file`, `run_command`, `list_dir`, `grep_search`, etc.). Never disable native tools (`--tools ""`) in an agentic evaluation to make MCP or Evidence appear stronger.
- **Task & rubric parity**: `raw`, `mcp_digest`, and `evidence` arms must receive comparable task descriptions, identical workspace safety boundaries, and the exact same `grading_rubric_id` and `total_checks`.
- **Zero oracle or answer leakage**: Never inject answer keys, oracle-selected report IDs, pre-verified root causes, or privileged grader thresholds into agent prompts or worker inputs.

### 1.3 Real Execution vs. Fixtures
- Label execution modes distinctly:
  - `contract_fixture`: deterministic unit/protocol test with mocked or synthetic inputs.
  - `mock_loopback`: local HTTP loopback server simulating a decision endpoint.
  - `offline_simulation`: deterministic manifest-order selection (`--routing offline`).
  - `live_hosted`: genuine authenticated request to a hosted provider (e.g., Cloudflare Workers AI Clef or OpenAI Decisions).
  - `agentic_e2e`: genuine coding-agent CLI/SDK execution in an isolated study workspace.
- **Never** label a `mock_loopback` or `offline_simulation` run as `live_hosted`, and **never** present an arithmetic sum of independently prefetched sequential stages as observed concurrent E2E execution.

### 1.4 Measured Truth Before Optimization
- Explicit failures (`failed`), timeouts (`timed_out`), router abstentions (`abstained`), null speedups, regressions, and cases where plain `mcp_digest` or `raw` outperforms `evidence` are legitimate results.
- **Never** suppress failed or slow cells, drop failed attempts from aggregate summaries, silently repair grading outputs, or state causal performance explanations without event-level trace proof.

### 1.5 Immutable History & Versioned Reconciliation
- Preserve all published and historical benchmark artifacts, CSVs, schemas, and raw observations unchanged (`bench/results/2026-10-18-*`, `bench/results/2026-10-24-*`, `bench/results/2026-10-25-gemini-iterative-eval*`).
- Version every new runner, schema, result bundle, and post-hoc correction.
- Any corrected interpretation (such as reconciling cumulative session trajectory token reporting) must be written to a new versioned artifact that explicitly links to `reconciledFromSourceArtifact` and documents the mathematical reconciliation.

### 1.6 Secrets, Sanitization & Provenance
- Never write API keys, tokens, credentials, or sensitive local paths (`/home/<user>`, `/tmp/perfdigest-...`) into committed logs, CSVs, or JSON traces; sanitize local paths to `<WORKSPACE>`, `<HOME>`, `<TMP>` and redact secrets to `[REDACTED]`.
- Preserve SHA-256 provenance hashes, byte sizes, exit codes, and sanitized tool argument/result previews.
- Never weaken report immutability checks (pre/post SHA-256 verification) or independent workload verification.

---

## 2. Mandatory Machine-Readable Outputs for Every Benchmark Run

Every comparative benchmark or measurement run must produce:
1. **Per-Cell CSV (`*-cells.csv`)** and **Aggregate Summary CSV (`*-summary.csv`)** with explicit units (`ms`, `tokens`, `usd`, `pct`, `bytes`).
2. **Source-Linked Machine-Readable Trace (`*.json` / `*.jsonl`)** containing ordered monotonic (`monotonicMs`) and UTC (`utcIso`) events.
3. **Measurement Receipt (`*-measurement-receipt.json`)** stating experiment scope, sample size, exact efforts, access parity, limitations, observed outcomes, and artifact links.

### Required Per-Cell Telemetry Fields
- **Identity & Validity**: `run_id`, `cell_id`, `study_id`, `arm`, `model_id`, `effort`, `runner_version`, `git_sha`, `workload_sha256`, `provider`, `provider_execution_mode`, `agent_execution_mode`, `native_tools_enabled`, `attempt`, `retries`, `status` (`complete` | `failed` | `timed_out` | `abstained` | `invalid_incomplete`), `failure_or_invalid_reason`, `grading_rubric_id`, `checks_passed`, `total_checks`, `accuracy_pct`, `verification_status`.
- **Timing (`ms`)**: `start_monotonic_ms`, `end_monotonic_ms`, `e2e_wall_ms` (directly observed monotonic interval `end - start`, never a stage sum), `agent_session_wall_ms`, `turn1_wall_ms`, `turn2_wall_ms`, `mcp_digest_wall_ms`, `decision_latency_ms`, `mcp_extraction_wall_ms`, `evidence_worker_wall_ms`, `verification_wall_ms`, `evidence_delivery_latency_ms`, `parallel_overlap_ms`, `worker_ready_to_consumption_ms`, `critical_path_wall_ms`, `stage_sum_wall_ms`, `service_api_duration_ms`, `service_duration_semantics`, `timing_unavailable_reason`.
- **Model Usage**: `usage_reporting_semantics` (`single_turn_only` | `cumulative_session_trajectory` | `incremental_per_turn` | `unavailable`), `turn1_input_tokens`, `turn2_reported_input_tokens`, `turn2_incremental_input_tokens`, `agent_input_tokens`, `agent_uncached_input_tokens`, `agent_cache_read_tokens`, `agent_cache_creation_tokens`, `agent_output_tokens`, `agent_thinking_tokens`, `usage_unavailable_reason`, plus separate decision-model usage (`decision_requests`, `decision_input_tokens`, `decision_output_tokens`, `decision_model`, `decision_provenance`).
- **Costs**: `agent_cost_usd` (`null` when billing is not directly observed), `agent_cost_basis`, `agent_cost_unavailable_reason`, `decision_cost_usd`, `decision_cost_basis`, `decision_cost_unavailable_reason`. **Never** infer `0` USD from an unreported subscription or quota.
- **Tool & Evidence Audit**: `tool_calls_count`, `turn1_tool_calls_count`, `turn2_tool_calls_count`, `source_trace_ref`, `provenance_count`, `evidence_delivery_mode`, `same_session_observed`, `in_execution_delivery_observed`, `missing_observation_flags`.

---

## 3. Cost Control & CI Verification Gates

- **API Spending**: Never start paid OpenAI or Claude runs or unbounded hosted experiments in automated tests or without explicit user authorization. Keep CI 100% fixture/loopback/offline by default (`PERFDIGEST_RUN_LIVE_DECISIONS=0`, `PERFDIGEST_RUN_CLEF_INTEGRATION=0`).
- **Required Pre-PR Validation**:
  ```bash
  npm run build
  npm test
  go test ./...
  npm run test:bench-integrity
  node bench/schema/build-schema.mjs --check
  node bench/validate.mjs
  ```
