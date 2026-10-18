# Real Workload Evaluation (Stage 2)

This document reports the controlled evaluation of **PerfDigest Evidence** across the four real profiler studies in [`onlyxItachi/PerfDigest-MCP-Bench`](https://github.com/onlyxItachi/PerfDigest-MCP-Bench).

Machine-readable results: [`bench/results/2026-10-18-real-workload-evaluation.json`](../bench/results/2026-10-18-real-workload-evaluation.json) (validated by `node bench/validate.mjs` against [`bench/schema/real-workload-eval.v1.schema.json`](../bench/schema/real-workload-eval.v1.schema.json)).
Reproducible harness: [`bench/real-workloads-eval.mjs`](../bench/real-workloads-eval.mjs).

---

## 1. Experimental Setup & Arms

### Host & Toolchain
- **CPU**: AMD Ryzen AI 9 HX 370 w/ Radeon 890M (`x86_64`, 24 logical CPUs, `perf_event_paranoid = 0`)
- **GPU**: NVIDIA GeForce RTX 4060 Laptop GPU (`sm_89`, 32.0 MB L2 cache, CUDA `nvcc` 13.2, Nsight Compute `ncu` 2026.2.1 with `ncu_report` Python PRI module)
- **C/C++ Toolchain**: `clang++-22` 22.1.3, `gcc` 15.2.0, `cmake` 4.2.1, `ninja` 1.12.1, Linux `perf` 7.0.0
- **Agent & Runtime**: `codex-cli 0.163.0` (authenticated via existing ChatGPT login — **zero OpenAI Platform API credits used**), Node.js `v22.22.1`, `perfdigest-mcp 1.3.0`
- **Memory & CPU Accounting**: Linux cgroup v2 (`systemd-run --user --scope` reading `memory.peak` and `cpu.stat`) paired with GNU `/usr/bin/time -v` (`ru_maxrss`).

### Evaluated Arms

| Arm | Description | MCP Session Lifecycle | Decision Routing & Provenance | Independent Verifier |
|---|---|---|---|---|
| **`A_codex_alone`** | Codex CLI alone operating on the raw/static text surface (e.g., `ptxas -v`, `cold.ninja_log`, or source files) without PerfDigest MCP digestion of binary/multi-MB profiler traces | `0` spawns, `0` calls | None | Not executed |
| **`B_codex_perfdigest_mcp`** | Codex CLI + PerfDigest MCP digesting all $K$ candidate profiler reports sequentially via one-shot MCP subprocesses after the initial analysis turn | $K$ spawns, $K$ calls (`0` reused) | None (all digests delivered unrouted) | Not executed |
| **`C_codex_perfdigest_evidence`** | Codex CLI + PerfDigest Evidence overlapping the initial analysis turn with bounded MCP session reuse across all $K$ candidate reports, decision routing to the highest-signal report with full SHA-256 provenance, abstention guard, and independent verification before the review turn | `1` spawn, $K$ calls ($K - 1$ reused) | Routed (`accepted` at $\ge 0.65$ or `abstained` $\to$ `needs_review`) with SHA-256 provenance for all $K$ reports | Executed & verified before review turn |

---

## 2. Candidate Studies, Artifacts & Compression

| Study ID | Source Study in `PerfDigest-MCP-Bench` | Capture Mode | Candidate Reports ($K$) | Raw Bytes $\to$ Digest Bytes (Compression) |
|---|---|---|---|---|
| **`cuda_opt_loop`** | `DEMANDING_WORKLOADS_4_CUDA_OPT_LOOP_2026-07-19.md` | **Live hardware capture** (`nvcc -arch=sm_89` + `ncu` on RTX 4060 Laptop GPU) | `ptxas-codegen` (`ptxas`), `ncu-roofline` (`ncu-rep`) | `2,351 B -> 1,051 B` (`2.24x`), `76,816 B -> 1,859 B` (`41.32x`) |
| **`cpp_build_loop`** | `DEMANDING_WORKLOADS_3_CPP_BUILD_LOOP_2026-07-19.md` | **Artifact + live toolchain** (`clang++-22 -ftime-trace` on `workloads/cpp_project`) | `cmake-cold`, `cmake-warm`, `ninja-cold`, `clang-heavy-tu` (`4` reports) | `1,544,826 B -> 775 B` (`1,993.32x`), `297,280 B -> 763 B` (`389.62x`), `565 B -> 760 B` (`0.74x`), `745,515 B -> 837 B` (`890.70x`) |
| **`pytorch_inductor_training`** | `DEMANDING_WORKLOADS_2_TORCH_TRAINING_2026-07-19.md` | **Artifact-level boundary** (8-step Kineto `chrome-trace` artifacts; host Python lacks multi-GB CUDA PyTorch wheel) | `eager-kineto-trace`, `compiled-kineto-trace` (`chrome-trace`) | `118,963 B -> 892 B` (`133.37x`), `117,579 B -> 980 B` (`119.98x`) |
| **`linux_perf_cpu`** | `CROSS_BACKEND_2026-06-15.md` | **Live hardware capture** (`perf stat -j` + `perf record/report` at `perf_event_paranoid=0` on Ryzen AI 9 HX 370) | `perf-stat` (`perf-stat-json`), `perf-report` (`perf-report`) | `917 B -> 666 B` (`1.38x`), `688 B -> 1,534 B` (`0.45x`) |

---

## 3. Diagnostic Accuracy, False Conclusions & Validated Speedups

Each study grades 5 objective, falsifiable diagnostic criteria against ground-truth profiler counters and executes an independent correctness and performance verifier for the concrete optimization fix.

| Study | Arm A (`A_codex_alone`) Accuracy / Unmeasured | Arm B (`B_codex_perfdigest_mcp`) Accuracy / Unmeasured | Arm C (`C_codex_perfdigest_evidence`) Accuracy / Unmeasured | Validated Optimization Fix & Speedup | Independent Verifier |
|---|---|---|---|---|---|
| **`cuda_opt_loop`** | `0/5` (`0.00`) — cannot read binary `.ncu-rep` DRAM peak (`89.95%`) or kernel durations | `5/5` (`1.00`) — `0` false conclusions | `5/5` (`1.00`) — `0` false conclusions | Coalesced padded `[32][33]` shared-memory transpose (`v0` `4.285 ms` $\to$ `v1` `2.328 ms`, **`1.84x` speedup** on warm RTX 4060 boost clocks; `2.63x` under locked `ncu` replay) | `./cuda_opt_bench` (exit `0`, full 67M-element device compare + 2M-sample spot check) |
| **`cpp_build_loop`** | `1/5` (`0.20`) — identifies slowest TU from `cold.ninja_log`, misses `InstantiateClass` (`3,496,667 us`), `ExecuteCompiler` (`1,707,440 us`), and CMake `project()` cold compiler detection | `5/5` (`1.00`) — `0` false conclusions | `5/5` (`1.00`) — `0` false conclusions | Replace exponential recursive `constexpr fib(27)` in `lib_template_heavy.cpp` with $O(n)$ iterative `constexpr` loop (`1,291.46 ms` $\to$ `933.45 ms`, **`1.38x`–`1.52x` compile speedup**) | `./verify_cpp_fix` (exit `0`, links `heavy_fixed_0.o` and verifies `bl::heavy_checksum()`) |
| **`pytorch_inductor_training`** | `1/5` (`0.20`) — cannot see Kineto `triton_red_fused_*` kernel name or `262.4 us` 8-step duration | `3/5` (`0.60`) — identifies `triton_red_fused_*` and `262.4 us` duration, misses 1-vs-4 kernel pairing sign | `5/5` (`1.00`) — `0` false conclusions | `torch.compile(model)` AOTAutograd forward+backward fusion of LayerNorm+GELU (`182.70 us/step` $\to$ `168.40 us/step`, **`1.08x` GPU kernel speedup**) | `node verify_torch_traces.mjs` (exit `0`, verifies kernel total reduction + preserved `AdamFunctor`) |
| **`linux_perf_cpu`** | `2/5` (`0.40`) — cannot read `compute_bound_poly` `self_pct` (`94.19%`) or program IPC (`0.5164`) without `perf` digests | `5/5` (`1.00`) — `0` false conclusions | `5/5` (`1.00`) — `0` false conclusions | 4-step composed affine recurrence (`a = a * m4 + b4`) breaking the 2-step serial FMA latency chain in `compute_bound_poly` (`6,002.19 ms` $\to$ `1,089.34 ms`, **`5.51x` wall speedup**) | `node verify_cpu_fix.mjs` (exit `0`, `sink1` exact match, `sink2` relative error `< 1e-5`) |
| **Overall Summary** | **Mean Accuracy: `0.20`** (`10` unmeasured/false conclusions) | **Mean Accuracy: `0.90`** (`1` false conclusion) | **Mean Accuracy: `1.00`** (`0` false conclusions, `4/4` verifiers passed) | **`1.84x` CUDA, `1.38x` C++, `1.08x` PyTorch, `5.51x` Linux CPU** | **`4/4` independent verifiers exit `0`** |

---

## 4. Cost Breakdown, MCP Session Reuse & Process-Tree Resources

Every run separates **agent/process execution overhead** (`agentExecutionOverheadMs`) from **model inference latency** (`modelInferenceMs`), **PerfDigest MCP engine latency** (`mcpEngineMs`), **independent verifier latency** (`verificationMs`), and **concurrent overlap** (`evidenceModelOverlapMs`).

| Study | Arm | Wall (ms) | Agent Overhead (ms) | Model Inference (ms) | MCP Engine (ms) | Verifier (ms) | Overlap Saved (ms) | MCP Spawns / Calls / Reused | cgroup v2 Tree Peak (KB) | Single-Proc `ru_maxrss` (KB) | MCP User+Sys CPU (ms) | Delivered Payload Bytes |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| **`cuda_opt_loop`** ($K=2$) | Arm A | `11,379.64` | `73.31` | `11,306.32` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `10,580` | `42,132` | `24.87` | `2,689` |
| | Arm B | `10,537.07` | `76.96` | `9,630.50` | `829.61` | `0.00` | `0.00` | `2 / 2 / 0` | `225,516` | `189,824` | `1,074.63` | `2,944` |
| | Arm C | `12,158.65` | `73.06` | `10,756.75` | `439.88` | `1,328.83` | `439.98` | `1 / 2 / 1` | `219,168` | `189,880` | `706.47` | `2,174` |
| **`cpp_build_loop`** ($K=4$) | Arm A | `12,329.88` | `67.16` | `12,262.72` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `11,884` | `41,928` | `24.82` | `709` |
| | Arm B | `14,575.50` | `73.65` | `12,936.12` | `1,565.74` | `0.00` | `0.00` | `4 / 4 / 0` | `112,752` | `96,080` | `1,748.67` | `3,196` |
| | Arm C | `11,265.47` | `73.77` | `11,187.82` | `500.43` | `3.89` | `500.43` | `1 / 4 / 3` | `123,680` | `102,120` | `634.11` | `1,175` |
| **`pytorch_inductor_training`** ($K=2$) | Arm A | `12,583.79` | `77.70` | `12,506.09` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `10,912` | `41,620` | `26.18` | `1,948` |
| | Arm B | `15,199.64` | `75.54` | `14,389.35` | `734.75` | `0.00` | `0.00` | `2 / 2 / 0` | `112,196` | `94,512` | `966.75` | `1,920` |
| | Arm C | `12,022.44` | `72.54` | `11,928.58` | `385.51` | `21.32` | `385.52` | `1 / 2 / 1` | `105,924` | `89,856` | `644.44` | `1,332` |
| **`linux_perf_cpu`** ($K=2$) | Arm A | `9,563.43` | `77.85` | `9,485.58` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `10,672` | `41,968` | `22.21` | `2,298` |
| | Arm B | `14,208.42` | `71.32` | `13,299.28` | `837.82` | `0.00` | `0.00` | `2 / 2 / 0` | `105,416` | `89,460` | `1,060.68` | `2,229` |
| | Arm C | `10,956.52` | `74.32` | `9,784.49` | `389.19` | `1,097.72` | `389.19` | `1 / 2 / 1` | `105,932` | `89,868` | `626.92` | `1,840` |

### Key Quantitative Observations
1. **Bounded MCP Session Reuse Cuts Engine Latency & CPU by `47%`–`68%`**:
   - For $K=2$ candidate reports (`cuda_opt_loop`, `pytorch_inductor_training`, `linux_perf_cpu`), reusing a single bounded PerfDigest MCP stdio session (`1` spawn, `2` calls) reduces `mcpEngineMs` from `734.75–837.82 ms` to `385.51–439.88 ms` (**`-47%` to `-54%`**) and reduces cgroup v2 CPU time by **`-33%` to `-41%`**.
   - For $K=4$ candidate reports (`cpp_build_loop`), reusing a single bounded MCP session (`1` spawn, `4` calls) reduces `mcpEngineMs` from `1,565.74 ms` to `500.43 ms` (**`-68.0%`**, saving `1,065.31 ms` and **`-63.7%`** CPU time).
2. **Concurrent Prefetch Fully Hides MCP Engine Time Behind Initial Analysis**:
   - In Arm C, `evidenceModelOverlapMs` equals `100%` of `mcpEngineMs` (`385.51–500.43 ms`), because bounded MCP digestion completes while the initial Codex analysis turn (`~3.5–5.0 s`) is in flight.
3. **Process-Tree Memory (`cgroup_v2_tree_peak`) vs Single-Process `ru_maxrss`**:
   - In `cuda_opt_loop`, loading NVIDIA's native `_ncu_report.so` PRI library inside the Python `perfdigest-mcp` child raises the process-tree peak (`cgroupTreePeakKb`) to `~219–225 MB` vs `~106–124 MB` for pure-Python JSON/text parsers (`cpp_build_loop`, `pytorch_inductor_training`, `linux_perf_cpu`).

---

## 5. Abstention Guard & Provenance Verification

For every study, `bench/real-workloads-eval.mjs` also tests the below-threshold abstention path (`confidence = 0.61 < 0.65` policy threshold):
- `decisionOutcome`: `'abstained'`
- `pipelineStatus`: `'needs_review'`
- `evidenceDeliveredCount`: `0` (no unverified/low-confidence evidence is injected into the review turn)
- `provenanceRetainedCount`: $K$ (`2` for CUDA/PyTorch/Linux perf, `4` for C++ build) with `100%` matching SHA-256 hashes and `delivered: false`.

---

## 6. Architectural & Engine Findings Discovered During Evaluation

1. **`summarize_report(top_n=5)` Truncation on Multi-Launch `ncu-rep` and Clang `[total]` Spans**:
   - PerfDigest MCP's `summarize_report` tool defaults to `top_n = 5` sorted by `duration_us` descending.
   - When `cuda_opt_bench` ran with `ROUNDS = 3` (`9` kernel launches), the 3 launches of `kernel_v0_naive` (`~6,018 us` each) and 2 launches of `kernel_v2_vectorized` (`~2,337 us` each) filled all 5 slots of `summarize_report(top_n=5)`, completely omitting `kernel_v1_coalesced` (`~2,291 us`) from the summary! Capturing 1 launch per variant (`ROUNDS = 1` for `ncu`) or increasing `top_n` / deduplicating repeated kernel launches in `ncu-rep` ensures faster variants are not hidden behind multiple launches of slower variants.
   - Similarly, in Clang `-ftime-trace` (`template_heavy.ftime-trace.json`), Clang emits both raw phase spans (`ExecuteCompiler`, `Frontend`) and `Total ... [total]` aggregate spans, plus summed recursive `InstantiateClass` spans (`3,496,667 us`), pushing `EvaluateAsInitializer` (`636,707 us`) to rank #9 outside `top_n = 5`.
2. **Scope & Limitations**:
   - Measurements reflect a single host (AMD Ryzen AI 9 HX 370 + NVIDIA RTX 4060 Laptop GPU) and a single live Codex CLI trial per study/arm; LLM inference wall time varies with network conditions.
   - Study 3 (`pytorch_inductor_training`) is evaluated at the Kineto `chrome-trace` artifact boundary because the local host Python environment does not install the multi-GB CUDA PyTorch wheel.
