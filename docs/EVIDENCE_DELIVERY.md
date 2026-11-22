# PerfDigest Evidence — Runtime-Aware Evidence Delivery (`Refs #19`)

This document specifies the runtime-aware evidence delivery architecture implemented for Issue #19, including the verified runtime capability matrix, deterministic mode negotiation, in-execution asynchronous delivery protocols, Codex App Server (`0.165.0`) live mid-turn evidence steering across `gpt-6.1-terra`, `gpt-6.1-sol`, and `gpt-6-luna`, and the single-execution fallback when mid-turn stdin steering is unsupported by the host agent CLI.

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
| `codex-app-server` (`codex app-server --listen stdio://`, `0.165.0+`) | `true` | `supported` | `supported` | `unsupported` | `supported` | `incremental_per_turn` |
| `codex` (`@openai/codex-sdk` `codex exec`) | `true` | `unsupported` | `supported` | `unsupported` | `unsupported` | `incremental_per_turn` |
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

### 4.3 Codex App Server (`0.165.0`) Live Mid-Turn Evidence Steering

While the per-turn `@openai/codex-sdk` wrapper (`codex exec`) closes `stdin` after writing the initial prompt (`inExecutionAsyncInput: 'unsupported'`), `codex-cli 0.165.0` ships a persistent bidirectional JSON-RPC 2.0 protocol over `stdio` (`codex app-server --listen stdio://`, implemented in [`src/codex.ts`](../src/codex.ts) and [`internal/perfdigest/agents.go`](../internal/perfdigest/agents.go)) that supports live mid-turn steering of an in-progress turn.

When `--agent codex` is invoked with `--agent-delivery auto` or `--agent-delivery in_execution`, PerfDigest selects the `codex-app-server` capability profile (`inExecutionAsyncInput: 'supported'`, `interruptionAndSteering: 'supported'`) and executes the turn via `codexAppServerInExecutionTurn`.

#### 4.3.1 Empirical Capability Matrix Across `gpt-6.1-terra`, `gpt-6.1-sol`, and `gpt-6-luna`

Live protocol verification against `codex-cli 0.165.0` (`codex app-server --listen stdio://`) confirms the following capabilities across all three target frontier models:

| Capability / Protocol Method | `gpt-6.1-terra` | `gpt-6.1-sol` | `gpt-6-luna` | Verified Wire Semantics & Empirical Behavior |
| :--- | :---: | :---: | :---: | :--- |
| **Model Availability (`model/list`)** | `supported` | `supported` | `supported` | Listed as first-class models (`efforts: low, medium, high, xhigh`). |
| **Context Window (`model/list`)** | `475,000` | `475,000` | `258,400` | Reported in `model/list` metadata on `codex-cli 0.165.0`. |
| **Active Turn Creation (`turn/start`)** | `supported` | `supported` | `supported` | Returns `{ turn: { id: activeTurnId, status: "inProgress" } }` and emits `turn/started`. |
| **Active-Turn Steering (`turn/steer`)** | `supported` | `supported` | `supported` | Request `{ threadId, expectedTurnId, input }` returns `{ turnId: activeTurnId }` and injects a `userMessage` item into the active turn. |
| **`turn/steer` Precondition Enforcement** | `supported` | `supported` | `supported` | Mismatched `expectedTurnId` returns JSON-RPC `-32600` (`"expected active turn id \`...\` but found \`...\`"`); steering after turn completion returns `-32600` (`"no active turn to steer"`). |
| **Tool-Level Data Delivery (`turn/start` `toolOutput`)** | `supported` | `supported` | `supported` | `ExternalMessage` wire representation (`input: []`, `toolOutput: { name: "perfdigest_evidence", namespace: "mcp_perfdigest", output, retain: true }`) joins the active `inProgress` turn (`returnedTurnId === activeTurnId`) with native `functionCallOutput` authority. |
| **Mid-Turn Interruption (`turn/interrupt`)** | `supported` | `supported` | `supported` | Request `{ threadId, turnId }` cleanly aborts the in-progress turn and emits `turn/completed` with `status: "interrupted"`. |
| **Token Usage (`thread/tokenUsage/updated`)** | `supported` | `supported` | `supported` | Emits both cumulative `total` and incremental per-step `last` `TokenUsageBreakdown` (`inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`). |

