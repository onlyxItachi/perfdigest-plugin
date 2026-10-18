package perfdigest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChildEnvironmentAndRedact(t *testing.T) {
	env := map[string]string{
		"PATH":                            "/usr/bin:/bin",
		"HOME":                            "/home/tester",
		"LC_ALL":                          "C.UTF-8",
		"PERFDIGEST_DECISIONS_API_KEY":    "sk-secret1234567890abcdef",
		"PERFDIGEST_CLOUDFLARE_API_TOKEN": "cf-secret-token-value",
		"UNLISTED_VAR":                    "ignored",
	}
	filtered := ChildEnvironment(env)
	if filtered["PATH"] != "/usr/bin:/bin" {
		t.Fatalf("expected PATH preserved, got %q", filtered["PATH"])
	}
	if filtered["LC_ALL"] != "C.UTF-8" {
		t.Fatalf("expected LC_ALL preserved, got %q", filtered["LC_ALL"])
	}
	if _, exists := filtered["PERFDIGEST_DECISIONS_API_KEY"]; exists {
		t.Fatalf("expected secret key stripped from child environment")
	}
	if _, exists := filtered["UNLISTED_VAR"]; exists {
		t.Fatalf("expected unlisted key stripped from child environment")
	}

	t.Setenv("MY_SECRET_TOKEN_TEST", "supersecretvalue999")
	redacted := Redact("Error with sk-1234567890abcdef1234 and Bearer mytoken12345 and supersecretvalue999")
	if strings.Contains(redacted, "sk-1234567890abcdef1234") ||
		strings.Contains(redacted, "mytoken12345") ||
		strings.Contains(redacted, "supersecretvalue999") {
		t.Fatalf("expected all secrets redacted, got %q", redacted)
	}
}

func TestManifestValidationAndReportFileContainment(t *testing.T) {
	ws := t.TempDir()
	outside := t.TempDir()

	// Valid >256 KB report to exercise streaming 64 KB SHA-256
	largeContent := bytes.Repeat([]byte(`{"ph":"X","name":"kernel","dur":10},`), 8000)
	expectedSum := sha256.Sum256(largeContent)
	expectedHex := hex.EncodeToString(expectedSum[:])

	reportPath := filepath.Join(ws, "trace.json")
	if err := os.WriteFile(reportPath, largeContent, 0o600); err != nil {
		t.Fatal(err)
	}

	info, err := ReportFile(ws, "trace.json", "")
	if err != nil {
		t.Fatalf("ReportFile failed: %v", err)
	}
	if info.Sha256 != expectedHex || info.Bytes != int64(len(largeContent)) {
		t.Fatalf("hash mismatch: got %s (%d), want %s (%d)", info.Sha256, info.Bytes, expectedHex, len(largeContent))
	}

	// Reject symlink report
	outsideFile := filepath.Join(outside, "secret.json")
	_ = os.WriteFile(outsideFile, []byte(`{"ok":true}`), 0o600)
	symlinkPath := filepath.Join(ws, "link.json")
	_ = os.Symlink(outsideFile, symlinkPath)
	if _, err := ReportFile(ws, "link.json", ""); err == nil {
		t.Fatalf("expected symlink escaping workspace to be rejected")
	}

	// Reject reserved __human_review__ ID
	_, err = ParseManifest([]byte(`{
		"version": 1,
		"issue": "test",
		"reports": [{"id": "__human_review__", "path": "trace.json", "format": "chrome-trace", "description": "d"}],
		"verification": {"command": "/bin/true"}
	}`))
	if err == nil || !strings.Contains(err.Error(), "Reserved routing choice") {
		t.Fatalf("expected Reserved routing choice error, got %v", err)
	}
}

