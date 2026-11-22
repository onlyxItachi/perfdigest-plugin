package perfdigest

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func writeMockCodexAppServer(t *testing.T, dir string, mode string, logPath string) string {
	t.Helper()
	binPath := filepath.Join(dir, "mock-codex-"+mode+".mjs")
	script := `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const mode = ` + "`" + mode + "`" + `;
const logPath = ` + "`" + logPath + "`" + `;

function appendLog(obj) {
  if (logPath) {
    fs.appendFileSync(logPath, JSON.stringify(obj) + '\n');
  }
}

if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{ name: 'inherited_mcp' }]) + '\n');
  process.exit(0);
}
if (args[0] !== 'app-server') {
  process.stderr.write('unexpected subcommand: ' + args.join(' ') + '\n');
  process.exit(2);
}

appendLog({ type: 'spawn_args', args });

const send = (obj) => {
  process.stdout.write(JSON.stringify(obj) + '\n');
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let activeTurnId = 'turn-live-1';
let threadId = 'thread-live-1';

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  appendLog({ type: 'rpc_in', msg });

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { serverInfo: { name: 'codex-app-server', version: '0.165.0' }, capabilities: {} },
    });
    return;
  }
  if (msg.method === 'initialized') {
    return;
  }
  if (msg.method === 'thread/start') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { thread: { id: threadId } },
    });
    return;
  }
  if (msg.method === 'turn/start') {
    // Check if this is toolOutput mid-turn injection
    if (msg.params && msg.params.toolOutput) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { turn: { id: activeTurnId, status: 'inProgress' } },
      });
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          threadId,
          turnId: activeTurnId,
          item: {
            id: 'msg-post-tool',
            type: 'agentMessage',
            phase: 'final_answer',
            text: 'ToolOutput received: top bottleneck is hot_kernel_reduce in cpu-trace.',
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: {
          threadId,
          turnId: activeTurnId,
          tokenUsage: {
            total: { inputTokens: 380, cachedInputTokens: 20, outputTokens: 60, reasoningOutputTokens: 10 },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId, turn: { id: activeTurnId, status: 'completed' } },
      });
      return;
    }

    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { turn: { id: activeTurnId, status: 'inProgress' } },
    });
    send({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId, turn: { id: activeTurnId, status: 'inProgress' } },
    });

    if (mode === 'early_complete') {
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            threadId,
            turnId: activeTurnId,
            item: {
              id: 'msg-early',
              type: 'agentMessage',
              phase: 'final_answer',
              text: 'Completed early from workspace inspection before profiler evidence arrived.',
            },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId, turn: { id: activeTurnId, status: 'completed' } },
        });
      }, 15);
      return;
    }

    if (mode === 'hang_blocked_pipe') {
      rl.close();
      process.stdin.pause();
      setTimeout(() => {}, 30000);
      return;
    }

    // Emit pre-steer commentary message
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId,
        turnId: activeTurnId,
        item: {
          id: 'msg-pre-commentary',
          type: 'agentMessage',
          phase: 'commentary',
          text: 'Inspecting workspace while awaiting PerfDigest evidence (mentioning hot_kernel_reduce pre-steer)...',
        },
      },
    });
    return;
  }

  if (msg.method === 'turn/steer') {
    const expected = msg.params?.expectedTurnId;
    if (expected !== activeTurnId) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32600,
          message: 'expected active turn id ' + expected + ' but found ' + activeTurnId,
        },
      });
      return;
    }

    if (mode === 'race_no_active_turn') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32600,
          message: 'no active turn to steer',
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          threadId,
          turnId: activeTurnId,
          item: {
            id: 'msg-race-final',
            type: 'agentMessage',
            phase: 'final_answer',
            text: 'Turn finished just as steer arrived.',
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId, turn: { id: activeTurnId, status: 'completed' } },
      });
      return;
    }

    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { turnId: activeTurnId },
    });

    if (mode === 'pre_steer_only_no_post_msg') {
      send({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId, turn: { id: activeTurnId, status: 'completed' } },
      });
      return;
    }

    const finalText =
      mode === 'ignore_evidence'
        ? 'Everything looks fine, no specific functions to report.'
        : 'Based on steered PerfDigest evidence in cpu-trace, the primary hotspot is hot_kernel_reduce (48200 us). Verification passed.';

    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId,
        turnId: activeTurnId,
        item: {
          id: 'msg-post-final',
          type: 'agentMessage',
          phase: 'final_answer',
          text: finalText,
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId: activeTurnId,
        tokenUsage: {
          total: {
            inputTokens: 420,
            cachedInputTokens: 64,
            cacheWriteInputTokens: 0,
            outputTokens: 85,
            reasoningOutputTokens: 16,
          },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId, turn: { id: activeTurnId, status: 'completed' } },
    });
    return;
  }

  if (msg.method === 'turn/interrupt') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {},
    });
    return;
  }
});
`
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return binPath
}

