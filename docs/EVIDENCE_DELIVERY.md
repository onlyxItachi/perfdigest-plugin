# PerfDigest Evidence — Runtime-Aware Evidence Delivery (`Refs #19`)

This document specifies the runtime-aware evidence delivery architecture implemented for Issue #19, including the verified runtime capability matrix, deterministic mode negotiation, in-execution asynchronous delivery protocols, and the single-execution fallback when mid-turn stdin steering is unsupported by the host agent CLI.

---

## 1. Root Cause of Two-Turn Evidence Overhead

In the legacy `two_turn` workflow ([`src/run.ts`](../src/run.ts) and [`internal/perfdigest/run.go`](../internal/perfdigest/run.go)), three interacting architectural mechanics create unnecessary latency and token overhead whenever an external agent CLI does not accept mid-turn asynchronous input:

1. **Duplicate Turn 1 Exploration:** While the background evidence worker runs `Decision ↔ PerfDigest MCP` (measured in [`bench/results/2026-10-18-lifecycle-and-orchestration.json`](../bench/results/2026-10-18-lifecycle-and-orchestration.json) and [`bench/results/2026-10-24-multi-model-evaluation.json`](../bench/results/2026-10-24-multi-model-evaluation.json)), an autonomous coding agent running in Turn 1 cannot receive the worker's output mid-turn. If native tools are enabled in Turn 1, the agent independently inspects raw workspace artifacts during Turn 1 before the digested evidence packet is delivered.
2. **`wg.Wait()` / `Promise.all([worker, agent])` Turn 1 Barrier:** Even when the background evidence worker finishes long before Turn 1 completes, the `two_turn` orchestrator waits at `Promise.all([worker, agent])` (TypeScript) / `wg.Wait()` (Go) for Turn 1 to exit before running verification and delivering the evidence packet in Turn 2.
3. **Turn 2 Session Context Replay:** Starting a second full CLI turn (`resume` / `--conversation`) re-tokenizes the entire Turn 1 conversation history in Turn 2 to produce the final evidence-grounded review, and on runtimes that report cumulative session trajectory usage (`cumulative_session_trajectory` on `agy`), naive multi-turn summation double-counts Turn 1 input tokens unless reconciled.

---

## 2. Verified Runtime Capability Matrix

PerfDigest Evidence never assumes a CLI runtime supports mid-turn asynchronous input merely because its `stdin` pipe remains writable (`queuedStdinNextTurn`). Every supported runtime is profiled against explicit capabilities in [`src/agents.ts`](../src/agents.ts) and [`internal/perfdigest/agents.go`](../internal/perfdigest/agents.go):

| Runtime Adapter | `sameSessionContinuation` | `inExecutionAsyncInput` | `inExecutionToolDelivery` | `queuedStdinNextTurn` | `interruptionAndSteering` | `usageReportingSemantics` |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `codex` (`@openai/codex-sdk`) | `true` | `unsupported` | `supported` | `unsupported` | `unsupported` | `incremental_per_turn` |
| `agy` (`agy -p --output-format stream-json`) | `true` | `unsupported` | `supported` | `supported` | `unsupported` | `cumulative_session_trajectory` |
| `claude` (`claude -p --output-format json`) | `true` | `unsupported` | `supported` | `supported` | `unsupported` | `incremental_per_turn` |
| `generic-cli` (default `inExecutionAsync: false`) | `Boolean(options.sessions)` | `unsupported` | `unsupported` | `unsupported` | `unsupported` | `incremental_per_turn` |
| `generic-cli` (`inExecutionAsync: true`) | `Boolean(options.sessions)` | `supported` | `supported` | `options.sessions ? 'supported' : 'unsupported'` | `unsupported` | `single_turn_only` |

---

## 3. Deterministic Delivery Mode Negotiation

`negotiateEvidenceDeliveryMode(requestedMode, capabilities, { strictDeliveryMode })` selects the execution path deterministically before any model turn or capture command starts:

