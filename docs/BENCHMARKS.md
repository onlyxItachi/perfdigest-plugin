# Runtime, build, MCP session reuse & external-agent benchmark consolidation

This document summarizes the reproducible, credential-free benchmark suite in [`bench/`](../bench/README.md), the 3-layer schema coordination with [`PerfDigest-MCP-Bench`](https://github.com/onlyxItachi/PerfDigest-MCP-Bench), the 18-cell matrix session in [`bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json`](../bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json), the controlled Stage 5 MCP session-reuse benchmark in [`bench/results/2026-10-18-mcp-session-reuse.json`](../bench/results/2026-10-18-mcp-session-reuse.json), and the full 4-backend (`node22`, `bun`, `deno`, `go`) equivalent-lifecycle and end-to-end benchmark in [`bench/results/2026-10-18-lifecycle-and-orchestration.json`](../bench/results/2026-10-18-lifecycle-and-orchestration.json).

> **Default CLI & MCP binary (`dist/perfdigest-plugin`) + TypeScript library (`dist/*.js`)**: Following the complete Go 1.26 end-to-end parity implementation (`cmd/perfdigest-plugin` + `internal/perfdigest/*.go`, zero external Go dependencies) and 4-backend lifecycle evaluation (Section 6), **`dist/perfdigest-plugin` (compiled Go 1.26 binary)** is the default CLI & MCP binary (`package.json#bin.perfdigest-plugin`), while **`dist/*.js` (compiled by `tsc 6.0.3` from `src/*.ts`)** remains the preserved ESM library export for Node.js, Bun, and Deno consumers. `bench/` is excluded from `package.json#files`.

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

## 6. Full Go 1.26 End-to-End Backend Parity, Default Binary Migration & 4-Backend Lifecycle Benchmarks

The Stage 7 benchmark in [`bench/bench-lifecycle.mjs`](../bench/bench-lifecycle.mjs) and [`bench/results/2026-10-18-lifecycle-and-orchestration.json`](../bench/results/2026-10-18-lifecycle-and-orchestration.json) evaluates **all 4 complete end-to-end backends (`node22`, `bun`, `deno`, `go`)** across both **`one_shot`** and **`persistent`** lifecycles under identical workloads.

### Complete Go 1.26 Production Implementation (`cmd/perfdigest-plugin` + `internal/perfdigest/*.go`)

Unlike the earlier `bench/go-worker` receipt prototype, `dist/perfdigest-plugin` (`cmd/perfdigest-plugin/main.go` and `internal/perfdigest/*.go`, built with **Go 1.26.8 standard library only** and zero external Go module dependencies) implements **100% of the plugin surface**:
1. **CLI subcommands & persistent daemon modes**: `init`, `demo`, `run`, `mcp`, `--serve-jsonl`, `--bench-investigate`, and `--zero-cost-mcp`, matching all CLI flags (`--workspace`, `--manifest`, `--config-dir`, `--provider`, `--agent`, `--agent-command`, `--agent-args-json`, `--agent-sessions`, `--no-agent-sessions`, `--json`).
2. **Manifest validation, workspace path containment & streaming SHA-256 provenance**: Rejects unknown fields, path escapes (`../` or symlink escapes via `filepath.EvalSymlinks`), non-regular files, and empty reports; enforces `0700` directory and `0600` file permissions via atomic temp-file + `os.Rename` writes.
3. **Bounded PerfDigest MCP stdio session client (`internal/perfdigest/mcpclient.go`)**: Speaks newline-delimited MCP JSON-RPC 2.0 (`initialize`, `notifications/initialized`, `tools/call` for `summarize_report`), enforcing `maxCalls` per child process and `validateDigest` schema checks (`total_units`, `returned_units`, `truncated`, `units[]`).
4. **Routing & synthesis providers (`internal/perfdigest/providers.go`)**: Full HTTP client support for **Cloudflare SystemOne** (`/v1/systemone` routing choices + probabilities), **OpenAI Responses API** (`json_schema` structured outputs), **MiniMax M2.7** (`chat/completions` + `<think>` stripping), and deterministic **offline** heuristic fallback.
5. **External CLI agent runners (`internal/perfdigest/agents.go`)**: Full `perfdigest-agent/v1` generic JSONL runner (`sessionId` continuation across `analysis` and `review` turns) and `codex exec` / `codex exec resume` runner, with `Promise.allSettled`-equivalent concurrent execution overlapping the initial `analysis` turn with evidence capture + MCP digest.
6. **Plugin MCP stdio server (`internal/perfdigest/mcpserver.go`)**: Full MCP server exposing `launch_evidence_prefetch` and `get_evidence_job` with workspace-isolated background job queues (`queued` -> `running` -> `complete` / `abstained` / `failed`).
7. **Parity test suites**: Verified by both `go test ./...` ([`internal/perfdigest/perfdigest_test.go`](../internal/perfdigest/perfdigest_test.go)) and the 90-test Node.js test suite including [`test/go-backend-parity.test.ts`](../test/go-backend-parity.test.ts) and `npm run test:package` (`npx perfdigest-plugin` tarball check).

---

### Table A: Worker Receipt & 64 KB Streaming SHA-256 Benchmark (`node22`, `bun`, `deno`, `go`)

All 4 backends execute the exact same workload over a 4-report workspace (3 profile reports + 1 `256 KB` trace file to exercise 64 KB chunked streaming SHA-256 + 1 allowlisted `/bin/true` verification command) under `one_shot` ($N = 15$, warmup $= 2$) and `persistent` stdio JSONL daemon ($N = 25$, warmup $= 3$) lifecycles:

| Backend | Lifecycle | N (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | Wall max (ms) | cgroup Tree Peak (KB) | Max Single-Proc RSS (KB) | cgroup User / Sys CPU (ms) | Parity (`sha256` + exit 0) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `node22` *(baseline)* | `one_shot` | 15 (2) | **23.20** | `22.69..23.80` | 31.34 | 12,064 | 48,200 | 16.2 / 17.2 | `pass` (all 4 byte-identical) |
| `node22` *(baseline)* | `persistent` | 25 (3) | **1.29** | `1.19..1.36` | 2.04 | 12,688 | 58,212 | 15.7 / 10.1 | `pass` (all 4 byte-identical) |
| `bun` | `one_shot` | 15 (2) | **19.93** | `18.54..20.60` | 20.98 | 10,560 | 24,376 | 11.8 / 13.6 | `pass` (all 4 byte-identical) |
| `bun` | `persistent` | 25 (3) | **0.85** | `0.73..0.91` | 2.05 | 9,808 | 40,336 | 15.7 / 4.5 | `pass` (all 4 byte-identical) |
| `deno` | `one_shot` | 15 (2) | **33.40** | `30.12..36.56` | 42.33 | 18,344 | 44,884 | 25.7 / 15.6 | `pass` (all 4 byte-identical) |
| `deno` | `persistent` | 25 (3) | **0.87** | `0.76..0.94` | 1.36 | 19,304 | 56,056 | 41.8 / 9.7 | `pass` (all 4 byte-identical) |
| **`go`** | `one_shot` | 15 (2) | **2.32** | `2.26..2.42` | 2.65 | **3,832** | **3,548** | 2.1 / 7.4 | `pass` (all 4 byte-identical) |
| **`go`** | `persistent` | 25 (3) | **0.50** | `0.49..0.54` | 1.13 | **3,312** | **6,012** | 2.0 / 2.0 | `pass` (all 4 byte-identical) |

---

### Table B (Workload 1): Full `investigate()` Service Orchestration-Isolated (`node22`, `bun`, `deno`, `go`)

To compare all 4 backends on the **full `investigate()` orchestration service** without conflating child responder startup differences, all 4 backends (`node22`, `bun`, `deno`, `go`) spawn the **exact same compiled zero-cost MCP stdio responder (`dist/perfdigest-plugin --zero-cost-mcp`)** and talk over loopback TCP to the **exact same external SystemOne HTTP server (`/v1/systemone`)**, while executing:
- Full manifest validation & workspace symlink/containment verification
- Pre- and post-digest `realpath`, `stat`, and streaming SHA-256 across 4 reports (including the `256 KB` trace file)
- Bounded MCP JSON-RPC `initialize` + 4 `tools/call` (`summarize_report`) round-trips + `validateDigest` (`reuseMcpSession: false` = 4 MCP child spawns; `reuseMcpSession: true` = 1 MCP child spawn + 3 warm reused calls)
- Loopback HTTP `POST /v1/systemone` routing decision (`choice: "r2"`, `confidence: 0.91`) + synthesis
- Verification command subprocess spawn (`/bin/true`)
- Atomic `run.json` and `report.md` artifact generation (`0600` permissions)

| Backend | Lifecycle | MCP Session Reuse | Runs (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | cgroup Tree Peak (KB) | Max Single-Proc RSS (KB) | cgroup User / Sys CPU (ms) | Parity |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `node22` *(baseline)* | `one_shot` | `false` (4 spawns) | 10 (2) | **180.44** | `173.81..186.60` | 65,030 | 98,008 | 254.4 / 42.3 | `pass` (`complete`, `r2`, exit 0) |
| `node22` *(baseline)* | `persistent` | `false` (4 spawns) | 15 (2) | **27.36** | `26.36..27.89` | 110,548 | 129,974 | 579.6 / 296.4 | `pass` (`complete`, `r2`, exit 0) |
| `node22` *(baseline)* | `one_shot` | `true` (1 spawn + 3 reuse) | 10 (2) | **169.20** | `165.21..171.38` | 57,778 | 97,408 | 232.3 / 44.7 | `pass` (`complete`, `r2`, exit 0) |
| `node22` *(baseline)* | `persistent` | `true` (1 spawn + 3 reuse) | 15 (2) | **14.10** | `13.59..15.34` | 94,350 | 125,342 | 435.9 / 135.4 | `pass` (`complete`, `r2`, exit 0) |
| `bun` | `one_shot` | `false` (4 spawns) | 10 (2) | **106.55** | `102.73..117.63` | 56,372 | 66,768 | 136.3 / 45.8 | `pass` (`complete`, `r2`, exit 0) |
| `bun` | `persistent` | `false` (4 spawns) | 15 (2) | **18.89** | `17.84..19.65` | 95,032 | 90,344 | 445.6 / 199.4 | `pass` (`complete`, `r2`, exit 0) |
| `bun` | `one_shot` | `true` (1 spawn + 3 reuse) | 10 (2) | **88.32** | `87.85..91.28` | 47,322 | 66,836 | 134.0 / 44.4 | `pass` (`complete`, `r2`, exit 0) |
| `bun` | `persistent` | `true` (1 spawn + 3 reuse) | 15 (2) | **8.84** | `8.53..9.38` | 75,662 | 84,622 | 261.6 / 113.0 | `pass` (`complete`, `r2`, exit 0) |
| `deno` | `one_shot` | `false` (4 spawns) | 10 (2) | **140.00** | `138.08..143.26` | 67,328 | 91,676 | 151.7 / 48.5 | `pass` (`complete`, `r2`, exit 0) |
| `deno` | `persistent` | `false` (4 spawns) | 15 (2) | **27.59** | `25.54..28.38` | 101,036 | 115,002 | 518.8 / 229.9 | `pass` (`complete`, `r2`, exit 0) |
| `deno` | `one_shot` | `true` (1 spawn + 3 reuse) | 10 (2) | **128.65** | `125.36..130.17` | 60,826 | 91,788 | 130.3 / 36.0 | `pass` (`complete`, `r2`, exit 0) |
| `deno` | `persistent` | `true` (1 spawn + 3 reuse) | 15 (2) | **15.69** | `14.68..16.68` | 89,232 | 114,636 | 392.6 / 129.0 | `pass` (`complete`, `r2`, exit 0) |
| **`go` (`dist/perfdigest-plugin`)** | `one_shot` | `false` (4 spawns) | 10 (2) | **16.65** | `16.45..16.81` | **18,936** | **11,044** | 9.7 / 18.2 | `pass` (`complete`, `r2`, exit 0) |
| **`go` (`dist/perfdigest-plugin`)** | `persistent` | `false` (4 spawns) | 15 (2) | **13.08** | `12.85..13.34` | **51,232** | **14,748** | 141.3 / 139.1 | `pass` (`complete`, `r2`, exit 0) |
| **`go` (`dist/perfdigest-plugin`)** | `one_shot` | `true` (1 spawn + 3 reuse) | 10 (2) | **10.79** | `10.76..10.93` | **11,082** | **11,138** | 7.9 / 12.9 | `pass` (`complete`, `r2`, exit 0) |
| **`go` (`dist/perfdigest-plugin`)** | `persistent` | `true` (1 spawn + 3 reuse) | 15 (2) | **6.88** | `6.70..7.07` | **31,370** | **14,554** | 88.8 / 62.6 | `pass` (`complete`, `r2`, exit 0) |

> **Workload 1 Takeaway**: On the full `investigate()` orchestration service with `reuseMcpSession: true`, **`go` (`dist/perfdigest-plugin`)** completes `one_shot` CLI invocation in **10.79 ms** (**15.7× faster** than Node 22 `169.20 ms`, **8.2× faster** than Bun `88.32 ms`, **11.9× faster** than Deno `128.65 ms`) with **11.1 MB cgroup peak memory** (**4.3×–5.5× lower** than Bun `47.3 MB`, Node 22 `57.8 MB`, and Deno `60.8 MB`). Even in the **persistent warm daemon** lifecycle (`reuseMcpSession: true`), Go (**6.88 ms**, **14.6 MB RSS**) is **2.05× faster than Node 22 (`14.10 ms`, `125.3 MB RSS`)**, **1.28× faster than Bun (`8.84 ms`, `84.6 MB RSS`)**, and **2.28× faster than Deno (`15.69 ms`, `114.6 MB RSS`)** while using **5.8×–8.6× less resident memory**.

---

### Table B2 (Workload 2): Full `investigate()` Live E2E Service with Real Python `uvx perfdigest-mcp` Engine (`node22`, `bun`, `deno`, `go`)

Table B2 replaces the zero-cost MCP responder with the **real Python `uvx perfdigest-mcp` engine** (`reuseMcpSession: true`), measuring the complete end-to-end 4-report investigation (`uvx perfdigest-mcp` session startup + 4 real `summarize_report` digests + loopback SystemOne HTTP routing + `/bin/true` verification + `run.json`/`report.md`) across all 4 backends:

| Backend | Lifecycle | MCP Session Reuse | Runs (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | cgroup Tree Peak (KB) | Max Single-Proc RSS (KB) | cgroup User / Sys CPU (ms) | Parity |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `node22` *(baseline)* | `one_shot` | `true` (live `uvx`) | 5 (1) | **540.62** | `533.52..545.71` | 114,150 | 97,794 | 568.5 / 79.2 | `pass` (`complete`, `r2`, exit 0) |
| `node22` *(baseline)* | `persistent` | `true` (live `uvx`) | 8 (1) | **384.21** | `374.15..390.49` | 132,582 | 114,982 | 3,325.6 / 408.5 | `pass` (`complete`, `r2`, exit 0) |
| `bun` | `one_shot` | `true` (live `uvx`) | 5 (1) | **456.23** | `455.54..465.51` | 98,916 | 64,718 | 481.2 / 86.5 | `pass` (`complete`, `r2`, exit 0) |
| `bun` | `persistent` | `true` (live `uvx`) | 8 (1) | **370.33** | `368.96..377.57` | 106,022 | 68,280 | 3,276.5 / 426.5 | `pass` (`complete`, `r2`, exit 0) |
| `deno` | `one_shot` | `true` (live `uvx`) | 5 (1) | **502.79** | `495.77..507.03` | 116,542 | 91,730 | 469.5 / 76.4 | `pass` (`complete`, `r2`, exit 0) |
| `deno` | `persistent` | `true` (live `uvx`) | 8 (1) | **387.43** | `380.73..394.53` | 139,618 | 114,272 | 3,304.7 / 400.2 | `pass` (`complete`, `r2`, exit 0) |
| **`go` (`dist/perfdigest-plugin`)** | `one_shot` | `true` (live `uvx`) | 5 (1) | **300.88** | `290.86..302.66` | **66,090** | **65,014** | 251.5 / 60.2 | `pass` (`complete`, `r2`, exit 0) |
| **`go` (`dist/perfdigest-plugin`)** | `persistent` | `true` (live `uvx`) | 8 (1) | **292.89** | `287.87..300.25` | **72,692** | **65,072** | 2,289.1 / 356.3 | `pass` (`complete`, `r2`, exit 0) |

> **Workload 2 Takeaway**: Even when the real Python `uvx perfdigest-mcp` engine (`~268 ms` cold start + `3 × 8 ms` warm calls = `~292 ms` engine floor) is included in the critical path, **`go` (`dist/perfdigest-plugin`)** completes a cold 4-report end-to-end investigation in **300.88 ms** (**239.7 ms / 1.80× faster than Node 22 `540.62 ms`**, **155.3 ms / 1.52× faster than Bun `456.23 ms`**, **201.9 ms / 1.67× faster than Deno `502.79 ms`**) and reduces the concurrent process-tree cgroup memory peak from **98.9–116.5 MB** down to **66.1 MB** (eliminating the entire JS runtime heap overhead on top of Python `uvx`).

---

### Table C: End-to-End Cost Separation & Pipeline Decomposition (`node22`, `bun`, `deno`, `go`)

Combining the measured runtime cold start ($\text{Table B}_{\text{one\_shot, reuse}} - \text{Table B}_{\text{persistent, reuse}}$) and warm orchestration latency ($\text{Table B}_{\text{persistent, reuse}}$) with the Stage 5 Python `uvx perfdigest-mcp` engine costs (`268.00 ms` cold spawn, `8.00 ms` warm reuse per report):

$$\text{Latency}_{\text{reuse}} = \text{ColdStart} + \text{Orchestration} + \text{MCPEngine}_{\text{cold}} + 3 \times \text{MCPEngine}_{\text{warm}}$$
$$\text{Latency}_{\text{noreuse}} = \text{ColdStart} + \text{Orchestration} + 4 \times \text{MCPEngine}_{\text{cold}}$$

| Runtime | Runtime Cold Start (ms) | Orchestration Only (ms) | Real Python MCP Cold Start (ms) | Warm MCP Reuse / Report (ms) | E2E with Session Reuse (ms) | E2E without Session Reuse (ms) | End-to-End Speedup Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Node.js 22** *(baseline)* | 155.10 | **14.10** | 268.00 | 8.00 | **461.20** *(measured: 540.62)* | 1,241.20 | **2.69×** |
| **Bun 1.4.3** | 79.48 | **8.84** | 268.00 | 8.00 | **380.32** *(measured: 456.23)* | 1,160.32 | **3.05×** |
| **Deno 2.9.7** | 112.96 | **15.69** | 268.00 | 8.00 | **420.65** *(measured: 502.79)* | 1,200.65 | **2.85×** |
| **Go 1.26.8 (`dist/perfdigest-plugin`)** | **3.91** | **6.88** | 268.00 | 8.00 | **302.79** *(measured: 300.88)* | 1,082.79 | **3.58×** |

---

### Table D (Workload 3): Full Plugin MCP Stdio Server (`mcp`) Job Lifecycle (`node22`, `bun`, `deno`, `go`)

Table D benchmarks the plugin's own **MCP stdio server mode (`perfdigest-plugin mcp`)** across a full client session (`initialize` -> `notifications/initialized` -> `tools/list` -> `tools/call(launch_evidence_prefetch)` -> polling `tools/call(get_evidence_job)` until `complete`) backed by the live Python `uvx perfdigest-mcp` engine and loopback SystemOne HTTP routing:

| Backend | Lifecycle | Runs (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | Wall max (ms) | cgroup Tree Peak (KB) | MCP Server Process `VmHWM` (KB) | cgroup User / Sys CPU (ms) | Parity |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `node22` *(baseline)* | `one_shot` | 5 (1) | **535.81** | `530.54..540.53` | 571.11 | 111,528 | 99,288 | 546.8 / 62.6 | `pass` (`2 tools`, `complete`, `r2`) |
| `node22` *(baseline)* | `persistent` | 8 (1) | **379.04** | `375.16..384.11` | 409.66 | 111,576 | 116,888 | 546.7 / 67.2 | `pass` (`2 tools`, `complete`, `r2`) |
| `bun` | `one_shot` | 5 (1) | **477.15** | `469.12..486.28` | 507.54 | 98,176 | 66,428 | 482.3 / 72.8 | `pass` (`2 tools`, `complete`, `r2`) |
| `bun` | `persistent` | 8 (1) | **366.31** | `364.96..371.28` | 378.64 | 98,184 | 71,320 | 493.1 / 58.7 | `pass` (`2 tools`, `complete`, `r2`) |
| `deno` | `one_shot` | 5 (1) | **494.16** | `491.27..499.87` | 510.03 | 116,548 | 94,364 | 454.6 / 58.4 | `pass` (`2 tools`, `complete`, `r2`) |
| `deno` | `persistent` | 8 (1) | **377.57** | `374.61..383.49` | 403.82 | 116,464 | 110,648 | 453.5 / 69.6 | `pass` (`2 tools`, `complete`, `r2`) |
| **`go` (`dist/perfdigest-plugin mcp`)** | `one_shot` | 5 (1) | **289.49** | `288.89..290.56` | 291.55 | **65,756** | **11,516** | 258.0 / 40.6 | `pass` (`2 tools`, `complete`, `r2`) |
| **`go` (`dist/perfdigest-plugin mcp`)** | `persistent` | 8 (1) | **291.29** | `289.34..293.56` | 300.86 | **66,068** | **14,732** | 266.2 / 39.3 | `pass` (`2 tools`, `complete`, `r2`) |

> **Workload 3 & Default Binary Migration Takeaway**:
> 1. **Instantaneous MCP Server & CLI Cold Start (`3.91 ms` vs `79–155 ms`)**: In `perfdigest-plugin mcp`, Go `one_shot` (**289.49 ms**) matches Go `persistent` (**291.29 ms**) and is **1.85× faster than Node 22 `one_shot` (`535.81 ms`)** and **1.30× faster than Node 22 `persistent` (`379.04 ms`)**.
> 2. **4.8×–8.6× Lower Long-Lived MCP Server Memory (`11.5–14.7 MB` vs `66.4–116.9 MB`)**: Because IDE and agent hosts (Claude Code, Cursor, Codex, Antigravity) keep MCP stdio servers running in the background for the duration of a developer session, migrating `"bin": { "perfdigest-plugin": "dist/perfdigest-plugin" }` reduces idle/active MCP server resident memory from **99–117 MB (Node 22)** down to **11.5–14.7 MB (Go)** while cutting cgroup tree peak memory (server + Python `uvx` child) from **111.6 MB** to **65.8 MB**.
> 3. **Dual-Surface Packaging**: `npm run build` compiles both `dist/*.js` (`tsc -p tsconfig.json`) for programmatic ESM library imports and `dist/perfdigest-plugin` (`go build -trimpath -ldflags="-s -w"`) as the default CLI/MCP binary.

---

## 7. Explicit scope & limitations

- **Single host, single session**: All medians, IQRs, and resource figures apply strictly to `amd-ryzen-ai-9-hx-370-x64` (`Linux 7.0.0-27-generic`) and do not generalize to other CPUs, OS kernels, filesystems, or shared CI runners.
- **1-report floor**: Single-report investigations (`K = 1`) still pay one initial `uvx perfdigest-mcp` startup (~268–404 ms); bounded session reuse eliminates $K - 1$ redundant Python/MCP startups when $K \ge 2$ candidate reports are summarized in a single investigation (such as multi-artifact CMake/Ninja/Clang or `ptxas` + `ncu` manifests).
- **Warm OS page cache**: "Cold build" means the output directory is deleted before every run and incremental `.tsbuildinfo` state is absent; the OS filesystem cache and `node_modules/` remain warm.
- **Deterministic local CLI agent in `agent_e2e`**: `agent.generic.go-cli.e2e` measures the full `perfdigest-agent/v1` stdio JSONL protocol, concurrent `analysis`/evidence overlap, session-continuation verification, and `review` evidence delivery using a compiled Go binary with zero network or LLM API calls; real workload evaluation with live Codex CLI turns is reported separately in `docs/REAL_WORKLOAD_EVALUATION.md`.