func TestCodexVerifyEvidenceConsumption(t *testing.T) {
	compactPayload := `{
		"schema": "perfdigest.agent-evidence.v1",
		"status": "complete",
		"decision": {"selectedId": "cpu-trace", "confidence": 0.91, "reason": "selected", "provider": "cloudflare"},
		"selected": [{
			"id": "cpu-trace",
			"format": "chrome-trace",
			"sha256Prefix": "abcdef0123456789",
			"digest": {"units": [{"name": "hot_kernel_reduce", "duration_us": 48200}]}
		}],
		"verification": {"passed": true, "exitCode": 0, "elapsedMs": 5}
	}`

	if VerifyCodexEvidenceConsumption("", compactPayload) {
		t.Fatalf("expected empty responseText to return false")
	}
	if VerifyCodexEvidenceConsumption("hot_kernel_reduce", "") {
		t.Fatalf("expected empty evidencePayload to return false")
	}
	if !VerifyCodexEvidenceConsumption("The hotspot is hot_kernel_reduce with 48.2ms.", compactPayload) {
		t.Fatalf("expected response citing unit name hot_kernel_reduce to return true")
	}
	if !VerifyCodexEvidenceConsumption("Selected report cpu-trace shows regression.", compactPayload) {
		t.Fatalf("expected response citing report id cpu-trace to return true")
	}
	if !VerifyCodexEvidenceConsumption("Artifact hash prefix abcdef01 verified.", compactPayload) {
		t.Fatalf("expected response citing 8-char sha256Prefix to return true")
	}
	if VerifyCodexEvidenceConsumption("Everything looks fine, no specific functions to report.", compactPayload) {
		t.Fatalf("expected generic response ignoring evidence to return false")
	}

	// Abstained packet with no selected reports
	abstainedPayload := `{
		"schema": "perfdigest.agent-evidence.v1",
		"status": "needs_review",
		"decision": {"selectedId": null, "confidence": 0.42, "reason": "low_confidence", "provider": "cloudflare"},
		"selected": [],
		"verification": {"passed": true, "exitCode": 0, "elapsedMs": 4}
	}`
	if !VerifyCodexEvidenceConsumption("Routing abstained with needs_review status; verification passed.", abstainedPayload) {
		t.Fatalf("expected abstained response citing needs_review/passed to return true")
	}
	if VerifyCodexEvidenceConsumption("Nothing to see here.", abstainedPayload) {
		t.Fatalf("expected ungrounded response on abstained payload to return false")
	}
}

func TestCodexAdapterCapabilitiesAndNegotiation(t *testing.T) {
	inExecAdapter := CodexAdapterWithOptions(CodexAdapterOptions{
		Model:            "gpt-6-luna",
		Effort:           "low",
		InExecutionAsync: true,
	})
	caps := inExecAdapter.Capabilities()
	if !caps.NativeAsyncInput || caps.InExecutionAsyncInput != "supported" || caps.InterruptionAndSteering != "supported" {
		t.Fatalf("unexpected codex-app-server capabilities: %+v", caps)
	}
	if caps.Sandbox != "read-only" || caps.UsageReportingSemantics != "incremental_per_turn" {
		t.Fatalf("unexpected sandbox/usage semantics: %+v", caps)
	}

	plan, err := NegotiateEvidenceDeliveryMode("auto", &caps, false)
	if err != nil {
		t.Fatalf("NegotiateEvidenceDeliveryMode failed: %v", err)
	}
	if plan.EffectiveMode != "in_execution" || plan.PlannedEvidenceDelivery != "in_execution_async_input" || plan.FellBack {
		t.Fatalf("expected auto to negotiate in_execution_async_input, got %+v", plan)
	}

	sdkAdapter := CodexAdapter("gpt-6-luna", "low")
	sdkCaps := sdkAdapter.Capabilities()
	if sdkCaps.NativeAsyncInput {
		t.Fatalf("expected SDK-mode codexAdapter to have NativeAsyncInput=false")
	}
	if sdkCaps.InExecutionAsyncInput != "unsupported" || sdkCaps.InExecutionToolDelivery != "supported" || sdkCaps.UsageReportingSemantics != "incremental_per_turn" {
		t.Fatalf("expected SDK-mode codexAdapter to return full codex capability profile, got %+v", sdkCaps)
	}
	genAdapter, err := GenericCliAdapter(GenericCliAgentOptions{Command: "/bin/true", Sessions: true})
	if err != nil {
		t.Fatalf("GenericCliAdapter failed: %v", err)
	}
	genCaps := genAdapter.Capabilities()
	if genCaps.InExecutionAsyncInput != "unsupported" || genCaps.InExecutionToolDelivery != "unsupported" || genCaps.UsageReportingSemantics != "incremental_per_turn" {
		t.Fatalf("expected non-in-exec GenericCliAdapter to return full generic-cli profile, got %+v", genCaps)
	}
}