| `requestedDeliveryMode` | Runtime `inExecutionAsyncInput` | `strictDeliveryMode` | `effectiveDeliveryMode` | `plannedEvidenceDelivery` | Selection Reason |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `auto` | `supported` | `false`/`true` | `in_execution` | `in_execution_async_input` | `runtime_supports_in_execution_async_input` |
| `auto` | `unsupported` | `false`/`true` | `single_turn` | `single_turn_with_evidence` | `runtime_lacks_in_execution_async_input_selected_single_turn_fallback` |
| `in_execution` | `supported` | `false`/`true` | `in_execution` | `in_execution_async_input` | `explicit_in_execution_supported_by_runtime` |
| `in_execution` | `unsupported` | `false` (default) | `single_turn` | `single_turn_with_evidence` | `requested_in_execution_unsupported_by_runtime_fell_back_to_single_turn` |
| `in_execution` | `unsupported` | `true` | *(throws `AgentError: unsupported`)* | — | Fails closed when strict mode forbids fallback |
| `single_turn` | any | any | `single_turn` | `single_turn_with_evidence` | `explicit_single_turn_with_evidence` |
| `two_turn` | any | any | `two_turn` | `same_session_next_turn` or `fresh_session_with_context` | Preserves legacy 2-turn mode for historical A/B comparisons |

---

## 4. In-Execution Asynchronous Delivery Protocols

### 4.1 Stream-Injected In-Execution Protocol (`in_execution_async_input`)

When `effectiveDeliveryMode === 'in_execution'` (`genericCliAdapter({ inExecutionAsync: true })` / `--agent-in-execution-async`):

1. **Concurrent Startup:** The runner spawns the agent process once and writes the initial investigation frame (with read-only, no-edit/no-patch, and `<UNTRUSTED_ISSUE>` prompt-injection guards) to `stdin` without closing the pipe:
   ```json
   {"protocol":"perfdigest-agent/v1","phase":"in_execution","prompt":"...","sessionId":null}
   ```
2. **Concurrent Layered Evidence Worker:** While the agent begins its investigation, the background worker executes captures, freshness checks, iterative `Decision ↔ PerfDigest MCP` drill-downs, and the independent verification command.
3. **Mid-Execution Injection:** As soon as verification completes (and if the agent has not already exited), the runner emits `evidence.delivered`, writes exactly one evidence frame to `stdin`, and closes `stdin`:
   ```json
   {"protocol":"perfdigest-agent/v1","type":"evidence","evidence":"{\"schema\":\"perfdigest.agent-evidence.v1\",...}"}
   ```