func TestSystemOneNormalizationAndConfidenceBoundary(t *testing.T) {
	reports := []ReportSpec{
		{ID: "r1", Path: "r1.json", Format: "chrome-trace", Description: "first"},
		{ID: "r2", Path: "r2.json", Format: "chrome-trace", Description: "second"},
	}
	q := RoutingQuestion(reports)

	// 0.65 -> selected (choice "r2")
	norm65, err := NormalizeSystemOne(map[string]any{
		"model": "@cf/cloudflare/clef-flash",
		"usage": map[string]any{"input_tokens": 20, "output_tokens": 5},
		"answers": map[string]any{
			"next_evidence": map[string]any{
				"type":          "choice",
				"choice":        "r2",
				"confidence":    0.65,
				"probabilities": map[string]any{"r1": 0.25, "r2": 0.65, "__human_review__": 0.10},
			},
		},
	}, []DecisionQuestion{q})
	if err != nil {
		t.Fatalf("NormalizeSystemOne failed: %v", err)
	}
	dec65, err := RouteDecisionFromResponse(norm65, reports, RouteDecision{
		Source:   "clef_local",
		Provider: "local",
	})
	if err != nil {
		t.Fatalf("RouteDecisionFromResponse failed: %v", err)
	}
	if dec65.SelectedID == nil || *dec65.SelectedID != "r2" {
		t.Fatalf("expected r2 selected at 0.65, got %v", dec65.SelectedID)
	}

	// 0.6468 -> abstained (selectedId == nil)
	normLow, err := NormalizeSystemOne(map[string]any{
		"model": "@cf/cloudflare/clef-flash",
		"usage": map[string]any{"input_tokens": 20, "output_tokens": 5},
		"answers": map[string]any{
			"next_evidence": map[string]any{
				"type":          "choice",
				"choice":        "r2",
				"confidence":    0.6468,
				"probabilities": map[string]any{"r1": 0.2532, "r2": 0.6468, "__human_review__": 0.10},
			},
		},
	}, []DecisionQuestion{q})
	if err != nil {
		t.Fatalf("NormalizeSystemOne failed: %v", err)
	}
	decLow, err := RouteDecisionFromResponse(normLow, reports, RouteDecision{
		Source:   "clef_local",
		Provider: "local",
	})
	if err != nil {
		t.Fatalf("RouteDecisionFromResponse failed: %v", err)
	}
	if decLow.SelectedID != nil {
		t.Fatalf("expected nil SelectedID at 0.6468, got %v", *decLow.SelectedID)
	}
}