func TestCodexTurnInExecutionMidTurnSteerAndToolOutput(t *testing.T) {
	ws := t.TempDir()
	logPath := filepath.Join(ws, "rpc.jsonl")
	mockBin := writeMockCodexAppServer(t, ws, "normal", logPath)
	t.Setenv("PERFDIGEST_CODEX_PATH", mockBin)

	evidenceJSON := `{"schema":"perfdigest.agent-evidence.v1","status":"complete","decision":{"selectedId":"cpu-trace"},"selected":[{"id":"cpu-trace","digest":{"units":[{"name":"hot_kernel_reduce","duration_us":48200}]}}]}`

	// 1. Default turn_steer mechanism
	adapter := CodexAdapterWithOptions(CodexAdapterOptions{
		Model:            "gpt-6-luna",
		Effort:           "low",
		InExecutionAsync: true,
	})
	sess, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	inExecSess := sess.(InExecutionAgentSession)

	var mu sync.Mutex
	var events []string
	emit := func(ev, _ string) {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
	}

	res, err := inExecSess.TurnInExecution(
		context.Background(),
		"Investigate bottleneck",
		func() (string, error) {
			time.Sleep(25 * time.Millisecond)
			return evidenceJSON, nil
		},
		emit,
	)
	if err != nil {
		t.Fatalf("TurnInExecution failed: %v", err)
	}
	if !res.EvidenceDeliveredInExecution || !res.EvidenceConsumedInExecution || res.EarlyAgentCompletion || res.DeliveryCount != 1 {
		t.Fatalf("unexpected TurnInExecution result: %+v", res)
	}
	if res.Turn.ThreadID == nil || *res.Turn.ThreadID != "thread-live-1" {
		t.Fatalf("expected thread-live-1, got %v", res.Turn.ThreadID)
	}
	if res.Turn.Usage["input_tokens"] != 420 || res.Turn.Usage["output_tokens"] != 85 {
		t.Fatalf("unexpected token usage: %+v", res.Turn.Usage)
	}

	mu.Lock()
	evCopy := append([]string{}, events...)
	mu.Unlock()
	for _, reqEv := range []string{
		"codex.in_execution.started",
		"codex.analysis.turn_started",
		"evidence.delivered",
		"evidence.accepted_by_runtime",
		"evidence.model_visible",
		"evidence.consumed",
		"codex.in_execution.completed",
	} {
		if !slices.Contains(evCopy, reqEv) {
			t.Fatalf("missing expected event %q in %v", reqEv, evCopy)
		}
	}

	// 2. tool_output mechanism
	toolAdapter := CodexAdapterWithOptions(CodexAdapterOptions{
		Model:             "gpt-6-luna",
		Effort:            "low",
		InExecutionAsync:  true,
		SteeringMechanism: "tool_output",
	})
	toolSess, err := toolAdapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatalf("Start (tool_output) failed: %v", err)
	}
	toolRes, err := toolSess.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Investigate bottleneck with toolOutput",
		func() (string, error) {
			time.Sleep(20 * time.Millisecond)
			return evidenceJSON, nil
		},
		nil,
	)
	if err != nil {
		t.Fatalf("TurnInExecution (tool_output) failed: %v", err)
	}
	if !toolRes.EvidenceDeliveredInExecution || !toolRes.EvidenceConsumedInExecution || toolRes.DeliveryCount != 1 {
		t.Fatalf("unexpected tool_output result: %+v", toolRes)
	}
}

func TestCodexTurnInExecutionIgnoredEvidenceAndPreSteerIsolation(t *testing.T) {
	ws := t.TempDir()
	mockIgnore := writeMockCodexAppServer(t, ws, "ignore_evidence", "")
	t.Setenv("PERFDIGEST_CODEX_PATH", mockIgnore)

	evidenceJSON := `{"schema":"perfdigest.agent-evidence.v1","status":"complete","decision":{"selectedId":"cpu-trace"},"selected":[{"id":"cpu-trace","digest":{"units":[{"name":"hot_kernel_reduce","duration_us":48200}]}}]}`

	adapter := CodexAdapterWithOptions(CodexAdapterOptions{
		InExecutionAsync: true,
	})
	sess, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var events []string
	emit := func(ev, _ string) {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
	}

	res, err := sess.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Investigate bottleneck",
		func() (string, error) {
			time.Sleep(20 * time.Millisecond)
			return evidenceJSON, nil
		},
		emit,
	)
	if err != nil {
		t.Fatalf("TurnInExecution failed: %v", err)
	}
	if !res.EvidenceDeliveredInExecution {
		t.Fatalf("expected EvidenceDeliveredInExecution == true")
	}
	if res.EvidenceConsumedInExecution {
		t.Fatalf("expected EvidenceConsumedInExecution == false when model ignores evidence")
	}

	mu.Lock()
	evCopy := append([]string{}, events...)
	mu.Unlock()
	if !slices.Contains(evCopy, "evidence.accepted_by_runtime") || !slices.Contains(evCopy, "evidence.model_visible") {
		t.Fatalf("expected accepted_by_runtime and model_visible events, got %v", evCopy)
	}
	if slices.Contains(evCopy, "evidence.consumed") {
		t.Fatalf("expected NO evidence.consumed event when evidence is ignored, got %v", evCopy)
	}

	// Sub-check: pre-steer commentary mentioning hot_kernel_reduce without any post-steer message must NOT emit model_visible or consumed
	mockPreOnly := writeMockCodexAppServer(t, ws, "pre_steer_only_no_post_msg", "")
	t.Setenv("PERFDIGEST_CODEX_PATH", mockPreOnly)
	sessPre, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	var preEvents []string
	resPre, err := sessPre.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Investigate",
		func() (string, error) {
			time.Sleep(20 * time.Millisecond)
			return evidenceJSON, nil
		},
		func(ev, _ string) {
			mu.Lock()
			preEvents = append(preEvents, ev)
			mu.Unlock()
		},
	)
	if err != nil {
		t.Fatalf("TurnInExecution pre_steer_only failed: %v", err)
	}
	if resPre.EvidenceConsumedInExecution {
		t.Fatalf("pre-steer commentary must not count as post-steer evidence consumption")
	}
	mu.Lock()
	preCopy := append([]string{}, preEvents...)
	mu.Unlock()
	if slices.Contains(preCopy, "evidence.model_visible") || slices.Contains(preCopy, "evidence.consumed") {
		t.Fatalf("expected no model_visible or consumed when no post-steer agentMessage emitted, got %v", preCopy)
	}
}

