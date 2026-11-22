# Production-Representative HPC Evaluation Contract (`perfdigest.hpc-eval-contract.v1`)

This document specifies the artifact-grounded HPC evaluation contract encoded in [`bench/hpc-eval-contract.json`](../bench/hpc-eval-contract.json), validated by [`bench/schema/hpc-eval-contract.v1.schema.json`](../bench/schema/hpc-eval-contract.v1.schema.json) and [`bench/schema/hpc-contract-validator.mjs`](../bench/schema/hpc-contract-validator.mjs) (`node bench/validate.mjs`), and scaffolded by [`scripts/evaluate-hpc-workloads.mjs`](../scripts/evaluate-hpc-workloads.mjs).

---

## 1. Arms, Delivery Stratification & Symmetric Workspace Policies

### 1.1 Three Primary Comparison Arms (Preserved)
All three primary arms operate on the **exact same zero-leakage `git archive` pre-fix snapshot**, **identical answer-neutral `agentPrompt` + `outputSchema`**, **identical genuine profiler/build artifacts**, **identical 25-criterion rubric per task**, and **identical workspace write policy**:

| Arm | Agent Surface | Provenance & Independent Verifier | Parity Rules |
|---|---|---|---|
| **`raw`** | Autonomous coding agent with native tools enabled (`native_tools_enabled = true`), zero PerfDigest MCP / Evidence tools. | External harness runs independent verifier on the declared target tree. | Identical workspace access & prompt; zero hints or asymmetric instructions. |
| **`mcp_digest`** | Native tools + direct `perfdigest-mcp` stdio server (`summarize_report`, `list_kernels`, `get_metrics`, `compare_metrics`, `expand`, `platform_capabilities`, `suggest_profile_command`). | External harness runs independent verifier on the declared target tree. | Identical pinned `perfdigest-mcp` version as `evidence`; agent chooses tools freely. |
| **`evidence`** | Native tools + `perfdigest-plugin` bounded MCP session reuse, decision routing + abstention guard, 64-char SHA-256 provenance (`run.json`), pre-delivery independent verifier, and `formatAgentEvidence` compact envelope. | Built-in provenance + pre-delivery verifier receipt + external rubric grading. | Abstained/failed/timed-out cells remain in all denominators per [`docs/BENCHMARK_INTEGRITY.md`](./BENCHMARK_INTEGRITY.md). |

### 1.2 Canonical `EvidenceDelivery` Stratification (within `evidence`)
Delivery strategy is evaluated separately from arm quality and emitted in `cells.csv#evidence_delivery_mode` and `source-trace.json` using the repository's canonical `EvidenceDelivery` vocabulary (matching `scripts/evaluate-live-steering.mjs` and `scripts/evaluate-delivery-modes.mjs`):

| Contract Delivery Strategy | Canonical `evidence_delivery_mode` |
|---|---|
| `in_execution` | `in_execution_async_input` |
| `in_execution_tool_delivery` | `in_execution_tool_delivery` |
| `single_turn` | `single_turn_with_evidence` |
| `two_turn` | `same_session_next_turn` |
| `skill_background_worker` | `skill_background_worker` |
| non-evidence (`raw`, `mcp_digest`) | `none` |

### 1.3 Symmetric Workspace Policies (`read_only_diagnosis` vs `autonomous_patch_and_verify`)
Every arm within a run MUST share the exact same write/tool policy:
- **`read_only_diagnosis`**: All 3 arms (`raw`, `mcp_digest`, `evidence`) are strictly read-only on the clean pre-fix snapshot (`writeAccessAllowed = false`). Only read-only reproducer/baseline verifiers (`targetTree = clean_pre_fix_snapshot`) and diagnosis/design criteria apply; patch-dependent implementation verifiers (`appliesInModes = ['autonomous_patch_and_verify']`) are explicitly excluded from cross-arm scoring.
- **`autonomous_patch_and_verify`**: All 3 arms receive identical isolated writable copies of the clean pre-fix snapshot (`writeAccessAllowed = true`). Evidence arms retrieve verified Evidence via MCP pull (`in_execution_tool_delivery`) or the Skill-controlled OS-native background worker (`skill_background_worker`) rather than the read-only `investigate()` prompt wrapper. External post-fix verifiers (`targetTree = arm_patched_workspace`) execute against each arm's patched workspace.

