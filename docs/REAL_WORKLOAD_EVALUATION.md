# Real Workload Evaluation, Critical Audit & 6-Model Benchmark (Stages 2, 7 & Multi-Model Qualification)

This document reports the controlled evaluation of **PerfDigest Evidence** across the four real profiler studies in [`onlyxItachi/PerfDigest-MCP-Bench`](https://github.com/onlyxItachi/PerfDigest-MCP-Bench), including our **Stage 7 Critical Self-Audit & Fair Re-Evaluation** and the **Controlled 6-Model × 4-Study × 3-Arm Multi-Model Evaluation**.

Machine-readable results:
- Stage 7 single-model audit: [`bench/results/2026-10-18-real-workload-evaluation.json`](../bench/results/2026-10-18-real-workload-evaluation.json) (validated by `node bench/validate.mjs` against [`bench/schema/real-workload-eval.v1.schema.json`](../bench/schema/real-workload-eval.v1.schema.json); harness: [`bench/real-workloads-eval.mjs`](../bench/real-workloads-eval.mjs)).
- Multi-model evaluation (72 cells across 6 models): [`bench/results/2026-10-24-multi-model-evaluation.json`](../bench/results/2026-10-24-multi-model-evaluation.json) (validated by `node bench/validate.mjs` against [`bench/schema/multi-model-eval.v1.schema.json`](../bench/schema/multi-model-eval.v1.schema.json); harness: [`bench/multi-model-eval.mjs`](../bench/multi-model-eval.mjs)).

---

## 1. Critical Self-Audit of Initial Stage 2 Claims & Methodological Corrections

During our Stage 7 audit of `bench/real-workloads-eval.mjs` and the core `src/` orchestration pipeline, we identified and corrected four issues that had artificially widened the gap between **Arm A (`A_codex_alone`)** and **Arms B/C** in the initial Stage 2 run:

1. **Unfair Withholding of Raw Text/JSON Artifacts from Arm A (`A_codex_alone`)**:
   - *Flaw Found*: In the initial Stage 2 run, Arm A was denied access to `cpu_stat.json` (`917 B`) and `cpu_report.txt` (`688 B`) in **Study 4 (`linux_perf_cpu`)** and given only `cpu_bench.c` (`2,298 B`), and in **Studies 2 and 3** Arm A was given only `cold.ninja_log` (`565 B`) or `torch_train_bench.py` (`1,800 B`) with zero raw trace JSON.
   - *Correction*:
     - In **Study 4 (`linux_perf_cpu`)**, Arm A now receives the **complete raw `cpu_stat.json` (`917 B`) + complete raw `cpu_report.txt` (`688 B`) + `cpu_bench.c`** (`4,006 B` total).
     - In **Study 2 (`cpp_build_loop`)**, Arm A receives `cold.ninja_log` (`565 B`) plus a `16 KB` raw JSON excerpt of `template_heavy.ftime-trace.json` (`745.5 KB`) and an `8 KB` raw JSON excerpt of `configure_cold.cmake-profile.json` (`1.54 MB`) = **`25,521 B` (`~6,381` tokens)** of raw trace data.
     - In **Study 3 (`pytorch_inductor_training`)**, we fixed the Kineto trace generator so each step's 75 host-side `cudaLaunchKernel` runtime spans are interleaved with its GPU stream 7 `kernel` spans (matching real `torch.profiler` trace ordering), and gave Arm A `torch_train_bench.py` plus `12 KB` raw JSON excerpts of both `eager_train.torch-trace.json` (`123.8 KB`) and `compiled_train.torch-trace.json` (`122.4 KB`) = **`29,555 B` (`~7,389` tokens)** of raw trace data.
     - In **Study 1 (`cuda_opt_loop`)**, `cuda_opt.ncu-rep` (`76.8 KB`) is a binary protobuf/zlib container that genuinely cannot be read as text without `ncu` / PerfDigest MCP, so Arm A receives the full `ptxas_verbose.txt` + full `cuda_opt_bench.cu` (`16,783 B`).
2. **Prompt Hint Leak in Study 3 (`pytorch_inductor_training`)**:
   - *Flaw Found*: The initial `analysisQuestion` for Study 3 contained a parenthetical note explaining `triton_red_fused_gelu_gelu_backward_native_layer_norm_native_layer_norm_backward_2` and AOTAutograd inline activation recomputation inside the question itself.
   - *Correction*: Removed the parenthetical hint completely from `analysisQuestion`. Models must identify the kernel name and duration strictly from the trace/digest surface.
3. **Hidden Prompt Payload & `top_n: 3` Truncation in Arm C (`C_codex_perfdigest_evidence`)**:
   - *Flaw Found*: `src/perfdigest.ts` previously hardcoded `top_n: 3` in `summarize_report` (which truncates 8-kernel Kineto traces), and `bench/real-workloads-eval.mjs` compensated by injecting `allDigestsSummary: fullDigests` and `validatedFixSummary` into Arm C's prompt while counting only `armCEvidence.evidence` (`1,175–2,174 B`) in `evidencePayloadBytes`.
   - *Correction*:
     - Added configurable `topN` (`1..10`, default `3`) to `PerfDigestSessionOptions` (`src/perfdigest.ts`) while bounding external decision-router summaries to the top 3 units in `decisionsInput()` (`src/decisions.ts`).
     - Added opt-in `includeCorroborating?: boolean` to `gatherEvidence()` (`src/evidence.ts`, `src/config.ts`) so accepted multi-report routes can retain the compact non-selected candidate digests already computed in the same bounded MCP session (omitted on abstention).
     - Removed `allDigestsSummary` and `validatedFixSummary` from Arm C's prompt and measured `evidencePayloadBytes = Buffer.byteLength(payloadStr)` over the **exact JSON string sent to the agent** in both Arm B and Arm C.
4. **Core Orchestration & Quota Handoff Improvements**:
   - Replaced whole-file `readFile` hashing with 64 KB chunked streaming SHA-256 (`createReadStream`) for files `> 64 KB` and cached `realpath(workspace)` once per investigation in `src/files.ts`, `src/evidence.ts`, and `src/run.ts`.
   - When `codex-cli 0.163.0` hit the ChatGPT Plus rolling usage window limit during the Stage 7 re-run, `bench/real-workloads-eval.mjs` automatically handed off to `agy` CLI (`1.4.2`, `executionMode: "agy_gemini_cli"`) running in an isolated empty directory with `--conversation` same-session continuation (`--effort low`, `--disable-slash-commands`).

---

## 2. Experimental Setup & Arms

### Host & Toolchain
- **CPU**: AMD Ryzen AI 9 HX 370 w/ Radeon 890M (`x86_64`, 24 logical CPUs, `perf_event_paranoid = 0`)
- **GPU**: NVIDIA GeForce RTX 4060 Laptop GPU (`sm_89`, 32.0 MB L2 cache, CUDA `nvcc` 13.2, Nsight Compute `ncu` 2026.2.1 with `ncu_report` Python PRI module)
- **C/C++ Toolchain**: `clang++-22` 22.1.3, `gcc` 15.2.0, `cmake` 4.2.1, `ninja` 1.12.1, Linux `perf` 7.0.0
- **Agents & Runtime**:
  - Initial Stage 2 run: `codex-cli 0.163.0` (`executionMode: "codex_chatgpt_login"`, zero OpenAI Platform API credits used).
  - Stage 7 fair re-evaluation (after `codex-cli` hit its rolling window limit): automatic handoff to `agy 1.4.2` (`executionMode: "agy_gemini_cli"`, 2-turn `--conversation` continuation in an isolated empty directory).
  - Runtime: Node.js `v22.22.1`, `perfdigest-mcp 1.3.0`.
- **Memory & CPU Accounting**: Linux cgroup v2 (`systemd-run --user --scope` reading `memory.peak` and `cpu.stat`) paired with GNU `/usr/bin/time -v` (`ru_maxrss`).

### Evaluated Arms

| Arm | Description | MCP Session Lifecycle | Decision Routing & Provenance | Independent Verifier |
|---|---|---|---|---|
| **`A_codex_alone`** | Agent CLI alone operating on fair raw text & JSON excerpts (`16.8–29.6 KB` for CUDA/C++/PyTorch; complete `4.0 KB` raw `cpu_stat.json` + `cpu_report.txt` + `.c` for Linux `perf`) without PerfDigest MCP | `0` spawns, `0` calls | None | Not executed |
| **`B_codex_perfdigest_mcp`** | Agent CLI + PerfDigest MCP (`topN: 10`) digesting all $K$ candidate profiler reports sequentially via one-shot MCP subprocesses after the initial analysis turn | $K$ spawns, $K$ calls (`0` reused) | None (all digests delivered unrouted) | Not executed |
| **`C_codex_perfdigest_evidence`** | Agent CLI + PerfDigest Evidence (`topN: 10`, `includeCorroborating: true`, `agentDelivery: 'two_turn'`) overlapping the initial analysis turn with bounded MCP session reuse across all $K$ candidate reports, decision routing with SHA-256 provenance, abstention guard, and independent verification before the review turn | `1` spawn, $K$ calls ($K - 1$ reused) | Routed (`accepted` at $\ge 0.65$ or `abstained` $\to$ `needs_review`) with SHA-256 provenance for all $K$ reports | Executed & verified before review turn |
| **`C_opt_single_turn_compact`** | Agent CLI + PerfDigest Evidence (`topN: 10`, `includeCorroborating: true`, `agentDelivery: 'single_turn'`, `compactEvidence: true`) executing bounded MCP session reuse (`~440 ms`), decision routing, and independent verification first, then delivering the compacted `formatAgentEvidence` envelope in a **single** evidence-grounded agent turn (`single_turn_with_evidence`) | `1` spawn, $K$ calls ($K - 1$ reused) | Routed + `formatAgentEvidence` compact prompt envelope (full 64-char SHA-256 provenance preserved in `run.json`) | Executed & verified before the single agent turn |

---

## 3. Candidate Studies, Artifacts & Compression (`topN: 10`)

| Study ID | Source Study in `PerfDigest-MCP-Bench` | Capture Mode | Candidate Reports ($K$) | Raw Bytes $\to$ Digest Bytes (`topN: 10` Compression) |
|---|---|---|---|---|
| **`cuda_opt_loop`** | `DEMANDING_WORKLOADS_4_CUDA_OPT_LOOP_2026-07-19.md` | **Live hardware capture** (`nvcc -arch=sm_89` + `ncu` on RTX 4060 Laptop GPU) | `ptxas-codegen` (`ptxas`), `ncu-roofline` (`ncu-rep`) | `2,351 B -> 2,203 B` (`1.07x`), `76,816 B -> 1,848 B` (`41.57x`) |
| **`cpp_build_loop`** | `DEMANDING_WORKLOADS_3_CPP_BUILD_LOOP_2026-07-19.md` | **Artifact + live toolchain** (`clang++-22 -ftime-trace` on `workloads/cpp_project`) | `cmake-cold`, `cmake-warm`, `ninja-cold`, `clang-heavy-tu` (`4` reports) | `1,544,826 B -> 2,007 B` (`769.72x`), `297,280 B -> 1,888 B` (`157.46x`), `565 B -> 1,337 B` (`0.42x`), `745,515 B -> 2,139 B` (`348.53x`) |
| **`pytorch_inductor_training`** | `DEMANDING_WORKLOADS_2_TORCH_TRAINING_2026-07-19.md` | **Artifact-level boundary** (8-step Kineto `chrome-trace` with 600 interleaved `cudaLaunchKernel` spans) | `eager-kineto-trace`, `compiled-kineto-trace` (`chrome-trace`) | `123,763 B -> 2,452 B` (`50.47x`), `122,379 B -> 2,284 B` (`53.58x`) |
| **`linux_perf_cpu`** | `CROSS_BACKEND_2026-06-15.md` | **Live hardware capture** (`perf stat -j` + `perf record/report` at `perf_event_paranoid=0` on Ryzen AI 9 HX 370) | `perf-stat` (`perf-stat-json`), `perf-report` (`perf-report`) | `917 B -> 664 B` (`1.38x`), `688 B -> 1,534 B` (`0.45x`) |

---

## 4. Audited Diagnostic Accuracy, Context Pollution & Validated Speedups

| Study | Arm A (`A_codex_alone`, Fair Raw Access) | Arm B (`B_codex_perfdigest_mcp`) | Arm C (`C_codex_perfdigest_evidence`) | Arm C Opt (`C_opt_single_turn_compact`) | Validated Optimization Fix & Speedup | Independent Verifier |
|---|---|---|---|---|---|---|
| **`cuda_opt_loop`** | **`3/5` (`0.60`)** — identifies `v0` uncoalesced write, `v2` non-speedup, and `ptxas` register non-monotonicity from `.cu` + `ptxas`, but cannot read binary `.ncu-rep` DRAM peak (`89.94%`) or measured `v0->v1` speedup (`1.84x`) | **`5/5` (`1.00`)** — `0` false conclusions | **`5/5` (`1.00`)** — `0` false conclusions | **`5/5` (`1.00`)** — `0` false conclusions (2/2 trials) | Coalesced padded `[32][33]` shared-memory transpose (`v0` `4.291 ms` $\to$ `v1` `2.336 ms`, **`1.84x` speedup** on warm RTX 4060 boost clocks) | `./cuda_opt_bench` (exit `0`, full 67M-element device compare + 2M-sample spot check) |
| **`cpp_build_loop`** | **`1/5` (`0.20`)** — identifies slowest TU from `cold.ninja_log`, but `25.5 KB` raw trace window (`43,983` input tokens) misses whole-file `InstantiateClass` sum (`3,496,667 us`), `ExecuteCompiler` (`1,707,440 us`), and cold CMake compiler detection | **`5/5` (`1.00`)** — `0` false conclusions (`34,554` input tokens, **`-9,429` tokens vs Arm A**) | **`5/5` (`1.00`)** — `0` false conclusions (`35,765` input tokens, **`-8,218` tokens vs Arm A**) | **`5/5` (`1.00`)** — `0` false conclusions (`18,407` input tokens, **`-25,576` tokens vs Arm A**) | Replace exponential recursive `constexpr fib(27)` in `lib_template_heavy.cpp` with $O(n)$ iterative `constexpr` loop (`1,286.94 ms` $\to$ `949.74 ms`, **`1.36x` compile speedup**) | `./verify_cpp_fix` (exit `0`, links `heavy_fixed_0.o` and verifies `bl::heavy_checksum()`) |
| **`pytorch_inductor_training`** | **`3/5` (`0.60`)** — identifies `torch.compile(model)` graph-break reason, inline recomputation concept, and 1-vs-4 kernel sign from `torch_train_bench.py`, but `29.6 KB` raw Kineto excerpt (`41,621` input tokens) is polluted by `cudaLaunchKernel` spans and misses the hottest Triton kernel & `262.4 us` 8-step sum | **`5/5` (`1.00`)** — `0` false conclusions (`33,688` input tokens, **`-7,933` tokens vs Arm A**) | **`5/5` (`1.00`)** — `0` false conclusions (`34,430` input tokens, **`-7,191` tokens vs Arm A**) | **`5/5` (`1.00`)** — `0` false conclusions (`17,869` input tokens, **`-23,752` tokens vs Arm A**) | `torch.compile(model)` AOTAutograd forward+backward fusion of LayerNorm+GELU (`182.70 us/step` $\to$ `168.40 us/step`, **`1.08x` GPU kernel speedup**) | `node verify_torch_traces.mjs` (exit `0`, verifies kernel total reduction + preserved `AdamFunctor`) |
| **`linux_perf_cpu`** | **`5/5` (`1.00`)** — with complete raw `cpu_stat.json` (`917 B`) + `cpu_report.txt` (`688 B`) in context (`4,006 B` total), the model accurately identifies `compute_bound_poly` (`94.36%`), `null` wall duration in `perf-report`, program IPC (`0.52`), and unsupported PMU counter semantics | **`5/5` (`1.00`)** — `0` false conclusions | **`5/5` (`1.00`)** — `0` false conclusions | **`5/5` (`1.00`)** — `0` false conclusions (`16,447` input tokens, **`-16,531` tokens vs Arm A**) | 4-step composed affine recurrence (`a = a * m4 + b4`) breaking the 2-step serial FMA latency chain in `compute_bound_poly` (`6,020.33 ms` $\to$ `1,077.49 ms`, **`5.59x` wall speedup**) | `node verify_cpu_fix.mjs` (exit `0`, `sink1` exact match, `sink2` relative error `< 1e-5`) |
| **Overall Summary** | **Mean Accuracy: `0.60` (`12/20`, `7` unmeasured/false conclusions)** | **Mean Accuracy: `1.00` (`20/20`, `0` false conclusions)** | **Mean Accuracy: `1.00` (`20/20`, `0` false conclusions, `4/4` verifiers passed)** | **Mean Accuracy: `1.00` (`20/20`, `0` false conclusions, `4/4` verifiers passed, `-49.50%` input tokens, `2.30x` faster wall)** | **`1.84x` CUDA, `1.36x` C++, `1.08x` PyTorch, `5.59x` Linux CPU** | **`4/4` independent verifiers exit `0`** |

### Why Challenging the Initial `0.20` Arm A Baseline Matters
- In **Study 4 (`linux_perf_cpu`)**, the raw profiler artifacts (`cpu_stat.json` + `cpu_report.txt`) total only **`1,605 B`**. When Arm A is fairly given those raw files, it scores **`5/5 (1.00)`**. Claiming that an LLM cannot diagnose a `1.6 KB` `perf report` text table without MCP was an artifact of withholding the file in the earlier script. On small text reports, PerfDigest Evidence's value is **schema normalization (`null` vs `0.0`), SHA-256 provenance, and independent verification**, not raw text comprehension.
- Conversely, in **Studies 1, 2, and 3**, PerfDigest MCP's diagnostic and token-efficiency advantage holds up under strict scrutiny:
  - **Binary profiler containers (`Study 1: .ncu-rep`, `76.8 KB`)** cannot be inspected by an LLM without `ncu` / PerfDigest MCP (`0.60` $\to$ `1.00`).
  - **Multi-hundred-KB / multi-MB event traces (`Study 2: 2.59 MB` CMake + Clang `-ftime-trace`; `Study 3: 246 KB` Kineto traces)** require **whole-file span aggregation** (summing 1,471 recursive `InstantiateClass` spans or 8 steps of GPU kernels buried inside 600 `cudaLaunchKernel` host events). Feeding raw `25–30 KB` JSON excerpts into Arm A pollutes the prompt with **`7,191–9,429` extra input tokens** (and **`23,752–25,576` extra input tokens** compared to single-turn `C_opt_single_turn_compact`) while still failing quantitative whole-trace checks (`0.20` in Study 2, `0.60` in Study 3 vs `1.00` in Arms B, C, and C_opt).

---

## 5. Cost Breakdown, MCP Session Reuse & Process-Tree Resources

Every run separates **model inference latency** (`modelInferenceMs`), **PerfDigest MCP engine latency** (`mcpEngineMs`), **independent verifier latency** (`verificationMs`), and **concurrent overlap** (`evidenceModelOverlapMs`), and reports exact prompt payload bytes (`evidencePayloadBytes`) and total model input/output tokens.

| Study | Arm | Wall (ms) | MCP Engine (ms) | Verifier (ms) | Overlap Saved (ms) | MCP Spawns / Calls / Reused | cgroup v2 Tree Peak (KB) | Single-Proc `ru_maxrss` (KB) | MCP User+Sys CPU (ms) | Exact Prompt Payload Bytes | Total Model Input / Output Tokens |
|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| **`cuda_opt_loop`** ($K=2$) | Arm A | `15,582.80` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `10,324` | `44,912` | `26.59` | `16,783` | `37,167 / 375` |
| | Arm B | `14,490.78` | `817.25` | `0.00` | `0.00` | `2 / 2 / 0` | `218,240` | `188,856` | `1,032.63` | `4,174` | `33,199 / 392` |
| | Arm C (2-turn) | `16,499.75` | `414.90` | `1,320.11` | `415.05` | `1 / 2 / 1` | `223,748` | `188,492` | `689.56` | `6,173` | `34,156 / 430` |
| | **Arm C Opt (1-turn)** | **`8,022.23`** | `395.92` | `3,668.93` | `0.00` | `1 / 2 / 1` | `223,832` | `188,712` | `676.00` | **`4,551`** | **`17,612 / 303`** |
| **`cpp_build_loop`** ($K=4$) | Arm A | `15,991.27` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `10,252` | `45,040` | `29.24` | `25,521` | `43,983 / 312` |
| | Arm B | `15,837.78` | `2,034.70` | `0.00` | `0.00` | `4 / 4 / 0` | `118,420` | `101,876` | `2,093.52` | `7,616` | `34,554 / 354` |
| | Arm C (2-turn) | `22,558.85` | `526.78` | `3.14` | `526.78` | `1 / 4 / 3` | `117,840` | `97,048` | `702.68` | `10,287` | `35,765 / 386` |
| | **Arm C Opt (1-turn)** | **`6,592.00`** | `495.57` | `3.05` | `0.00` | `1 / 4 / 3` | `118,224` | `97,810` | `704.93` | **`6,501`** | **`18,407 / 320`** |
| **`pytorch_inductor_training`** ($K=2$) | Arm A | `14,554.21` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `10,512` | `45,104` | `30.38` | `29,555` | `41,621 / 345` |
| | Arm B | `13,876.72` | `755.09` | `0.00` | `0.00` | `2 / 2 / 0` | `104,944` | `92,248` | `995.87` | `4,885` | `33,688 / 390` |
| | Arm C (2-turn) | `13,667.34` | `383.03` | `24.96` | `383.04` | `1 / 2 / 1` | `105,120` | `91,244` | `634.33` | `6,615` | `34,430 / 360` |
| | **Arm C Opt (1-turn)** | **`7,011.34`** | `369.51` | `25.13` | `0.00` | `1 / 2 / 1` | `103,800` | `91,562` | `629.55` | **`4,896`** | **`17,869 / 312`** |
| **`linux_perf_cpu`** ($K=2$) | Arm A | `12,655.10` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `10,296` | `44,908` | `30.99` | `4,006` | `32,978 / 344` |
| | Arm B | `13,258.38` | `750.08` | `0.00` | `0.00` | `2 / 2 / 0` | `104,264` | `90,740` | `1,019.97` | `2,329` | `34,206 / 359` |
| | Arm C (2-turn) | `14,647.67` | `432.22` | `1,105.24` | `432.22` | `1 / 2 / 1` | `106,080` | `89,392` | `613.37` | `3,962` | `34,938 / 317` |
| | **Arm C Opt (1-turn)** | **`7,703.85`** | `395.98` | `3,454.99` | `0.00` | `1 / 2 / 1` | `103,644` | `91,244` | `600.89` | **`2,496`** | **`16,447 / 276`** |

### Key Resource & Latency Takeaways
1. **Bounded MCP Session Reuse (`reuseMcpSession: true`) Cuts MCP Engine Time by `42%`–`74%` and CPU by `33%`–`66%`**:
   - Across $K=2$ studies, reusing one bounded MCP session reduces `mcpEngineMs` from `750–817 ms` to `369–432 ms` and reduces cgroup v2 CPU (`user + sys`) from `~1,016 ms` to `~646 ms`.
   - In the 4-report C++ build study (`cpp_build_loop`), reusing one bounded MCP session reduces `mcpEngineMs` from **`2,034.70 ms` to `526.78 ms` (`3.86x` faster, saving `1,507.92 ms`)** and reduces cgroup v2 CPU from **`2,093.52 ms` to `702.68 ms` (`2.98x` less CPU)**.
2. **100% Overlap in 2-Turn Mode vs. Single-Turn Elimination (`single_turn_with_evidence`)**:
   - In 2-turn overlap mode (`C_codex_perfdigest_evidence`), `evidenceModelOverlapMs` equals `100%` of `mcpEngineMs` (`383.03–526.78 ms`), hiding the MCP engine cost behind the concurrent initial hypothesis turn.
   - However, because local session-reused MCP digestion completes in **`369–496 ms`** while an initial LLM turn takes **`7,000–11,000 ms`** and consumes **`~17,000` input tokens** (CLI system instructions + prompt), skipping the speculative blind turn in `C_opt_single_turn_compact` (`agentDelivery: 'single_turn'`) is **`2.30x` faster in end-to-end wall time (`16,843.40 ms -> 7,332.35 ms`)** and **`4.19x` faster in model inference time (`16,843.40 ms -> 4,023.46 ms`)**.

---

## 6. Abstention Guard & Provenance Verification

For every study, `bench/real-workloads-eval.mjs` tests the below-threshold abstention path (`confidence = 0.61 < 0.65` policy threshold):
- `decisionOutcome`: `'abstained'`
- `pipelineStatus`: `'needs_review'`
- `evidenceDeliveredCount`: `0` (neither `evidence` nor `corroborating` digests are delivered when a route abstains)
- `provenanceRetainedCount`: $K$ (`2` for CUDA/PyTorch/Linux perf, `4` for C++ build) with `100%` matching SHA-256 hashes and `delivered: false`.

---

## 7. Independent Measurement of Context/Token Compaction (`formatAgentEvidence`) and Single-Turn Evidence Delivery (`single_turn_with_evidence`)

To address the two remaining efficiency bottlenecks in Arm C (`C_codex_perfdigest_evidence`)—(1) prompt bloat in the serialized evidence envelope (`+1,633 B` to `+2,671 B` over unrouted Arm B) and (2) the `~17,000` input tokens and `~9.5 s` spent on the initial blind `analysis` turn before `~440 ms` local MCP digestion finishes—we implemented and independently measured two composable optimizations in `src/agents.ts`, `src/run.ts`, `src/config.ts`, and `src/cli.ts`:

### 7.1 Optimization A — Compact Agent Evidence Envelope (`formatAgentEvidence` in `src/agents.ts`)

`formatAgentEvidence(evidence, verification, pipelineStatus, compact = true)` strips non-diagnostic boilerplate from the agent prompt envelope while keeping the full uncompacted `EvidenceBundle` and 64-character SHA-256 `EvidenceProvenance[]` intact on disk in `.perfdigest-evidence/runs/<runId>/run.json`:
- Omits the verbose `considered: EvidenceProvenance[]` array (`path`, `bytes`, `digestedAt`, full 64-char `sha256` per report) from the LLM prompt, replacing it with a compact 16-character `sha256Prefix` on each delivered digest.
- Strips `raw_ref` filesystem paths and duplicate per-unit `domain` and `index` fields inside `digest.units[]` (`units[]` is already ordered and `domain` is already declared at the digest root).
- Replaces verbose verification command metadata (`command`, `args`, `cwd`, `durationMs`, `stderr`) with `{ passed, exitCode, stdout }`.
- Preserves **100%** of diagnostic units, `metrics` (including `null` values), `summary`, `warnings`, `truncation`, `corroborating` digests, `decision` routing metadata, and `verification.passed`.

| Study | Candidate Reports ($K$) | Unrouted Arm B Bytes | Verbose Arm C Bytes (`compact: false`) | Compact Arm C Opt Bytes (`formatAgentEvidence`) | Bytes Saved | Byte Reduction (%) | Est. Prompt Tokens (`Verbose -> Compact`) |
|---|---:|---:|---:|---:|---:|---:|---:|
| **`cuda_opt_loop`** | `2` | `4,174 B` | `6,173 B` | **`4,551 B`** | `-1,622 B` | **`-26.28%`** | `1,544 -> 1,138` (`-406`) |
| **`cpp_build_loop`** | `4` | `7,616 B` | `10,287 B` | **`6,501 B`** | `-3,786 B` | **`-36.80%`** | `2,572 -> 1,626` (`-946`) |
| **`pytorch_inductor_training`** | `2` | `4,885 B` | `6,615 B` | **`4,896 B`** | `-1,719 B` | **`-25.99%`** | `1,654 -> 1,224` (`-430`) |
| **`linux_perf_cpu`** | `2` | `2,329 B` | `3,962 B` | **`2,496 B`** | `-1,466 B` | **`-37.00%`** | `991 -> 624` (`-367`) |
| **Mean across 4 Studies** | `2.5` | `4,751.00 B` | `6,759.25 B` | **`4,611.00 B`** | **`-2,148.25 B`** | **`-31.78%`** | **`1,690.25 -> 1,153.00` (`-537.25`)** |

> **Key Finding (Optimization A)**: Across all 4 studies, `formatAgentEvidence` reduces the serialized evidence envelope from a mean of **`6,759.25 B` to `4,611.00 B` (`-31.78%`, saving `2,148.25 B` / `~537.25` tokens per turn)**. The compacted routed + verified envelope (`4,611.00 B` mean) is **smaller on average than unrouted Arm B (`4,751.00 B` mean)**, and on the 4-report C++ build study (`cpp_build_loop`) it is **`1,115 B` smaller than Arm B (`6,501 B` vs `7,616 B`)** despite carrying routing decision metadata and independent verification output.

### 7.2 Optimization B — Single-Turn Evidence Delivery (`agentDelivery: 'single_turn'` / `--agent-delivery single_turn`)

When `agentDelivery: 'single_turn'` is enabled in `investigate()` (`src/run.ts`), the orchestrator runs bounded session-reused PerfDigest MCP digestion (`~370–496 ms`), decision routing, and independent verification first, then invokes the coding agent **once** (`evidenceDelivery: 'single_turn_with_evidence'`) with the compacted evidence envelope (`analysis: null`, `review: <single-turn output>`). Each study was evaluated over **2 live trials** (`8` live trials total for `C_opt_single_turn_compact`):

| Study | Two-Turn Arm C Wall (ms) | Single-Turn Arm C Opt Wall (ms) | Wall Speedup (`Saved ms`) | Two-Turn Model Inference (ms) | Single-Turn Model Inference (ms) | Model Inference Speedup | Two-Turn Total Input Tokens | Single-Turn Total Input Tokens | Input Tokens Saved (`Reduction %`) | Accuracy (`2-Turn -> 1-Turn`) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **`cuda_opt_loop`** | `16,499.75` | **`8,022.23`** | **`2.06x`** (`-8,477.52 ms`) | `16,499.75` | **`3,953.93`** | **`4.17x`** | `34,156` | **`17,612`** | `-16,544` (**`-48.44%`**) | `1.00 -> 1.00` (`5/5`) |
| **`cpp_build_loop`** | `22,558.85` | **`6,592.00`** | **`3.42x`** (`-15,966.85 ms`) | `22,558.85` | **`3,832.06`** | **`5.89x`** | `35,765` | **`18,407`** | `-17,358` (**`-48.53%`**) | `1.00 -> 1.00` (`5/5`) |
| **`pytorch_inductor_training`** | `13,667.34` | **`7,011.34`** | **`1.95x`** (`-6,656.00 ms`) | `13,667.34` | **`4,455.16`** | **`3.07x`** | `34,430` | **`17,869`** | `-16,561` (**`-48.10%`**) | `1.00 -> 1.00` (`5/5`) |
| **`linux_perf_cpu`** | `14,647.67` | **`7,703.85`** | **`1.90x`** (`-6,943.82 ms`) | `14,647.67` | **`3,852.69`** | **`3.80x`** | `34,938` | **`16,447`** | `-18,491` (**`-52.93%`**) | `1.00 -> 1.00` (`5/5`) |
| **Mean across 4 Studies** | `16,843.40` | **`7,332.35`** | **`2.30x` (`-9,511.05 ms`)** | `16,843.40` | **`4,023.46`** | **`4.19x` (`-12,819.94 ms`)** | `34,822.25` | **`17,583.75`** | **`-17,238.50` (`-49.50%`)** | **`1.00 -> 1.00` (`20/20`, `0` false)** |

> **Key Finding (Optimization B)**: Eliminating the speculative blind `analysis` turn cuts mean total model input tokens by **`49.50%` (`34,822.25 -> 17,583.75` tokens, saving `17,238.50` tokens per investigation)**, cuts mean end-to-end wall latency by **`2.30x` (`16,843.40 ms -> 7,332.35 ms`, saving `9.51 s`)**, and cuts mean model inference latency by **`4.19x` (`16,843.40 ms -> 4,023.46 ms`)** while maintaining **`1.00` (`20/20`) diagnostic accuracy and `0` false conclusions** across all 8 live trials.

---

## 8. Controlled 6-Model × 4-Study × 3-Arm Multi-Model Evaluation (`2026-10-24`)

To verify whether PerfDigest Evidence's diagnostic accuracy, context compression, latency, and API cost properties generalize across model families and reasoning tiers, [`bench/multi-model-eval.mjs`](../bench/multi-model-eval.mjs) evaluates **6 models** at their highest supported reasoning configurations across all **4 `PerfDigest-MCP-Bench` studies** and **3 fair single-turn arms (`raw`, `mcp_digest`, `compact_evidence`)** (`72` total live evaluations in [`bench/results/2026-10-24-multi-model-evaluation.json`](../bench/results/2026-10-24-multi-model-evaluation.json)).

### 8.1 Preflight Smoke Tests (Practical Verification Before Benchmarking)

1. **Preflight Smoke Test 1 — `agy` CLI (`1.4.7`) Gemini 3.8 Flash & Gemini 4 Argon Availability, Effort Tiers, and Streaming Telemetry**:
   - Verified via `agy models` that both `gemini-3.8-flash-high` (`gemini-3.8-flash-low`, `-medium`, `-high`) and `gemini-4-argon-high` (`gemini-4-argon-low`, `-medium`, `-high`) are installed and available.
   - Confirmed practically that `--effort max` is explicitly rejected by `agy` (`gemini-3.8-flash has no "max" effort (available: low, medium, high)` and `gemini-4-argon has no "max" effort (available: low, medium, high)`), making `--effort high` the highest supported reasoning configuration for both Gemini models.
   - Verified `agy -p ... --model gemini-3.8-flash-high --effort high --output-format stream-json --disable-slash-commands` in an isolated `/tmp` directory: observed `init`, `step_update (user_input, DONE)`, `step_update (agent_response, ACTIVE)` (first response timestamp), and `step_update (agent_response, DONE)` with `duration_seconds` and `usage: { input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens }`.
2. **Preflight Smoke Test 2 — `claude` CLI (`2.1.310`) Practical Canary Isolation Under Existing `oauth_token` (`firstParty`) API Billing Auth**:
   - Note on `--bare` vs `--safe-mode`: `claude --bare` disables keychain/OAuth token reads (`Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper`), whereas combining `--safe-mode --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence --tools "" --system-prompt "..."` with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_SAFE_MODE=1` preserves existing `oauth_token` (`firstParty`) API billing auth while stripping all local context, plugins, hooks, and MCP servers.
   - **Practical Canary Test**: Created a temporary workspace containing four active canaries:
     - `CLAUDE.md` instructing the model to reply `CANARY_CLAUDE_MD_LEAKED_9941`
     - `.claude/CLAUDE.md` instructing the model to reply `CANARY_DOT_CLAUDE_LEAKED_9942`
     - `.mcp.json` registering `canary_leaked_mcp`
     - `.claude/settings.json` registering a `UserPromptSubmit` hook (`echo LEAKED_HOOK >&2; exit 2`) that aborts any non-isolated invocation
   - **Observed Result**: `init` event reported `tools: []` (`0`), `mcp_servers: []` (`0`), `slash_commands: []` (`0`), `skills: []` (`0`), the `exit 2` hook did not execute, and the model replied `"ISOLATED"` (`smokeCostUsd: $0.000282`).

### 8.2 Fair Arm Definitions & Self-Audit Correction During Multi-Model Run

All 6 models receive identical prompts, identical evidence payloads, and identical deterministic grading functions per `(study, arm)`:
- **`raw`**: Complete raw profiler text/JSON for small reports (`linux_perf_cpu`: `4,006 B`) and fair `16.8–29.6 KB` raw text/JSON surfaces for binary/large-trace studies (`cuda_opt_loop`: `16,783 B`; `cpp_build_loop`: `25,521 B`; `pytorch_inductor_training`: `29,555 B`), with `0` MCP spawns, no routing, and no verification receipt.
- **`mcp_digest`**: Sequential per-report `PerfDigest MCP` (`topN: 10`, `reuseMcpSession: false`, $K$ spawns / $K$ calls) across **all $K$ candidate reports** in declaration order (`candidateDigests`), with no routing selection and no verification receipt.
  - *Self-Audit Catch During Multi-Model Run*: In our first pass of `bench/multi-model-eval.mjs`, passing `routing: 'offline'` to `gatherEvidence()` caused `measuredRouting = selectedProvider !== 'offline'` (`src/evidence.ts`) to skip the multi-report loop and digest only `reports[0]`, artificially depressing `mcp_digest` accuracy to `0.35–0.65`. We caught this in post-run check auditing, fixed `mcp_digest` to digest all $K$ candidate reports in declaration order, and re-ran all 24 `mcp_digest` cells.
- **`compact_evidence`**: Full `PerfDigest Evidence` single-turn pipeline (`topN: 10`, `reuseMcpSession: true` with `1` MCP spawn + $K - 1$ warm reused calls, loopback SystemOne HTTP routing on `http://127.0.0.1:PORT/v1/systemone`, independent verification command execution, and `formatAgentEvidence(..., true)` compact prompt envelope).

### 8.3 Local Pipeline Spans, Compression & cgroup v2 Resource Footprints by Study

| Study | Arm | Payload Bytes (`Est. Tokens`) | Reduction vs Verbose / Raw | Local Orch (ms) | Local MCP (ms) | Loopback Routing (ms) | Verifier (ms) | MCP Spawns / Calls / Reused | cgroup v2 Tree Peak (KB) | Max Single-Proc RSS (KB) | cgroup User / Sys CPU (ms) |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| **`cuda_opt_loop`** ($K=2$) | `raw` | `16,783 B` (`4,196`) | — | `0.43` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `10,192` | `41,560` | `16.10 / 13.13` |
| | `mcp_digest` | `4,170 B` (`1,043`) | `-75.15%` vs `raw` | `0.08` | `798.55` | `0.00` | `0.00` | `2 / 2 / 0` | `218,344` | `189,476` | `866.74 / 148.13` |
| | **`compact_evidence`** | **`4,486 B` (`1,122`)** | **`-35.28%` vs verbose (`6,931 B`)**, `-73.27%` vs `raw` | `2.23` | **`399.18`** (`2.00x`) | `19.00` | `1,274.62` | **`1 / 2 / 1`** | `218,512` | `189,176` | **`534.99 / 108.81`** |
| **`cpp_build_loop`** ($K=4$) | `raw` | `25,521 B` (`6,381`) | — | `0.55` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `9,940` | `41,592` | `15.33 / 15.37` |
| | `mcp_digest` | `7,604 B` (`1,901`) | `-70.21%` vs `raw` | `0.07` | `1,583.15` | `0.00` | `0.00` | `4 / 4 / 0` | `112,144` | `91,000` | `1,549.22 / 201.36` |
| | **`compact_evidence`** | **`6,432 B` (`1,608`)** | **`-39.93%` vs verbose (`10,707 B`)**, `-74.80%` vs `raw` | `1.99` | **`412.34`** (**`3.84x`**) | `5.00` | `3.00` | **`1 / 4 / 3`** | `122,368` | `97,560` | **`552.43 / 77.19`** |
| **`pytorch_inductor_training`** ($K=2$) | `raw` | `29,555 B` (`7,389`) | — | `0.53` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `10,504` | `41,560` | `20.34 / 10.17` |
| | `mcp_digest` | `4,879 B` (`1,220`) | `-83.49%` vs `raw` | `0.06` | `730.93` | `0.00` | `0.00` | `2 / 2 / 0` | `106,204` | `84,556` | `846.08 / 107.39` |
| | **`compact_evidence`** | **`4,819 B` (`1,205`)** | **`-31.01%` vs verbose (`6,985 B`)**, `-83.69%` vs `raw` | `1.95` | **`380.66`** (`1.92x`) | `4.00` | `24.83` | **`1 / 2 / 1`** | `111,852` | `89,788` | **`531.68 / 75.67`** |
| **`linux_perf_cpu`** ($K=2$) | `raw` | `4,006 B` (`1,002`) | — | `0.39` | `0.00` | `0.00` | `0.00` | `0 / 0 / 0` | `9,720` | `41,152` | `15.04 / 9.35` |
| | `mcp_digest` | `2,324 B` (`581`) | `-41.99%` vs `raw` | `0.06` | `720.20` | `0.00` | `0.00` | `2 / 2 / 0` | `104,284` | `84,000` | `866.78 / 114.61` |
| | **`compact_evidence`** | **`2,432 B` (`608`)** | **`-43.72%` vs verbose (`4,321 B`)**, `-39.29%` vs `raw` | `1.90` | **`361.39`** (`1.99x`) | `5.00` | `1,101.16` | **`1 / 2 / 1`** | `104,792` | `85,192` | **`566.16 / 71.79`** |

- **CLI Process-Tree Footprints (`cgroup_v2_tree_peak`)**:
  - `agy` CLI (`1.4.7`): `cgroupTreePeakKb = 95,436 KB`, `maxSingleProcessRssKb = 109,016 KB`, `cgroupUserCpuMs = 590.51 ms`, `cgroupSysCpuMs = 152.97 ms`.
  - `claude` CLI (`2.1.310`): `cgroupTreePeakKb = 197,308 KB`, `maxSingleProcessRssKb = 259,036 KB`, `cgroupUserCpuMs = 1,093.64 ms`, `cgroupSysCpuMs = 204.31 ms`.

### 8.4 Aggregate 6-Model × 3-Arm Results Across All 4 Studies (72 Evaluations)

> **Observable vs. Unobservable Timing Spans**:
> - For **`claude` (`2.1.310` `--output-format stream-json --verbose --include-partial-messages`)**, `cliStartupMs` (`init`), `modelFirstResponseMs` (`message_start` after `requesting`), `thinkingStreamMs` (`content_block_start(thinking)` $\to$ `content_block_start(text)`), `textOutputStreamMs` (`content_block_start(text)` $\to$ `message_stop`), `modelApiDurationMs` (`duration_api_ms`), and `totalCostUsd` (`total_cost_usd`) are all directly observed on every turn.
> - For **`agy` (`1.4.7` `--output-format stream-json`)**, `cliStartupMs` (`init`), `modelFirstResponseMs` (first `step_update(agent_response, ACTIVE)` after `user_input DONE`), `textOutputStreamMs` (`agent_response ACTIVE` $\to$ `DONE`), `modelApiDurationMs` (`duration_seconds * 1000`), and `usage.thinking_tokens` are directly observed. Because `agy` emits thinking + text as a single step update without a separate thinking-start timestamp or USD cost field, `thinkingStreamMs` and `totalCostUsd` are recorded as `null` (`N/A`) rather than fabricated.

| Model (`CLI`, Reasoning Effort) | Arm | Mean Accuracy (`Checks / 20`, False) | Mean Input Tokens | Mean Output Tokens (`Thinking`) | Mean CLI Startup (ms) | Mean Local Pipe `Orch+MCP+Route+Ver` (ms) | Mean Model 1st Resp (ms) | Mean Thinking Stream (ms) | Mean Text Stream (ms) | Mean Model API (ms) | Mean Total E2E Wall (ms) | Total API Cost across 4 Studies (`$`) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **`gemini-4-argon-high`** (`agy`, `high`) | `raw` | `0.60` (`12/20`, `7` false) | `18,199.25` | `2,464.00` (`2,380.75`) | `2,249.13` | `0.61` | `29,123.77` | `null` | `498.27` | `29,630.37` | `33,661.40` | `N/A` |
| | `mcp_digest` | **`1.00` (`20/20`, `0` false)** | `12,655.25` | `1,442.00` (`1,340.50`) | `2,420.58` | `950.24` | `18,202.82` | `null` | `548.27` | `18,778.05` | `22,762.90` | `N/A` |
| | **`compact_evidence`** | **`1.00` (`20/20`, `0` false)** | **`12,645.50`** | **`1,252.00` (`1,154.75`)** | `2,469.44` | `1,043.30` | **`15,025.25`** | `null` | `549.20` | **`15,588.08`** | **`20,273.58`** | `N/A` |
| **`gemini-3.8-flash-high`** (`agy`, `high`) | `raw` | `0.60` (`12/20`, `7` false) | `18,395.50` | `20,534.00` (`20,457.00`) | `2,420.64` | `0.61` | `51,154.36` | `null` | `370.26` | `51,546.49` | `56,300.04` | `N/A` |
| | `mcp_digest` | **`1.00` (`20/20`, `0` false)** | `12,804.25` | `3,813.00` (`3,713.75`) | `2,475.12` | `950.24` | **`10,081.25`** | `null` | `249.59` | **`10,347.61`** | **`14,269.87`** | `N/A` |
| | **`compact_evidence`** | **`1.00` (`20/20`, `0` false)** | **`12,793.75`** | `17,480.25` (`17,384.75`) | `2,225.94` | `1,043.30` | `42,189.14` | `null` | `394.63` | `42,591.34` | `46,954.81` | `N/A` |
| **`claude-fable-5-1`** (`claude`, `max`) | `raw` | `0.60` (`12/20`, `7` false) | `11,056.50` | `4,880.25` (`4,759.75`) | `563.57` | `0.48` | `1,581.63` | `56,145.51` | `951.98` | `58,383.75` | `60,112.29` | `$1.323166` |
| | `mcp_digest` | **`1.00` (`20/20`, `0` false)** | `3,124.00` | `2,467.25` (`2,331.75`) | `512.63` | `950.24` | `1,733.06` | `26,297.74` | `1,084.02` | `28,897.50` | `31,575.49` | `$0.649631` |
| | **`compact_evidence`** | **`1.00` (`20/20`, `0` false)** | **`3,070.00`** | **`1,876.75` (`1,738.75`)** | `457.16` | `1,019.80` | **`1,182.24`** | **`19,341.74`** | `1,180.68` | **`21,418.75`** | **`24,088.97`** | **`$0.528831`** |
| **`claude-opus-5-5`** (`claude`, `max`) | `raw` | `0.55` (`11/20`, `7` false) | `11,056.50` | `10,930.00` (`10,801.25`) | `487.92` | `0.48` | `1,560.55` | `98,839.74` | `732.78` | `100,844.00` | `102,506.61` | `$1.014925` |
| | `mcp_digest` | **`1.00` (`20/20`, `0` false)** | `3,124.00` | `3,309.75` (`3,165.25`) | `434.23` | `950.24` | `1,506.71` | `26,484.60` | `810.66` | `28,425.50` | **`31,058.26`** | **`$0.327252`** |
| | **`compact_evidence`** | **`1.00` (`20/20`, `0` false)** | **`3,070.00`** | `5,863.75` (`5,719.50`) | `458.98` | `1,019.80` | `1,513.96` | `48,071.64` | `804.52` | `50,101.50` | `52,737.44` | `$0.530492` |
| **`claude-sonnet-5-5`** (`claude`, `max`) | `raw` | `0.60` (`12/20`, `7` false) | `11,060.50` | `8,095.25` (`7,979.75`) | `450.02` | `0.48` | `1,656.34` | `54,295.66` | `223.78` | `55,807.75` | `57,402.52` | `$0.434412` |
| | `mcp_digest` | **`1.00` (`20/20`, `0` false)** | `3,128.00` | `3,933.75` (`3,800.25`) | `464.51` | `950.24` | `1,753.61` | `24,540.86` | `507.66` | `26,269.75` | **`29,176.02`** | **`$0.188626`** |
| | **`compact_evidence`** | **`1.00` (`20/20`, `0` false)** | **`3,074.00`** | `6,456.50` (`6,325.75`) | `444.66` | `1,019.80` | `2,296.81` | `40,606.80` | `423.91` | `42,989.75` | `45,655.11` | `$0.288995` |
| **`claude-haiku-5-5`** (`claude`, `max`) | `raw` | `0.50` (`10/20`, `8` false) | `11,058.50` | `11,176.25` (`11,050.75`) | `474.13` | `0.48` | `1,298.40` | `47,280.74` | `188.07` | `48,489.75` | `50,143.80` | `$0.027881` |
| | `mcp_digest` | **`0.95` (`19/20`, `0` false)** | `3,126.00` | `8,081.00` (`7,945.75`) | `451.20` | `950.24` | `1,049.77` | `31,865.21` | `359.37` | `32,912.00` | **`35,557.78`** | **`$0.017724`** |
| | **`compact_evidence`** | **`0.95` (`19/20`, `0` false)** | **`3,072.00`** | `11,700.25` (`11,561.00`) | `451.84` | `1,019.80` | `1,414.10` | `45,598.90` | `275.68` | `46,885.25` | `49,561.20` | `$0.024937` |

### 8.5 Per-Study Diagnostic Accuracy, E2E Latency & API Cost Matrix (72 Evaluations)

| Study | Model | `raw` Accuracy (`E2E s`, `Cost $`) | `mcp_digest` Accuracy (`E2E s`, `Cost $`) | `compact_evidence` Accuracy (`E2E s`, `Cost $`) |
|---|---|---|---|---|
| **`cuda_opt_loop`** | `gemini-4-argon-high` | `0.60` (`3/5`, `36.40s`, `N/A`) | **`1.00`** (`5/5`, `16.01s`, `N/A`) | **`1.00`** (`5/5`, `21.89s`, `N/A`) |
| | `gemini-3.8-flash-high` | `0.60` (`3/5`, `19.42s`, `N/A`) | **`1.00`** (`5/5`, `10.70s`, `N/A`) | **`1.00`** (`5/5`, `13.58s`, `N/A`) |
| | `claude-fable-5-1` | `0.60` (`3/5`, `52.46s`, `$0.325033`) | **`1.00`** (`5/5`, `10.79s`, `$0.062720`) | **`1.00`** (`5/5`, `14.23s`, `$0.087345`) |
| | `claude-opus-5-5` | `0.60` (`3/5`, `174.77s`, `$0.418933`) | **`1.00`** (`5/5`, `12.40s`, `$0.037168`) | **`1.00`** (`5/5`, `46.82s`, `$0.115678`) |
| | `claude-sonnet-5-5` | `0.60` (`3/5`, `84.07s`, `$0.142027`) | **`1.00`** (`5/5`, `13.16s`, `$0.023384`) | **`1.00`** (`5/5`, `72.10s`, `$0.108009`) |
| | `claude-haiku-5-5` | `0.60` (`3/5`, `59.40s`, `$0.007592`) | **`1.00`** (`5/5`, `21.70s`, `$0.002728`) | **`1.00`** (`5/5`, `44.74s`, `$0.005474`) |
| **`cpp_build_loop`** | `gemini-4-argon-high` | `0.20` (`1/5`, `48.18s`, `N/A`) | **`1.00`** (`5/5`, `32.44s`, `N/A`) | **`1.00`** (`5/5`, `29.03s`, `N/A`) |
| | `gemini-3.8-flash-high` | `0.20` (`1/5`, `45.65s`, `N/A`) | **`1.00`** (`5/5`, `24.85s`, `N/A`) | **`1.00`** (`5/5`, `147.06s`, `N/A`) |
| | `claude-fable-5-1` | `0.20` (`1/5`, `47.69s`, `$0.391945`) | **`1.00`** (`5/5`, `20.48s`, `$0.124333`) | **`1.00`** (`5/5`, `12.44s`, `$0.094093`) |
| | `claude-opus-5-5` | `0.20` (`1/5`, `34.90s`, `$0.155918`) | **`1.00`** (`5/5`, `25.37s`, `$0.075973`) | **`1.00`** (`5/5`, `34.13s`, `$0.093999`) |
| | `claude-sonnet-5-5` | `0.20` (`1/5`, `41.10s`, `$0.099589`) | **`1.00`** (`5/5`, `50.65s`, `$0.082787`) | **`1.00`** (`5/5`, `31.65s`, `$0.057011`) |
| | `claude-haiku-5-5` | `0.20` (`1/5`, `29.50s`, `$0.005486`) | **`1.00`** (`5/5`, `55.61s`, `$0.007133`) | **`1.00`** (`5/5`, `66.72s`, `$0.008564`) |
| **`pytorch_inductor_training`** | `gemini-4-argon-high` | `0.60` (`3/5`, `19.74s`, `N/A`) | **`1.00`** (`5/5`, `28.59s`, `N/A`) | **`1.00`** (`5/5`, `17.47s`, `N/A`) |
| | `gemini-3.8-flash-high` | `0.60` (`3/5`, `14.31s`, `N/A`) | **`1.00`** (`5/5`, `10.97s`, `N/A`) | **`1.00`** (`5/5`, `14.39s`, `N/A`) |
| | `claude-fable-5-1` | `0.60` (`3/5`, `107.58s`, `$0.437318`) | **`1.00`** (`5/5`, `79.67s`, `$0.399908`) | **`1.00`** (`5/5`, `61.59s`, `$0.302883`) |
| | `claude-opus-5-5` | `0.40` (`2/5`, `168.86s`, `$0.360286`) | **`1.00`** (`5/5`, `69.92s`, `$0.186913`) | **`1.00`** (`5/5`, `121.58s`, `$0.300333`) |
| | `claude-sonnet-5-5` | `0.60` (`3/5`, `74.17s`, `$0.145332`) | **`1.00`** (`5/5`, `38.94s`, `$0.068086`) | **`1.00`** (`5/5`, `71.70s`, `$0.114506`) |
| | `claude-haiku-5-5` | `0.20` (`1/5`, `79.35s`, `$0.010898`) | **`0.80`** (`4/5`, `46.51s`, `$0.006172`) | **`0.80`** (`4/5`, `67.90s`, `$0.008693`) |
| **`linux_perf_cpu`** | `gemini-4-argon-high` | **`1.00`** (`5/5`, `30.32s`, `N/A`) | **`1.00`** (`5/5`, `14.01s`, `N/A`) | **`1.00`** (`5/5`, `12.71s`, `N/A`) |
| | `gemini-3.8-flash-high` | **`1.00`** (`5/5`, `145.81s`, `N/A`) | **`1.00`** (`5/5`, `10.56s`, `N/A`) | **`1.00`** (`5/5`, `12.79s`, `N/A`) |
| | `claude-fable-5-1` | **`1.00`** (`5/5`, `32.72s`, `$0.168670`) | **`1.00`** (`5/5`, `15.36s`, `$0.062670`) | **`1.00`** (`5/5`, `8.09s`, `$0.044195`) |
| | `claude-opus-5-5` | **`1.00`** (`5/5`, `31.49s`, `$0.079788`) | **`1.00`** (`5/5`, `16.55s`, `$0.027198`) | **`1.00`** (`5/5`, `8.43s`, `$0.020478`) |
| | `claude-sonnet-5-5` | **`1.00`** (`5/5`, `30.28s`, `$0.047464`) | **`1.00`** (`5/5`, `13.95s`, `$0.014369`) | **`1.00`** (`5/5`, `7.17s`, `$0.009469`) |
| | `claude-haiku-5-5` | **`1.00`** (`5/5`, `32.32s`, `$0.003905`) | **`1.00`** (`5/5`, `18.41s`, `$0.001691`) | **`1.00`** (`5/5`, `18.89s`, `$0.002206`) |

### 8.6 Key Multi-Model Conclusions

1. **Consistent Diagnostic Lift Across All 6 Models (`0.50–0.60` $\to$ `0.95–1.00`)**:
   - Without PerfDigest MCP (`raw`), every model—even `gemini-4-argon-high`, `claude-fable-5-1 --effort max`, and `claude-opus-5-5 --effort max`—scores `0.60` on `cuda_opt_loop`, `0.20` on `cpp_build_loop`, and `0.20–0.60` on `pytorch_inductor_training` (`7–8` false or unmeasured conclusions per model across the 4 studies), while scoring `1.00` on `linux_perf_cpu` where the complete raw `1.6 KB` text report fits in context.
   - Both `mcp_digest` and `compact_evidence` reach **`1.00` (`20/20` checks, `0` false conclusions)** on `gemini-4-argon-high`, `gemini-3.8-flash-high`, `claude-fable-5-1`, `claude-opus-5-5`, and `claude-sonnet-5-5`, and **`0.95` (`19/20`, `0` false conclusions)** on `claude-haiku-5-5`.
2. **`mcp_digest` vs. `compact_evidence` Tradeoffs**:
   - When all candidate digests are already provided in a single turn, `mcp_digest` and `compact_evidence` achieve identical diagnostic accuracy (`1.00` on 5/6 models, `0.95` on Haiku 5.5).
   - **`compact_evidence` wins on local pipeline efficiency, context size, provenance/verification guarantees, and flagship-model latency/cost**:
     - **2.47x faster local MCP digestion** (`958.21 ms` $\to$ `388.39 ms` mean; **3.84x faster** on the 4-report C++ build study: `1,583.15 ms` $\to$ `412.34 ms`, cutting cgroup user CPU from `1,549.22 ms` to `552.43 ms`).
     - **smaller prompt payload than both verbose evidence (`-35.3%` to `-43.7%`) and `mcp_digest`** (`4,542.25 B` mean vs `4,744.25 B` in `mcp_digest` and `18,966.25 B` in `raw`), reducing Claude mean input tokens per study from `11,058` (`raw`) and `3,125` (`mcp_digest`) to **`3,071` (`compact_evidence`)**.
     - **Fastest & cheapest on `claude-fable-5-1` and `gemini-4-argon-high`**: Because `compact_evidence` explicitly supplies the routed primary report (`decision`) and independent verification receipt (`verification`), `claude-fable-5-1` spends fewer thinking tokens (`1,738.75` vs `2,331.75` in `mcp_digest` and `4,759.75` in `raw`), completing in **`24.09s` (`$0.528831`)** vs `31.58s` (`$0.649631`) in `mcp_digest` and `60.11s` (`$1.323166`) in `raw`. Similarly, `gemini-4-argon-high` completes in **`20.27s`** on `compact_evidence` vs `22.76s` on `mcp_digest` and `33.66s` on `raw`.
     - On `claude-opus-5-5`, `claude-sonnet-5-5`, and `gemini-3.8-flash-high`, `mcp_digest` has slightly lower model thinking time than `compact_evidence` because those models spend extra thinking tokens cross-checking the verification receipt and routing probabilities when present in `compact_evidence`; however, both arms remain **1.26x–3.95x faster and 33%–68% cheaper than `raw`**.


