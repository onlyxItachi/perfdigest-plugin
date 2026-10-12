# Hackathon submission walkthrough

PerfDigest Evidence collects performance evidence while Codex develops hypotheses, then delivers the measurements and an independent verifier result to the same thread. PerfDigest translates profiler data; the selected decision provider chooses the next evidence path; Codex reviews the hypothesis and alternatives. Confidence cannot turn a failed verifier into a pass.

The MVP uses TypeScript 6, the official Codex SDK and the existing ChatGPT login. A small provider switch supports Cloudflare Clef-flash, local llama.cpp Clef-flash, OpenAI Luna and explicit offline routing. The Python tool remains `uvx perfdigest-mcp`. Dedicated provider credentials are excluded from Codex, capture, verifier and Python MCP child environments.

## Presentation sequence

1. Show the README's provider qualification table. Distinguish actual CPU/Codex execution, synthetic HTTP fixtures and genuine decision inference. A valid-key OpenAI Decisions result has not been obtained.
2. Show `perfdigest-plugin init`: Cloudflare is the recommended hosted option, local llama.cpp uses a persistent server, OpenAI uses a separate key, and offline is visibly deterministic. Setup is an explicit command, never an npm install hook.
3. Open a completed, recorded evidence run. Show the provider/model, report SHA-256, selected route, returned probabilities, inference latency, end-to-end wall time and verifier exit status. For local inference, pair this with the actual server/runtime/GGUF-hash receipt; a localhost response alone is insufficient.
4. Show the two Codex turns in the same thread: initial hypotheses, then evidence review. Report the observed overlap, including zero if collection finished before `turn.started`. No hidden reasoning injection is claimed.
5. Demonstrate the installed offline package and its three MCP tools. Finish with the exact submitted commit's CI result and the limits below.

The controlled example compares row-major and column-major CPU traversal. It is not a solved PyTorch issue. An observed duration difference does not establish cache-miss causality; that requires counters and repeated, controlled measurements.

## Reproduce without hosted credentials

From a source checkout:

```bash
npm ci
npm run check
npm run benchmark:evidence -- --trials 1
```

The benchmark command is a plumbing comparison: A uses scripted raw-report delivery, B uses a PerfDigest digest, C uses a synthetic Decisions HTTP contract and early evidence. It is not a comparison of real decision models or an autonomous debugging benchmark. Model-free runs report token usage and cost as unmeasured.

Install the produced archive into a clean prefix and use its executable:

```bash
npm install --prefix /path/to/local-tools ./perfdigest-plugin-0.1.0.tgz
export PATH="/path/to/local-tools/node_modules/.bin:$PATH"
perfdigest-plugin init --provider offline --yes
perfdigest-plugin demo --provider offline
```

The archive is locally installable; it has not been published to the npm registry. After local installation, `npx --no-install perfdigest-plugin init` selects the installed executable without fetching a potentially unrelated registry package. No setup prompt runs during installation.

## Opt-in genuine Clef and Codex check

Cloudflare uses an existing account and an account-scoped Workers AI token stored outside the repository in a private environment file. Check the account's free quota in the dashboard before inference; setup does not create a paid plan.

```bash
PERFDIGEST_RUN_CLEF_INTEGRATION=1 node --env-file=/absolute/private/cloudflare.env scripts/check-clef-live.mjs --provider cloudflare --codex
```

This makes one decision request using real CPU evidence, then reviews the evidence through the existing Codex session with Astra/max. It writes a receipt and fails on a provider error or failed verifier; it does not substitute a fixture. `--codex` consumes the existing account's Codex usage.

For local Clef, capture the report before starting the model server, then use a saved manifest with `captures: []`:

```bash
PERFDIGEST_RUN_CLEF_INTEGRATION=1 node scripts/check-clef-live.mjs --provider local --manifest /absolute/saved/manifest.json --workspace /absolute/saved --quantization Q4_K_M --codex
```

Keep the server process, official runtime revision, GGUF SHA-256 and observed device-memory receipt with the run. The quantization flag is a label, not attestation. Unload local inference before profiling a GPU workload; never use simultaneous Clef GPU load as an isolated CUDA measurement.

For a recorded demo, retain the original trace and capture receipt with their hashes/timestamps. Replaying the same bytes runs digesting and verification again; it is not a new performance measurement. Keep original and replay receipts separately.

## Validation and remaining limits

| Area | Verified behavior or boundary |
| --- | --- |
| CPU evidence | Actual capture, SHA-256, real stdio MCP digest and independent arithmetic verifier |
| Codex | Existing ChatGPT session through the official SDK; two turns with explicit same-thread evidence handoff |
| Clef providers | Mapping, response normalization and failures verified with HTTP fixtures; genuine hosted/local qualification must reference its own run receipt |
| OpenAI Decisions | Official SDK and real loopback HTTP E2E pass; one deliberately invalid-credential remote request returned the expected 401; valid-key inference remains unvalidated |
| Setup/package | Interactive and noninteractive setup, clean archive installation, executable offline demo and three evidence MCP tools |
| Secret isolation | Dedicated credential markers absent from tested child environments and receipts; this is not an OS-level sandbox |
| Upstream releases | PerfDigest 1.2.1 and 1.3.0 are published. The plugin's TypeScript client separately passed seven real tool calls against the actual PyPI 1.3.0 install. Its established CI installation pin remains unchanged. |
| Unvalidated | Real PyTorch issue/patch, GPU profiling, Desktop UI activation, diagnosis quality, calibration and speed/cost improvement |

CI uses no hosted credentials or model calls. Preserve failed runs as evidence: the first provider/TUI CI run exposed an obsolete injected Decisions client in benchmark arm B; the caller and regression test were corrected before subsequent CI passed. Use the final commit's workflow result, not a previous green run, when preparing submission.

The upstream releases and GitHub release notes were authorized and handled independently. The plugin still requires separate authorization for npm publication. Future work is listed under **Future Update Trajectories** in the README.
