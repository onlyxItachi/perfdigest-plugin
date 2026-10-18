# bench/ — runtime & build benchmark foundations

Reproducible, credential-free harness that measures PerfDigest Evidence's **build**
and **runtime** costs against a fixed reference baseline and gates every
alternative backend on **contract parity** before any number is interpreted.

> Reference baseline: **Node 22 + TypeScript 6.0.3 `tsc`** (the production build).
> Nothing in `bench/` changes the production build, `src/`, `test/` or the
> published package (`bench/` is not in `package.json#files`).

## Layout

| Path | Purpose |
|---|---|
| `run-matrix.mjs` | Harness. Reads a manifest, runs cells, checks parity, writes a `benchmark-result.v1` JSON. |
| `manifests/default.json` | `benchmark-manifest.v1`: the cell list (build / runtime / worker), N and warmups. |
| `schema/formats.mjs` | zod source of truth for both formats. |
| `schema/*.schema.json` | JSON Schema (draft 2020-12) **generated** from `formats.mjs` (`node bench/schema/build-schema.mjs`; `--check` in CI). |
| `validate.mjs` | Validates manifests/results (zod + reporting rules). |
| `probes/mcp-probe.mjs` | Constant Node MCP client: spawn server → initialize → `tools/list` → close. |
| `probes/spawn-loop.mjs` | Runtime-agnostic per-spawn latency probe (`node:child_process`). |
| `go-worker/` | **Prototype only**: Go vs Node exec-and-hash receipt worker (see below). |
| `results/` | Committed result documents, `<date>-<host-label>.json`. |
| `package.json` | Bench-only devDependency: `@typescript/native-preview` (tsgo) pinned. |

## Running

```bash
npm ci && npm run build                 # production build (tsc 6) — the runtime cells execute this dist
(cd bench && npm ci)                    # optional: installs pinned tsgo for the build cells
PERFDIGEST_BENCH_BUN=/path/to/bun \
PERFDIGEST_BENCH_DENO=/path/to/deno \
node bench/run-matrix.mjs               # full matrix -> bench/results/<date>-<host>.json
node bench/run-matrix.mjs --smoke       # tiny N, Node-only cells, result in a temp dir
node bench/run-matrix.mjs --only runtime.node22.demo,runtime.bun.demo
node bench/validate.mjs                 # validate manifests + committed results
```

Full runs need `hyperfine` and GNU `/usr/bin/time`. Missing optional backends
(Bun, Deno, tsgo, Go, uvx) are recorded as `not-run` with a reason, never silently
dropped. `--smoke` falls back to an in-process timer when hyperfine is absent and
labels the cell's `method` accordingly.

## What is measured

**BUILD** (kept separate from runtime): `tsc -p tsconfig.json` (TS 6.0.3 under
Node) vs the native `tsgo -p tsconfig.json` (TS 7 preview), cold = output dir
removed and no incremental state (OS page cache warm). Wall time (hyperfine),
user/sys CPU and peak RSS (GNU time). **Build parity**: each compiler emits a
copy of the repo's `dist/` and `.test-build/` in a scratch tree, then the
equivalent of `npm test` (`node --test .test-build/test/*.test.js`), the offline
demo and MCP discovery run against that emit under Node 22.

**RUNTIME** — Node 22 (baseline), Bun, Deno executing the *tsc-built* `dist/`:

| Scenario | Command | Timer |
|---|---|---|
| `cli-help` | `<rt> dist/cli.js --help` | hyperfine -N |
| `offline-demo` | `<rt> dist/cli.js demo --provider offline --agent none --workspace <tmp>` (fresh `.perfdigest/` per run) | hyperfine -N |
| `mcp-tools-list` | `<rt> dist/cli.js mcp` driven by a constant Node MCP client | in-probe `performance.now()` per spawn→initialize→tools/list→close |
| `spawn-overhead` | `<rt> probes/spawn-loop.mjs N` spawning `/bin/true` | in-process per-spawn timer |
| `perfdigest-mcp-session-start` | `uvx perfdigest-mcp` driven by the same client | same as mcp |

The offline demo's capture and verifier children run under the same runtime
(`process.execPath`); the digest child is always `uvx perfdigest-mcp` (Python).

**WORKER** (prototype): see `go-worker/README.md`.

## Contract-parity gate

A runtime/backend is **accepted for further study** only when its cell's
`parity.status` is `pass`:

* offline demo: `status=complete`, verifier exit `0`, exactly one evidence item,
  recorded report SHA-256 and byte count equal a fresh SHA-256 of the report on
  disk, and the digest lists the same units (`column_major,row_major`);
* MCP discovery lists exactly the 3 expected tools
  (`cancel_evidence_job, get_evidence_job, launch_evidence_prefetch`);
* build: emit succeeds, the full test suite passes on the emitted code, and the
  demo + MCP checks above pass on the emitted `dist/`.

No cell may be described as "better" unless its parity passes. Timings never
override a parity failure.

## Result format (`perfdigest.benchmark-result.v1`)

One JSON document per session: `subject` (repo, git SHA, dirty flag), `host`
(label, kernel, CPU model, logical CPUs, memory, loadavg at start), `tools`
(versions, plus SHA-256 for downloaded binaries), `manifest` (id + SHA-256),
and `cells[]` each with `command` (argv, host paths replaced by placeholders),
`method`, `wall` / `peakRssKb` stats (`n, median, min, max, mean, stdev, q1, q3`),
`cpu` (median user/sys ms), `parity` and per-sample `extra.samplesMs`. Top-level
`claims` and `limits` are mandatory (`limits` must be non-empty).

The format is deliberately flat and language-neutral so PerfDigest-MCP-Bench raw
results (`results/*_raw/*.json`, currently `{median_us, q1_us, q3_us, n}` per
backend plus SHA-256 identity maps) could adopt it by mapping one raw file to one
cell: `unit: "us"`, `median/q1/q3/n` carry over, digest byte-identity becomes a
`parity.checks[]` entry. Validation needs only the JSON Schema files.

## Rules for reporting

* Report medians with spread (min/max, stdev, IQR) and N; never a single run.
* State the host; single-host results do not generalize.
* No model, hosted API or credential is used: offline routing, `--agent none`,
  minimal allowlisted child environment and a throwaway `XDG_CONFIG_HOME`.
