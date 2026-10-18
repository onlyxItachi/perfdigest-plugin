# Runtime & build benchmark foundations (Stage 3)

This document summarizes the reproducible, credential-free benchmark harness in [`bench/`](../bench/README.md) and the recorded session in [`bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json`](../bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json).

> **Reference baseline**: **Node.js v22.22.1 + TypeScript 6.0.3 (`tsc`)** remains the production build and runtime baseline. Nothing in `bench/` modifies `src/`, `test/`, or the published package (`bench/` is excluded from `package.json#files`).

---

## 1. Methodology, host & tool provenance

### Experimental rules

1. **Build vs. runtime separation**: Build cells (`tsc` 6.0.3 vs. `tsgo` TS 7 native preview) are measured and gated separately from runtime cells (Node 22, Bun, Deno executing the production `tsc`-emitted `dist/`).
2. **Contract-parity gate before interpretation**: Every cell records a structured `parity` block (`pass`, `fail`, `not-checked`, or `not-applicable`). If a runtime or build backend fails contract parity before timing (such as hanging on exit or emitting broken artifacts), timing is skipped (`status: "not-run"`) and no performance comparison or superiority claim is made.
3. **Credential-free offline isolation**: Every child process executes with a minimal allowlisted environment (`PATH`, `HOME`, `TMPDIR`, `USER`, `XDG_CACHE_HOME`, `LANG=C`, `LC_ALL=C`, `NO_COLOR=1`, `DENO_NO_UPDATE_CHECK=1`), a throwaway `XDG_CONFIG_HOME` in `/tmp`, offline routing (`--provider offline`), and `--agent none`. Zero credentials, model turns, or external network requests are used.
4. **Measurement primitives**:
   - Process-level wall time uses `hyperfine -N` (no shell wrapper) with explicit warmup runs and `--prepare` cleanup where state is written.
   - Process-tree CPU (`userMedian`, `sysMedian`) and `peakRssKb` use GNU `/usr/bin/time -f '%U %S %M'` in separate un-timed runs (`rssRuns = 5`) so resource instrumentation does not perturb wall-time samples.
   - MCP stdio discovery (`mcp-tools-list` and `perfdigest-mcp-session-start`) uses a constant Node 22 MCP SDK client (`bench/probes/mcp-probe.mjs`) so only the server backend varies.

### Recorded host (`amd-ryzen-ai-9-hx-370-x64`)

| Property | Recorded value |
| --- | --- |
| Session timestamp (`createdAt`) | `2026-10-18T17:12:21.870Z` |
| Subject commit (`gitSha`) | `04de22a5b36ad1c9dc538673f718a44a62dc4ee4` (`dirty: false`) |
| Manifest (`id` / `sha256`) | `stage3-runtime-build-foundations` / `b3f0eb9bfe4c542e51c85dea4f57e4923ff99e87fb74ac97bac62505cd0f2d17` |
| OS / Kernel | `Linux 7.0.0-27-generic` (`x64`) |
| CPU model | `AMD Ryzen AI 9 HX 370 w/ Radeon 890M` (24 logical CPUs) |
| Memory (`memTotalKb`) | `14,927,160 KB` (~14.24 GiB) |
| 1-min loadavg at start | `1.71` |

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

## 2. Build matrix results (`tsc` 6.0.3 vs. `tsgo` TS 7 preview)

Each build cell runs a cold type-check and emit of `tsconfig.json` (`--prepare` removes the output directory before every run; no `.tsbuildinfo` or incremental state is used; OS page cache is warm).

