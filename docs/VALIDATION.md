# Recorded validation — 12 October 2026

## Genuine Cloudflare Clef and Codex run

A real CPU trace was captured locally, summarized by the Python PerfDigest MCP over stdio, and submitted once to the fixed Workers AI `@cf/cloudflare/clef-flash` endpoint. The model selected the saved evidence route. The independent verifier passed, and Astra/max reviewed the evidence in the same Codex SDK thread as its initial hypotheses. No synthetic response, provider fallback or patch was used.

| Observation | Recorded value |
| --- | --- |
| Capture date | 2026-10-12, approximately 14:35 Istanbul |
| Provider / advertised model | Cloudflare Workers AI / `clef-flash` |
| Quantization | Provider managed; not observed |
| Decision requests | 1 |
| Chosen route | `traversal-timing` |
| Returned choice probability | 0.9072 |
| Returned confidence | 0.6632, SystemOne semantics; not correctness |
| Decision latency | 2,588 ms |
| End-to-end wall time | 90,461 ms |
| Full evidence pipeline / initial model overlap | 2,575.26 ms, including Cloudflare routing |
| Capture/digest alone / initial model overlap | 0 ms; completed before the actual model turn began |
| Clef usage | 652 input tokens, 0 output tokens as reported by the service |
| Codex | `gpt-6-astra`, effort `max`, two turns in the same thread |
| Codex analysis usage | 10,767 input / 1,025 output tokens |
| Codex review usage | 23,422 input / 2,233 output tokens; 10,624 cached input tokens |
| Independent verifier | Exit 0; both traversals match an independent formula at six sizes |
| Billing / remaining free quota | Not observed; no account plan change |

Input evidence SHA-256:

```text
aaf4a474c360387d4c4fd9a74b3d03eaafa20aa4cedbf087deef01c2908a5938
```

Bounded Decisions state SHA-256:

```text
91b483661e1ede8e727b3a28003e0ae6d0b6e48c502d7e9506c4b0694ede5743
```

The trace contains one measured row batch at approximately 3.179 ms and one column batch at approximately 4.727 ms. After three warmups, each timed batch contains eight traversals plus assertions; these are not single-traversal durations. Astra described the column slowdown as consistent with a cache-locality hypothesis, while explicitly retaining alternatives and requiring repeated measurements and hardware counters. A single controlled CPU sample is not a diagnosis-quality benchmark, a solved PyTorch issue or a speedup claim. Correct arithmetic does not validate the causal explanation.

The opt-in reproduction commands are in [HACKATHON.md](HACKATHON.md). Replaying a saved trace does not create a new physical measurement. Hosted inference is never a public CI dependency.

The [portable recorded example](../examples/recorded-cloudflare/README.md) ships the original trace, bounded routing input and sanitized original receipt. Its hashes can be recomputed without a credential or a new model call.

## Other checks and boundaries

- The OpenAI adapter passed real loopback HTTP E2E using actual measured PerfDigest input and synthetic Decisions/Codex responses. A separate single remote request using a deliberately invalid synthetic credential returned the expected HTTP 401. No valid-key OpenAI inference has been claimed.
- Build, contract tests, real CPU/Python MCP discovery, clean npm archive installation, CLI/TUI and three-tool evidence MCP discovery pass. The 50-test checkpoint passed [hosted CI](https://github.com/onlyxItachi/perfdigest-plugin/actions/runs/38242080918).
- The earlier provider/TUI CI failure exposed an obsolete injected OpenAI client in benchmark arm B. The caller was fixed and a regression test added; the failed [workflow](https://github.com/onlyxItachi/perfdigest-plugin/actions/runs/38241555893) remains available.
- PerfDigest [1.2.1](https://github.com/onlyxItachi/PerfDigest-MCP/releases/tag/v1.2.1) and [1.3.0](https://github.com/onlyxItachi/PerfDigest-MCP/releases/tag/v1.3.0) were independently published and verified. The plugin's TypeScript MCP SDK 1.32.1 passed all seven actual stdio tool calls against a clean PyPI 1.3.0 / Python MCP SDK 2.3.0 installation. This is supplemental evidence; the established plugin CI pin remains unchanged.
- Local Clef model qualification, GPU profiling, a real PyTorch issue/patch, Desktop plugin activation, provider calibration and real A/B/C speed/cost benefits require their own evidence. The npm archive has not been published to the registry.
