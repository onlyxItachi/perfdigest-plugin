# Hackathon submission walkthrough

## What to demonstrate

PerfDigest Evidence collects a saved performance report while Codex develops hypotheses, then delivers measurements and an independent verifier result to the same thread. PerfDigest translates profiler data. Decisions selects the next evidence path. The reviewer tests hypotheses against evidence. Confidence is a routing signal; it cannot turn a failed verifier into a pass.

This MVP is Codex-first TypeScript 6 with the existing ChatGPT authentication. It uses the real Python PerfDigest package through `uvx perfdigest-mcp`. There is no generic provider framework. The dedicated Decisions key is omitted from Codex and profiler child environments.

## Short demo sequence

1. Show the README's validation boundary: real CPU/MCP/Codex evidence, Decisions fixture verification, live Decisions pending access.
2. Run `npm run demo`. Open the printed `report.md` and `run.json`. Show the trace hash, raw reference, actual command exit status and missing metrics.
3. If a live Codex session is appropriate, run `npm run benchmark:evidence -- --trials 1 --agent codex --model gpt-6-astra --effort max`. Show the fresh thread per arm, two-turn evidence handoff and measured usage. Allow several minutes; do not promise a sub-minute model run.
4. Show `npm test` and the hosted CI link for the exact submitted commit. Point to failure cases: wrong routes, credential inheritance, report mutation and a model success claim contradicted by a failed verifier.
5. Close with the actual limits below. Do not present the controlled CPU example as a fixed PyTorch issue.

For a recorded demonstration, retain the original CPU trace and `run.json` with hashes and timestamps. A replay digests the saved capture and runs verification; it does not create a new profiling measurement. Keep the original receipt alongside the replay receipt so the distinction remains visible.

## Readiness boundaries

| Area | Evidence / boundary |
| --- | --- |
| CPU evidence | Actual capture, SHA-256, real stdio MCP digest, independent arithmetic verifier |
| Codex | Existing ChatGPT session through the official SDK; two turns, explicit next-turn handoff |
| Decisions | Direct OpenAI SDK adapter, synthetic HTTP fixtures and fail-closed behavior; live access pending |
| Packaging | `npm pack`, clean prefix install, executable demo, plugin metadata and three evidence MCP tools |
| CI | Linux/Node 22 build, tests, real CPU/MCP, package install and model-free comparison; inspect actual run result |
| Upstream migration | Independent work; plugin retains the known-working MCP v1 installation pin |
| Unvalidated | Real PyTorch issue/patch, GPU profiling, Desktop UI activation, live Decisions end-to-end, diagnosis/speed/cost improvement |

## Delivery checks

Run `npm ci`, `npm run check` and `npm run benchmark:evidence -- --trials 3`. Keep the lockfile, tarball, recorded evidence and exact hosted CI URL together. The npm archive is a local artifact until explicitly published. An upstream PR is not an installed release. Do not change the working Python tool pin merely because a migration PR exists.

Future work is listed under **Future Update Trajectories** in the README. Merge, tag, PyPI release and npm publication remain separate approval decisions.