4. **Observable Transport Acknowledgment vs. Model Consumption:**
   - `{"protocol":"perfdigest-agent/v1","type":"evidence_ack"}` is accepted **only after** `evidence.delivered` has been emitted (any premature `evidence_ack` emitted before `evidence.delivered` is ignored) and records **only** `evidence.accepted_by_runtime` (proving the child runtime's `stdin` loop received the frame).
   - `evidence.model_visible` and `evidence.consumed` (`evidenceConsumedInExecution: true`) require an explicit `"evidenceConsumed": true` in the terminal `result` frame after `evidence.delivered`. If `"evidenceConsumed"` is `false` or omitted in the terminal `result` frame, `evidenceConsumedInExecution` is `false` and neither `evidence.model_visible` nor `evidence.consumed` is emitted, even if `evidence_ack` was received.
5. **Early Agent Completion Handling:** If the agent resolves the issue and exits *before* the slow evidence worker finishes, the runner records `agent.in_execution.completed_before_evidence` (`earlyAgentCompletion: true`, `evidenceConsumedInExecution: false`, `deliveryCount: 0`), awaits the background worker so `run.json` still records full SHA-256 provenance and verification receipts, and never spawns a second turn.

### 4.2 Same-Execution MCP Tool Delivery (`in_execution_tool_delivery`)

For MCP-capable runtimes (`codex`, `agy`, `claude`) running the `perfdigest-evidence` MCP server (`perfdigest-plugin mcp`):

1. The agent calls `launch_evidence_prefetch({ issue, reports, mode })` at the start of its turn, which starts the layered `Decision ↔ PerfDigest MCP` worker asynchronously and returns `{ jobId, status: "running" }` immediately.
2. While the background job runs, the agent inspects source code normally.
3. Within the **same execution**, the agent calls `get_evidence_job({ jobId, waitMs: 30000 })` (up to `60,000 ms` long-polling), which blocks until the background job finishes (or `waitMs` elapses) and returns `deliveryMode: "in_execution_tool_delivery"` when `status === "complete"` (or `deliveryMode: null` while still `"running"` or `"failed"`).

---

## 5. Single-Execution Fallback (`single_turn_with_evidence`)

When `perfdigest-plugin run` orchestrates an external CLI that does not support mid-turn `stdin` injection (`inExecutionAsyncInput: 'unsupported'`), `--agent-delivery auto` selects `single_turn` (`single_turn_with_evidence`):

- The runner executes the local `Decision ↔ PerfDigest MCP` investigation and independent verification first, then starts the coding agent session and invokes the agent **once** in read-only mode with the compacted, SHA-256-verified evidence packet.
- **Prompt Delimiters & Read-Only Autonomy:** The `single_turn` prompt wraps untrusted inputs in `<UNTRUSTED_ISSUE>...</UNTRUSTED_ISSUE>` and `<UNTRUSTED_EVIDENCE_DATA>...</UNTRUSTED_EVIDENCE_DATA>` and instructs the coding agent to investigate in read-only mode using both the workspace and the verified evidence packet while forbidding file edits/patches and untrusted data prompt-injection execution.
- **Event Ordering:** `evidence.delivered` is emitted before invoking `session.turn`, while `evidence.accepted_by_runtime` and `evidence.model_visible` are emitted once the child runtime actually starts the review turn (`*.review.turn_started`), followed by `evidence.consumed` when the review turn completes.

---

## 6. Reproducing & Validating Delivery-Mode Evaluations

In accordance with the repository's benchmark artifact policy (`bench/results/` holds only frozen historical artifacts), reproducible delivery-mode evaluation bundles are generated into untracked working directories under `work/` using the committed generator script [`scripts/evaluate-delivery-modes.mjs`](../scripts/evaluate-delivery-modes.mjs):

```bash
npm run build
node scripts/evaluate-delivery-modes.mjs
```

By default, [`scripts/evaluate-delivery-modes.mjs`](../scripts/evaluate-delivery-modes.mjs) executes all 24 cells (`generic-cli-in-execution-v1` and `generic-cli-single-turn-fallback-v1` × 4 studies × 3 arms: `raw`, `mcp_digest`, `evidence`) using real `investigate()` runs, computes all stage timings directly from measured timeline events (`routing.evidence.started -> routing.evidence.completed`, `routing.started -> routing.completed`, `evidence.prefetch.started -> evidence.ready`, `verification.started -> verification.completed`), and writes the validated bundle (`cells.csv`, `summary.csv`, `trace.json`, and `measurement-receipt.json`) to `work/bench-results/issue19-delivery-modes/bench/results/` via `writeValidatedBenchmarkBundle` and `auditBenchmarkResultsDirectory`.

For historical live-model single-turn evaluations across 6 frontier models and 4 studies (`raw` vs. `mcp_digest` vs. `compact_evidence`), see [`bench/results/2026-10-24-multi-model-evaluation.json`](../bench/results/2026-10-24-multi-model-evaluation.json). For backend orchestration and MCP session lifecycle measurements across Node, Bun, Deno, and Go, see [`bench/results/2026-10-18-lifecycle-and-orchestration.json`](../bench/results/2026-10-18-lifecycle-and-orchestration.json).
