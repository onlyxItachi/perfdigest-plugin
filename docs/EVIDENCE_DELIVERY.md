# PerfDigest Evidence — Runtime-Aware Evidence Delivery (`Refs #19`)

This document specifies the runtime-aware evidence delivery architecture implemented for Issue #19, including the verified runtime capability matrix, deterministic mode negotiation, in-execution asynchronous delivery protocols, and the single-execution fallback when mid-turn stdin steering is unsupported by the host agent CLI.

---

## 1. Root Cause of Two-Turn Evidence Overhead

Timeline and token-accounting audits of the 24-cell v2/v3 evaluation (`bench/results/2026-10-25-v3-*`) proved three interacting root causes in the legacy `two_turn` workflow:

1. **Duplicate Turn 1 Investigation (`100%` in Turn 1):** While the background evidence worker ran `Decision ↔ PerfDigest MCP` (`1,134 ms`–`1,704 ms`), the autonomous coding agent in Turn 1 had no way to receive the worker's result mid-turn and therefore independently read the raw profiler artifacts using native tools (`read_file` / `run_command`), consuming `11,648` to `34,478` tokens over `56,161 ms` to `59,362 ms`.
2. **`wg.Wait()` Delivery Barrier (`54,637 ms`–`57,658 ms` delay):** Even though the evidence worker finished in `~1.4 s`, the orchestrator could not deliver the evidence until Turn 1 exited (`wg.Wait()`), delaying evidence handoff by `54.6 s`–`57.7 s`.
3. **Turn 2 Context Replay:** Starting a second full CLI turn (`--resume`) re-tokenized the entire Turn 1 conversation history (`18,622` to `35,693` input tokens) to produce a short review summary.

---

## 2. Verified Runtime Capability Matrix

PerfDigest Evidence never assumes a CLI runtime supports mid-turn asynchronous input merely because its `stdin` pipe remains writable (`queuedStdinNextTurn`). Every supported runtime is profiled against five explicit capabilities in [`src/agents.ts`](../src/agents.ts) and [`internal/perfdigest/agents.go`](../internal/perfdigest/agents.go):

| Runtime Adapter | `sameSessionContinuation` | `inExecutionAsyncInput` | `inExecutionToolDelivery` | `queuedStdinNextTurn` | `interruptionAndSteering` | `usageReportingSemantics` |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `codex` (`@openai/codex-sdk`) | `true` | `unsupported` | `supported` | `unsupported` | `unsupported` | `incremental_per_turn` |
| `agy` (`agy -p --output-format stream-json`) | `true` | `unsupported` | `supported` | `supported` | `unsupported` | `cumulative_session_trajectory` |
| `claude` (`claude -p --output-format json`) | `true` | `unsupported` | `supported` | `supported` | `unsupported` | `incremental_per_turn` |
| `generic-cli` (default `inExecutionAsync: false`) | `options.sessions` | `unsupported` | `unsupported` | `unsupported` | `unsupported` | `incremental_per_turn` |
| `generic-cli` (`inExecutionAsync: true`) | `true` | `supported` | `supported` | `supported` | `supported` | `single_turn_only` |

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

1. **Concurrent Startup:** The runner spawns the agent process once and writes the initial investigation frame to `stdin` without closing the pipe:
   ```json
   {"protocol":"perfdigest-agent/v1","phase":"in_execution","prompt":"...","sessionId":null}
   ```
2. **Concurrent Layered Evidence Worker:** While the agent begins its investigation, the background worker executes captures, freshness checks, iterative `Decision ↔ PerfDigest MCP` drill-downs, and the independent verification command.
3. **Mid-Execution Injection:** As soon as verification completes (and if the agent has not already exited), the runner writes exactly one evidence frame to `stdin` and closes `stdin`:
   ```json
   {"protocol":"perfdigest-agent/v1","type":"evidence","evidence":"{\"schema\":\"perfdigest.agent-evidence.v1\",...}"}
   ```
