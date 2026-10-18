# Runtime, build, MCP session reuse & external-agent benchmark consolidation

This document summarizes the reproducible, credential-free benchmark suite in [`bench/`](../bench/README.md), the 3-layer schema coordination with [`PerfDigest-MCP-Bench`](https://github.com/onlyxItachi/PerfDigest-MCP-Bench), the 18-cell matrix session in [`bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json`](../bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json), and the controlled Stage 5 MCP session-reuse benchmark in [`bench/results/2026-10-18-mcp-session-reuse.json`](../bench/results/2026-10-18-mcp-session-reuse.json).

> **Reference baseline**: **Node.js v22.22.1 + TypeScript 6.0.3 (`tsc`)** remains the production build and runtime baseline. `bench/` is excluded from `package.json#files`.

---

## 1. Methodology, 3-layer architecture & `PerfDigest-MCP-Bench` coordination

### Three-layer metric separation (`engine` | `orchestration` | `agent_e2e`)

To prevent conflating upstream Python MCP digest latency with TypeScript plugin orchestration or external agent turn overhead, every cell in `perfdigest.benchmark-manifest.v1` and `perfdigest.benchmark-result.v1` carries both an architectural `layer` (`engine` | `orchestration` | `agent_e2e`) and a functional `group` (`build` | `runtime` | `worker` | `agent`), summarized at the top level in `layerSummary`:

| Layer (`cell.layer`) | Scope | Cells in `bench/manifests/default.json` | Recorded `layerSummary` (`total` / `measured` / `notRun` / `parityPass`) |
| --- | --- | --- | --- |
| **`engine`** | Upstream PerfDigest MCP server session startup & tool surface (`uvx perfdigest-mcp`) | `runtime.uvx.perfdigest-mcp` (1 cell) | `1` total / `1` measured / `0` not-run (`parityNotApplicable: 1`) |
| **`orchestration`** | Compiler build (`tsc` vs `tsgo`), CLI startup, agentless offline demo (`--agent none`), plugin MCP server discovery, child-process spawn loop, and worker receipt hashing (`node` vs `go`) | `build.*` (2), `runtime.*.{help,demo,mcp,spawn}` (12), `worker.*.receipt` (2) (16 cells) | `16` total / `16` measured / `0` not-run (`parityPass: 13`, `parityFail: 0`, `parityNotApplicable: 3`) |
| **`agent_e2e`** | End-to-end offline investigation orchestrated with a genuine compiled Go `perfdigest-agent/v1` CLI agent (`--agent generic --agent-sessions`: `analysis` turn overlapped with capture + MCP digest, followed by independent verification and `same_session_next_turn` `review` turn) | `agent.generic.go-cli.e2e` (1 cell) | `1` total / `1` measured / `0` not-run (`parityPass: 1`) |

### Schema coordination with `PerfDigest-MCP-Bench` (`benchCompatibility`)

The JSON Schemas in [`bench/schema/benchmark-result.v1.schema.json`](../bench/schema/benchmark-result.v1.schema.json), [`bench/schema/benchmark-manifest.v1.schema.json`](../bench/schema/benchmark-manifest.v1.schema.json), and [`bench/schema/mcp-reuse-result.v1.schema.json`](../bench/schema/mcp-reuse-result.v1.schema.json) (generated from [`bench/schema/formats.mjs`](../bench/schema/formats.mjs) via `node bench/schema/build-schema.mjs`) include a top-level `benchCompatibility` block documenting deterministic mapping between `onlyxItachi/PerfDigest-MCP-Bench` raw artifacts (`results/interpreter_matrix_raw`, `results/cpp_build_loop_raw`, `results/cuda_opt_bench_raw`) and `perfdigest.benchmark-result.v1`:

| `PerfDigest-MCP-Bench` raw artifact | Raw field shape | Mapping in `perfdigest.benchmark-result.v1` |
| --- | --- | --- |
| `results/interpreter_matrix_raw/*_latency.json` | `results["<backend>:<format>"].{median_us, q1_us, q3_us, iqr_us, n}` | `cells[layer="engine"].wall.{unit: "us", median, q1, q3, n}` |
| `results/interpreter_matrix_raw/*_identity.json` | `results["<backend>:<format>"].{sha256, bytes, total_units}` | `cells[layer="engine"].parity.checks[name="digest-sha256:<backend>:<format>"]` |
| `results/interpreter_matrix_raw/*_startup.json` | `{median_startup_s}` | `cells[layer="engine", scenario="interpreter-startup"].wall.{unit: "s", median}` |
| `results/interpreter_matrix_raw/*_concurrency.json` | `{same_path_1thread, same_path_nthreads, mixed_paths_nthreads}.{wall_time_s, throughput_calls_per_s, correct}` | `cells[layer="engine"].extra.concurrency` |
| `results/interpreter_matrix_raw/latency_loadavg.json` | `{start_1m, end_1m}` | `host.loadavg1AtStart` |

### Experimental rules & memory measurement semantics

1. **Build vs. runtime vs. agent E2E separation**: Build cells (`tsc` 6.0.3 vs. `tsgo` TS 7 native preview), runtime orchestration cells, upstream MCP engine cells, and external CLI agent E2E cells are measured and gated separately.
2. **Contract-parity gate before interpretation**: Every cell records a structured `parity` block (`pass`, `fail`, `not-checked`, or `not-applicable`). If a backend fails contract parity before timing, timing is skipped (`status: "not-run"`) and no performance comparison or superiority claim is made.
3. **Credential-free offline isolation**: Every child process executes with a minimal allowlisted environment (`PATH`, `HOME`, `TMPDIR`, `USER`, `XDG_CACHE_HOME`, `LANG=C`, `LC_ALL=C`, `NO_COLOR=1`, `DENO_NO_UPDATE_CHECK=1`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`), a throwaway `XDG_CONFIG_HOME` in `/tmp`, and offline routing (`--provider offline`). Zero credentials, hosted model turns, or external network requests are used.
4. **Portable runtime discovery**: Optional runtimes (`bun`, `deno`, `tsgo`, `go`) are discovered dynamically via `bench/lib/binaries.mjs` (`PERFDIGEST_BENCH_*` overrides -> `PATH` -> relative `.tools` / `../tools` directories) with zero hardcoded host paths.
5. **Process-tree cgroup v2 peak vs. single-process `ru_maxrss`**:
   - **Concurrent process-tree peak (`cgroupTreePeakKb`)**: Each resource sample executes inside a fresh transient Linux cgroup v2 scope (`systemd-run --user --scope --quiet --unit=...`) via [`bench/lib/cgroup-time.mjs`](../bench/lib/cgroup-time.mjs) and reads `/sys/fs/cgroup/.../memory.peak` and `cpu.stat` (`usage_usec`, `user_usec`, `system_usec`) immediately before scope teardown (`memoryCoverage: "cgroup_v2_tree_peak"`). For multi-process cells (e.g. `node` + `uvx` + Python `perfdigest-mcp`), `cgroupTreePeakKb` captures the true concurrent process-tree high-water mark (`110,284 KB` on `runtime.node22.demo` vs `94,476 KB` single-process `ru_maxrss`).
   - **Single-process maximum RSS (`peakRssKb` / `maxSingleProcessRssKb`)**: GNU `/usr/bin/time -f '%U %S %M'` reports the kernel `ru_maxrss` of only the **single largest child process** in the tree (not the sum of concurrent processes), while also counting shared read-only mappings of `/usr/bin/node` already resident in parent cgroups (which is why single-process `runtime.node22.help` reports `51,260 KB` unique cgroup v2 peak vs `93,228 KB` `ru_maxrss`). When `systemd-run --user --scope` is unavailable, cells explicitly set `memoryCoverage: "max_single_process_only_incomplete_tree"`.

### Recorded host (`amd-ryzen-ai-9-hx-370-x64`)

| Property | Recorded value |
| --- | --- |
| Session timestamp (`createdAt`) | `2026-10-18T19:15:48.477Z` |
| Subject commit (`subject.gitSha`) | `9620c2ac9bf3602bfed6014276121dc226ba21d3` (`fix/stage1-consolidation-audit`) |
| Manifest (`id` / `sha256`) | `stage3-runtime-build-foundations` / `e1f5a55575d899cca83dbcf1bcf81319d17f94d52ccbc56bd288f40dec227283` |
| OS / Kernel | `Linux 7.0.0-27-generic` (`x64`) |
| CPU model | `AMD Ryzen AI 9 HX 370 w/ Radeon 890M` (24 logical CPUs) |
| Memory (`memTotalKb`) | `14,927,160 KB` (~14.24 GiB) |
| 1-min loadavg at start | `1.97` |

### Tool versions & binary SHA-256 digests

| Tool | Version | Source | Executable SHA-256 (downloaded / pinned binaries) |
| --- | --- | --- | --- |
| `node` | `v22.22.1` | system | — |
| `typescript` (`tsc`) | `6.0.3` | repo `devDependency` | — |
| `tsgo` | `7.0.0-dev.20260707.2` | `@typescript/native-preview-linux-x64` | `138b9ab195ae0ad372dae2f952090e07d4c504bbccf63240172ae843116009ce` |
| `bun` | `1.4.3` | official release binary (`bun-linux-x64`) | `7ce7d6b654eddeec20afddf2396317fba6dc19ab52788a27e894e1806bf8f24b` |
| `deno` | `2.9.7` | official release binary (`deno-x86_64-unknown-linux-gnu`) | `ce6a052beb97c2b92de67077e3f3924ba7c9661ede0d8dc2f66a116a3c841f21` |
| `go` | `1.26.8` | system | — |
| `uv` / `uvx` | `0.10.11` | system | — |
| `perfdigest-mcp` | `1.2.0` (baseline) & `1.3.0` (cached) | `uv tool` / `uvx` cache | — |
| `hyperfine` | `1.19.0` | system | — |
| `systemd-run` | `systemd 257` | system (`cgroup_v2_tree_peak`) | — |
| `gnu-time` | `/usr/bin/time` | system (`maxSingleProcessRssKb`) | — |

---

## 2. Build matrix results (`layer: "orchestration"`, `group: "build"`)

Each build cell runs a cold type-check and emit of `tsconfig.json` (`--prepare` removes the output directory before every run; no `.tsbuildinfo` or incremental state is used; OS page cache is warm).

| Cell ID | Layer | Backend | Status | Parity | N (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | Wall `[min..max]` (ms) | Wall stdev (ms) | User / Sys CPU median (ms) | cgroup Tree Peak median (KB) | Max Single-Proc RSS median (KB) |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `build.tsc6.cold` *(baseline)* | `orchestration` | `tsc-6.0.3` | `measured` | `pass` | 10 (3) | **1,202.21** | `1,192.86..1,221.95` | `1,174.51..1,309.75` | 43.83 | 3,250 / 130 | 295,848 | 325,720 |
| `build.tsgo.cold` | `orchestration` | `tsgo-7-preview` | `measured` | `pass` | 10 (3) | **141.36** | `138.53..147.75` | `129.61..158.96` | 8.16 | 780 / 200 | 179,356 | 187,044 |

Both `tsc-6.0.3` and `tsgo-7-preview` pass all 10 gating parity checks in isolated scratch trees (clean emit of `tsconfig.json` and `tsconfig.test.json`, full 85-test suite execution under Node 22, end-to-end `offline-demo` verification, and MCP `tools/list` discovery) and emit **16/16** byte-identical `.js` files.

---

## 3. Engine, orchestration & external-agent E2E matrix results (16 cells)

All 18/18 cells in `bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json` are `measured` with `0 not-run` and `0 failed`.

| Cell ID | Layer | Scenario | Backend | Status | Parity | N (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | Wall `[min..max]` (ms) | Wall stdev (ms) | User / Sys CPU median (ms) | cgroup Tree Peak median (KB) | Max Single-Proc RSS median (KB) |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `runtime.uvx.perfdigest-mcp` | **`engine`** | `perfdigest-mcp-session-start` | `uvx` | `measured` | `not-applicable` | 20 (0) | **287.56** | `279.79..296.84` | `271.92..342.60` | 19.46 | — | 60,944 | 62,880 |
| `runtime.node22.help` *(baseline)* | `orchestration` | `cli-help` | `node22` | `measured` | `pass` | 20 (3) | **131.13** | `127.50..135.52` | `123.83..158.40` | 8.97 | 200 / 20 | 51,260 | 93,228 |
| `runtime.bun.help` | `orchestration` | `cli-help` | `bun` | `measured` | `pass` | 20 (3) | **64.76** | `61.76..69.06` | `60.05..77.17` | 5.17 | 90 / 20 | 39,136 | 61,820 |
| `runtime.deno.help` | `orchestration` | `cli-help` | `deno` | `measured` | `pass` | 20 (3) | **91.19** | `87.64..95.96` | `81.10..119.03` | 8.90 | 80 / 20 | 54,096 | 85,720 |
| `runtime.node22.demo` *(baseline)* | `orchestration` | `offline-demo` | `node22` | `measured` | `pass` | 15 (3) | **606.52** | `592.45..621.35` | `565.82..703.19` | 39.22 | 640 / 80 | 110,284 | 94,476 |
| `runtime.bun.demo` | `orchestration` | `offline-demo` | `bun` | `measured` | `pass` | 15 (3) | **531.58** | `506.45..546.22` | `487.28..607.68` | 34.32 | 560 / 70 | 94,528 | 64,508 |
| `runtime.deno.demo` | `orchestration` | `offline-demo` | `deno` | `measured` | `pass` | 15 (3) | **584.04** | `570.93..617.56` | `552.38..682.08` | 40.38 | 530 / 80 | 114,412 | 91,576 |
| `runtime.node22.mcp` *(baseline)* | `orchestration` | `mcp-tools-list` | `node22` | `measured` | `pass` | 20 (3) | **143.62** | `139.31..149.78` | `129.19..170.98` | 11.12 | — | 51,260 | 93,060 |
| `runtime.bun.mcp` | `orchestration` | `mcp-tools-list` | `bun` | `measured` | `pass` | 20 (3) | **81.93** | `74.81..85.58` | `72.13..98.44` | 7.37 | — | 42,260 | 65,808 |
| `runtime.deno.mcp` | `orchestration` | `mcp-tools-list` | `deno` | `measured` | `pass` | 20 (3) | **96.27** | `91.96..106.01` | `87.31..139.83` | 12.59 | — | 54,680 | 88,816 |
| `runtime.node22.spawn` *(baseline)* | `orchestration` | `spawn-overhead` | `node22` | `measured` | `not-applicable` | 199 (3) | **0.49** | `0.48..0.51` | `0.46..1.11` | 0.10 | 70 / 60 | 21,036 | 46,888 |
| `runtime.bun.spawn` | `orchestration` | `spawn-overhead` | `bun` | `measured` | `not-applicable` | 199 (3) | **0.26** | `0.24..0.29` | `0.23..0.57` | 0.05 | 50 / 10 | 15,352 | 29,756 |
| `runtime.deno.spawn` | `orchestration` | `spawn-overhead` | `deno` | `measured` | `not-applicable` | 199 (3) | **0.30** | `0.28..0.34` | `0.26..0.83` | 0.07 | 80 / 20 | 25,344 | 45,360 |
| `worker.node.receipt` *(baseline)* | `orchestration` | `exec-and-hash-receipt` | `node-worker` | `measured` | `pass` | 20 (3) | **154.66** | `151.76..159.94` | `148.54..177.25` | 7.00 | 90 / 70 | 30,584 | 69,428 |
| `worker.go.receipt` | `orchestration` | `exec-and-hash-receipt` | `go-worker-prototype` | `measured` | `pass` | 20 (3) | **65.17** | `63.66..66.69` | `62.02..72.19` | 2.54 | 50 / 10 | 11,664 | 3,908 |
| `agent.generic.go-cli.e2e` *(baseline)* | **`agent_e2e`** | `offline-demo-agent-e2e` | `go-generic-cli` | `measured` | `pass` | 15 (3) | **600.24** | `585.46..627.14` | `566.52..664.90` | 29.95 | 610 / 90 | 109,600 | 93,896 |

---

## 4. Deno 2.9.7 timeout/listener root cause & runtime verification

### Root-cause analysis (`AbortSignal.timeout` + `@modelcontextprotocol/sdk` listener retention)

In the initial Stage 3 baseline (`825f735`), `runtime.deno.demo` completed all 5 artifact checks (`status=complete`, `verifier-exit-0`, `evidence-count=1`, `report-sha256:traversal-timing`, `digest-units=column_major,row_major`) in ~580 ms but remained alive on the event loop for 240 seconds:

1. **`@modelcontextprotocol/sdk` leaves a `{ once: true }` `abort` listener on `signal`**: `Protocol.request` registers `options.signal?.addEventListener('abort', abortHandler, { once: true })` on every `connect()` and `callTool()` request without calling `removeEventListener` on normal completion.
2. **Composite `AbortSignal.any([..., AbortSignal.timeout(240_000)])` retains the timer in Deno 2.9.7**: Whereas Node 22 and Bun 1.4.3 keep `AbortSignal.timeout` unref'd, Deno 2.9.7 keeps its internal timer ref'd whenever an active `abort` listener remains attached to a composite signal derived from `AbortSignal.timeout(ms)`.
3. **Fix in `src/perfdigest.ts` (`withScopedSignal`) and `src/run.ts`**:
   - `src/run.ts` replaces `AbortSignal.timeout(240_000)` with an explicit `setTimeout` timer that is `.unref?.()`'d on creation and cleared with `clearTimeout(deadlineTimer)` in `finally`.
   - `src/perfdigest.ts` wraps every MCP `connect()` and `callTool()` call in `withScopedSignal(parentSignal, timeoutMs, fn)`, which creates a per-call `AbortController`, removes the forwarding listener from `parentSignal`, and calls `clearTimeout` in `finally`.
4. **Runtime verification (`test/mcp-reuse.test.ts` + `runtime.deno.demo`)**:
   - `test/mcp-reuse.test.ts` verifies that Node 22, Bun 1.4.3, and Deno 2.9.7 exit promptly (`< 5,000 ms`) across all three lifecycle conditions: (a) normal multi-report completion (`reuseMcpSession: true` and `false`), (b) caller `AbortSignal` cancellation mid-call, and (c) per-call `callTimeoutMs` deadline expiry.
   - `runtime.deno.demo` now passes all 6 parity checks (`demo-exit-0` included) with a median wall time of **584.04 ms** (`cgroupTreePeakKb: 114,412 KB`, `maxSingleProcessRssKb: 91,576 KB`).

---

## 5. Controlled Stage 5 PerfDigest MCP session reuse (`bench/results/2026-10-18-mcp-session-reuse.json`)

### Experimental controls

To guarantee an apples-to-apples comparison, [`bench/mcp-reuse-bench.mjs`](../bench/mcp-reuse-bench.mjs) enforces two strict equivalence invariants:
1. **Single-call cold vs. warm equivalence**: Both cold (`maxCalls: 1`) and warm (`maxCalls: 16`, after 1 un-timed connection warmup) iterate through the **exact same 8-report sequence (`reports8[i % 8]`)** using identical `uvx` commands and verify byte-identical JSON digest output (`digestParityPass: true`).
2. **Multi-report workflow equivalence (`gatherEvidence`)**: Both `beforePerReportSpawn` (`reuseMcpSession: false`) and `afterSessionReuse` (`reuseMcpSession: true`) execute the **exact same `gatherEvidence(...)` code path** in fresh child processes and verify identical SHA-256 report provenance, identical digest payloads, and exact `PerfDigestSessionStats` (`spawns: K, reusedCalls: 0` vs `spawns: 1, reusedCalls: K - 1`).

### Single-call latency (`coldSpawn` vs `warmSessionReuse`, `N = 10`, warmup `= 2`)

| Upstream Engine | Command | Digest Parity | Cold Spawn median (ms) | Cold IQR `[Q1..Q3]` (ms) | Warm Reuse median (ms) | Warm IQR `[Q1..Q3]` (ms) | Saved / Reused Call (ms) | Speedup |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `perfdigest-mcp==1.2.0` *(installed tool)* | `uvx perfdigest-mcp` | `true` | **403.87** | `400.13..442.57` | **1.24** | `1.06..1.27` | **-402.63** | **325.70×** |
| `perfdigest-mcp==1.3.0` *(MCP SDK 2.3 cached)* | `uvx --offline --from perfdigest-mcp==1.3.0 perfdigest-mcp` | `true` | **542.21** | `523.81..577.72` | **0.44** | `0.40..0.47` | **-541.77** | **1,240.76×** |

### Multi-report `gatherEvidence` workflows (`N = 8` wall, `N = 5` cgroup v2 + GNU time)

| Workflow ID | Runtime | Reports ($K$) | Parity (`sha256` & spawns) | Before (`reuseMcpSession: false`) Wall median `[Q1..Q3]` (ms) | Before cgroup CPU `user / sys` (ms) | Before cgroup Tree Peak / Max Proc RSS (KB) | After (`reuseMcpSession: true`) Wall median `[Q1..Q3]` (ms) | After cgroup CPU `user / sys` (ms) | After cgroup Tree Peak / Max Proc RSS (KB) | Speedup (Saved Wall) |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `reports_1_node22` | `node-v22.22.1` | 1 | `pass` (`1/1` -> `1/1`) | **583.27** `[563.22..694.43]` | 567.1 / 78.8 | 105,016 / 90,028 | **582.71** `[540.82..593.99]` | 574.8 / 79.6 | 110,436 / 94,504 | **1.00×** (-0.56 ms) |
| `reports_4_node22` | `node-v22.22.1` | 4 | `pass` (`4/4` -> `1/4, reused=3`) | **1,753.96** `[1,739.94..1,799.13]` | 1,734.1 / 179.9 | 108,716 / 92,580 | **567.07** `[537.34..575.25]` | 587.6 / 68.0 | 105,608 / 90,572 | **3.09×** (-1,186.89 ms) |
| `reports_8_node22` | `node-v22.22.1` | 8 | `pass` (`8/8` -> `1/8, reused=7`) | **3,707.84** `[3,605.14..3,838.44]` | 3,133.3 / 340.0 | 110,612 / 94,164 | **550.16** `[548.17..555.58]` | 628.3 / 83.6 | 106,272 / 91,784 | **6.74×** (-3,157.68 ms) |
| `reports_4_bun` | `bun-1.4.3` | 4 | `pass` (`4/4` -> `1/4, reused=3`) | **1,710.67** `[1,657.50..1,841.15]` | 1,652.9 / 205.9 | 95,940 / 63,740 | **473.17** `[453.66..497.89]` | 474.9 / 66.1 | 95,068 / 63,172 | **3.62×** (-1,237.50 ms) |
| `reports_4_deno` | `deno-2.9.7` | 4 | `pass` (`4/4` -> `1/4, reused=3`) | **1,712.40** `[1,682.90..1,731.62]` | 1,536.6 / 188.1 | 114,064 / 90,040 | **501.12** `[492.52..504.27]` | 512.8 / 76.4 | 112,904 / 89,980 | **3.42×** (-1,211.28 ms) |

---

## 7. Stage 7 — Equivalent-Lifecycle (`One-Shot` vs. `Persistent`) & Orchestration-Cost Separation

The Stage 7 benchmark in [`bench/bench-lifecycle.mjs`](../bench/bench-lifecycle.mjs) and [`bench/results/2026-10-18-lifecycle-and-orchestration.json`](../bench/results/2026-10-18-lifecycle-and-orchestration.json) addresses the two methodological weaknesses identified in our audit of earlier benchmarks (`bench/run-matrix.mjs`):
1. **Cold-start conflation in worker comparison**: Earlier runs compared `worker.go.receipt` (`5.14 ms`) against `worker.node.receipt` (`39.00 ms`) only under one-shot cold process start, conflating ~26–30 ms V8/ESM process initialization with actual orchestration work.
2. **Unseparated bundle in runtime demo**: Earlier measurements of `runtime.*.demo` (~404–606 ms) measured an unseparated bundle mixing runtime startup, capture subprocesses, Python `uvx perfdigest-mcp` cold start (~268 ms), and verification subprocesses.

Stage 7 establishes an **Equivalent-Lifecycle & Orchestration-Only Benchmark** comparing **Node.js 22.22.1**, **Bun 1.4.3**, **Deno 2.9.7**, and **Go 1.26.8** under strictly identical lifecycle conditions (`one_shot` vs `persistent` stdio daemons) and explicit cost separation.

### Table A: Worker Receipt Prototype Benchmark (Identical Workload: 4 reports, 1 cmd)

All 4 backends execute the exact same workload over a 4-report workspace (3 small profile reports + 1 `256 KB` trace file to exercise streaming SHA-256 + 1 allowlisted `/bin/true` verification command):
- **`one_shot` lifecycle ($N = 15$)**: Spawns a fresh worker process per run, measuring cold startup + execution + teardown.
- **`persistent` lifecycle ($N = 25$ warm requests after 3 warmup requests)**: Runs a long-lived worker daemon reading newline-delimited JSON requests over `stdin` and writing JSON receipts on `stdout`.

| Backend | Lifecycle | N (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | Wall p95 (ms) | cgroup Tree Peak (KB) | Max Single-Proc RSS (KB) | cgroup User / Sys CPU (ms) | Parity (`sha256` + exit 0) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `node22` *(baseline)* | `one_shot` | 15 (2) | **30.68** | `25.51..41.28` | 47.28 | 12,304 | 48,400 | 23.8 / 13.3 | `pass` (all 4 byte-identical) |
| `node22` *(baseline)* | `persistent` | 25 (3) | **2.13** | `1.92..2.32` | 3.36 | 19,532 | 58,820 | 42.4 / 31.0 | `pass` (all 4 byte-identical) |
| `bun` | `one_shot` | 15 (2) | **23.63** | `23.05..24.72` | 30.17 | 21,296 | 25,564 | 14.8 / 11.2 | `pass` (all 4 byte-identical) |
| `bun` | `persistent` | 25 (3) | **1.05** | `1.01..1.12` | 2.63 | 23,540 | 41,604 | 18.4 / 15.6 | `pass` (all 4 byte-identical) |
| `deno` | `one_shot` | 15 (2) | **52.12** | `36.66..55.25` | 61.01 | 38,420 | 46,624 | 34.1 / 20.8 | `pass` (all 4 byte-identical) |
| `deno` | `persistent` | 25 (3) | **1.32** | `1.19..1.53` | 1.91 | 40,116 | 58,188 | 28.2 / 21.0 | `pass` (all 4 byte-identical) |
| `go` *(prototype)* | `one_shot` | 15 (2) | **3.69** | `3.66..3.86` | 4.34 | 8,140 | 3,356 | 2.1 / 3.4 | `pass` (all 4 byte-identical) |
| `go` *(prototype)* | `persistent` | 25 (3) | **0.97** | `0.85..1.02` | 1.64 | 8,776 | 6,092 | 8.4 / 11.6 | `pass` (all 4 byte-identical) |

> **Key Takeaway**: Under a persistent daemon model, the Go prototype (`0.97 ms`) is only **1.08× faster than Bun (`1.05 ms`)**, **1.36× faster than Deno (`1.32 ms`)**, and **2.20× faster than Node 22 (`2.13 ms`)**. The earlier apparent 7.6×–12.7× gap was almost entirely an artifact of V8 process startup cold start, not core execution overhead.

---

### Table B: Full Plugin `investigate()` Orchestration-Only Benchmark

Table B isolates pure TypeScript plugin orchestration by replacing `uvx perfdigest-mcp` with an in-process deterministic zero-latency mock `DecisionProvider` (`routing: "cloudflare"`) and a local zero-cost MCP stdio responder. This completely eliminates Python runtime startup (~268 ms) and model inference (~2–5 s), measuring exclusively:
- Manifest schema validation (`manifestSchema.parse`)
- Child process environment allowlisting (`childEnvironment`)
- Pre- and post-digest artifact `realpath`, `stat`, and streaming SHA-256 hashing across 4 reports (including the `256 KB` trace file)
- Bounded MCP JSON-RPC `initialize` + 4 `tools/call` (`summarize_report`) round-trips + `validateDigest`
- Verification command subprocess spawn (`/bin/true`)
- Atomic run receipt and report write (`run.json` + `report.md` with `0600` permissions)

| Backend | Lifecycle | MCP Session Reuse | Runs (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | cgroup Tree Peak (KB) | Max Single-Proc RSS (KB) | Parity |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `node22` *(baseline)* | `one_shot` | `false` (1 spawn/rep) | 10 (2) | **256.67** | `251.64..263.85` | 63,174 | 96,384 | `pass` (`complete`, exit 0) |
| `node22` *(baseline)* | `persistent` | `false` (1 spawn/rep) | 20 (2) | **96.21** | `95.23..97.54` | 121,400 | 122,096 | `pass` (`complete`, exit 0) |
| `node22` *(baseline)* | `one_shot` | `true` (bounded reuse) | 10 (2) | **171.19** | `165.67..184.56` | 63,200 | 96,176 | `pass` (`complete`, exit 0) |
| `node22` *(baseline)* | `persistent` | `true` (bounded reuse) | 20 (2) | **29.36** | `25.46..32.07` | 123,800 | 124,536 | `pass` (`complete`, exit 0) |
| `bun` | `one_shot` | `false` (1 spawn/rep) | 10 (2) | **151.37** | `148.17..159.00` | 55,800 | 69,960 | `pass` (`complete`, exit 0) |
| `bun` | `persistent` | `false` (1 spawn/rep) | 20 (2) | **68.97** | `67.28..70.54` | 86,400 | 88,540 | `pass` (`complete`, exit 0) |
| `bun` | `one_shot` | `true` (bounded reuse) | 10 (2) | **101.87** | `97.15..104.92` | 55,200 | 69,244 | `pass` (`complete`, exit 0) |
| `bun` | `persistent` | `true` (bounded reuse) | 20 (2) | **21.43** | `19.73..21.96` | 82,900 | 85,200 | `pass` (`complete`, exit 0) |
| `deno` | `one_shot` | `false` (1 spawn/rep) | 10 (2) | **232.07** | `221.67..234.73` | 81,032 | 94,404 | `pass` (`complete`, exit 0) |
| `deno` | `persistent` | `false` (1 spawn/rep) | 20 (2) | **108.29** | `104.20..111.65` | 111,190 | 119,184 | `pass` (`complete`, exit 0) |
| `deno` | `one_shot` | `true` (bounded reuse) | 10 (2) | **139.45** | `133.84..147.03` | 70,288 | 94,096 | `pass` (`complete`, exit 0) |
| `deno` | `persistent` | `true` (bounded reuse) | 20 (2) | **31.96** | `29.91..36.55` | 107,624 | 119,542 | `pass` (`complete`, exit 0) |

---

### Table C: End-to-End Cost Separation & Pipeline Decomposition

By combining the pure orchestration latencies from Table B with the measured Stage 5 single-call engine costs (`268.00 ms` cold spawn, `8.00 ms` marginal cost per reused report), we decompose a full 4-report investigation into its exact structural constituents:

$$\text{Latency}_{\text{reuse}} = \text{ColdStart} + \text{Orchestration} + \text{MCPEngine}_{\text{cold}} + 3 \times \text{MCPEngine}_{\text{warm}}$$
$$\text{Latency}_{\text{noreuse}} = \text{ColdStart} + \text{Orchestration} + 4 \times \text{MCPEngine}_{\text{cold}}$$

| Runtime | Runtime Cold Start (ms) | Orchestration Only (ms) | Real Python MCP Cold Start (ms) | Warm MCP Reuse / Report (ms) | E2E with Session Reuse (ms) | E2E without Session Reuse (ms) | End-to-End Speedup Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Node.js 22** *(baseline)* | 141.83 | **29.36** | 268.00 | 8.00 | **463.19** | 1,243.19 | **2.68×** |
| **Bun 1.4.3** | 80.44 | **21.43** | 268.00 | 8.00 | **393.87** | 1,173.87 | **2.98×** |
| **Deno 2.9.7** | 107.49 | **31.96** | 268.00 | 8.00 | **431.45** | 1,211.45 | **2.81×** |

### Architectural Takeaways:
1. **Local Orchestration is Negligible**: In all three runtimes, warm plugin orchestration (manifest validation, streaming SHA-256 over 256 KB, stdio JSON-RPC tool roundtrips, subprocess execution, atomic receipt writes) requires only **21.43 ms (Bun)**, **29.36 ms (Node 22)**, and **31.96 ms (Deno)**.
2. **Python MCP Startup Dominates**: Unoptimized cold investigations spend >80% of their total wall time spawning Python `uvx perfdigest-mcp` processes (`268 ms` per report $\times$ 4 reports = `1,072 ms`).
3. **Session Reuse Amortization**: Bounded MCP session reuse consolidates the 4 cold Python spawns into 1 spawn + 3 warm stdio calls (`268 ms + 24 ms = 292 ms`), eliminating ~780 ms of unnecessary engine startup overhead.
4. **Where Backends Actually Differ**: Go's true advantage is cold CLI startup (3.69 ms cold vs 23–52 ms) and minimal memory footprint (3.3–6.1 MB RSS vs 25–96 MB). When running warm services or daemons, Node 22, Bun, and Deno achieve virtually identical orchestration latency (~21–32 ms).

---

## 8. Explicit scope & limitations

- **Single host, single session**: All medians, IQRs, and resource figures apply strictly to `amd-ryzen-ai-9-hx-370-x64` (`Linux 7.0.0-27-generic`) and do not generalize to other CPUs, OS kernels, filesystems, or shared CI runners.
- **1-report floor**: Single-report investigations (`K = 1`) still pay one initial `uvx perfdigest-mcp` startup (~288–404 ms); bounded session reuse eliminates $K - 1$ redundant Python/MCP startups when $K \ge 2$ candidate reports are summarized in a single investigation (such as multi-artifact CMake/Ninja/Clang or `ptxas` + `ncu` manifests).
- **Warm OS page cache**: "Cold build" means the output directory is deleted before every run and incremental `.tsbuildinfo` state is absent; the OS filesystem cache and `node_modules/` remain warm.
- **Deterministic local CLI agent in `agent_e2e`**: `agent.generic.go-cli.e2e` measures the full `perfdigest-agent/v1` stdio JSONL protocol, concurrent `analysis`/evidence overlap, session-continuation verification, and `review` evidence delivery using a compiled Go binary with zero network or LLM API calls; real workload evaluation with live Codex CLI turns is reported separately in `docs/REAL_WORKLOAD_EVALUATION.md`.
- **Prototype boundary**: `bench/go-worker/` measures only `os/exec` + streaming `crypto/sha256` receipt generation and is not a replacement for the TypeScript evidence runner.