func TestCodexTurnInExecutionMismatchedExpectedTurnID(t *testing.T) {
	ws := t.TempDir()
	mockBin := writeMockCodexAppServer(t, ws, "normal", "")
	t.Setenv("PERFDIGEST_CODEX_PATH", mockBin)

	adapter := CodexAdapterWithOptions(CodexAdapterOptions{
		InExecutionAsync:       true,
		OverrideExpectedTurnID: "00000000-0000-0000-0000-000000000000",
	})
	sess, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}

	_, err = sess.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Investigate",
		func() (string, error) {
			time.Sleep(15 * time.Millisecond)
			return `{"schema":"perfdigest.agent-evidence.v1","status":"complete"}`, nil
		},
		nil,
	)
	if err == nil {
		t.Fatalf("expected protocol error for mismatched expectedTurnId")
	}
	ae, ok := err.(*AgentError)
	if !ok {
		t.Fatalf("expected *AgentError, got %T (%v)", err, err)
	}
	if ae.Kind != AgentErrProtocol || ae.Phase != "in_execution" {
		t.Fatalf("expected protocol/in_execution error, got kind=%s phase=%s msg=%s", ae.Kind, ae.Phase, ae.Msg)
	}
}

func TestCodexTurnInExecutionEarlyCompletionAndRace(t *testing.T) {
	ws := t.TempDir()

	// Case A: Agent completes before supplyEvidence resolves
	mockEarly := writeMockCodexAppServer(t, ws, "early_complete", "")
	t.Setenv("PERFDIGEST_CODEX_PATH", mockEarly)

	adapter := CodexAdapterWithOptions(CodexAdapterOptions{InExecutionAsync: true})
	sess, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var events []string
	res, err := sess.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Quick turn",
		func() (string, error) {
			time.Sleep(120 * time.Millisecond)
			return `{"schema":"perfdigest.agent-evidence.v1","status":"complete"}`, nil
		},
		func(ev, _ string) {
			mu.Lock()
			events = append(events, ev)
			mu.Unlock()
		},
	)
	if err != nil {
		t.Fatalf("early completion failed: %v", err)
	}
	if !res.EarlyAgentCompletion || res.EvidenceDeliveredInExecution || res.EvidenceConsumedInExecution || res.DeliveryCount != 0 {
		t.Fatalf("unexpected early completion flags: %+v", res)
	}
	mu.Lock()
	evCopy := append([]string{}, events...)
	mu.Unlock()
	if !slices.Contains(evCopy, "codex.in_execution.completed_before_evidence") {
		t.Fatalf("expected codex.in_execution.completed_before_evidence in %v", evCopy)
	}
	if slices.Contains(evCopy, "evidence.delivered") {
		t.Fatalf("unexpected evidence.delivered on early completion: %v", evCopy)
	}

	// Case B: Simultaneous completion / delivery race ("no active turn to steer")
	mockRace := writeMockCodexAppServer(t, ws, "race_no_active_turn", "")
	t.Setenv("PERFDIGEST_CODEX_PATH", mockRace)
	sessRace, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	var raceEvents []string
	resRace, err := sessRace.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Race turn",
		func() (string, error) {
			time.Sleep(20 * time.Millisecond)
			return `{"schema":"perfdigest.agent-evidence.v1","status":"complete"}`, nil
		},
		func(ev, _ string) {
			mu.Lock()
			raceEvents = append(raceEvents, ev)
			mu.Unlock()
		},
	)
	if err != nil {
		t.Fatalf("race completion failed: %v", err)
	}
	if !resRace.EarlyAgentCompletion || resRace.EvidenceDeliveredInExecution || resRace.DeliveryCount != 0 {
		t.Fatalf("unexpected race flags: %+v", resRace)
	}
	mu.Lock()
	raceCopy := append([]string{}, raceEvents...)
	mu.Unlock()
	if slices.Contains(raceCopy, "evidence.delivered") {
		t.Fatalf("expected NO dangling evidence.delivered on race: %v", raceCopy)
	}
	if !slices.Contains(raceCopy, "codex.in_execution.completed_before_evidence") {
		t.Fatalf("expected codex.in_execution.completed_before_evidence on race: %v", raceCopy)
	}
}