| Cell ID | Backend | Status | Parity | N (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | Wall `[min..max]` (ms) | Wall stdev (ms) | User / Sys CPU median (ms) | Peak RSS median (KB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `build.tsc6.cold` *(baseline)* | `tsc-6.0.3` | `measured` | `pass` | 10 (3) | **1,160.78** | `1,155.73..1,189.05` | `1,124.10..1,230.51` | 32.19 | 3,090 / 110 | 334,908 |
| `build.tsgo.cold` | `tsgo-7-preview` | `measured` | `pass` | 10 (3) | **147.38** | `139.50..158.00` | `134.40..183.54` | 15.67 | 660 / 150 | 185,320 |

### Build parity verification

Both `tsc-6.0.3` and `tsgo-7-preview` passed all 10 gating parity checks in isolated scratch trees:
- Clean emit of both `tsconfig.json` (`emit-dist`) and `tsconfig.test.json` (`emit-test-build`).
- Full test suite execution under Node 22 (`node --test .test-build/test/*.test.js`).
- End-to-end offline demo execution against the emitted `dist/cli.js` (`demo-exit-0`, `status=complete`, `verifier-exit-0`, `evidence-count=1`, `report-sha256:traversal-timing`, `digest-units=column_major,row_major`).
- MCP stdio discovery against the emitted `dist/cli.js` (`cancel_evidence_job,get_evidence_job,launch_evidence_prefetch`).
- Informational check (`info:js-byte-identical-to-repo-dist`): `tsgo` emitted **16/16** `.js` files byte-identical (SHA-256) to `tsc` 6.0.3 for the current `src/` tree.

---

## 3. Runtime & worker prototype matrix results

All runtime cells execute the production `tsc`-emitted `dist/cli.js` (or `bench/probes/spawn-loop.mjs`).

| Cell ID | Scenario | Backend | Status | Parity | N (warmup) | Wall median (ms) | Wall IQR `[Q1..Q3]` (ms) | Wall `[min..max]` (ms) | Wall stdev (ms) | User / Sys CPU median (ms) | Peak RSS median (KB) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `runtime.node22.help` *(baseline)* | `cli-help` | `node22` | `measured` | `pass` | 20 (3) | **134.36** | `129.26..139.63` | `120.69..165.00` | 11.25 | 180 / 20 | 93,896 |
| `runtime.bun.help` | `cli-help` | `bun` | `measured` | `pass` | 20 (3) | **69.13** | `63.84..72.08` | `58.31..77.92` | 5.70 | 90 / 10 | 63,388 |
| `runtime.deno.help` | `cli-help` | `deno` | `measured` | `pass` | 20 (3) | **86.77** | `82.72..93.07` | `79.90..124.54` | 10.23 | 90 / 20 | 86,808 |
| `runtime.node22.demo` *(baseline)* | `offline-demo` | `node22` | `measured` | `pass` | 15 (3) | **582.59** | `577.12..592.72` | `565.05..612.97` | 13.36 | 590 / 70 | 93,692 |
| `runtime.bun.demo` | `offline-demo` | `bun` | `measured` | `pass` | 15 (3) | **502.37** | `495.35..524.74` | `465.11..536.23` | 21.59 | 530 / 70 | 66,300 |
| `runtime.deno.demo` | `offline-demo` | `deno` | `not-run` | **`fail`** | — | — | — | — | — | — | — |
| `runtime.node22.mcp` *(baseline)* | `mcp-tools-list` | `node22` | `measured` | `pass` | 20 (3) | **131.08** | `125.95..149.97` | `124.66..203.17` | 19.07 | — | 94,156 |
| `runtime.bun.mcp` | `mcp-tools-list` | `bun` | `measured` | `pass` | 20 (3) | **80.21** | `77.88..86.26` | `72.28..109.27` | 8.94 | — | 67,044 |
| `runtime.deno.mcp` | `mcp-tools-list` | `deno` | `measured` | `pass` | 20 (3) | **97.62** | `94.06..104.48` | `88.41..145.41` | 13.14 | — | 89,736 |
| `runtime.node22.spawn` *(baseline)* | `spawn-overhead` | `node22` | `measured` | `not-applicable` | 199 (3) | **0.49** | `0.48..0.52` | `0.46..0.96` | 0.08 | 70 / 60 | 46,736 |
| `runtime.bun.spawn` | `spawn-overhead` | `bun` | `measured` | `not-applicable` | 199 (3) | **0.25** | `0.24..0.27` | `0.22..0.65` | 0.05 | 60 / 10 | 30,684 |
| `runtime.deno.spawn` | `spawn-overhead` | `deno` | `measured` | `not-applicable` | 199 (3) | **0.26** | `0.26..0.27` | `0.24..0.87` | 0.06 | 70 / 30 | 46,344 |
| `runtime.uvx.perfdigest-mcp` | `perfdigest-mcp-session-start` | `uvx` | `measured` | `not-applicable` | 20 (0) | **282.53** | `276.96..291.44` | `271.53..311.87` | 11.46 | — | 62,644 |
| `worker.node.receipt` *(baseline)* | `exec-and-hash-receipt` | `node-worker` | `measured` | `pass` | 20 (3) | **152.96** | `150.75..161.05` | `145.65..165.55` | 6.43 | 90 / 70 | 69,568 |
| `worker.go.receipt` | `exec-and-hash-receipt` | `go-worker-prototype` | `measured` | `pass` | 20 (3) | **64.47** | `62.96..65.41` | `59.54..66.34` | 2.05 | 40 / 10 | 3,908 |

*Note on `spawn-overhead`*: Wall-time statistics are per-spawn (`N = 199` warm sequential spawns of `/bin/true` inside one process after dropping the first cold spawn), whereas CPU and peak RSS are measured by GNU time for the entire 200-spawn loop process.

---

## 4. Contract-parity gate findings (including Deno `offline-demo` hang)

| Cell / Group | Parity status | Key findings |
| --- | --- | --- |
| `build.tsc6.cold`, `build.tsgo.cold` | `pass` | Both compilers emit `dist/` and `.test-build/`, pass the full `node --test` suite, and pass `offline-demo` + `mcp-tools-list` under Node 22. |
| `runtime.{node22,bun,deno}.help` | `pass` | All three runtimes print the expected CLI help banner and exit `0`. |
| `runtime.{node22,bun}.demo` | `pass` | Both exit `0` within budget, write `run.json` (`status: "complete"`, `verification: 0`), match recomputed SHA-256 and byte length for `traversal-timing`, and produce the expected `column_major,row_major` digest units. |
| `runtime.deno.demo` | **`fail`** (`not-run`) | **Process-exit hang under Deno 2.9.7**: Deno executes the capture child, the `uvx perfdigest-mcp` stdio digest session, and the verifier child, writes a complete `run.json` (`status: "complete"`, `verification: 0`, matching `report-sha256:traversal-timing` `f859e14b9f2d` and `digest-units=column_major,row_major`), and prints the JSON summary to stdout in ~460 ms—all five artifact checks pass—but the Deno process **never exits** after `StdioClientTransport.close()` because Deno's Node compatibility layer retains an active handle on the closed child stdio transport. It fails `demo-exit-0` at the 15,000 ms gate timeout and is excluded from timing. |
| `runtime.{node22,bun,deno}.mcp` | `pass` | When Deno runs as the MCP **server** (`cli.js mcp`) and the Node client closes the transport, all three runtimes return the exact 3 expected tools (`cancel_evidence_job,get_evidence_job,launch_evidence_prefetch`) and exit cleanly. |
| `worker.{node,go}.receipt` | `pass` | Both prototypes execute 200 × `/bin/true` without a shell under an allowlisted environment (`PATH`, `LANG`) and stream-hash a 16 MiB synthetic payload plus `examples/*.mjs`, producing byte-identical receipts (`argv`, `exitCode`, `sha256`, `bytes`). |

---

## 5. PerfDigest MCP optimization opportunities (measured)

The benchmark matrix isolates the cost of the plugin's interaction with the upstream Python `perfdigest-mcp` server (`v1.2.0` via `uvx`):

1. **Per-report MCP session startup dominates local evidence collection (~48.5% of Node `offline-demo`)**:
   - `runtime.uvx.perfdigest-mcp` measures **282.53 ms** median (`[271.53..311.87]` ms, peak RSS **62,644 KB**) just to spawn `uvx perfdigest-mcp`, complete the MCP `initialize` handshake, list tools, and close—before `summarize_report` is even invoked.
   - Compare this with the full `runtime.node22.demo` median of **582.59 ms** (or `runtime.bun.demo` at **502.37 ms**), which includes parent CLI startup (~134 ms on Node / ~69 ms on Bun), running the capture child (`examples/capture-transpose.mjs`), running the `uvx perfdigest-mcp` session + `summarize_report`, and running the verifier child (`examples/verify-transpose.mjs`).
   - Switching the outer TypeScript runtime from Node 22 to Bun reduces `offline-demo` median wall time by **80.22 ms** (`582.59 ms -> 502.37 ms`, -13.8%), roughly matching the sum of Bun's faster CLI startup and child-process spawn overhead, while the ~283 ms Python `uvx perfdigest-mcp` floor remains unchanged across runtimes.

2. **Actionable optimization levers (ranked by measured impact)**:
   - **Session reuse across multiple reports in a manifest (high impact for multi-report runs)**: `src/perfdigest.ts` currently opens and closes a fresh `StdioClientTransport` subprocess for every digested report (`digestReportWithMcp`). For a manifest with $K$ digested reports, reusing one MCP client session per run eliminates $(K - 1) \times 282.5\text{ ms}$ of cold `uvx` + Python MCP initialization overhead.
   - **Direct tool binary invocation vs. `uvx` wrapper resolution**: When `perfdigest-mcp` is already installed in `uv tool list`, resolving and invoking the installed tool executable directly (or keeping a warm stdio worker) avoids repeated `uvx` ephemeral environment resolution on every run.
   - **Subprocess + SHA-256 worker overhead is small unless command counts are high**: For 200 sequential spawns plus 16 MiB SHA-256 hashing (`worker.node.receipt` vs. `worker.go.receipt`), the Go prototype reduces median wall time from **152.96 ms** to **64.47 ms** (-88.49 ms) and peak RSS from **69,568 KB** to **3,908 KB**. For typical PerfDigest manifests (1–5 capture/verify commands and kilobyte-scale JSON traces), Node's per-spawn overhead (**0.49 ms** median) is negligible compared to the **282.53 ms** `uvx perfdigest-mcp` session start.
   - **Developer build loop (`tsgo`)**: For local development and CI type-checking/emit experiments, `tsgo` (`@typescript/native-preview`) reduces cold build median wall time from **1,160.78 ms** to **147.38 ms** (7.88× faster, 44.7% lower peak RSS) with 16/16 byte-identical JS emit on the current codebase.

---

## 6. Explicit scope & limitations

- **Single host, single session**: All medians, IQRs, and resource figures apply strictly to `amd-ryzen-ai-9-hx-370-x64` (`Linux 7.0.0-27-generic`) at commit `04de22a` and do not generalize to other CPUs, OS kernels, filesystems, or shared CI runners.
- **Unpinned host scheduling**: CPU frequency scaling, turbo boost, and core isolation were not pinned; runs executed sequentially with starting 1-minute load average `1.71`.
- **Warm OS page cache**: "Cold build" means the output directory is deleted before every run and incremental `.tsbuildinfo` state is absent; the OS filesystem cache and `node_modules/` remain warm.
- **Node-compatibility surface**: Bun and Deno were exercised only on `cli-help`, `offline-demo`, `mcp-tools-list`, and `spawn-overhead` against the `tsc`-emitted ESM bundle. Live Codex SDK sessions, live Decisions HTTP providers, and interactive TUI flows were not benchmarked under Bun or Deno.
- **Prototype boundary**: `bench/go-worker/` measures only `os/exec` + streaming `crypto/sha256` receipt generation and is not a replacement for the TypeScript evidence runner.
