package perfdigest

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestEvidenceWorkerHelperProcess acts as a self-contained detached _worker and zero-cost MCP
// responder when spawned by unit tests inside `go test -race`.
func TestEvidenceWorkerHelperProcess(t *testing.T) {
	sepIdx := -1
	for i, arg := range os.Args {
		if arg == "--" {
			sepIdx = i
			break
		}
	}
	if sepIdx == -1 || sepIdx+1 >= len(os.Args) {
		return
	}
	subArgs := os.Args[sepIdx+1:]
	if len(subArgs) >= 1 && subArgs[0] == "zero-cost-mcp" {
		runHelperZeroCostMcp()
		os.Exit(0)
	}
	if len(subArgs) >= 2 && subArgs[0] == "evidence" && subArgs[1] == "_worker" {
		ws := ""
		jobID := ""
		for i := 2; i < len(subArgs); i++ {
			switch subArgs[i] {
			case "--workspace":
				if i+1 < len(subArgs) {
					ws = subArgs[i+1]
					i++
				}
			case "--job-id":
				if i+1 < len(subArgs) {
					jobID = subArgs[i+1]
					i++
				}
			}
		}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		if err := RunDetachedEvidenceWorker(ctx, ws, jobID); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, Redact(err.Error()))
			os.Exit(1)
		}
		os.Exit(0)
	}
}

func runHelperZeroCostMcp() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg map[string]any
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		method, _ := msg["method"].(string)
		id := msg["id"]
		switch method {
		case "initialize":
			enc, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      id,
				"result": map[string]any{
					"protocolVersion": "2024-11-05",
					"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
					"serverInfo":      map[string]any{"name": "zero-cost-mcp", "version": "1.0.0"},
				},
			})
			fmt.Println(string(enc))
		case "tools/list":
			enc, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      id,
				"result": map[string]any{
					"tools": []any{
						map[string]any{
							"name":        "summarize_report",
							"description": "Zero cost fixture",
							"inputSchema": map[string]any{"type": "object"},
						},
					},
				},
			})
			fmt.Println(string(enc))
		case "tools/call":
			params, _ := msg["params"].(map[string]any)
			args, _ := params["arguments"].(map[string]any)
			reportRef, _ := args["report_ref"].(string)
			formatStr, _ := args["format"].(string)
			if formatStr == "" {
				formatStr = "chrome-trace"
			}
			data := map[string]any{
				"format":      formatStr,
				"raw_ref":     reportRef,
				"total_units": 1,
				"returned":    1,
				"units": []any{
					map[string]any{
						"index":       0,
						"name":        "hot_kernel",
						"duration_us": 1250,
						"metrics":     map[string]any{"calls": 1, "cache_misses": nil},
					},
				},
			}
			dataBytes, _ := json.Marshal(data)
			enc, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      id,
				"result": map[string]any{
					"content":           []any{map[string]any{"type": "text", "text": string(dataBytes)}},
					"structuredContent": data,
				},
			})
			fmt.Println(string(enc))
		}
	}
}

func helperMcpOptions() *SessionOptions {
	return &SessionOptions{
		Command: os.Args[0],
		Args:    []string{"-test.run=^TestEvidenceWorkerHelperProcess$", "--", "zero-cost-mcp"},
	}
}