#### 4.3.2 Steering Mechanisms & Authority Levels (`--codex-steering-mechanism`)

PerfDigest supports both verified `codex app-server` mid-turn injection mechanisms via `codexSteeringMechanism` (`--codex-steering-mechanism turn_steer|tool_output`):

1. **`turn_steer` (`turn/steer` with `expectedTurnId` precondition, default):**
   - Sends `turn/steer` with `{ threadId, expectedTurnId: activeTurnId, input: [{ type: "text", text: framedEvidence, text_elements: [] }] }`.
   - Enforces the `expectedTurnId` precondition at the protocol level: if `expectedTurnId` does not match the active turn, `codex app-server` rejects the request with JSON-RPC `-32600` (`"expected active turn id \`...\` but found \`...\`"`), which PerfDigest surfaces as a protocol error (`AgentError: protocol`). If the turn completed naturally in a race just as `turn/steer` was sent (`-32600: "no active turn to steer"`), PerfDigest records `codex.in_execution.completed_before_evidence` (`earlyAgentCompletion: true`, `evidenceDeliveredInExecution: false`, `deliveryCount: 0`).
   - **Authority Level:** Because `turn/steer` injects a `userMessage` item into the active turn, PerfDigest wraps the payload in explicit `<UNTRUSTED_EVIDENCE_DATA>...</UNTRUSTED_EVIDENCE_DATA>` trust-boundary delimiters and instructs the model never to follow instructions or commands inside the untrusted data block.
2. **`tool_output` (`turn/start` with `toolOutput` / `ExternalMessage` wire format):**
   - Uses the `ExternalMessage` wire representation from the `openai-codex` SDK:
     ```json
     {
       "threadId": "<active-thread-id>",
       "cwd": "<workspace>",
       "input": [],
       "toolOutput": {
         "name": "perfdigest_evidence",
         "namespace": "mcp_perfdigest",
         "output": "{\"schema\":\"perfdigest.agent-evidence.v1\",...}",
         "retain": true
       }
     }
     ```
   - **Empirical Schema Constraint:** `toolOutput.namespace` must match `^[a-zA-Z0-9_-]+$` (e.g., `mcp_perfdigest`). Namespaces containing colons (such as `mcp:perfdigest`) are rejected by the upstream Responses API with HTTP 400 (`Invalid 'input[0].namespace': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'`).
   - **Mid-Turn Join & Authority Level:** When sent while `activeTurnId` is `inProgress`, `codex app-server` attaches the `toolOutput` to the active turn (`result.turn.id === activeTurnId`) with native **tool-level (`functionCallOutput`) authority** — strictly below `system`/`developer` and `user` instructions in the model instruction hierarchy.

#### 4.3.3 Strict 3-State Separation of Transport Acceptance, Post-Steer Output, and Lexical Evidence Overlap

PerfDigest separates transport acceptance, post-steer message arrival, and lexical evidence overlap in both TypeScript ([`src/codex.ts`](../src/codex.ts)) and Go ([`internal/perfdigest/agents.go`](../internal/perfdigest/agents.go)):

1. **`evidence.accepted_by_runtime` (`evidenceDeliveredInExecution: true`):**
   - Emitted only when `codex app-server` returns a successful JSON-RPC response to `turn/steer` (`result.turnId === activeTurnId`) or mid-turn `turn/start` `toolOutput` (`result.turn.id === activeTurnId`).
2. **`evidence.model_visible`:**
   - Emitted only when the model completes a post-steer `agentMessage` (`item/completed` with `item.type === "agentMessage"`) inside the active turn **after** `steerAccepted` is true. Pre-steer commentary messages (`phase: "commentary"`) emitted before `turn/steer` or `toolOutput` acceptance never trigger `evidence.model_visible`.