### 1.4 Answer-Neutral Output Schema, Automated vs Blind-Judge Split & Zero Leakage
- **100-Criterion Accounting**: Exactly `4` task slots $\times$ `25` criteria = `100` criteria (`75` grounded across Tasks 1–3 + `25` reserved in `task_4_unselected`), partitioned 5×5 across Categories **A** (Profiler Grounding), **B** (Root-Cause Localization), **C** (Correctness/Boundary Invariants), **D** (Scope Honesty/Falsification), and **E** (Remediation & Independent Verification).
- **Answer-Neutral Exposed Schema**: Every confirmed task exposes the same generic HPC JSON schema (`measured_metrics`, `top_profiler_units`, `localized_files`, `localized_symbols`, `cited_commits_and_refs`, `root_cause_summary`, `invariants_and_boundaries`, `scope_limitations`, `remediation_proposal`, `patch_applied`, `verification_notes`) plus task-neutral `neutralMetricKeys`. `bench/schema/hpc-contract-validator.mjs` fails closed if any automated criterion references an unexposed key OR if any string in `taskBrief`, `workspaceInstructions`, `outputSchema` (keys & values), or `neutralMetricKeys` contains a forbidden oracle substring or `fixSha`.
- **Honest Grading Split**:
  - **`deterministic_automated` (`automated: true`)**: Strictly objective numeric ranges/tolerances, `null != 0` checks, exact file/symbol/commit matches on exposed neutral fields, and independent external `verifierReceipts` (`exit_code_equals`, used strictly where verifiers discriminate across arms' patched workspaces). Zero self-reported boolean checkboxes and zero reference-fix design constants hinted in `neutralMetricKeys`.
  - **`blind_rubric_judge` (`automated: false`)**: Mechanistic explanations, nuanced invariant designs, scope honesty, anti-overclaim judgments, and read-only reproducer reporting (`T2-23..25`) carry an explicit grader-only `judgeRubric` (`targetFields`, `passCondition`, `failCondition`, `evidenceRequired`). Without external blind-judge verdicts supplied, the harness records them explicitly as `pending_blind_judge` (`passed: null`) and **excludes unjudged criteria from `total_checks` / `accuracy_pct`** (recording `contract_total_criteria`, `graded_criteria_count`, `pending_blind_judge_count`, `not_applicable_count`, and `grading_complete` in `source-trace.json`) — never faking passes and never silently penalizing pending judge items as failures.
- **Zero Local Paths**: No host-specific local user, root, or temp directory paths are permitted anywhere in the contract, schema, docs, or receipts; use `<REPO_ROOT>`, `<SNAPSHOT_DIR>`, `<ARTIFACT_DIR>`, `<BUILD_DIR>`, and `<VENV_PYTHON>` placeholders.

---

## 2. `PerfDigest-MCP` Format Compatibility & Artifact Capture Prerequisites

`perfdigest-mcp` (`1.2.0` / `1.3.0`) registers **14 readable backends** (`ncu-rep`, `ncu-csv`, `rocprof-csv`, `perf-stat-json`, `perf-report`, `metal-trace`, `chrome-trace`/`torch-trace`, `ptxas-verbose`, `clang-time-trace`, `cmake-profile`, `ninja-log`, `cargo-json`, `criterion`, `gha-log`, `git-numstat`) across 7 tools.

- **Important Format Gap**: `perfdigest-mcp` does **not** include a Python `cProfile`/`pstats` adapter or custom benchmark-verdict JSON adapter. Task 1 therefore requires genuine `linux_perf` (`perf-stat-json` + `perf-report`) + `cargo-json` captures rather than reusing `cProfile`.

---

## 3. Task Matrix (75 Grounded + 25 Reserved = 100 Criteria)

### Task 1 — `gafime_rc3_ingestion` (Confirmed, `T1-01..T1-25`)
- **Supported Modes**: `read_only_diagnosis`, `autonomous_patch_and_verify` (default).
- **Repo / Pre-fix Snapshot**: `onlyxItachi/GAFIME` exported via `git archive` at `c85178fe705ed71ac65d6c59203ce5dd76524239` (zero `.git`). Fix reference (grader-only): PR #111 (`2edd4df`) $\to$ `v1.0.0-rc.3` (`b510b4dd9af4c47602846b9a58702ed005fe67e4`).
- **Required Genuine Artifacts**: `perf-stat-json` (`dataload` vs `direct` on `100k x 100` Parquet), `perf-report`, and `cargo-json` (`crates/gafime-py`). *(The archived 31.8 MB RT-Core GBDT `.ncu-rep` is unrelated and excluded.)*
- **Independent Verifiers (`autonomous_patch_and_verify`, targeting `arm_patched_workspace`)**:
  1. `cargo test --manifest-path <ARM_WORKSPACE>/crates/gafime-py/Cargo.toml acquisition`
  2. `<VENV_PYTHON> -m pytest <VERIFIER_DIR>/test_v1_native_ingestion.py <VERIFIER_DIR>/test_v1_ingest_contracts.py -q`
  3. `<VENV_PYTHON> <VERIFIER_DIR>/perf_14_ingest_budget.py --budget <VERIFIER_DIR>/ingest_cost_budget.json ...`

### Task 2 — `triton_xdna_106_abi` (Confirmed, `T2-01..T2-25`)
- **Supported Modes**: `read_only_diagnosis` only (upstream source trees are immutable).
- **Repo / Frozen Snapshot**: Exported via `git archive` (zero `.git` anywhere, including nested `sources/*`) from `triton-lang/triton@675c59878aa2280b31f722aaf42b825fcee21de8`, `amd/Triton-XDNA@e0667baa81c9dba66e8163c23e4683a144505cef`, `facebookincubator/triton-shared@0c27923cbcb51f1565ae39c2de0e2245babb6067`, plus pinned LLVM `4611156032e1ebac68b2b8f6107b1475a7c60800`. All investigation docs/results are excluded and recursively checked by preflight.
- **Required Genuine Artifacts**: Sanitized `ninja-log` (`native_registry.ninja_log`, `initializer.ninja_log` — verified with `perfdigest-mcp`), plus freshly captured `cmake-profile` and `clang-time-trace` on neutralized probe builds.
- **Independent Verifiers (`read_only_diagnosis`, targeting `clean_pre_fix_snapshot`)**:
  1. `patch --dry-run -p1 -d <SNAPSHOT_DIR>/sources/triton < <SNAPSHOT_DIR>/sources/triton-xdna/third_party/triton.patch` (expected exit `1`)
  2. `bash <VERIFIER_DIR>/probes/initializer/reproduce.sh <SNAPSHOT_DIR>` (expected exit `1`)
  3. `bash <VERIFIER_DIR>/probes/native_registry/reproduce.sh <SNAPSHOT_DIR> <LLVM_PREFIX> <ENV_PREFIX>` (expected exit `0`, `10/10` exact outcomes)

### Task 3 — `gafime_v041_mutual_info` (Confirmed, `T3-01..T3-25`)
- **Supported Modes**: `read_only_diagnosis`, `autonomous_patch_and_verify` (default).
- **Repo / Pre-fix Snapshot**: `onlyxItachi/GAFIME` exported via `git archive` at tag `v0.4.0` (`a9a43bc4505034cb2aef64bbe4fc54f0a53b89a5`, zero `.git`). Fix reference (grader-only): tag `v0.4.1` (`2a4fc9114b7321201fda80abc6978777e4dc7b79`).
- **Required Genuine Artifacts**: `ncu-rep` (`tests/profile_discrete_selection_cuda_ncu.py`), `ptxas-verbose` (`nvcc -arch=sm_89 -O3 -Xptxas -v`), `perf-stat-json` + `perf-report`, and `cargo-json`.
- **Independent Verifiers (`autonomous_patch_and_verify`, targeting `arm_patched_workspace`)**:
  1. `<VENV_PYTHON> -m pytest <VERIFIER_DIR>/test_discrete_selection_scores.py <VERIFIER_DIR>/test_discrete_functions.py -q`
  2. `cargo test --manifest-path <ARM_WORKSPACE>/src/cpu/gafime_cpu/Cargo.toml`
  3. `<VENV_PYTHON> -m pytest <VERIFIER_DIR>/test_discrete_native_gpu.py -q`
  4. `<VENV_PYTHON> <ARM_WORKSPACE>/tests/profile_discrete_selection_cuda_ncu.py --samples 60000 --features 32 --candidates 8192 --seed 42`

### Task 4 — `task_4_unselected` (Unselected Placeholder, `T4-01..T4-25`)
- Explicitly `status: "unselected"`, `selectedByUser: false`, `runnable: false`.
- Runners MUST skip Task 4 and disclose its exclusion in `measurement-receipt.json#limitations` (never emitting `0/25` rows).

---

## 4. Running the Harness & Fail-Closed Preflight Gates

```bash
# 1. Validate schema sync and 100-criterion contract invariants (single source of truth)
node bench/schema/build-schema.mjs --check
node bench/validate.mjs

# 2. Run arm-neutral contract_fixture smoke (0 LLM/API calls; writes receipt-validated bundle under work/bench-results/)
node scripts/evaluate-hpc-workloads.mjs

# 3. Live mode fails closed unless explicit confirmation, pinned perfdigest-mcp version,
#    recursively clean git-archive snapshots with verified snapshotTreeSha256, and genuine
#    pre-captured profiler artifacts with verified SHA-256 are all supplied:
node scripts/evaluate-hpc-workloads.mjs --mode live --confirm-live \
  --perfdigest-mcp-version 1.2.0 \
  --snapshot-manifest <PATH_TO_SNAPSHOT_MANIFEST> \
  --artifact-manifest <PATH_TO_ARTIFACT_MANIFEST>
```

> **`contract_fixture` Honesty**: Default `--mode contract_fixture` supplies **identical arm-neutral synthetic values** to `raw`, `mcp_digest`, and `evidence` (zero baked-in hypothesis bias against `raw`), exercising only contract plumbing, `automated` vs `blind_rubric_judge` accounting, `task_4_unselected` skipping, deliberate failure/abstention preservation, and `writeValidatedBenchmarkBundle` / `auditBenchmarkResultsDirectory`. Live arm execution parity is explicitly marked `liveBaselineParityVerified: false` in trace findings and `receipt.limitations`.

---

## 5. Open Decisions Blocking a Full Live Matrix Run

1. **`DEC-01` (Blocking)**: Sequentially capture genuine `perfdigest-mcp`-supported artifacts on target hardware (`linux_perf` + `cargo-json` for Task 1; `cmake-profile` + `clang-time-trace` for Task 2; `ncu-rep` + `ptxas-verbose` + `linux_perf` + `cargo-json` for Task 3).
2. **`DEC-02` (Non-blocking for Tasks 1–3; blocking for full 100-criterion run)**: User designation of Task 4.
3. **`DEC-03` (Blocking)**: Pin one exact `perfdigest-mcp` version (`1.2.0` vs `1.3.0`) across `mcp_digest` and `evidence`, and confirm Python `cProfile` stays out of scope.
4. **`DEC-04` (Non-blocking)**: Confirm Task 1 stays scoped to PR #111 (keeping PR #114 Core benchmark calibration headroom separate).
5. **`DEC-05` (Blocking)**: Confirm live `evaluationMode` (`read_only_diagnosis` vs `autonomous_patch_and_verify`) for Tasks 1 and 3 on the 16 GB host.
6. **Schema Follow-Up (`src/benchmark-integrity.ts`, non-blocking for contract PR)**: In a dedicated follow-up touching `src/benchmark-integrity.ts` and `bench/schema/formats.mjs`, relax `measurement-receipt.v1` so `contract_fixture` receipts may emit `baselineParityVerified: false` natively (currently forced to `true` by the shared Issue #18 validator and explicitly disclosed via `LIVE_BASELINE_PARITY_UNVERIFIED` + `liveBaselineParityVerified: false` in `source-trace.json`).
