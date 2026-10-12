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
- GPU profiling, a real PyTorch issue/patch, Desktop plugin activation, provider calibration and real A/B/C speed/cost benefits remain unvalidated. The npm archive has not been published to the registry.

## Genuine local Clef qualification

The official `Clef-Flash-Q4_K_M.gguf` (6,486,448,288 bytes) ran under official llama.cpp **b11565**, commit `f9a95aeb2`, using **Vulkan0 / NVIDIA RTX 4060 Laptop 8 GB**. This was Vulkan execution, not CUDA inference. Model SHA-256:

```text
3626116623ca8d89641952471fac9ce12af84fb3517520029a2ac6f5146868a2
```

A persistent loopback server used context/batch/ubatch 2048 and parallelism 1. Logs verified 33/33 layers offloaded. GPU model buffers were 5,629.85 MiB and compute buffers 474.32 MiB; 545.64 MiB of model data remained CPU-mapped, so full layer offload does not mean every byte resided exclusively on the GPU. The owned process used 6,147 MiB at the observed snapshot. No CUDA profiling workload ran concurrently.

One genuine model response to synthetic input exercised choice, noul and score, and passed the plugin's production normalizer. It reported 399 input / 0 output tokens and took 12.523 seconds on the first request, including first-use runtime work. This is an inference/contract check, not a latency benchmark or fixture response.

A separate single request used real PerfDigest CPU evidence captured before model loading and then the same-thread Astra/max review:

| Observation | Recorded value |
| --- | --- |
| Local model decision latency | 7,864 ms |
| End-to-end wall time | 64,448 ms |
| Returned probability for `traversal-timing` | 0.7716861809340284 |
| Returned confidence | 0.5433723618680568 |
| Policy threshold | 0.65, unchanged |
| Pipeline outcome | `needs_review`; no report route accepted |
| Independent verifier | Exit 0 |
| Codex review | Completed in the same thread |
| Diagnostic process exit | 1, because the success gate requires `complete` |

No threshold was lowered, retry made or provider fallback used to force a successful route. This qualifies real local inference and the abstention path; it does not qualify an accepted local evidence route. The hosted Cloudflare run above remains the completed demo. These runs use different captures and warmup conditions and do not establish a provider performance comparison. The localhost-only diagnostic deliberately leaves identity unqualified on its own; the independent process, runtime and pinned model-hash receipts provide that additional evidence.