func TestInvestigateEndToEndWithMockMcpAndSystemOneLoopback(t *testing.T) {
	ws := t.TempDir()
	r1 := filepath.Join(ws, "r1.json")
	r2 := filepath.Join(ws, "r2.json")
	_ = os.WriteFile(r1, []byte(`{"traceEvents":[{"name":"k1","dur":100}]}`), 0o600)
	_ = os.WriteFile(r2, []byte(`{"traceEvents":[{"name":"k2","dur":200}]}`), 0o600)

	mcpScript := filepath.Join(ws, "mcp-mock.mjs")
	_ = os.WriteFile(mcpScript, []byte(`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0.0' } }
    }) + '\n');
  } else if (req.method === 'tools/call') {
    const args = req.params?.arguments ?? {};
    const digest = {
      format: args.format ?? 'chrome-trace',
      raw_ref: args.report_ref ?? '',
      total_units: 2,
      returned: 1,
      units: [{ index: 0, domain: 'cuda', duration_us: 100, metrics: { calls: 1 } }]
    };
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: JSON.stringify(digest) }], structuredContent: digest }
    }) + '\n');
  }
});
`), 0o600)

	var currentConfidence = 0.82
	var currentModel = "@cf/cloudflare/clef-flash"
	var currentStatus = 200

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/systemone" {
			http.NotFound(w, r)
			return
		}
		if currentStatus != 200 {
			w.WriteHeader(currentStatus)
			_, _ = w.Write([]byte(`{"error":"upstream error"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		rem := (1.0 - currentConfidence) / 2.0
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": currentModel,
			"usage": map[string]any{
				"input_tokens":  25,
				"output_tokens": 10,
			},
			"answers": map[string]any{
				"next_evidence": map[string]any{
					"type":       "choice",
					"choice":     "r2",
					"confidence": currentConfidence,
					"probabilities": map[string]any{
						"r1":               rem,
						"r2":               currentConfidence,
						"__human_review__": rem,
					},
				},
			},
		})
	}))
	defer srv.Close()

	t.Setenv("PERFDIGEST_CLEF_URL", srv.URL+"/v1/systemone")
	nodeBin, err := Executable("node", nil)
	if err != nil {
		t.Fatal(err)
	}

	manifest := Manifest{
		Version:  1,
		Issue:    "Which kernel trace shows higher duration?",
		Captures: []CommandSpec{},
		Reports: []ReportSpec{
			{ID: "r1", Path: "r1.json", Format: "chrome-trace", Description: "first trace"},
			{ID: "r2", Path: "r2.json", Format: "chrome-trace", Description: "second trace"},
		},
		Verification: CommandSpec{Command: "/bin/true", Args: []string{}, TimeoutMs: 5000},
	}

	// Case 1: Selected (confidence 0.82 >= 0.65)
	resSel, err := Investigate(context.Background(), RunOptions{
		Workspace: ws,
		Manifest:  manifest,
		Routing:   "local",
		Agent:     "none",
		McpSessionOptions: &SessionOptions{
			Command: nodeBin,
			Args:    []string{mcpScript},
		},
	})
	if err != nil {
		t.Fatalf("Investigate selected failed: %v", err)
	}
	if resSel.Status != "complete" || resSel.DecisionOutcome != "accepted" {
		t.Fatalf("expected complete/accepted, got %s/%s", resSel.Status, resSel.DecisionOutcome)
	}
	if resSel.Evidence == nil || resSel.Evidence.Decision.SelectedID == nil || *resSel.Evidence.Decision.SelectedID != "r2" {
		t.Fatalf("expected r2 selected")
	}
	if len(resSel.Provenance) != 2 {
		t.Fatalf("expected 2 provenance entries, got %d", len(resSel.Provenance))
	}

	// Case 2: Abstained (confidence 0.6468 < 0.65) -> retains provenance!
	currentConfidence = 0.6468
	resAbs, err := Investigate(context.Background(), RunOptions{
		Workspace: ws,
		Manifest:  manifest,
		Routing:   "local",
		Agent:     "none",
		McpSessionOptions: &SessionOptions{
			Command: nodeBin,
			Args:    []string{mcpScript},
		},
	})
	if err != nil {
		t.Fatalf("Investigate abstained failed: %v", err)
	}
	if resAbs.Status != "needs_review" || resAbs.DecisionOutcome != "abstained" {
		t.Fatalf("expected needs_review/abstained, got %s/%s", resAbs.Status, resAbs.DecisionOutcome)
	}
	if len(resAbs.Provenance) != 2 {
		t.Fatalf("expected provenance retained on abstention, got %d", len(resAbs.Provenance))
	}

	// Case 3: Rejected (unexpected model identity) -> retains provenance!
	currentConfidence = 0.85
	currentModel = "unexpected-model-id"
	resRej, err := Investigate(context.Background(), RunOptions{
		Workspace: ws,
		Manifest:  manifest,
		Routing:   "local",
		Agent:     "none",
		McpSessionOptions: &SessionOptions{
			Command: nodeBin,
			Args:    []string{mcpScript},
		},
	})
	if err != nil {
		t.Fatalf("Investigate rejected failed: %v", err)
	}
	if resRej.Status != "failed" || resRej.DecisionOutcome != "rejected" {
		t.Fatalf("expected failed/rejected, got %s/%s", resRej.Status, resRej.DecisionOutcome)
	}
	if len(resRej.Provenance) != 2 {
		t.Fatalf("expected provenance retained on schema rejection, got %d", len(resRej.Provenance))
	}

	// Case 4: Failed (HTTP 500) -> retains provenance!
	currentModel = "@cf/cloudflare/clef-flash"
	currentStatus = 500
	resFail, err := Investigate(context.Background(), RunOptions{
		Workspace: ws,
		Manifest:  manifest,
		Routing:   "local",
		Agent:     "none",
		McpSessionOptions: &SessionOptions{
			Command: nodeBin,
			Args:    []string{mcpScript},
		},
	})
	if err != nil {
		t.Fatalf("Investigate HTTP 500 failed: %v", err)
	}
	if resFail.Status != "failed" || resFail.DecisionOutcome != "failed" {
		t.Fatalf("expected failed/failed, got %s/%s", resFail.Status, resFail.DecisionOutcome)
	}
	if len(resFail.Provenance) != 2 {
		t.Fatalf("expected provenance retained on HTTP 500 failure, got %d", len(resFail.Provenance))
	}
}

func TestServeMCPLifecycle(t *testing.T) {
	ws := t.TempDir()
	r1 := filepath.Join(ws, "r1.json")
	_ = os.WriteFile(r1, []byte(`{"traceEvents":[{"name":"k1","dur":100}]}`), 0o600)

	nodeBin, err := Executable("node", nil)
	if err != nil {
		t.Fatal(err)
	}
	mcpScript := filepath.Join(ws, "mcp-mock.mjs")
	_ = os.WriteFile(mcpScript, []byte(`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0.0' } }
    }) + '\n');
  } else if (req.method === 'tools/call') {
    const args = req.params?.arguments ?? {};
    const digest = {
      format: args.format ?? 'chrome-trace',
      raw_ref: args.report_ref ?? '',
      total_units: 1,
      returned: 1,
      units: [{ name: 'k1', value: 100 }]
    };
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: JSON.stringify(digest) }], structuredContent: digest }
    }) + '\n');
  }
});
`), 0o600)

	inR, inW := io.Pipe()
	outR, outW := io.Pipe()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	doneCh := make(chan error, 1)
	go func() {
		doneCh <- ServeMCP(ctx, ws, "offline", ServeMCPOptions{
			McpSessionOptions: &SessionOptions{
				Command: nodeBin,
				Args:    []string{mcpScript},
			},
			Stdin:  inR,
			Stdout: outW,
		})
	}()

	dec := json.NewDecoder(outR)
	send := func(msg map[string]any) map[string]any {
		raw, _ := json.Marshal(msg)
		_, _ = fmt.Fprintf(inW, "%s\n", string(raw))
		var resp map[string]any
		if err := dec.Decode(&resp); err != nil {
			t.Fatalf("decode failed: %v", err)
		}
		return resp
	}

	initResp := send(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params":  map[string]any{"protocolVersion": "2024-11-05"},
	})
	if initResp["result"] == nil {
		t.Fatalf("expected initialize result, got %v", initResp)
	}

	listResp := send(map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "tools/list",
	})
	tools := listResp["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 3 {
		t.Fatalf("expected 3 tools, got %d", len(tools))
	}

	launchResp := send(map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "launch_evidence_prefetch",
			"arguments": map[string]any{
				"issue": "test issue",
				"reports": []any{
					map[string]any{"id": "r1", "path": "r1.json", "format": "chrome-trace", "description": "d"},
				},
				"mode": "offline",
			},
		},
	})
	sc := launchResp["result"].(map[string]any)["structuredContent"].(map[string]any)
	jobID := sc["jobId"].(string)

	getResp := send(map[string]any{
		"jsonrpc": "2.0",
		"id":      4,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "get_evidence_job",
			"arguments": map[string]any{
				"jobId":  jobID,
				"waitMs": 5000,
			},
		},
	})
	getSc := getResp["result"].(map[string]any)["structuredContent"].(map[string]any)
	if getSc["status"] != "complete" {
		t.Fatalf("expected complete job status, got %v", getSc)
	}

	// Second poll must return not_found (consumed once)
	getResp2 := send(map[string]any{
		"jsonrpc": "2.0",
		"id":      5,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "get_evidence_job",
			"arguments": map[string]any{
				"jobId": jobID,
			},
		},
	})
	getSc2 := getResp2["result"].(map[string]any)["structuredContent"].(map[string]any)
	if getSc2["status"] != "not_found" {
		t.Fatalf("expected not_found on second consumption, got %v", getSc2)
	}

	_ = inW.Close()
	if err := <-doneCh; err != nil {
		t.Fatalf("ServeMCP exited with error: %v", err)
	}
}
