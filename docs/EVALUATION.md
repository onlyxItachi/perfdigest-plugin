# Evidence-delivery evaluation

The hackathon experiment is intentionally bounded while live Decisions access is pending. It exercises real CPU capture, the production Decisions adapter against an in-process HTTP fixture, real Python MCP digestion, independent verification and optionally the real Codex SDK using the existing ChatGPT login.

## Reproduce

Install the README's pinned dependencies, then run:

```sh
npm run benchmark:evidence -- --trials 3
npm run benchmark:evidence -- --trials 1 --agent codex --model gpt-6-astra --effort max
```

The first command makes zero model calls. The second consumes Codex subscription usage; it still makes **zero live Decisions calls**. All artifact directories are isolated under `work/benchmark/`. One to five trials are accepted, and each arm has a four-minute limit. Do not use a real API key for this experiment.

## What is held constant

- A single real CPU capture, identical issue and independent arithmetic verifier; hashes checked before and after evidence collection.
- New Codex thread per arm, identical initial prompt and structured final-answer request, same model/effort, no edits, tools or delegation by the model.
- B and C deliver the same digest content. Confidence and synthetic usage never enter the model's evidence or the observed service metrics.
- Each trial rotates the arm order. Three trials cover every arm in every position; this does not eliminate cache or shared-host effects.

| Arm | Delivery | Scheduling | Routing |
| --- | --- | --- | --- |
| A_raw | Raw measured trace read from disk | Initial hypothesis, then evidence | None |
| B_digest | Real `uvx perfdigest-mcp` digest | Initial hypothesis, then evidence | Fixed first report |
| C_fixture_prefetch | Same real digest | Collect while requesting initial hypothesis | Official OpenAI SDK, in-process fixture only |

A is a controlled file-delivery baseline, **not** an autonomous model choosing ordinary tools. One report makes route selection trivial. No artificial worker delay is added to manufacture overlap. If the worker finishes before `turn.started`, actual model overlap is zero.

## What the receipt means

`benchmark.json` checkpoints every arm, including failed arms. It records capture and verifier receipts, artifact hashes, evidence payloads, model responses, timestamps and observations. `benchmark.md` is the compact table.

- **Wall time** includes per-arm Codex login/configuration preparation, evidence collection, model turns and verification. The shared capture is recorded separately.
- **Evidence bytes** are UTF-8 bytes of the exact evidence payload, not a token estimate. Short traces can be smaller than their digest.
- **Tokens** come only from completed Codex SDK turns. The total includes both turns and cached input is reported separately. Fixture response usage is synthetic and excluded. No model means unknown usage, not zero tokens.
- **Cost** is always unknown because the runner does not observe billing. Do not multiply fixture usage by a price or treat subscription usage as free API usage.
- **Reading grade** checks only the slower measured region, the actual independent verifier outcome and refusal to claim a proven cache cause from elapsed spans alone. Raw trace durations provide the oracle. This is not a score for arbitrary debugging correctness or patch quality.
- **Verification** checks both traversal algorithms against an arithmetic formula at six sizes. No patch is applied. A passing verifier does not prove a causal performance explanation.

## Required next evaluation

After live Decisions access and a real issue are available, evaluate ordinary autonomous tools, digest tools and live routing/prefetch under a predeclared task and budget. Repeated independent workload captures, falsification tests, a patch/reproducer oracle, observed service usage and independent billing are needed before comparative claims. Keep failures, timeouts, abstentions and unavailable hardware cells in the results. Do not replace those with zero measurements or a favorable subset.
