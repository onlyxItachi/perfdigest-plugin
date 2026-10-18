# Runtime, build & external-agent benchmark consolidation (Stage 3 + Stage 6)

This document summarizes the reproducible, credential-free benchmark harness in [`bench/`](../bench/README.md), the 3-layer schema coordination with [`PerfDigest-MCP-Bench`](https://github.com/onlyxItachi/PerfDigest-MCP-Bench), and the recorded 18-cell session in [`bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json`](../bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json).

> **Reference baseline**: **Node.js v22.22.1 + TypeScript 6.0.3 (`tsc`)** remains the production build and runtime baseline. Nothing in `bench/` modifies `src/`, `test/`, or the published package (`bench/` is excluded from `package.json#files`).

---

## 1. Methodology, 3-layer architecture & `PerfDigest-MCP-Bench` coordination

### Three-layer metric separation (`engine` | `orchestration` | `agent_e2e`)

To prevent conflating upstream Python MCP digest latency with TypeScript plugin orchestration or external agent turn overhead, every cell in `perfdigest.benchmark-manifest.v1` and `perfdigest.benchmark-result.v1` carries both an architectural `layer` (`engine` | `orchestration` | `agent_e2e`) and a functional `group` (`build` | `runtime` | `worker` | `agent`), summarized at the top level in `layerSummary`:

| Layer (`cell.layer`) | Scope | Cells in `bench/manifests/default.json` | Recorded `layerSummary` (`total` / `measured` / `notRun` / `parityPass`) |
| --- | --- | --- | --- |
| **`engine`** | Upstream PerfDigest MCP server session startup & tool surface (`uvx perfdigest-mcp`) | `runtime.uvx.perfdigest-mcp` (1 cell) | `1` total / `1` measured / `0` not-run (`parityNotApplicable: 1`) |
| **`orchestration`** | Compiler build (`tsc` vs `tsgo`), CLI startup, agentless offline demo (`--agent none`), plugin MCP server discovery, child-process spawn loop, and worker receipt hashing (`node` vs `go`) | `build.*` (2), `runtime.*.{help,demo,mcp,spawn}` (12), `worker.*.receipt` (2) (16 cells) | `16` total / `15` measured / `1` not-run (`parityPass: 12`, `parityFail: 1`, `parityNotApplicable: 3`) |
| **`agent_e2e`** | End-to-end offline investigation orchestrated with a genuine compiled Go `perfdigest-agent/v1` CLI agent (`--agent generic --agent-sessions`: `analysis` turn overlapped with capture + MCP digest, followed by independent verification and `same_session_next_turn` `review` turn) | `agent.generic.go-cli.e2e` (1 cell) | `1` total / `1` measured / `0` not-run (`parityPass: 1`) |

### Schema coordination with `PerfDigest-MCP-Bench` (`benchCompatibility`)

The JSON Schemas in [`bench/schema/benchmark-result.v1.schema.json`](../bench/schema/benchmark-result.v1.schema.json) and [`bench/schema/benchmark-manifest.v1.schema.json`](../bench/schema/benchmark-manifest.v1.schema.json) (generated from [`bench/schema/formats.mjs`](../bench/schema/formats.mjs) via `node bench/schema/build-schema.mjs`) include a top-level `benchCompatibility` block documenting deterministic mapping between `onlyxItachi/PerfDigest-MCP-Bench` raw artifacts (`results/interpreter_matrix_raw`, `results/cpp_build_loop_raw`, `results/cuda_opt_bench_raw`) and `perfdigest.benchmark-result.v1`:

| `PerfDigest-MCP-Bench` raw artifact | Raw field shape | Mapping in `perfdigest.benchmark-result.v1` |
| --- | --- | --- |
| `results/interpreter_matrix_raw/*_latency.json` | `results["<backend>:<format>"].{median_us, q1_us, q3_us, iqr_us, n}` | `cells[layer="engine"].wall.{unit: "us", median, q1, q3, n}` |
| `results/interpreter_matrix_raw/*_identity.json` | `results["<backend>:<format>"].{sha256, bytes, total_units}` | `cells[layer="engine"].parity.checks[name="digest-sha256:<backend>:<format>"]` |
| `results/interpreter_matrix_raw/*_startup.json` | `{median_startup_s}` | `cells[layer="engine", scenario="interpreter-startup"].wall.{unit: "s", median}` |
| `results/interpreter_matrix_raw/*_concurrency.json` | `{same_path_1thread, same_path_nthreads, mixed_paths_nthreads}.{wall_time_s, throughput_calls_per_s, correct}` | `cells[layer="engine"].extra.concurrency` |
| `results/interpreter_matrix_raw/latency_loadavg.json` | `{start_1m, end_1m}` | `host.loadavg1AtStart` |

### Experimental rules

1. **Build vs. runtime vs. agent E2E separation**: Build cells (`tsc` 6.0.3 vs. `tsgo` TS 7 native preview), runtime orchestration cells, upstream MCP engine cells, and external CLI agent E2E cells are measured and gated separately.
2. **Contract-parity gate before interpretation**: Every cell records a structured `parity` block (`pass`, `fail`, `not-checked`, or `not-applicable`). If a backend fails contract parity before timing, timing is skipped (`status: "not-run"`) and no performance comparison or superiority claim is made.
3. **Credential-free offline isolation**: Every child process executes with a minimal allowlisted environment (`PATH`, `HOME`, `TMPDIR`, `USER`, `XDG_CACHE_HOME`, `LANG=C`, `LC_ALL=C`, `NO_COLOR=1`, `DENO_NO_UPDATE_CHECK=1`), a throwaway `XDG_CONFIG_HOME` in `/tmp`, and offline routing (`--provider offline`). Zero credentials, hosted model turns, or external network requests are used.
4. **Measurement primitives**:
   - Process-level wall time uses `hyperfine -N` (no shell wrapper) with explicit warmup runs and `--prepare` cleanup where state is written.
   - Process-tree CPU (`userMedian`, `sysMedian`) and `peakRssKb` use GNU `/usr/bin/time -f '%U %S %M'` in separate un-timed runs (`rssRuns = 5`) so resource instrumentation does not perturb wall-time samples.
   - MCP stdio discovery (`mcp-tools-list` and `perfdigest-mcp-session-start`) uses a constant Node 22 MCP SDK client (`bench/probes/mcp-probe.mjs`) so only the server backend varies.

### Recorded host (`amd-ryzen-ai-9-hx-370-x64`)

| Property | Recorded value |
| --- | --- |
| Session timestamp (`createdAt`) | `2026-10-18T17:55:05.324Z` |
| Subject commit (`gitSha`) | `6d628f532975604c567ec5efc9f95fb92b6bfcbd` (`dirty: false`) |
| Manifest (`id` / `sha256`) | `stage3-runtime-build-foundations` / `e1f5a55575d899cca83dbcf1bcf81319d17f94d52ccbc56bd288f40dec227283` |
| OS / Kernel | `Linux 7.0.0-27-generic` (`x64`) |
| CPU model | `AMD Ryzen AI 9 HX 370 w/ Radeon 890M` (24 logical CPUs) |
| Memory (`memTotalKb`) | `14,927,160 KB` (~14.24 GiB) |
| 1-min loadavg at start | `2.21` |

### Tool versions & binary SHA-256 digests

| Tool | Version | Source | Executable SHA-256 (downloaded / pinned binaries) |
| --- | --- | --- | --- |
| `node` | `v22.22.1` | system | — |
| `typescript` (`tsc`) | `6.0.3` | repo `devDependency` | — |
| `tsgo` | `7.0.0-dev.20260707.2` | `@typescript/native-preview` (`bench/package.json`) | `138b9ab195ae0ad372dae2f952090e07d4c504bbccf63240172ae843116009ce` |
| `bun` | `1.4.3` | official release binary (`bun-linux-x64`) | `7ce7d6b654eddeec20afddf2396317fba6dc19ab52788a27e894e1806bf8f24b` |
| `deno` | `2.9.7` | official release binary (`deno-x86_64-unknown-linux-gnu`) | `ce6a052beb97c2b92de67077e3f3924ba7c9661ede0d8dc2f66a116a3c841f21` |
| `go` | `1.26.8` | system | — |
| `uv` / `uvx` | `0.10.11` | system | — |
| `perfdigest-mcp` | `1.2.0` | `uv tool` | — |
| `hyperfine` | `1.19.0` | system | — |
| `gnu-time` | `/usr/bin/time` | system | — |

---

## 2. Build matrix results (`layer: "orchestration"`, `group: "build"`)

Each build cell runs a cold type-check and emit of `tsconfig.json` (`--prepare` removes the output directory before every run; no `.tsbuildinfo` or incremental state is used; OS page cache is warm).

| Cell ID | Layer | Backend | Status | Parity | N (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | Wall `[min..max]` (ms) | Wall stdev (ms) | User / Sys CPU median (ms) | Peak RSS median (KB) |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `build.tsc6.cold` *(baseline)* | `orchestration` | `tsc-6.0.3` | `measured` | `pass` | 10 (3) | **1,290.25** | `1,251.32..1,298.59` | `1,184.37..1,368.16` | 59.29 | 3,310 / 120 | 335,428 |
| `build.tsgo.cold` | `orchestration` | `tsgo-7-preview` | `measured` | `pass` | 10 (3) | **135.77** | `132.03..139.42` | `128.42..145.76` | 5.28 | 760 / 150 | 186,916 |

### Build parity verification

Both `tsc-6.0.3` and `tsgo-7-preview` passed all 10 gating parity checks in isolated scratch trees:
- Clean emit of both `tsconfig.json` (`emit-dist`) and `tsconfig.test.json` (`emit-test-build`).
- Full test suite execution under Node 22 (`node --test .test-build/test/*.test.js`), including external Go + Python CLI agent tests (`test/generic-agent-external.test.ts`).
- End-to-end offline demo execution against the emitted `dist/cli.js` (`demo-exit-0`, `status=complete`, `verifier-exit-0`, `evidence-count=1`, `report-sha256:traversal-timing`, `digest-units=column_major,row_major`).
- MCP stdio discovery against the emitted `dist/cli.js` (`cancel_evidence_job,get_evidence_job,launch_evidence_prefetch`).
- Informational check (`info:js-byte-identical-to-repo-dist`): `tsgo` emitted **16/16** `.js` files byte-identical (SHA-256) to `tsc` 6.0.3 for the current `src/` tree.

---

## 3. Engine, orchestration & external-agent E2E matrix results (16 cells)

All runtime and agent cells execute the production `tsc`-emitted `dist/cli.js` (or `bench/probes/spawn-loop.mjs`).

| Cell ID | Layer | Scenario | Backend | Status | Parity | N (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | Wall `[min..max]` (ms) | Wall stdev (ms) | User / Sys CPU median (ms) | Peak RSS median (KB) |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `runtime.uvx.perfdigest-mcp` | **`engine`** | `perfdigest-mcp-session-start` | `uvx` | `measured` | `not-applicable` | 20 (0) | **276.80** | `273.45..282.30` | `266.17..313.24` | 12.05 | — | 62,844 |
| `runtime.node22.help` *(baseline)* | `orchestration` | `cli-help` | `node22` | `measured` | `pass` | 20 (3) | **125.66** | `120.64..128.99` | `118.15..135.48` | 5.15 | 170 / 20 | 89,600 |
| `runtime.bun.help` | `orchestration` | `cli-help` | `bun` | `measured` | `pass` | 20 (3) | **65.02** | `60.85..68.88` | `57.19..80.98` | 6.46 | 90 / 20 | 61,996 |
| `runtime.deno.help` | `orchestration` | `cli-help` | `deno` | `measured` | `pass` | 20 (3) | **84.91** | `82.93..88.01` | `79.51..91.68` | 3.51 | 80 / 20 | 85,160 |
| `runtime.node22.demo` *(baseline)* | `orchestration` | `offline-demo` | `node22` | `measured` | `pass` | 15 (3) | **580.81** | `563.64..596.01` | `546.02..661.49` | 28.67 | 610 / 70 | 93,560 |
| `runtime.bun.demo` | `orchestration` | `offline-demo` | `bun` | `measured` | `pass` | 15 (3) | **514.03** | `498.43..531.93` | `466.28..549.35` | 24.49 | 520 / 70 | 65,620 |
| `runtime.deno.demo` | `orchestration` | `offline-demo` | `deno` | `not-run` | **`fail`** | — | — | — | — | — | — | — |
| `runtime.node22.mcp` *(baseline)* | `orchestration` | `mcp-tools-list` | `node22` | `measured` | `pass` | 20 (3) | **133.09** | `129.19..139.73` | `124.20..147.69` | 7.31 | — | 93,160 |
| `runtime.bun.mcp` | `orchestration` | `mcp-tools-list` | `bun` | `measured` | `pass` | 20 (3) | **78.95** | `74.72..83.85` | `70.53..95.59` | 7.50 | — | 66,264 |
| `runtime.deno.mcp` | `orchestration` | `mcp-tools-list` | `deno` | `measured` | `pass` | 20 (3) | **94.17** | `88.82..95.95` | `86.81..109.47` | 6.90 | — | 88,020 |
| `runtime.node22.spawn` *(baseline)* | `orchestration` | `spawn-overhead` | `node22` | `measured` | `not-applicable` | 199 (3) | **0.50** | `0.48..0.54` | `0.46..0.90` | 0.07 | 60 / 60 | 46,680 |
| `runtime.bun.spawn` | `orchestration` | `spawn-overhead` | `bun` | `measured` | `not-applicable` | 199 (3) | **0.24** | `0.23..0.26` | `0.22..0.63` | 0.06 | 50 / 10 | 29,596 |
| `runtime.deno.spawn` | `orchestration` | `spawn-overhead` | `deno` | `measured` | `not-applicable` | 199 (3) | **0.27** | `0.26..0.28` | `0.25..0.59` | 0.04 | 60 / 20 | 45,588 |
| `worker.node.receipt` *(baseline)* | `orchestration` | `exec-and-hash-receipt` | `node-worker` | `measured` | `pass` | 20 (3) | **151.53** | `147.62..152.68` | `142.88..167.47` | 5.29 | 90 / 60 | 69,756 |
| `worker.go.receipt` | `orchestration` | `exec-and-hash-receipt` | `go-worker-prototype` | `measured` | `pass` | 20 (3) | **62.81** | `60.21..65.33` | `57.61..69.34` | 3.54 | 40 / 10 | 3,908 |
| `agent.generic.go-cli.e2e` *(baseline)* | **`agent_e2e`** | `offline-demo-agent-e2e` | `go-generic-cli` | `measured` | `pass` | 15 (3) | **589.24** | `585.20..602.61` | `557.80..679.29` | 30.54 | 600 / 80 | 94,236 |

*Note on `spawn-overhead`*: Wall-time statistics are per-spawn (`N = 199` warm sequential spawns of `/bin/true` inside one process after dropping the first cold spawn), whereas CPU and peak RSS are measured by GNU time for the entire 200-spawn loop process.

---

## 4. Contract-parity gate findings & Deno 2.9.7 root-cause analysis

| Cell / Group | Layer | Parity status | Key findings |
| --- | --- | --- | --- |
| `build.tsc6.cold`, `build.tsgo.cold` | `orchestration` | `pass` | Both compilers emit `dist/` and `.test-build/`, pass the full `node --test` suite, and pass `offline-demo` + `mcp-tools-list` under Node 22. |
| `runtime.{node22,bun,deno}.help` | `orchestration` | `pass` | All three runtimes print the expected CLI help banner and exit `0`. |
| `runtime.{node22,bun}.demo` | `orchestration` | `pass` | Both exit `0` within budget, write `run.json` (`status: "complete"`, `verification: 0`), match recomputed SHA-256 and byte length for `traversal-timing`, and produce the expected `column_major,row_major` digest units. |
| `runtime.deno.demo` | `orchestration` | **`fail`** (`not-run`) | **Process-exit hang under Deno 2.9.7** (exact 4-line root cause documented below): all 5 artifact checks pass (`status=complete`, `verifier-exit-0`, `evidence-count=1`, `report-sha256:traversal-timing`, `digest-units=column_major,row_major`), but Deno stays alive on the 240,000 ms `AbortSignal.timeout` timer and fails `demo-exit-0` at the 15,000 ms gate timeout. |
| `runtime.{node22,bun,deno}.mcp` | `orchestration` | `pass` | When Deno runs as the MCP **server** (`cli.js mcp`) and the Node client closes the transport, all three runtimes return the exact 3 expected tools (`cancel_evidence_job,get_evidence_job,launch_evidence_prefetch`) and exit cleanly. |
| `worker.{node,go}.receipt` | `orchestration` | `pass` | Both prototypes execute 200 × `/bin/true` without a shell under an allowlisted environment (`PATH`, `LANG`) and stream-hash a 16 MiB synthetic payload plus `examples/*.mjs`, producing byte-identical receipts (`argv`, `exitCode`, `sha256`, `bytes`). |
| `agent.generic.go-cli.e2e` | `agent_e2e` | `pass` | Compiled Go `perfdigest-agent/v1` binary passes all 8 E2E parity checks (`demo-exit-0`, `status=complete`, `verifier-exit-0`, `agent-error-null`, `evidence-delivery=same_session_next_turn`, `session-continuation:go-bench-sess-1`, `evidence-count=1`, `report-sha256:traversal-timing`, `digest-units=column_major,row_major`). |

### Root-cause analysis: Deno 2.9.7 `offline-demo` process-exit hang

Investigation of `runtime.deno.demo` isolated the exact 4-line root cause of the Deno 2.9.7 process-exit hang on the `825f735` baseline:

1. **`@modelcontextprotocol/sdk` leaves a `{ once: true }` `abort` listener on `signal`**: `Protocol.request` in `@modelcontextprotocol/sdk` registers `options.signal?.addEventListener('abort', abortHandler, { once: true })` on every `connect()` and `callTool()` call, and does **not** call `removeEventListener` when the request resolves normally.
2. **`src/run.ts` combines `controller.signal` with `AbortSignal.timeout(240_000)`**: At the start of `investigate()`, `src/run.ts` constructs `const deadline = AbortSignal.timeout(240_000)` and `const signal = AbortSignal.any([controller.signal, deadline, ...])`, passing `signal` down into `gatherEvidence()` -> `digestReportWithMcp()`.
3. **Deno 2.9.7 keeps `AbortSignal.timeout(ms)` ref'd when a composite `AbortSignal.any` retains an active `abort` listener**: In Node 22 and Bun 1.4.3, `AbortSignal.timeout(240_000)` uses an unref'd timer that allows the process to exit as soon as `main()` finishes. In Deno 2.9.7, `AbortSignal.timeout(ms)` keeps its internal timer `unref`'d *only while no active `abort` listener is attached*; an unremoved `{ once: true }` listener on `AbortSignal.any([..., AbortSignal.timeout(240_000)])` keeps Deno's event loop ref'd for the full 240 seconds even after `controller.abort()` runs in `finally` and `run.json` + `stdout` are flushed.
4. **Minimal 4-line reproduction** (exits `124` under `timeout 2 deno eval`, exits `0` immediately under Node 22 and Bun 1.4.3):
   ```js
   const c = new AbortController();
   const s = AbortSignal.any([c.signal, AbortSignal.timeout(240_000)]);
   s.addEventListener('abort', () => {}, { once: true });
   ```
   *(Note: Stage 5 replaces uncancelled `AbortSignal.timeout` signals with explicitly cleared and `.unref()`'d timeout helpers so that completed runs do not leave live timers on the event loop; in this pre-fix baseline snapshot, `runtime.deno.demo` remains recorded honestly as `status: "not-run"`, `parity.status: "fail"`.)*

---

## 5. Layer-by-layer performance analysis

Separating the 18 cells into `engine`, `orchestration`, and `agent_e2e` isolates where wall time is spent:

1. **`engine` layer (`runtime.uvx.perfdigest-mcp`: 276.80 ms median)** dominates single-report local runs:
   - Spawning `uvx perfdigest-mcp`, completing the MCP `initialize` handshake, listing tools, and closing takes **276.80 ms** median (`[266.17..313.24]` ms, peak RSS **62,844 KB**)—roughly **47.7%** of the entire `runtime.node22.demo` (`580.81 ms`) and **47.0%** of the full external-agent E2E run (`agent.generic.go-cli.e2e`, `589.24 ms`).
2. **`agent_e2e` layer (`agent.generic.go-cli.e2e`: 589.24 ms median vs. `runtime.node22.demo`: 580.81 ms median)**:
   - Orchestrating a two-turn external Go CLI agent (`perfdigest-agent/v1` over JSONL stdio with `--agent-sessions`) adds only **+8.43 ms** (+1.45%) to the median wall time of `--agent none` (`580.81 ms -> 589.24 ms`, peak RSS `93,560 KB -> 94,236 KB`).
   - Because `investigate()` launches `evidence.prefetch` concurrently with the `analysis` turn (`Promise.all([worker, agent])`), the external Go agent's `analysis` turn executes completely inside the shadow of capture + `uvx perfdigest-mcp` digestion, leaving only the post-verification `review` turn spawn on the critical path.
3. **`orchestration` layer levers (ranked by measured impact)**:
   - **MCP session reuse across multi-report manifests**: Reusing a single `StdioClientTransport` session across $K$ reports in `src/perfdigest.ts` saves $(K - 1) \times 276.8\text{ ms}$ of cold `uvx` + Python MCP initialization overhead.
   - **Outer JS runtime (`node22` vs. `bun`)**: Bun reduces `cli-help` median wall time from **125.66 ms** to **65.02 ms** (-60.64 ms) and `offline-demo` from **580.81 ms** to **514.03 ms** (-66.78 ms, -11.5%).
   - **Developer build loop (`tsc` 6.0.3 vs. `tsgo` TS 7 preview)**: `tsgo` reduces cold build median wall time from **1,290.25 ms** to **135.77 ms** (9.50× faster, 44.3% lower peak RSS) with 16/16 byte-identical JS emit.
   - **Worker subprocess + SHA-256 receipt prototype (`node-worker` vs. `go-worker-prototype`)**: For 200 sequential spawns + 16 MiB SHA-256 hashing, Go reduces median wall time from **151.53 ms** to **62.81 ms** and peak RSS from **69,756 KB** to **3,908 KB**, though for typical 1–5 command manifests Node's **0.50 ms** per-spawn overhead is negligible relative to the **276.80 ms** `engine` floor.

---

## 6. Explicit scope & limitations

- **Single host, single session**: All medians, IQRs, and resource figures apply strictly to `amd-ryzen-ai-9-hx-370-x64` (`Linux 7.0.0-27-generic`) at commit `6d628f5` and do not generalize to other CPUs, OS kernels, filesystems, or shared CI runners.
- **Unpinned host scheduling**: CPU frequency scaling, turbo boost, and core isolation were not pinned; runs executed sequentially with starting 1-minute load average `2.21`.
- **Warm OS page cache**: "Cold build" means the output directory is deleted before every run and incremental `.tsbuildinfo` state is absent; the OS filesystem cache and `node_modules/` remain warm.
- **Deterministic local CLI agent in `agent_e2e`**: `agent.generic.go-cli.e2e` measures the full `perfdigest-agent/v1` stdio JSONL protocol, concurrent `analysis`/evidence overlap, session-continuation verification, and `review` evidence delivery using a compiled Go binary with zero network or LLM API calls; live LLM inference latency is intentionally excluded.
- **Prototype boundary**: `bench/go-worker/` measures only `os/exec` + streaming `crypto/sha256` receipt generation and is not a replacement for the TypeScript evidence runner.