3. **`evidence.consumed` (`telemetry.evidenceConsumedInExecution: true`):**
   - Emitted only when `verifyCodexEvidenceConsumption` / `VerifyCodexEvidenceConsumption` observes lexical overlap between the post-steer `agentMessage` text and identifiers from the delivered evidence packet (at least one selected/corroborating/extracted report ID, hot diagnostic unit name, 8+ hex character SHA-256 prefix, canary token, or non-contradictory abstention/verification status when no report is selected).
   - **Heuristic Scope Note:** This check is a lexical overlap heuristic, not causal proof of model reasoning consumption. Report IDs that match workspace filenames (e.g., `primary-trace`) or unit names readable directly from workspace files by a tool-enabled agent can overlap lexically, and an `item/completed` emitted shortly after steer acknowledgment can reflect generation started prior to acceptance.
   - If the model completes a post-steer message that has no lexical overlap with the evidence packet, `evidence.accepted_by_runtime` and `evidence.model_visible` are recorded on the timeline while `evidence.consumed` is omitted and `telemetry.evidenceConsumedInExecution` remains `false`.

### 4.4 Skill-Controlled OS-Native Background Worker (`skill_background_worker`)

As an alternative asynchronous delivery path alongside native app-server steering (§4.3), MCP tool pull (§4.2), and single-turn fallback (§5), `perfdigest-plugin evidence` exposes a Skill-controlled OS-native background worker sharing 100% of the underlying PerfDigest Evidence contracts (`investigate(..., agent: 'none')`, `formatAgentEvidence` / `perfdigest.agent-evidence.v1`, SHA-256 report immutability, independent verification, abstention guard, `0600` atomic `run.json` receipts, and `childEnvironment()` secret isolation):

- **Foreground blocking worker (`perfdigest-plugin evidence run <manifest.json>`):** Executes captures, digesting, routing, and independent verification, atomically writes `.perfdigest/runs/<jobId>/evidence.v1.json` (`0600`) followed last by `.perfdigest/runs/<jobId>/ready.json` (`0600`, carrying the SHA-256 digest of `evidence.v1.json`), prints a single bounded JSON object with `deliveryMode: "skill_background_worker"` and `packet` (`perfdigest.agent-evidence.v1`), and exits `0` iff `status === "complete"`. Designed to be launched inside a harness's own background command runner.
- **Detached lifecycle (`perfdigest-plugin evidence start|status|wait|collect|cancel`):** `start` validates the manifest and provider preflight synchronously, records `.perfdigest/jobs/<jobId>/state.json` (`0600`), and spawns a detached session-leader worker (`evidence _worker`) using `childEnvironment()` (no shell, no secrets on `argv`; private external `envFile` credentials load strictly inside the worker process). `status` performs non-blocking `state.json` + `ready.json` + OS PID liveness/ownership checks (`running | complete | needs_review | failed | cancelled | crashed`). `wait` blocks locally up to `--timeout-ms` (`0..300000`, default `30000`) without burning model turns. `collect` verifies `ready.json` SHA-256 against `evidence.v1.json` (failing closed on tamper/mismatch) and returns the packet (or full `run.json` with `--full`) idempotently. `cancel` verifies PID + job ownership before signaling the worker process group (`SIGTERM`, then `SIGKILL` after 2s) and atomically recording `cancelled`.

#### 4.4.1 Harness Background-Notification Matrix (Empirical Probes & Documented Behavior)