func TestCodexTurnInExecutionBlockedStdinPipeTimeout(t *testing.T) {
	ws := t.TempDir()
	mockHang := writeMockCodexAppServer(t, ws, "hang_blocked_pipe", "")
	t.Setenv("PERFDIGEST_CODEX_PATH", mockHang)

	adapter := CodexAdapterWithOptions(CodexAdapterOptions{
		InExecutionAsync: true,
		TimeoutMs:        120,
	})
	sess, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}

	largePayload := strings.Repeat("X", 300*1024) // > 256 KiB exceeds 64 KiB OS pipe buffer
	start := time.Now()
	_, err = sess.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Hung turn",
		func() (string, error) {
			return largePayload, nil
		},
		nil,
	)
	elapsed := time.Since(start)
	if elapsed > 2500*time.Millisecond {
		t.Fatalf("TurnInExecution took too long (%v > 2.5s), indicating blocked pipe deadlock", elapsed)
	}
	if err == nil {
		t.Fatalf("expected timed_out error")
	}
	ae, ok := err.(*AgentError)
	if !ok {
		t.Fatalf("expected *AgentError, got %T (%v)", err, err)
	}
	if ae.Kind != AgentErrTimedOut || ae.Phase != "in_execution" {
		t.Fatalf("expected timed_out/in_execution, got kind=%s phase=%s", ae.Kind, ae.Phase)
	}
}

func TestVerifyCodexEvidenceConsumptionWordBoundariesAndEnvelopeGuard(t *testing.T) {
	shortTokenPayload := `{"schema":"perfdigest.agent-evidence.v1","status":"complete","selected":[{"id":"ion","digest":{"units":[{"name":"ion","duration_us":1200}]}}]}`
	if VerifyCodexEvidenceConsumption("The execution and solution completed without issues.", shortTokenPayload) {
		t.Fatalf("expected short token 'ion' NOT to false-positive inside 'execution' or 'solution'")
	}
	if VerifyCodexEvidenceConsumption("The execution and solution completed without issues.", `{"selected":[{"id":"io","digest":{"units":[{"name":"io","duration_us":1200}]}}]}`) {
		t.Fatalf("expected short token 'io' NOT to false-positive inside 'execution' or 'solution'")
	}
	if !VerifyCodexEvidenceConsumption("The bottleneck is in ion (1200us).", shortTokenPayload) {
		t.Fatalf("expected short token 'ion' to match when bounded by word boundaries")
	}
	if VerifyCodexEvidenceConsumption("Verification passed for the run.", "{}") {
		t.Fatalf("expected empty JSON {} NOT to false-positive on generic words 'verification' or 'passed'")
	}
	if VerifyCodexEvidenceConsumption("The check passed after verification.", `{"unrelated":true}`) {
		t.Fatalf("expected non-envelope JSON NOT to false-positive on generic words 'passed' or 'verification'")
	}
}