func createTestTraceWorkspace(t *testing.T, ver CommandSpec) (string, Manifest) {
	t.Helper()
	ws := t.TempDir()
	tracePath := filepath.Join(ws, "trace.json")
	if err := os.WriteFile(tracePath, []byte(`{"traceEvents":[{"name":"hot_kernel","ph":"X","ts":0,"dur":1250}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{
		Version:  1,
		Issue:    "Diagnose hot_kernel latency.",
		Captures: []CommandSpec{},
		Reports: []ReportSpec{
			{
				ID:          "primary-trace",
				Path:        "trace.json",
				Format:      "chrome-trace",
				Description: "Fixture trace",
			},
		},
		Verification: ver,
	}
	return ws, manifest
}

func TestEvidenceWorkerRunAndTamperDetection(t *testing.T) {
	ws, manifest := createTestTraceWorkspace(t, CommandSpec{
		Command:   "/bin/sh",
		Args:      []string{"-c", "echo verify-ok"},
		TimeoutMs: 10_000,
	})

	out, err := RunEvidenceWorker(context.Background(), EvidenceWorkerRunOptions{
		Workspace:         ws,
		Manifest:          manifest,
		Routing:           "offline",
		McpSessionOptions: helperMcpOptions(),
	})
	if err != nil {
		t.Fatalf("RunEvidenceWorker failed: %v", err)
	}
	if out.DeliveryMode != SkillBackgroundDeliveryMode || out.Status != "complete" || out.DecisionOutcome != "accepted" {
		t.Fatalf("unexpected run output: %+v", out)
	}
	if out.Packet["schema"] != "perfdigest.agent-evidence.v1" {
		t.Fatalf("expected perfdigest.agent-evidence.v1 schema, got %v", out.Packet["schema"])
	}
	if runtime.GOOS != "windows" {
		for _, p := range []string{out.RunJsonPath, out.EvidencePath, out.ReadyPath} {
			info, statErr := os.Stat(p)
			if statErr != nil {
				t.Fatalf("stat %s failed: %v", p, statErr)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("expected 0600 on %s, got %o", p, info.Mode().Perm())
			}
		}
	}

	// Collect succeeds idempotently
	col, err := CollectEvidenceWorker(ws, out.JobID, true)
	if err != nil {
		t.Fatalf("CollectEvidenceWorker failed: %v", err)
	}
	if !col.VerifiedSha256 || col.Run == nil || col.Run.Status != "complete" {
		t.Fatalf("unexpected collect output: %+v", col)
	}

	// Tamper 1 byte -> must fail closed on SHA-256 mismatch
	rawEv, err := os.ReadFile(out.EvidencePath)
	if err != nil {
		t.Fatal(err)
	}
	tampered := strings.Replace(string(rawEv), `"complete"`, `"tampered"`, 1)
	if err := os.WriteFile(out.EvidencePath, []byte(tampered), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := CollectEvidenceWorker(ws, out.JobID, false); err == nil || !strings.Contains(err.Error(), "SHA-256 mismatch") {
		t.Fatalf("expected SHA-256 mismatch error, got %v", err)
	}

	if _, err := ValidateEvidenceJobID("../bad"); err == nil {
		t.Fatalf("expected path traversal jobId rejection")
	}
}

func TestEvidenceWorkerStartStatusWaitCollectAndCancel(t *testing.T) {
	ws, manifest := createTestTraceWorkspace(t, CommandSpec{
		Command:   "/bin/sh",
		Args:      []string{"-c", "sleep 0.2; echo bg-ok"},
		TimeoutMs: 10_000,
	})

	started, err := StartEvidenceWorker(EvidenceWorkerStartOptions{
		Workspace:         ws,
		Manifest:          manifest,
		Routing:           "offline",
		McpSessionOptions: helperMcpOptions(),
		WorkerCommand:     os.Args[0],
		WorkerArgsPrefix:  []string{"-test.run=^TestEvidenceWorkerHelperProcess$", "--"},
	})
	if err != nil {
		t.Fatalf("StartEvidenceWorker failed: %v", err)
	}
	if started.PID <= 0 || started.Status != "running" {
		t.Fatalf("unexpected start output: %+v", started)
	}

	st, err := GetEvidenceWorkerStatus(ws, started.JobID)
	if err != nil {
		t.Fatalf("GetEvidenceWorkerStatus failed: %v", err)
	}
	if st.Status != "running" && st.Status != "complete" {
		t.Fatalf("unexpected status: %+v", st)
	}

	waited, err := WaitEvidenceWorker(context.Background(), ws, started.JobID, 15_000)
	if err != nil {
		t.Fatalf("WaitEvidenceWorker failed: %v", err)
	}
	if waited.Status != "complete" || waited.TimedOut || waited.Packet == nil {
		t.Fatalf("unexpected wait output: %+v", waited)
	}

	col, err := CollectEvidenceWorker(ws, started.JobID, false)
	if err != nil || !col.VerifiedSha256 || col.Status != "complete" {
		t.Fatalf("collect after wait failed: %v (%+v)", err, col)
	}

	// Now test cancel on a slow worker
	slowWs, slowManifest := createTestTraceWorkspace(t, CommandSpec{
		Command:   "/bin/sh",
		Args:      []string{"-c", "sleep 20"},
		TimeoutMs: 30_000,
	})
	slowStarted, err := StartEvidenceWorker(EvidenceWorkerStartOptions{
		Workspace:         slowWs,
		Manifest:          slowManifest,
		Routing:           "offline",
		McpSessionOptions: helperMcpOptions(),
		WorkerCommand:     os.Args[0],
		WorkerArgsPrefix:  []string{"-test.run=^TestEvidenceWorkerHelperProcess$", "--"},
	})
	if err != nil {
		t.Fatalf("slow StartEvidenceWorker failed: %v", err)
	}
	cancelOut, err := CancelEvidenceWorker(slowWs, slowStarted.JobID)
	if err != nil {
		t.Fatalf("CancelEvidenceWorker failed: %v", err)
	}
	if cancelOut.Status != "cancelled" || cancelOut.AlreadyTerminal {
		t.Fatalf("unexpected cancel output: %+v", cancelOut)
	}
	if _, err := CollectEvidenceWorker(slowWs, slowStarted.JobID, false); err == nil || !strings.Contains(err.Error(), "was cancelled") {
		t.Fatalf("expected cancelled collect error, got %v", err)
	}
}

func TestEvidenceWorkerAbstentionFailedVerifierCrashedAndRedaction(t *testing.T) {
	// 1. Abstention (needs_review) via loopback local SystemOne mock
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"clef-flash","answers":{"next_evidence":{"type":"choice","choice":"primary-trace","confidence":0.4,"probabilities":{"primary-trace":0.55,"__human_review__":0.45}}},"usage":{"input_tokens":10,"output_tokens":1}}`))
	}))
	defer srv.Close()
	t.Setenv("PERFDIGEST_CLEF_URL", srv.URL+"/v1/systemone")

	abstWs, abstManifest := createTestTraceWorkspace(t, CommandSpec{
		Command:   "/bin/sh",
		Args:      []string{"-c", "echo ok"},
		TimeoutMs: 10_000,
	})
	abstOut, err := RunEvidenceWorker(context.Background(), EvidenceWorkerRunOptions{
		Workspace:         abstWs,
		Manifest:          abstManifest,
		Routing:           "local",
		McpSessionOptions: helperMcpOptions(),
	})
	if err != nil {
		t.Fatalf("abstention RunEvidenceWorker failed: %v", err)
	}
	if abstOut.Status != "needs_review" || abstOut.DecisionOutcome != "abstained" || abstOut.ProvenanceCount != 1 {
		t.Fatalf("unexpected abstention output: %+v", abstOut)
	}

	// 2. Failed verifier must stay failed + secret redaction
	secretVal := "go_super_secret_token_445566"
	t.Setenv("PERFDIGEST_TEST_SECRET_TOKEN", secretVal)
	failWs, failManifest := createTestTraceWorkspace(t, CommandSpec{
		Command:   "/bin/sh",
		Args:      []string{"-c", fmt.Sprintf("echo leak=%s sk-abcdef1234567890abcdef >&2; exit 1", secretVal)},
		TimeoutMs: 10_000,
	})
	failOut, err := RunEvidenceWorker(context.Background(), EvidenceWorkerRunOptions{
		Workspace:         failWs,
		Manifest:          failManifest,
		Routing:           "offline",
		McpSessionOptions: helperMcpOptions(),
	})
	if err != nil {
		t.Fatalf("failed-verifier RunEvidenceWorker returned unexpected error: %v", err)
	}
	if failOut.Status != "failed" || failOut.VerificationExitCode == nil || *failOut.VerificationExitCode != 1 {
		t.Fatalf("expected failed verification exit 1, got %+v", failOut)
	}
	for _, p := range []string{failOut.EvidencePath, failOut.ReadyPath, failOut.RunJsonPath} {
		raw, rerr := os.ReadFile(p)
		if rerr != nil {
			t.Fatal(rerr)
		}
		if strings.Contains(string(raw), secretVal) || strings.Contains(string(raw), "sk-abcdef1234567890abcdef") {
			t.Fatalf("secret leaked into %s", p)
		}
	}

	// 3. Stale/crashed PID detection
	deadCmd := exec.Command("/bin/sh", "-c", "exit 0")
	if err := deadCmd.Run(); err != nil {
		t.Fatal(err)
	}
	deadPID := deadCmd.Process.Pid
	crashJobID := "ev-go-crashed-pid01"
	jobDir, err := AssertSafeDirectoryChain(failWs, ".perfdigest", "jobs", crashJobID)
	if err != nil {
		t.Fatal(err)
	}
	runDir, err := AssertSafeDirectoryChain(failWs, ".perfdigest", "runs", crashJobID)
	if err != nil {
		t.Fatal(err)
	}
	startID := "1"
	stFile := EvidenceJobState{
		Version:        1,
		DeliveryMode:   SkillBackgroundDeliveryMode,
		JobID:          crashJobID,
		PID:            &deadPID,
		ProcessStartID: &startID,
		WorkerMarker:   crashJobID,
		Status:         "running",
		StartedAt:      utcISO(time.Now()),
		UpdatedAt:      utcISO(time.Now()),
		Workspace:      failWs,
		RunDir:         runDir,
		RunJsonPath:    filepath.Join(runDir, "run.json"),
		EvidencePath:   filepath.Join(runDir, "evidence.v1.json"),
		ReadyPath:      filepath.Join(runDir, "ready.json"),
		StatusPath:     filepath.Join(jobDir, "state.json"),
		LogPath:        filepath.Join(jobDir, "worker.log"),
		Routing:        "offline",
	}
	if err := WriteJSON(filepath.Join(jobDir, "state.json"), stFile); err != nil {
		t.Fatal(err)
	}
	st, err := GetEvidenceWorkerStatus(failWs, crashJobID)
	if err != nil {
		t.Fatalf("GetEvidenceWorkerStatus crashed check failed: %v", err)
	}
	if st.Status != "crashed" || st.Ready {
		t.Fatalf("expected crashed status, got %+v", st)
	}
	waited, err := WaitEvidenceWorker(context.Background(), failWs, crashJobID, 5000)
	if err != nil {
		t.Fatalf("WaitEvidenceWorker crashed check failed: %v", err)
	}
	if waited.Status != "crashed" || waited.TimedOut {
		t.Fatalf("expected prompt crashed wait result, got %+v", waited)
	}
}