PerfDigest explicitly distinguishes **(A) harness-managed background execution** (a foreground blocking worker handed to the harness's own backgrounding tool) from **(B) OS-detached processes** (`setsid`/`nohup`/`&` or `evidence start`, where the launching shell returns exit `0` immediately), and distinguishes live local probes from documentation-only inspection:

| Target Harness / Mode | Verification Basis | Harness-Managed BG Foreground Worker (`evidence run`) → Model-Visible Notification? | OS-Detached Worker (`evidence start` / `setsid` / `&`) → Model-Visible Notification? | Mechanism & Required Retrieval Pattern |
| :--- | :--- | :--- | :--- | :--- |
| **`agy` `1.5.14` interactive / agentic (`run_command` with short `WaitMsBeforeAsync`)** | **Empirically probed** (local live session) | **Yes** — `<SYSTEM_MESSAGE>` delivered at next tool boundary and wakes an idle turn | **No** (0 harness notifications) | Live probe confirmed foreground async task auto-delivers output at tool boundary, while detached `setsid` child produced zero notifications. Use `evidence run` in async `run_command`, or explicit `evidence wait`/`collect` for `evidence start`. |
| **`agy` `1.5.14 -p` (non-interactive print mode)** | **Documented** (`agy --help`) | **Active tool loop only** (exits when final assistant response is emitted) | **No** | Must await or collect before emitting the final response so background tasks are not truncated. |
| **`codex` `0.171.0` (`exec_command` / `unified_exec`, interactive / `exec` / `app-server` agent)** | **Empirically probed** (local `codex app-server` + ChatGPT login) | **No** (app-server emits `item/completed` to the *client* only; **not** model-visible) | **No** | Live probe on `codex app-server 0.171.0` (`unified_exec=true`) confirmed that even when a backgrounded `exec_command` exited *before* a subsequent tool call finished, the model received zero unsolicited exit notification and saw output only after explicitly calling `write_stdin` (or `evidence wait`/`collect`). |
| **`codex app-server` `0.171.0` (external orchestrator, §4.3)** | **Empirically probed** (local `codex app-server` JSON-RPC) | **Yes** — external host pushes via `turn/steer` / `turn/start` `toolOutput` | N/A (external host owns worker) | External orchestrator pushes directly into the active turn via JSON-RPC. |
| **`claude` `2.1.310`** | **Documented only** (`claude --help` & official docs; **0 billed API calls**) | **Documented yes in interactive REPL** (`Bash(run_in_background: true)` → synthetic `<task-notification>`); **caveat in `-p`** (parent can exit before late tasks finish) | **No** | Documented REPL behavior surfaces `<task-notification>` for harness-managed `Bash(run_in_background: true)` tasks only; `-p` mode and detached workers require explicit wait/collect before finalizing. |
| **Generic plain-shell agents** | **Architectural baseline** | **No** | **No** | Always requires an explicit `evidence wait` or `evidence collect` tool call. |

**Sandbox & Credential Boundary Note:** Under restricted command sandboxes (e.g., Codex `read-only`, or `workspace-write` with `network_access=false`), shell-launched workers cannot write outside permitted paths or reach external private `envFile`s / hosted decision APIs. In those environments, prefer the host-side `perfdigest-evidence` MCP pull path (§4.2) or offline local manifests.

---

## 5. Single-Execution Fallback (`single_turn_with_evidence`)

When `perfdigest-plugin run` orchestrates an external CLI that does not support mid-turn `stdin` injection (`inExecutionAsyncInput: 'unsupported'`), `--agent-delivery auto` selects `single_turn` (`single_turn_with_evidence`):

- The runner executes the local `Decision ↔ PerfDigest MCP` investigation and independent verification first, then starts the coding agent session and invokes the agent **once** in read-only mode with the compacted, SHA-256-verified evidence packet.
- **Prompt Delimiters & Read-Only Autonomy:** The `single_turn` prompt wraps untrusted inputs in `<UNTRUSTED_ISSUE>...</UNTRUSTED_ISSUE>` and `<UNTRUSTED_EVIDENCE_DATA>...</UNTRUSTED_EVIDENCE_DATA>` and instructs the coding agent to investigate in read-only mode using both the workspace and the verified evidence packet while forbidding file edits/patches and untrusted data prompt-injection execution.
- **Event Ordering:** `evidence.delivered` is emitted before invoking `session.turn`, while `evidence.accepted_by_runtime` and `evidence.model_visible` are emitted once the child runtime actually starts the review turn (`*.review.turn_started`), followed by `evidence.consumed` when the review turn completes.

---

## 6. Reproducing & Validating Delivery-Mode and Live Steering Evaluations

In accordance with the repository's benchmark artifact policy (`bench/results/` holds only frozen historical artifacts), reproducible delivery-mode and live-steering evaluation bundles are generated into untracked working directories under `work/` using the committed generator scripts [`scripts/evaluate-delivery-modes.mjs`](../scripts/evaluate-delivery-modes.mjs) and [`scripts/evaluate-live-steering.mjs`](../scripts/evaluate-live-steering.mjs):

```bash
npm run build
node scripts/evaluate-delivery-modes.mjs
node scripts/evaluate-live-steering.mjs
```

- **Generic CLI Delivery-Mode Evaluation ([`scripts/evaluate-delivery-modes.mjs`](../scripts/evaluate-delivery-modes.mjs)):** Executes all 24 cells (`generic-cli-in-execution-v1` and `generic-cli-single-turn-fallback-v1` × 4 studies × 3 arms: `raw`, `mcp_digest`, `evidence`) using real `investigate()` runs, computes all stage timings directly from measured timeline events, and writes the validated bundle (`cells.csv`, `summary.csv`, `trace.json`, and `measurement-receipt.json`) to `work/bench-results/issue19-delivery-modes/bench/results/` via `writeValidatedBenchmarkBundle` and `auditBenchmarkResultsDirectory`.
- **Codex App Server Protocol-Level Steering Feasibility Harness ([`scripts/evaluate-live-steering.mjs`](../scripts/evaluate-live-steering.mjs)):** Exercises all 5 delivery/baseline configurations (`raw` baseline with native read-only workspace tools enabled, `two_turn` `same_session_next_turn`, `single_turn` `single_turn_with_evidence`, `in_execution` `turn_steer`, and `in_execution` `tool_output`) across `gpt-6.1-terra`, `gpt-6.1-sol`, and `gpt-6-luna` without any artificial CPU or memory throttling (`NODE_OPTIONS`, `GOMAXPROCS`, `GOFLAGS`). Supports both deterministic contract-fixture mode (`--mode contract_fixture`, default) and live authenticated Codex subscription mode (`--live-codex`), writing receipt-validated bundles to `work/bench-results/live-steering-eval/bench/results/`. **Scope boundary:** This harness validates protocol-level steering mechanics on synthetic `<200 B` 2-event trace fixtures with a simulated MCP responder, loopback mock Decision routing, a `/bin/true` no-op verifier, and a permissive 5-check substring rubric; it is **protocol-level feasibility evidence, NOT proof of superior performance on realistic HPC workloads**.

### 6.1 Protocol-Level Live Steering Feasibility Snapshot (`codex app-server 0.165.0`, `agent_execution_mode="agentic_e2e"`)

> **Methodological Scope & Limitations:** The snapshot below (`2026-10-28-codex-live-steering-live-cli`, `N = 1` trial per configuration on a single synthetic study `cuda_opt_loop`, `checkedCellsCount: 15`, `valid: true`) provides **protocol-level steering feasibility evidence** confirming that `codex app-server` accepts `turn/steer` and `turn/start` `toolOutput` mid-turn across `gpt-6.1-terra`, `gpt-6.1-sol`, and `gpt-6-luna`. It is **NOT** proof of superior end-to-end latency, token cost, or diagnostic accuracy on realistic HPC workloads because:
> 1. **Tiny synthetic traces:** Inputs are `<200 B` 2-event Chrome trace JSON fixtures, not realistic multi-megabyte HPC profiler captures.
> 2. **Simulated MCP responder:** Digestion ran against a local stub (`mcp-responder.mjs`) with an artificial `450 ms` sleep delay rather than `perfdigest-mcp` parsing real traces.
> 3. **Mock loopback Decision routing:** Routing used a local `127.0.0.1` SystemOne HTTP stub (`provider_execution_mode="mock_loopback"`), not a live hosted Clef/Decisions model.
> 4. **No-op verifier:** Independent verification ran `/bin/true` rather than a real build/test/benchmark verifier.
> 5. **Invalidated rubric scores from historical 2026-10-28 harness defects (`AGENTS.md` §1.2 / §1.4):** That pre-remediation harness had three defects that contaminated cross-arm grading: (a) it wrote `study-meta.json` (containing `primaryUnit`, `secondaryUnit`, `symptomKeyword`, and durations) into the parent workspace directory `ws/`, readable inside the read-only sandbox by tool-enabled `codex app-server` arms (`raw`/`in_execution`, `native_tools_enabled="true"`) but unreachable by `shell_tool=false` `codex exec` SDK arms (`single_turn`/`two_turn`, `native_tools_enabled="false"`); (b) Check 4 used a buggy `'us'` substring check (`lower.includes('us')`) that falsely matched ordinary English words (`because`, `using`, `must`, `focus`, `status`, `issue`); and (c) prompts differed across arms (`raw` verification wording and an `in_execution`-only hypothesis stall instruction). Accordingly, the contaminated rubric column is **omitted as invalid** below, retaining only directly observed protocol timings and token telemetry (and noting that subsequent harness remediation fixed all three defects plus `timed_out` / unobserved-token / `tool_calls_count` / `same_session_observed` reporting).

| Base Model (`effort="low"`) | Configuration (`model_id` / `arm`) | Delivery Mode | E2E Wall (`ms`) | Worker Ready→Delivery (`ms`) | Parallel Overlap (`ms`) | Uncached Input Tokens | Cached Input Tokens | Output Tokens | Run Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-6.1-terra` | `gpt-6.1-terra` (`raw`) | `none` (native read-only tools) | `10,330.45` | `0` | `0` | `5,006` | `44,160` | `343` | `complete` |
| `gpt-6.1-terra` | `gpt-6.1-terra` (`evidence`) | `in_execution_async_input` (`turn_steer`) | `9,936.58` | `5.41` | `940.17` | `5,110` | `44,416` | `382` | `complete` |
| `gpt-6.1-terra` | `gpt-6.1-terra-tool-output` (`evidence`) | `in_execution_async_input` (`tool_output`) | `15,364.78` | `5.75` | `920.64` | `5,489` | `44,800` | `493` | `complete` |
| `gpt-6.1-terra` | `gpt-6.1-terra-single-turn` (`evidence`) | `single_turn_with_evidence` | `14,844.91` | `88.70` | `0` | `14,662` | `67,712` | `447` | `complete` |
| `gpt-6.1-terra` | `gpt-6.1-terra-two-turn` (`evidence`) | `same_session_next_turn` | `14,920.71` | `8,095.28` | `916.09` | `9,297` | `30,848` | `570` | `complete` |
| `gpt-6.1-sol` | `gpt-6.1-sol` (`raw`) | `none` (native read-only tools) | `29,479.22` | `0` | `0` | `9,988` | `56,448` | `442` | `complete` |
| `gpt-6.1-sol` | `gpt-6.1-sol` (`evidence`) | `in_execution_async_input` (`turn_steer`) | `34,923.61` | `3.19` | `919.97` | `10,204` | `73,984` | `588` | `complete` |
| `gpt-6.1-sol` | `gpt-6.1-sol-tool-output` (`evidence`) | `in_execution_async_input` (`tool_output`) | `29,460.10` | `4.91` | `917.27` | `18,872` | `75,520` | `621` | `complete` |
| `gpt-6.1-sol` | `gpt-6.1-sol-single-turn` (`evidence`) | `single_turn_with_evidence` | `23,303.71` | `75.43` | `0` | `27,344` | `80,640` | `514` | `complete` |
| `gpt-6.1-sol` | `gpt-6.1-sol-two-turn` (`evidence`) | `same_session_next_turn` (240s timeout*) | `240,020.41` | `—` | `—` | `—` | `—` | `—` | `failed`* (would classify as `timed_out` under the remediated harness) |
| `gpt-6-luna` | `gpt-6-luna` (`raw`) | `none` (native read-only tools) | `6,469.16` | `0` | `0` | `8,945` | `38,272` | `214` | `complete` |
| `gpt-6-luna` | `gpt-6-luna` (`evidence`) | `in_execution_async_input` (`turn_steer`) | `9,457.32` | `4.63` | `923.63` | `8,691` | `22,784` | `315` | `complete` |
| `gpt-6-luna` | `gpt-6-luna-tool-output` (`evidence`) | `in_execution_async_input` (`tool_output`) | `7,982.77` | `4.13` | `915.15` | `4,832` | `26,880` | `341` | `complete` |
| `gpt-6-luna` | `gpt-6-luna-single-turn` (`evidence`) | `single_turn_with_evidence` | `17,744.40` | `76.35` | `0` | `30,697` | `46,208` | `497` | `complete` |
| `gpt-6-luna` | `gpt-6-luna-two-turn` (`evidence`) | `same_session_next_turn` | `18,004.67` | `4,519.62` | `914.92` | `13,277` | `24,960` | `566` | `complete` |

*\*In the 2026-10-28 snapshot, `gpt-6.1-sol-two-turn` hit the 240s pipeline timeout before Turn 2 usage was reported; its recorded historical status was `failed` with zero-filled telemetry (shown as `—` above because usage was unobserved). Under the remediated harness, this outcome classifies as `timed_out` with null/`unavailable` usage and `same_session_observed="false"`.*

Protocol-level feasibility observations from this synthetic fixture snapshot (not general HPC performance claims):
- **Mid-Turn Delivery Mechanics vs. Turn-1 Wait Barrier:** In `two_turn` (`same_session_next_turn`), the simulated worker finished in `~986 ms`, while delivery waited for Turn 1 completion (`4,519.62–8,095.28 ms` on `luna`/`terra`, and `gpt-6.1-sol` hit the 240s pipeline timeout). In `in_execution` (`turn_steer` and `tool_output`), `codex app-server` accepted the steered packet within `3.19–5.75 ms` of worker completion while overlapping `915.15–940.17 ms` with the active turn (`0 ms` overlap in `single_turn`).
- **Observed Single-Trial Variance (`N = 1`):** In this single-trial synthetic snapshot, reported uncached input and output token counts were lower for `turn_steer` than `two_turn`/`single_turn` on `gpt-6.1-terra` and `gpt-6-luna`, while end-to-end wall time varied across models (`gpt-6.1-sol` `single_turn` completed in `23.30 s` vs. `29.46–34.92 s` for `in_execution`). Single-trial observations on a pre-remediation synthetic fixture do not establish causal token or latency advantages.
- **Honest Baseline Trade-offs & Next Validation Step:** On a tiny `<200 B` 2-event fixture trace, a `raw` baseline with native read-only tools enabled finished quickly (`6.47–10.33 s` on `luna`/`terra`) by reading the small JSON file directly, without running independent verification (`verification_status="not_run"`), recording SHA-256 provenance (`provenance_count=0`), or digesting large multi-megabyte profiles. Evaluating end-to-end effectiveness on realistic HPC workloads requires genuine multi-megabyte profiler artifacts, production `perfdigest-mcp`, real verifiers, and deep task rubrics.

For historical live-model single-turn evaluations across 6 frontier models and 4 studies (`raw` vs. `mcp_digest` vs. `compact_evidence`), see [`bench/results/2026-10-24-multi-model-evaluation.json`](../bench/results/2026-10-24-multi-model-evaluation.json). For backend orchestration and MCP session lifecycle measurements across Node, Bun, Deno, and Go, see [`bench/results/2026-10-18-lifecycle-and-orchestration.json`](../bench/results/2026-10-18-lifecycle-and-orchestration.json).