func TestInvestigateRejectsInvalidCodexSteeringMechanism(t *testing.T) {
	ws := t.TempDir()
	if err := os.WriteFile(filepath.Join(ws, "trace.json"), []byte(`{"traceEvents":[{"name":"hot_kernel_reduce","dur":48200}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{
		Version: 1,
		Issue:   "Reject invalid codexSteeringMechanism",
		Reports: []ReportSpec{
			{ID: "cpu-trace", Path: "trace.json", Format: "chrome-trace", Description: "CPU trace"},
		},
		Verification: CommandSpec{Command: "true", Args: []string{}},
	}
	res, err := Investigate(context.Background(), RunOptions{
		Workspace:              ws,
		Manifest:               manifest,
		Routing:                "local",
		Agent:                  "codex",
		AgentDelivery:          "in_execution",
		CodexSteeringMechanism: "invalid_mechanism",
	})
	if err != nil {
		t.Fatalf("Investigate returned unexpected error: %v", err)
	}
	if res.Status != "failed" {
		t.Fatalf("expected status=failed, got %s", res.Status)
	}
	if res.AgentError == nil || res.AgentError.Kind != AgentErrUnsupported || res.AgentError.Phase != "start" {
		t.Fatalf("expected AgentError kind=unsupported phase=start, got %+v", res.AgentError)
	}
	if !strings.Contains(res.AgentError.Message, "codexSteeringMechanism must be turn_steer or tool_output") {
		t.Fatalf("unexpected AgentError message: %s", res.AgentError.Message)
	}
}

func TestCodexRemediationRegressions(t *testing.T) {
	// 1. VerifyCodexEvidenceConsumption: verbose extractions + secondaryReportId + contradictory verification guard + UTF-8 rune fallback
	verbosePayload := `{"evidence":{"decision":{"selectedId":null},"evidence":[],"extractions":[{"unit":"matmul_tiled_fp16","secondaryReportId":"baseline-gpu-rep"}]},"verification":{"exitCode":0,"timedOut":false,"aborted":false},"pipelineStatus":"complete"}`
	if !VerifyCodexEvidenceConsumption("Compared against baseline-gpu-rep.", verbosePayload) {
		t.Fatalf("expected secondaryReportId in verbose evidence.extractions to match")
	}
	if !VerifyCodexEvidenceConsumption("Bottleneck is matmul_tiled_fp16.", verbosePayload) {
		t.Fatalf("expected unit in verbose evidence.extractions to match")
	}
	failedVerAbstain := `{"schema":"perfdigest.agent-evidence.v1","status":"failed","decision":{"selectedId":null},"selected":[],"verification":{"passed":false,"exitCode":2}}`
	if VerifyCodexEvidenceConsumption("Everything looks fine and verification passed.", failedVerAbstain) {
		t.Fatalf("contradictory 'verification passed' must not match when verification.passed is false")
	}
	if !VerifyCodexEvidenceConsumption("Verification failed with exit code 2.", failedVerAbstain) {
		t.Fatalf("matching 'verification failed' should return true when verification.passed is false")
	}
	passedVerAbstain := `{"schema":"perfdigest.agent-evidence.v1","status":"needs_review","decision":{"selectedId":null},"selected":[],"verification":{"passed":true,"exitCode":0}}`
	if VerifyCodexEvidenceConsumption("Verification failed unexpectedly.", passedVerAbstain) {
		t.Fatalf("contradictory 'verification failed' must not match when verification.passed is true")
	}
	utf8NonJson := "μs_Δ_α_β_γ_δ_ε_ζ_η_θ_ι_κ_λ_μ_ν_ξ_ο_π_ρ_σ_τ_υ_φ_χ_ψ_ω_extra_tail"
	if !VerifyCodexEvidenceConsumption("Observed prefix "+string([]rune(utf8NonJson)[:32])+" in output.", utf8NonJson) {
		t.Fatalf("expected multi-byte UTF-8 non-JSON fallback rune slicing to match cleanly")
	}

	// 2. Go two_turn respects CompactEvidence=true (parity with TS src/run.ts:357)
	ws := t.TempDir()
	if err := os.WriteFile(filepath.Join(ws, "trace.json"), []byte(`{"traceEvents":[{"name":"hot_kernel_reduce","dur":48200}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	mcpScript := filepath.Join(ws, "mcp.mjs")
	if err := os.WriteFile(mcpScript, []byte(`#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'm', version: '1' } } }) + '\n');
  } else if (req.method === 'tools/call') {
    const d = { format: 'chrome-trace', raw_ref: req.params.arguments.report_ref, total_units: 1, returned: 1, units: [{ index: 0, name: 'hot_kernel_reduce', duration_us: 48200 }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(d) }], structuredContent: d } }) + '\n');
  }
});
`), 0o755); err != nil {
		t.Fatal(err)
	}
	reviewPromptLog := filepath.Join(ws, "review-prompt.txt")
	agentScript := filepath.Join(ws, "two-turn-agent.mjs")
	if err := os.WriteFile(agentScript, []byte(`#!/usr/bin/env node
import fs from 'node:fs';
const req = JSON.parse(fs.readFileSync(0, 'utf8').trim());
if (req.phase === 'review') fs.writeFileSync(`+"`"+reviewPromptLog+"`"+`, req.prompt, 'utf8');
console.log(JSON.stringify({ type: 'started' }));
console.log(JSON.stringify({ type: 'result', sessionId: 'sess-compact-1', text: 'ok:' + req.phase, usage: { input_tokens: 10, output_tokens: 5 } }));
`), 0o755); err != nil {
		t.Fatal(err)
	}
	nodeBin, err := Executable("node", nil)
	if err != nil {
		t.Fatal(err)
	}
	genAdapter, err := GenericCliAdapter(GenericCliAgentOptions{Command: nodeBin, Args: []string{agentScript}, Sessions: true})
	if err != nil {
		t.Fatal(err)
	}
	compactTrue := true
	twoTurnRes, err := Investigate(context.Background(), RunOptions{
		Workspace:         ws,
		Manifest:          Manifest{Version: 1, Issue: "Compact two_turn parity", Reports: []ReportSpec{{ID: "cpu-trace", Path: "trace.json", Format: "chrome-trace", Description: "trace"}}, Verification: CommandSpec{Command: "/bin/true"}},
		Routing:           "offline",
		Agent:             "generic",
		AgentDelivery:     "two_turn",
		AgentAdapter:      genAdapter,
		CompactEvidence:   &compactTrue,
		McpSessionOptions: &SessionOptions{Command: nodeBin, Args: []string{mcpScript}},
	})
	if err != nil {
		t.Fatalf("Investigate two_turn compact failed: %v", err)
	}
	if twoTurnRes.Status != "complete" {
		t.Fatalf("expected complete, got %s (err=%v)", twoTurnRes.Status, twoTurnRes.Error)
	}
	reviewPromptBytes, err := os.ReadFile(reviewPromptLog)
	if err != nil {
		t.Fatalf("failed reading review prompt log: %v", err)
	}
	if !strings.Contains(string(reviewPromptBytes), `"schema":"perfdigest.agent-evidence.v1"`) {
		t.Fatalf("expected two_turn with CompactEvidence=true to deliver compact schema, got: %s", string(reviewPromptBytes))
	}

	// 3. Early crash / malformed JSON during initialize fails fast (<2s, no 120s deadlock!)
	crashKindFile := filepath.Join(ws, "crash-kind.txt")
	crashMock := filepath.Join(ws, "mock-codex-crash.mjs")
	if err := os.WriteFile(crashMock, []byte(`#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'mcp') { console.log('[]'); process.exit(0); }
const kind = fs.readFileSync(`+"`"+crashKindFile+"`"+`, 'utf8').trim();
if (kind === 'malformed') {
  process.stdout.write('NOT-VALID-JSON\n');
  setTimeout(() => {}, 5000);
} else {
  process.exit(1);
}
`), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PERFDIGEST_CODEX_PATH", crashMock)

	for _, kind := range []string{"exit", "malformed"} {
		if err := os.WriteFile(crashKindFile, []byte(kind), 0o600); err != nil {
			t.Fatal(err)
		}
		adapter := CodexAdapterWithOptions(CodexAdapterOptions{InExecutionAsync: true, TimeoutMs: 10_000})
		sess, err := adapter.Start(context.Background(), ws)
		if err != nil {
			t.Fatalf("Start (%s) failed: %v", kind, err)
		}
		t0 := time.Now()
		_, err = sess.(InExecutionAgentSession).TurnInExecution(
			context.Background(),
			"Crash test",
			func() (string, error) { return `{"status":"complete"}`, nil },
			nil,
		)
		elapsed := time.Since(t0)
		if elapsed > 3*time.Second {
			t.Fatalf("crash kind=%s stalled (%v > 3s) instead of failing fast", kind, elapsed)
		}
		if err == nil {
			t.Fatalf("expected error for crash kind=%s", kind)
		}
		if ae, ok := err.(*AgentError); !ok || ae.Kind == AgentErrTimedOut {
			t.Fatalf("expected non-timeout AgentError for crash kind=%s, got %v", kind, err)
		}
	}

	// 4. Observed ToolCallsCount + close_on_steer early completion + concurrent s.ID() race safety
	edgeModeFile := filepath.Join(ws, "go-edge-mode.txt")
	edgeMock := filepath.Join(ws, "mock-codex-edge.mjs")
	if err := os.WriteFile(edgeMock, []byte(`#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'mcp') { console.log('[]'); process.exit(0); }
const mode = fs.readFileSync(`+"`"+edgeModeFile+"`"+`, 'utf8').trim();
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }); return; }
  if (msg.method === 'thread/start') { send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr-go-edge' } } }); return; }
  if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-go-edge', status: 'inProgress' } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr-go-edge', turn: { id: 'turn-go-edge', status: 'inProgress' } } });
    if (mode === 'close_on_steer') {
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thr-go-edge', turnId: 'turn-go-edge', item: { id: 'm1', type: 'agentMessage', phase: 'final_answer', text: 'Done before steer reply.' } } });
        send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thr-go-edge', turn: { id: 'turn-go-edge', status: 'completed' } } });
      }, 30);
      return;
    }
    send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thr-go-edge', turnId: 'turn-go-edge', item: { id: 'tc1', type: 'commandExecution' } } });
    send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thr-go-edge', turnId: 'turn-go-edge', item: { id: 'tc2', type: 'mcpToolCall' } } });
    return;
  }
  if (msg.method === 'turn/steer') {
    if (mode === 'close_on_steer') {
      setTimeout(() => process.exit(0), 50);
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'turn-go-edge' } });
    send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thr-go-edge', turnId: 'turn-go-edge', item: { id: 'm2', type: 'agentMessage', phase: 'final_answer', text: 'Steered cpu-trace hot_kernel_reduce confirmed.' } } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thr-go-edge', turn: { id: 'turn-go-edge', status: 'completed' } } });
  }
});
`), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PERFDIGEST_CODEX_PATH", edgeMock)
	if err := os.WriteFile(edgeModeFile, []byte("tools"), 0o600); err != nil {
		t.Fatal(err)
	}

	edgeAdapter := CodexAdapterWithOptions(CodexAdapterOptions{InExecutionAsync: true})
	edgeSess, err := edgeAdapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	stopPoll := make(chan struct{})
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		for {
			select {
			case <-stopPoll:
				return
			default:
				_ = edgeSess.ID()
				time.Sleep(1 * time.Millisecond)
			}
		}
	}()
	toolsRes, err := edgeSess.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Count tool calls",
		func() (string, error) {
			time.Sleep(15 * time.Millisecond)
			return `{"schema":"perfdigest.agent-evidence.v1","status":"complete","selected":[{"id":"cpu-trace","digest":{"units":[{"name":"hot_kernel_reduce"}]}}]}`, nil
		},
		nil,
	)
	close(stopPoll)
	<-pollDone
	if err != nil {
		t.Fatalf("edge tools TurnInExecution failed: %v", err)
	}
	if toolsRes.Turn.ToolCallsCount == nil || *toolsRes.Turn.ToolCallsCount != 2 {
		t.Fatalf("expected ToolCallsCount == 2, got %v", toolsRes.Turn.ToolCallsCount)
	}

	if err := os.WriteFile(edgeModeFile, []byte("close_on_steer"), 0o600); err != nil {
		t.Fatal(err)
	}
	edgeSess2, err := edgeAdapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	tClose := time.Now()
	closeRes, err := edgeSess2.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Close during steer",
		func() (string, error) {
			time.Sleep(10 * time.Millisecond)
			return `{"schema":"perfdigest.agent-evidence.v1","status":"complete"}`, nil
		},
		nil,
	)
	if err != nil {
		t.Fatalf("close_on_steer failed: %v", err)
	}
	if time.Since(tClose) > 3*time.Second {
		t.Fatalf("close_on_steer took too long (%v)", time.Since(tClose))
	}
	if !closeRes.EarlyAgentCompletion || closeRes.EvidenceDeliveredInExecution {
		t.Fatalf("expected EarlyAgentCompletion=true and EvidenceDeliveredInExecution=false, got %+v", closeRes)
	}
}

func TestCodexTurnInExecutionErrorNotificationsAndWebSearchDisabled(t *testing.T) {
	ws := t.TempDir()
	modeFile := filepath.Join(ws, "err-notif-mode.txt")
	argsLog := filepath.Join(ws, "spawn-args.txt")
	mockBin := filepath.Join(ws, "mock-codex-errnotif.mjs")
	if err := os.WriteFile(mockBin, []byte(`#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'mcp') { console.log('[]'); process.exit(0); }
fs.writeFileSync(`+"`"+argsLog+"`"+`, JSON.stringify(args), 'utf8');
const mode = fs.readFileSync(`+"`"+modeFile+"`"+`, 'utf8').trim();
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }); return; }
  if (msg.method === 'thread/start') { send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr-errnotif' } } }); return; }
  if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-errnotif', status: 'inProgress' } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr-errnotif', turn: { id: 'turn-errnotif', status: 'inProgress' } } });
    if (mode === 'retry_and_other_turn') {
      send({
        jsonrpc: '2.0',
        method: 'error',
        params: {
          threadId: 'thr-errnotif',
          turnId: 'turn-errnotif',
          willRetry: true,
          error: { message: 'transient stream reconnect' }
        }
      });
      send({
        jsonrpc: '2.0',
        method: 'error',
        params: {
          threadId: 'thr-errnotif',
          turnId: 'turn-other',
          willRetry: false,
          error: { message: 'other turn error should be ignored' }
        }
      });
    } else if (mode === 'fatal') {
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          method: 'error',
          params: {
            threadId: 'thr-errnotif',
            turnId: 'turn-errnotif',
            willRetry: false,
            error: { message: 'stream disconnected permanently' }
          }
        });
      }, 15);
    }
    return;
  }
  if (msg.method === 'turn/steer') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'turn-errnotif' } });
    if (mode === 'retry_and_other_turn') {
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          threadId: 'thr-errnotif',
          turnId: 'turn-errnotif',
          item: { id: 'm1', type: 'agentMessage', phase: 'final_answer', text: 'Recovered: cpu-trace hot_kernel_reduce confirmed.' }
        }
      });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thr-errnotif', turn: { id: 'turn-errnotif', status: 'completed' } } });
    }
  }
});
`), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PERFDIGEST_CODEX_PATH", mockBin)
	adapter := CodexAdapterWithOptions(CodexAdapterOptions{InExecutionAsync: true})

	// 1. willRetry: true + mismatched turnId must not fail turn; verify web_search="disabled" flag passed
	if err := os.WriteFile(modeFile, []byte("retry_and_other_turn"), 0o600); err != nil {
		t.Fatal(err)
	}
	sess1, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	res1, err := sess1.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Retryable error test",
		func() (string, error) {
			time.Sleep(15 * time.Millisecond)
			return `{"schema":"perfdigest.agent-evidence.v1","status":"complete","selected":[{"id":"cpu-trace","digest":{"units":[{"name":"hot_kernel_reduce"}]}}]}`, nil
		},
		nil,
	)
	if err != nil {
		t.Fatalf("expected willRetry:true and mismatched turnId errors to be ignored, got err=%v", err)
	}
	if !res1.EvidenceConsumedInExecution {
		t.Fatalf("expected EvidenceConsumedInExecution=true after recovery")
	}
	spawnArgsBytes, err := os.ReadFile(argsLog)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(spawnArgsBytes), `web_search=\"disabled\"`) {
		t.Fatalf("expected web_search=\"disabled\" in app-server args, got %s", string(spawnArgsBytes))
	}

	// 2. willRetry: false on active turn fails with params.error.message (not generic fallback)
	if err := os.WriteFile(modeFile, []byte("fatal"), 0o600); err != nil {
		t.Fatal(err)
	}
	sess2, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	_, err = sess2.(InExecutionAgentSession).TurnInExecution(
		context.Background(),
		"Fatal error notification test",
		func() (string, error) {
			time.Sleep(100 * time.Millisecond)
			return `{"status":"complete"}`, nil
		},
		nil,
	)
	if err == nil {
		t.Fatalf("expected fatal ErrorNotification to fail the turn")
	}
	ae, ok := err.(*AgentError)
	if !ok || ae.Kind != AgentErrFailed {
		t.Fatalf("expected AgentError kind=failed, got %T (%v)", err, err)
	}
	if !strings.Contains(ae.Msg, "stream disconnected permanently") {
		t.Fatalf("expected params.error.message to be preserved, got %q", ae.Msg)
	}
}