4. **Runtime Acknowledgment & Single-Turn Completion:** The agent emits `{"protocol":"perfdigest-agent/v1","type":"evidence_ack"}` (recording `evidence.accepted_by_runtime` and `evidence.model_visible`) and completes its investigation in the same execution (`{"protocol":"perfdigest-agent/v1","type":"result","evidenceConsumed":true,...}`).
5. **Early Agent Completion Handling:** If the agent resolves the issue and exits *before* the slow evidence worker finishes, the runner records `agent.in_execution.completed_before_evidence` (`earlyAgentCompletion: true`, `evidenceConsumedInExecution: false`, `deliveryCount: 0`), awaits the background worker so `run.json` still records full SHA-256 provenance and verification receipts, and never spawns a second turn.

### 4.2 Same-Execution MCP Tool Delivery (`in_execution_tool_delivery`)

For MCP-capable runtimes (`codex`, `agy`, `claude`) running the `perfdigest-evidence` MCP server (`perfdigest-plugin mcp`):

1. The agent calls `launch_evidence_prefetch({ issue, reports, mode })` at the start of its turn, which starts the layered `Decision ↔ PerfDigest MCP` worker asynchronously and returns `{ jobId, status: "running" }` immediately.
2. While the background job runs, the agent inspects source code normally.
3. Within the **same execution**, the agent calls `get_evidence_job({ jobId, waitMs: 30000 })` (extended up to `60,000 ms` long-polling), which blocks only until the background job finishes and returns `{ jobId, status: "complete", deliveryMode: "in_execution_tool_delivery", waitedMs, packet }` directly as a tool result inside the active turn.

---

## 5. Single-Execution Fallback (`single_turn_with_evidence`)

When `perfdigest-plugin run` orchestrates an external CLI that does not support mid-turn `stdin` injection (`inExecutionAsyncInput: 'unsupported'`), `--agent-delivery auto` selects `single_turn` (`single_turn_with_evidence`):

- The runner executes the fast local `Decision ↔ PerfDigest MCP` investigation (`~1.1 s`–`1.7 s`) and independent verification first, then invokes the coding agent **once** with the compacted, SHA-256-verified evidence packet.
- This eliminates the `54.6 s`–`57.7 s` `wg.Wait()` barrier, eliminates 100% of duplicate Turn 1 profiler tool calls, and eliminates Turn 2 context re-tokenization.

---

## 6. Measured Delivery-Mode Comparison (`bench/results/2026-10-25-issue19-*`)

All measurements below are recorded in [`bench/results/2026-10-25-issue19-delivery-modes-cells.csv`](../bench/results/2026-10-25-issue19-delivery-modes-cells.csv), [`bench/results/2026-10-25-issue19-delivery-modes-summary.csv`](../bench/results/2026-10-25-issue19-delivery-modes-summary.csv), and [`bench/results/2026-10-25-issue19-measurement-receipt.json`](../bench/results/2026-10-25-issue19-measurement-receipt.json) and validated by the Issue #18 benchmark integrity gates:

| Delivery Mode | Effective Delivery | Agent Turns | Duplicate Profiler Tool Calls | Evidence Ready → Delivery Delay (ms) | Reconciled Agent Total Tokens (Mean) | E2E Wall Time (Mean ms) | Accuracy |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `two_turn` (legacy baseline) | `same_session_next_turn` | 2 | 100% (Turn 1) | `56,147.2` | `26,356` | `78,795.0` | `1.000` |
| `single_turn` (`auto` fallback for non-streaming CLI) | `single_turn_with_evidence` | 1 | 0% | `4.8` | `6,842` | `21,418.5` | `1.000` |
| `in_execution` (`auto` with `inExecutionAsync: true`) | `in_execution_async_input` | 1 | 0% | `1.4` | `5,910` | `18,640.2` | `1.000` |
| `in_execution` (early agent completion) | `null` (`earlyAgentCompletion: true`) | 1 | 0% | `null` (0 deliveries) | `3,420` | `11,250.0` | `1.000` |
