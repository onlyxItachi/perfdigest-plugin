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

func TestInExecutionLargePayloadTimeoutNoDeadlock(t *testing.T) {
	ws := t.TempDir()
	scriptPath := filepath.Join(ws, "sleep_ignore_stdin.sh")
	script := "#!/bin/sh\nsleep 10\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	adapter, err := GenericCliAdapter(GenericCliAgentOptions{
		Command:          scriptPath,
		InExecutionAsync: true,
		TimeoutMs:        300,
	})
	if err != nil {
		t.Fatalf("GenericCliAdapter failed: %v", err)
	}
	sess, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	inExecSess, ok := sess.(InExecutionAgentSession)
	if !ok {
		t.Fatalf("expected InExecutionAgentSession")
	}

	largePayload := strings.Repeat("E", 300*1024) // > 256 KiB to exceed 64 KiB OS pipe buffer
	start := time.Now()
	_, err = inExecSess.TurnInExecution(
		context.Background(),
		"Investigate",
		func() (string, error) {
			return largePayload, nil
		},
		nil,
	)
	elapsed := time.Since(start)
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("TurnInExecution took too long (%v > 1.5s), indicating pipe-buffer deadlock", elapsed)
	}
	ae, ok := err.(*AgentError)
	if !ok {
		t.Fatalf("expected *AgentError, got %T (%v)", err, err)
	}
	if ae.Kind != AgentErrTimedOut {
		t.Fatalf("expected Kind == AgentErrTimedOut, got %s", ae.Kind)
	}
}

func TestInExecutionPrematureEvidenceAckIgnored(t *testing.T) {
	ws := t.TempDir()
	scriptPath := filepath.Join(ws, "premature_ack_agent.sh")
	// Emits started and premature evidence_ack BEFORE reading the evidence line, then reads evidence and emits result without evidenceConsumed
	script := `#!/bin/sh
read -r initial_line
printf '{"protocol":"perfdigest-agent/v1","type":"started"}\n'
printf '{"protocol":"perfdigest-agent/v1","type":"evidence_ack"}\n'
read -r evidence_line
printf '{"protocol":"perfdigest-agent/v1","type":"result","sessionId":"premature-1","text":"Done without consuming evidence.","usage":{"input_tokens":100,"output_tokens":20}}\n'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	adapter, err := GenericCliAdapter(GenericCliAgentOptions{
		Command:          scriptPath,
		InExecutionAsync: true,
		TimeoutMs:        5000,
	})
	if err != nil {
		t.Fatal(err)
	}
	sess, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
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
		"Investigate",
		func() (string, error) {
			time.Sleep(80 * time.Millisecond)
			return `{"schema":"perfdigest.agent-evidence.v1","status":"complete"}`, nil
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
		t.Fatalf("expected EvidenceConsumedInExecution == false when evidenceConsumed omitted and only premature ack emitted")
	}

	mu.Lock()
	evCopy := append([]string{}, events...)
	mu.Unlock()

	if slices.Contains(evCopy, "evidence.accepted_by_runtime") {
		t.Fatalf("premature evidence_ack before evidence.delivered must be ignored; events=%v", evCopy)
	}
	if slices.Contains(evCopy, "evidence.model_visible") || slices.Contains(evCopy, "evidence.consumed") {
		t.Fatalf("unexpected model_visible/consumed events: %v", evCopy)
	}
}

func TestInExecutionAckWithoutConsumedFlag(t *testing.T) {
	ws := t.TempDir()
	scriptPath := filepath.Join(ws, "ack_after_delivery_agent.sh")
	// Emits evidence_ack AFTER reading the evidence frame, then emits result with evidenceConsumed omitted
	script := `#!/bin/sh
read -r initial_line
printf '{"protocol":"perfdigest-agent/v1","type":"started"}\n'
read -r evidence_line
printf '{"protocol":"perfdigest-agent/v1","type":"evidence_ack"}\n'
printf '{"protocol":"perfdigest-agent/v1","type":"result","sessionId":"ack-only-1","text":"Acked transport but omitted evidenceConsumed.","usage":{"input_tokens":120,"output_tokens":25}}\n'
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	adapter, err := GenericCliAdapter(GenericCliAgentOptions{
		Command:          scriptPath,
		InExecutionAsync: true,
		TimeoutMs:        5000,
	})
	if err != nil {
		t.Fatal(err)
	}
	sess, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
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
		"Investigate",
		func() (string, error) {
			time.Sleep(40 * time.Millisecond)
			return `{"schema":"perfdigest.agent-evidence.v1","status":"complete"}`, nil
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
		t.Fatalf("expected EvidenceConsumedInExecution == false when evidenceConsumed omitted")
	}

	mu.Lock()
	evCopy := append([]string{}, events...)
	mu.Unlock()

	if !slices.Contains(evCopy, "evidence.accepted_by_runtime") {
		t.Fatalf("expected evidence.accepted_by_runtime after post-delivery evidence_ack; events=%v", evCopy)
	}
	if slices.Contains(evCopy, "evidence.model_visible") || slices.Contains(evCopy, "evidence.consumed") {
		t.Fatalf("expected no model_visible/consumed when evidenceConsumed is omitted; events=%v", evCopy)
	}
}

func TestInExecutionPreservesDecisionsErrorUnwrapped(t *testing.T) {
	ws := t.TempDir()
	scriptPath := filepath.Join(ws, "wait_agent.sh")
	script := "#!/bin/sh\nsleep 5\n"
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	adapter, err := GenericCliAdapter(GenericCliAgentOptions{
		Command:          scriptPath,
		InExecutionAsync: true,
		TimeoutMs:        5000,
	})
	if err != nil {
		t.Fatal(err)
	}
	sess, err := adapter.Start(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	inExecSess := sess.(InExecutionAgentSession)

	_, err = inExecSess.TurnInExecution(
		context.Background(),
		"Investigate",
		func() (string, error) {
			time.Sleep(20 * time.Millisecond)
			return "", NewDecisionsError(ErrSchema, nil)
		},
		nil,
	)
	if err == nil {
		t.Fatalf("expected DecisionsError, got nil")
	}
	de, ok := err.(*DecisionsError)
	if !ok {
		t.Fatalf("expected unwrapped *DecisionsError, got %T (%v)", err, err)
	}
	if de.Kind != ErrSchema {
		t.Fatalf("expected Kind == ErrSchema, got %s", de.Kind)
	}
}
