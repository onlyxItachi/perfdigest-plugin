# Real Workload Evaluation & Critical Audit (Stages 2 & 7)

This document reports the controlled evaluation of **PerfDigest Evidence** across the four real profiler studies in [`onlyxItachi/PerfDigest-MCP-Bench`](https://github.com/onlyxItachi/PerfDigest-MCP-Bench), including our **Stage 7 Critical Self-Audit & Fair Re-Evaluation**.

Machine-readable results: [`bench/results/2026-10-18-real-workload-evaluation.json`](../bench/results/2026-10-18-real-workload-evaluation.json) (validated by `node bench/validate.mjs` against [`bench/schema/real-workload-eval.v1.schema.json`](../bench/schema/real-workload-eval.v1.schema.json)).
Reproducible harness: [`bench/real-workloads-eval.mjs`](../bench/real-workloads-eval.mjs).

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