func TestEvidenceWorkerNonLinuxFailClosedAndDuplicateAndPreCancel(t *testing.T) {
	// 1. Parse and evaluate darwin, windows, and unknown OS ownership fail-closed.
	st, startID, cmd, ok := parsePsProcessLine("Ss   Sun Nov 22 23:15:00 2026 /usr/bin/perfdigest-plugin evidence _worker --job-id ev-darwin-01\n")
	if !ok || st != "Ss" || startID != "Sun Nov 22 23:15:00 2026" || !strings.Contains(cmd, "ev-darwin-01") {
		t.Fatalf("unexpected parsePsProcessLine result: ok=%v st=%q startID=%q cmd=%q", ok, st, startID, cmd)
	}
	alive, owned := evaluateWorkerProcessStatus("darwin", 4242, "Sun Nov 22 23:15:00 2026", "ev-darwin-01", processInspectFuncs{
		killZero: func(int) error { return nil },
		psQuery: func(int) (string, string, string, bool) {
			return "S", "Sun Nov 22 23:15:00 2026", "perfdigest-plugin evidence _worker --job-id ev-darwin-01", true
		},
	})
	if !alive || !owned {
		t.Fatalf("expected darwin verified match alive=true owned=true, got alive=%v owned=%v", alive, owned)
	}
	// Mismatched start time or failing ps must fail closed (owned=false).
	alive, owned = evaluateWorkerProcessStatus("darwin", 4242, "Sun Nov 22 23:15:00 2026", "ev-darwin-01", processInspectFuncs{
		killZero: func(int) error { return nil },
		psQuery:  func(int) (string, string, string, bool) { return "", "", "", false },
	})
	if !alive || owned {
		t.Fatalf("expected darwin ps failure to fail closed (alive=true owned=false), got alive=%v owned=%v", alive, owned)
	}
	// Windows CIM probe verification + fail-closed when query fails.
	alive, owned = evaluateWorkerProcessStatus("windows", 4242, "20261122231500.000000+000", "ev-win-01", processInspectFuncs{
		winQuery: func(int) (bool, string, string, bool) {
			return true, "20261122231500.000000+000", "perfdigest-plugin.exe evidence _worker --job-id ev-win-01", true
		},
	})
	if !alive || !owned {
		t.Fatalf("expected windows verified match, got alive=%v owned=%v", alive, owned)
	}
	alive, owned = evaluateWorkerProcessStatus("windows", 4242, "20261122231500.000000+000", "ev-win-01", processInspectFuncs{
		winQuery: func(int) (bool, string, string, bool) { return false, "", "", false },
	})
	if !alive || owned {
		t.Fatalf("expected windows query failure to fail closed (alive=true owned=false), got alive=%v owned=%v", alive, owned)
	}
	// Unknown OS fails closed.
	alive, owned = evaluateWorkerProcessStatus("plan9", 4242, "123", "ev-plan9-01", processInspectFuncs{
		killZero: func(int) error { return nil },
	})
	if !alive || owned {
		t.Fatalf("expected unknown OS to fail closed (alive=true owned=false), got alive=%v owned=%v", alive, owned)
	}

	// 2. Duplicate jobId rejected atomically in RunEvidenceWorker and StartEvidenceWorker.
	ws, manifest := createTestTraceWorkspace(t, CommandSpec{
		Command:   "/bin/sh",
		Args:      []string{"-c", "touch verifier-ran.flag"},
		TimeoutMs: 10_000,
	})
	fixedID := "ev-go-duplicate-01"
	out, err := RunEvidenceWorker(context.Background(), EvidenceWorkerRunOptions{
		Workspace:         ws,
		Manifest:          manifest,
		Routing:           "offline",
		JobID:             fixedID,
		McpSessionOptions: helperMcpOptions(),
	})
	if err != nil || out.Status != "complete" {
		t.Fatalf("initial RunEvidenceWorker failed: %v", err)
	}
	if _, err := RunEvidenceWorker(context.Background(), EvidenceWorkerRunOptions{
		Workspace:         ws,
		Manifest:          manifest,
		Routing:           "offline",
		JobID:             fixedID,
		McpSessionOptions: helperMcpOptions(),
	}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected duplicate RunEvidenceWorker rejection, got %v", err)
	}
	if _, err := StartEvidenceWorker(EvidenceWorkerStartOptions{
		Workspace:         ws,
		Manifest:          manifest,
		Routing:           "offline",
		JobID:             fixedID,
		McpSessionOptions: helperMcpOptions(),
		WorkerCommand:     os.Args[0],
		WorkerArgsPrefix:  []string{"-test.run=^TestEvidenceWorkerHelperProcess$", "--"},
	}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected duplicate StartEvidenceWorker rejection, got %v", err)
	}

	// 3. Pre-PID cancelled.marker stops RunDetachedEvidenceWorker before running verification.
	_ = os.Remove(filepath.Join(ws, "verifier-ran.flag"))
	preID := "ev-go-precancel-01"
	jobDir, err := CreateExclusiveDirectory(ws, preID, ".perfdigest", "jobs")
	if err != nil {
		t.Fatal(err)
	}
	runDir, err := CreateExclusiveDirectory(ws, preID, ".perfdigest", "runs")
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(filepath.Join(jobDir, "manifest.json"), manifest); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(filepath.Join(jobDir, "request.json"), workerRequestFile{
		Version:         1,
		JobID:           preID,
		Routing:         "offline",
		CompactEvidence: true,
		McpCommand:      os.Args[0],
		McpArgs:         []string{"-test.run=^TestEvidenceWorkerHelperProcess$", "--", "zero-cost-mcp"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(filepath.Join(jobDir, "state.json"), EvidenceJobState{
		Version:      1,
		DeliveryMode: SkillBackgroundDeliveryMode,
		JobID:        preID,
		WorkerMarker: preID,
		Status:       "running",
		StartedAt:    utcISO(time.Now()),
		UpdatedAt:    utcISO(time.Now()),
		Workspace:    ws,
		RunDir:       runDir,
		RunJsonPath:  filepath.Join(runDir, "run.json"),
		EvidencePath: filepath.Join(runDir, "evidence.v1.json"),
		ReadyPath:    filepath.Join(runDir, "ready.json"),
		StatusPath:   filepath.Join(jobDir, "state.json"),
		LogPath:      filepath.Join(jobDir, "worker.log"),
		Routing:      "offline",
	}); err != nil {
		t.Fatal(err)
	}
	cOut, err := CancelEvidenceWorker(ws, preID)
	if err != nil || cOut.Status != "cancelled" || cOut.AlreadyTerminal {
		t.Fatalf("pre-PID CancelEvidenceWorker failed: %v (%+v)", err, cOut)
	}
	if err := RunDetachedEvidenceWorker(context.Background(), ws, preID); err != nil {
		t.Fatalf("RunDetachedEvidenceWorker after pre-PID cancel returned unexpected error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(ws, "verifier-ran.flag")); !os.IsNotExist(err) {
		t.Fatalf("expected verifier-ran.flag not to exist after pre-PID cancellation")
	}
	if _, err := os.Stat(filepath.Join(runDir, "ready.json")); !os.IsNotExist(err) {
		t.Fatalf("expected ready.json not to exist after pre-PID cancellation")
	}
}
