# go-worker — PROTOTYPE (not a replacement)

A deliberately tiny comparison of **subprocess + hashing overhead** between Go
and Node. It is *not* a port of the PerfDigest Evidence runner: no MCP, no
routing, no verification semantics, no artifact layout, no error taxonomy.

Both `main.go` and `node-worker.mjs` read the same manifest:

```json
{ "version": 1,
  "envAllowlist": ["PATH", "LANG"],
  "commands": [{ "command": "/bin/true", "args": [] }],
  "reports": ["/abs/path/report.json"] }
```

and print the same receipt (`perfdigest.worker-receipt.v0-prototype`):
`commands[] {argv, exitCode, elapsedMs}`, `reports[] {path, sha256, bytes}`, `totalMs`.

Properties shared by both implementations:

* commands are executed as argv **without a shell**;
* children receive **only** allowlisted environment variables;
* report files are streamed through SHA-256 sequentially.

`bench/run-matrix.mjs` builds the Go binary into its scratch directory
(`go build -trimpath`), runs both workers over the same fixture (N × `/bin/true`
plus a 16 MiB synthetic file and the example scripts), requires byte-identical
receipts (argv, exit codes, SHA-256, bytes — timings excluded) as the parity
check, then times each with hyperfine.

```bash
cd bench/go-worker && go build -trimpath -o /tmp/perfdigest-worker .
/tmp/perfdigest-worker manifest.json
node node-worker.mjs manifest.json
```
