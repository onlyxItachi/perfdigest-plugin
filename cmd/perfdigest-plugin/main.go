package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/onlyxItachi/perfdigest-plugin/internal/perfdigest"
)

const helpText = `PerfDigest Evidence — Codex-first MVP

  perfdigest-plugin init [--provider cloudflare|local|openai|offline --yes] [--env-file PATH] [--endpoint URL] [--decision-model clef-flash|clef|clef-omni] [--check-connection]
  perfdigest-plugin demo [--agent none|codex|generic] [--agent-command PATH] [--agent-sessions] [--routing offline|decisions] [--decision-model NAME] [--perf]
  perfdigest-plugin run manifest.json [--workspace PATH] [--routing decisions|offline] [--agent codex|none|generic] [--agent-command PATH] [--agent-sessions] [--decision-model NAME]
  perfdigest-plugin mcp [--workspace PATH]

Unconfigured demo defaults: real local CPU measurements + verification, offline routing, no model calls.
Unconfigured run defaults: existing Codex ChatGPT login + live Decisions (PERFDIGEST_DECISIONS_API_KEY).
Use --agent codex to demonstrate overlap with a real Codex session, or --agent generic --agent-command PATH for a JSONL CLI agent.
--perf adds Linux hardware counters; otherwise the demo uses genuine elapsed-time traces.
Raw reports, command receipts and timeline are saved under .perfdigest/runs/.
--provider cloudflare|local|openai|offline explicitly selects inference; --routing keeps legacy aliases.
--decision-model selects the Cloudflare Clef model (default clef-flash); it is refused for other providers.
init --check-connection opts in to one read-only Cloudflare check; inference and quota are not checked.
`

type cliFlags struct {
	help                 bool
	workspace            *string
	agent                *string
	agentCommand         *string
	agentSessions        *bool
	agentDelivery        *string
	routing              *string
	provider             *string
	model                *string
	perf                 bool
	endpoint             *string
	envFile              *string
	decisionModel        *string
	yes                  *bool
	checkConnection      *bool
	decisionsMockURL     *string
	mcpCommand           *string
	mcpArgs              []string
	reuseMcpSession      *bool
	includeCorroborating bool
	compactEvidence      *bool
	serveJSONL           bool
	benchInvestigate     bool
	zeroCostMcp          bool
	// bench-investigate flags
	manifestPath string
	mcpServer    string
	liveMcp      bool
	systemOneURL string
	lifecycle    string
	runs         int
	warmup       int
	positionals  []string
}

func parseCLIArgs(args []string) (cliFlags, error) {
	f := cliFlags{
		lifecycle: "one_shot",
		runs:      1,
		warmup:    0,
	}
	boolFlags := map[string]bool{
		"--help":                  true,
		"-h":                      true,
		"--agent-sessions":        true,
		"--perf":                  true,
		"--yes":                   true,
		"--check-connection":      true,
		"--include-corroborating": true,
		"--compact-evidence":      true,
		"--serve-jsonl":           true,
		"--bench-investigate":     true,
		"--zero-cost-mcp":         true,
		"--live-mcp":              true,
	}
	stringFlags := map[string]bool{
		"--workspace":          true,
		"--agent":              true,
		"--agent-command":      true,
		"--agent-delivery":     true,
		"--routing":            true,
		"--provider":           true,
		"--model":              true,
		"--endpoint":           true,
		"--env-file":           true,
		"--decision-model":     true,
		"--decisions-mock-url": true,
		"--mcp-command":        true,
		"--mcp-arg":            true,
		"--reuse-mcp-session":  true,
		"--manifest":           true,
		"--mcp-server":         true,
		"--systemone-url":      true,
		"--reuse":              true,
		"--lifecycle":          true,
		"--runs":               true,
		"--warmup":             true,
	}

	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			f.positionals = append(f.positionals, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			f.positionals = append(f.positionals, arg)
			continue
		}
		name := arg
		var inlineVal *string
		if eqIdx := strings.IndexByte(arg, '='); eqIdx > 0 {
			name = arg[:eqIdx]
			v := arg[eqIdx+1:]
			inlineVal = &v
		}
		if boolFlags[name] {
			val := true
			if inlineVal != nil {
				val = (*inlineVal == "true" || *inlineVal == "1")
			}
			switch name {
			case "--help", "-h":
				f.help = val
			case "--agent-sessions":
				f.agentSessions = &val
			case "--perf":
				f.perf = val
			case "--yes":
				f.yes = &val
			case "--check-connection":
				f.checkConnection = &val
			case "--include-corroborating":
				f.includeCorroborating = val
			case "--compact-evidence":
				f.compactEvidence = &val
			case "--serve-jsonl":
				f.serveJSONL = val
			case "--bench-investigate":
				f.benchInvestigate = val
			case "--zero-cost-mcp":
				f.zeroCostMcp = val
			case "--live-mcp":
				f.liveMcp = val
			}
			continue
		}
		if stringFlags[name] {
			var val string
			if inlineVal != nil {
				val = *inlineVal
			} else {
				if i+1 >= len(args) {
					return f, fmt.Errorf("Option '%s' argument missing", name)
				}
				i++
				val = args[i]
			}
			switch name {
			case "--workspace":
				f.workspace = &val
			case "--agent":
				f.agent = &val
			case "--agent-command":
				f.agentCommand = &val
			case "--agent-delivery":
				f.agentDelivery = &val
			case "--routing":
				f.routing = &val
			case "--provider":
				f.provider = &val
			case "--model":
				f.model = &val
			case "--endpoint":
				f.endpoint = &val
			case "--env-file":
				f.envFile = &val
			case "--decision-model":
				f.decisionModel = &val
			case "--decisions-mock-url":
				f.decisionsMockURL = &val
			case "--mcp-command":
				f.mcpCommand = &val
			case "--mcp-arg":
				f.mcpArgs = append(f.mcpArgs, val)
			case "--reuse-mcp-session", "--reuse":
				b := (val == "true" || val == "1")
				f.reuseMcpSession = &b
			case "--manifest":
				f.manifestPath = val
			case "--mcp-server":
				f.mcpServer = val
			case "--systemone-url":
				f.systemOneURL = val
			case "--lifecycle":
				f.lifecycle = val
			case "--runs":
				n, err := strconv.Atoi(val)
				if err != nil {
					return f, err
				}
				f.runs = n
			case "--warmup":
				n, err := strconv.Atoi(val)
				if err != nil {
					return f, err
				}
				f.warmup = n
			}
			continue
		}
		return f, fmt.Errorf("Unknown option '%s'", name)
	}
	return f, nil
}

func runZeroCostMcp() error {
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
			res := map[string]any{
				"jsonrpc": "2.0",
				"id":      id,
				"result": map[string]any{
					"protocolVersion": "2024-11-05",
					"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
					"serverInfo":      map[string]any{"name": "zero-cost-mcp", "version": "1.0.0"},
				},
			}
			encoded, _ := json.Marshal(res)
			fmt.Println(string(encoded))
		case "notifications/initialized":
		case "tools/list":
			res := map[string]any{
				"jsonrpc": "2.0",
				"id":      id,
				"result": map[string]any{
					"tools": []any{
						map[string]any{
							"name":        "summarize_report",
							"description": "Zero cost summarize_report responder",
							"inputSchema": map[string]any{
								"type": "object",
								"properties": map[string]any{
									"report_ref": map[string]any{"type": "string"},
									"format":     map[string]any{"type": "string"},
									"top_n":      map[string]any{"type": "number"},
								},
								"required": []string{"report_ref", "format"},
							},
						},
					},
				},
			}
			encoded, _ := json.Marshal(res)
			fmt.Println(string(encoded))
		case "tools/call":
			params, _ := msg["params"].(map[string]any)
			args, _ := params["arguments"].(map[string]any)
			reportRef, _ := args["report_ref"].(string)
			formatStr, _ := args["format"].(string)
			if formatStr == "" {
				formatStr = "chrome-trace"
			}
			topN := 3
			if tn, ok := args["top_n"].(float64); ok && int(tn) > 0 && int(tn) < 3 {
				topN = int(tn)
			}
			units := make([]any, 0, topN)
			for idx := 0; idx < topN; idx++ {
				units = append(units, map[string]any{
					"index":       idx,
					"name":        fmt.Sprintf("unit_%d", idx),
					"duration_us": 100 * (idx + 1),
					"metrics":     map[string]any{"calls": 1, "cache_misses": nil},
				})
			}
			data := map[string]any{
				"format":      formatStr,
				"raw_ref":     reportRef,
				"total_units": len(units),
				"returned":    len(units),
				"units":       units,
			}
			dataBytes, _ := json.Marshal(data)
			res := map[string]any{
				"jsonrpc": "2.0",
				"id":      id,
				"result": map[string]any{
					"content":           []any{map[string]any{"type": "text", "text": string(dataBytes)}},
					"structuredContent": data,
				},
			}
			encoded, _ := json.Marshal(res)
			fmt.Println(string(encoded))
		}
	}
	return nil
}

type localMockBenchProvider struct{}

func (localMockBenchProvider) Name() string { return "cloudflare" }

func (localMockBenchProvider) Select(_ context.Context, _ string, reports []perfdigest.ReportSpec, _ []perfdigest.CollectedEvidence) (perfdigest.RouteDecision, error) {
	var sel *string
	if len(reports) > 0 {
		id := reports[0].ID
		sel = &id
	}
	conf := 0.95
	inTok := 10
	outTok := 5
	return perfdigest.RouteDecision{
		SelectedID:          sel,
		Confidence:          &conf,
		Reason:              "zero-latency local mock decision",
		Source:              "clef_cloudflare",
		Provider:            "cloudflare",
		Model:               "perfdigest/clef-flash-v1",
		ConfidenceSemantics: "systemone_uniform_zero",
		Transport:           "local_mock",
		Requests:            1,
		LatencyMs:           0.05,
		InputTokens:         &inTok,
		OutputTokens:        &outTok,
		CostUsd:             nil,
	}, nil
}

func runBenchInvestigate(ctx context.Context, f cliFlags) error {
	ws := ""
	if f.workspace != nil {
		ws = *f.workspace
	}
	rawManifest, err := os.ReadFile(f.manifestPath)
	if err != nil {
		return err
	}
	manifest, err := perfdigest.ParseManifest(rawManifest)
	if err != nil {
		return err
	}

	var mcpOpts *perfdigest.SessionOptions
	if !f.liveMcp && (f.mcpServer != "" || f.mcpCommand != nil) {
		cmd := "node"
		if f.mcpCommand != nil && *f.mcpCommand != "" {
			cmd = *f.mcpCommand
		}
		var args []string
		if len(f.mcpArgs) > 0 {
			args = append(args, f.mcpArgs...)
		}
		if f.mcpServer != "" {
			args = append(args, f.mcpServer)
		}
		mcpOpts = &perfdigest.SessionOptions{
			Command:          cmd,
			Args:             args,
			ConnectTimeoutMs: 10000,
			CallTimeoutMs:    10000,
		}
	}

	routing := "cloudflare"
	var provider perfdigest.DecisionProvider = localMockBenchProvider{}
	if f.systemOneURL != "" {
		_ = os.Setenv("PERFDIGEST_CLEF_URL", f.systemOneURL)
		routing = "local"
		p, err := perfdigest.CreateDecisionProvider("local", perfdigest.DecisionProviderOptions{})
		if err != nil {
			return err
		}
		provider = p
	}

	reuse := true
	if f.reuseMcpSession != nil {
		reuse = *f.reuseMcpSession
	}

	runOnce := func() (perfdigest.RunResult, float64, error) {
		t0 := time.Now()
		res, err := perfdigest.Investigate(ctx, perfdigest.RunOptions{
			Workspace:         ws,
			Manifest:          manifest,
			Routing:           routing,
			Agent:             "none",
			DecisionProvider:  provider,
			McpSessionOptions: mcpOpts,
			ReuseMcpSession:   &reuse,
		})
		elapsedMs := float64(time.Since(t0).Nanoseconds()) / 1e6
		return res, elapsedMs, err
	}

	type provSummary struct {
		ID     string `json:"id"`
		Sha256 string `json:"sha256"`
		Bytes  int64  `json:"bytes"`
	}
	toProv := func(p []perfdigest.EvidenceProvenance) []provSummary {
		out := make([]provSummary, 0, len(p))
		for _, item := range p {
			out = append(out, provSummary{ID: item.ID, Sha256: item.Sha256, Bytes: item.Bytes})
		}
		return out
	}

	if f.lifecycle == "one_shot" {
		res, elapsedMs, err := runOnce()
		if err != nil {
			return err
		}
		var verExit *int
		if res.Verification != nil {
			verExit = res.Verification.ExitCode
		}
		pass := res.Status == "complete" && verExit != nil && *verExit == 0
		out := map[string]any{
			"ok":                   pass,
			"elapsedMs":            elapsedMs,
			"status":               res.Status,
			"decisionOutcome":      res.DecisionOutcome,
			"verificationExitCode": verExit,
			"provenance":           toProv(res.Provenance),
		}
		encoded, _ := json.Marshal(out)
		fmt.Println(string(encoded))
		return nil
	}

	for i := 0; i < f.warmup; i++ {
		if _, _, err := runOnce(); err != nil {
			return err
		}
	}
	samplesMs := make([]float64, 0, f.runs)
	var lastRes perfdigest.RunResult
	for i := 0; i < f.runs; i++ {
		res, elapsedMs, err := runOnce()
		if err != nil {
			return err
		}
		samplesMs = append(samplesMs, elapsedMs)
		lastRes = res
	}
	var verExit *int
	if lastRes.Verification != nil {
		verExit = lastRes.Verification.ExitCode
	}
	pass := lastRes.Status == "complete" && verExit != nil && *verExit == 0
	out := map[string]any{
		"ok":                   pass,
		"samplesMs":            samplesMs,
		"status":               lastRes.Status,
		"decisionOutcome":      lastRes.DecisionOutcome,
		"verificationExitCode": verExit,
		"provenance":           toProv(lastRes.Provenance),
	}
	encoded, _ := json.Marshal(out)
	fmt.Println(string(encoded))
	return nil
}

func runServeJSONL(ctx context.Context) error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req map[string]any
		if err := json.Unmarshal(line, &req); err != nil {
			resp, _ := json.Marshal(map[string]any{"ok": false, "error": err.Error()})
			fmt.Println(string(resp))
			continue
		}
		ws, _ := req["workspace"].(string)
		if ws == "" {
			ws, _ = os.Getwd()
		}
		manifestRaw, hasManifest := req["manifest"]
		if !hasManifest {
			resp, _ := json.Marshal(map[string]any{"ok": false, "error": "missing manifest"})
			fmt.Println(string(resp))
			continue
		}
		var manifest perfdigest.Manifest
		switch mVal := manifestRaw.(type) {
		case string:
			rawBytes, err := os.ReadFile(mVal)
			if err != nil {
				resp, _ := json.Marshal(map[string]any{"ok": false, "error": err.Error()})
				fmt.Println(string(resp))
				continue
			}
			manifest, err = perfdigest.ParseManifest(rawBytes)
			if err != nil {
				resp, _ := json.Marshal(map[string]any{"ok": false, "error": err.Error()})
				fmt.Println(string(resp))
				continue
			}
		default:
			rawBytes, _ := json.Marshal(mVal)
			var err error
			manifest, err = perfdigest.ParseManifest(rawBytes)
			if err != nil {
				resp, _ := json.Marshal(map[string]any{"ok": false, "error": err.Error()})
				fmt.Println(string(resp))
				continue
			}
		}
		routing, _ := req["routing"].(string)
		if routing == "" {
			routing = "offline"
		}
		agent, _ := req["agent"].(string)
		if agent == "" {
			agent = "none"
		}
		reuse := true
		if rVal, ok := req["reuseMcpSession"].(bool); ok {
			reuse = rVal
		}
		var mcpOpts *perfdigest.SessionOptions
		if mcpCmd, ok := req["mcpCommand"].(string); ok && mcpCmd != "" {
			var mcpArgs []string
			if rawArgs, ok := req["mcpArgs"].([]any); ok {
				for _, a := range rawArgs {
					if s, ok := a.(string); ok {
						mcpArgs = append(mcpArgs, s)
					}
				}
			}
			mcpOpts = &perfdigest.SessionOptions{
				Command: mcpCmd,
				Args:    mcpArgs,
			}
		}
		var provider perfdigest.DecisionProvider
		if mockMode, ok := req["mockProvider"].(bool); ok && mockMode {
			provider = localMockBenchProvider{}
		}
		t0 := time.Now()
		res, err := perfdigest.Investigate(ctx, perfdigest.RunOptions{
			Workspace:         ws,
			Manifest:          manifest,
			Routing:           routing,
			Agent:             agent,
			DecisionProvider:  provider,
			McpSessionOptions: mcpOpts,
			ReuseMcpSession:   &reuse,
		})
		elapsedMs := float64(time.Since(t0).Nanoseconds()) / 1e6
		if err != nil {
			resp, _ := json.Marshal(map[string]any{"ok": false, "error": err.Error()})
			fmt.Println(string(resp))
			continue
		}
		var verExit *int
		if res.Verification != nil {
			verExit = res.Verification.ExitCode
		}
		resp, _ := json.Marshal(map[string]any{
			"ok":                   res.Status == "complete",
			"elapsedMs":            elapsedMs,
			"status":               res.Status,
			"decisionOutcome":      res.DecisionOutcome,
			"directory":            res.Directory,
			"verificationExitCode": verExit,
		})
		fmt.Println(string(resp))
	}
	return nil
}

func runCLI() error {
	f, err := parseCLIArgs(os.Args[1:])
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if f.zeroCostMcp {
		return runZeroCostMcp()
	}
	if f.serveJSONL {
		return runServeJSONL(ctx)
	}
	if f.benchInvestigate {
		return runBenchInvestigate(ctx, f)
	}
	if f.help || len(f.positionals) == 0 {
		fmt.Printf("%s\n", helpText)
		return nil
	}

	wsRaw := ""
	if f.workspace != nil {
		wsRaw = *f.workspace
	} else {
		var err error
		wsRaw, err = os.Getwd()
		if err != nil {
			return err
		}
	}
	workspace, err := filepath.EvalSymlinks(wsRaw)
	if err != nil {
		return err
	}
	command := f.positionals[0]
	if command == "init" {
		yes := f.yes != nil && *f.yes
		checkConn := f.checkConnection != nil && *f.checkConnection
		res, err := perfdigest.InitConfiguration(perfdigest.InitOptions{
			Workspace:       workspace,
			Provider:        f.provider,
			Endpoint:        f.endpoint,
			EnvFile:         f.envFile,
			DecisionModel:   f.decisionModel,
			Yes:             yes,
			CheckConnection: checkConn,
			Ctx:             ctx,
		})
		if err != nil {
			return err
		}
		if !res.Ready {
			os.Exit(1)
		}
		return nil
	}

	if f.yes != nil || f.endpoint != nil || f.envFile != nil || f.checkConnection != nil {
		return errors.New("--yes, --endpoint, --env-file and --check-connection belong to init; configure the workspace first")
	}
	if command != "demo" && command != "run" && command != "mcp" {
		return errors.New("Unknown command; use --help")
	}

	configured, err := perfdigest.LoadConfiguration(workspace)
	if err != nil {
		return err
	}
	accepted := []string{"offline", "cloudflare", "local", "openai", "decisions", "clef-local", "clef-cloudflare", "openai-luna"}
	selected := ""
	if f.provider != nil {
		selected = *f.provider
	} else if f.routing != nil {
		selected = *f.routing
	} else if configured != nil && configured.Provider != "" {
		selected = configured.Provider
	} else if command == "run" {
		selected = "decisions"
	} else {
		selected = "offline"
	}
	if !slices.Contains(accepted, selected) {
		return errors.New("Unknown provider; use cloudflare, local, openai or offline")
	}
	routing := selected
	if f.provider != nil && f.routing != nil {
		if !slices.Contains(accepted, *f.routing) {
			return errors.New("--provider and --routing conflict")
		}
		p1, err1 := perfdigest.ProviderName(*f.routing)
		p2, err2 := perfdigest.ProviderName(routing)
		if err1 != nil || err2 != nil || p1 != p2 {
			return errors.New("--provider and --routing conflict")
		}
	}

	pName, err := perfdigest.ProviderName(routing)
	if err != nil {
		return err
	}
	if configured != nil && pName != "offline" {
		if err := perfdigest.ApplyConfigurationEnvironment(*configured, workspace, nil); err != nil {
			return err
		}
	}

	var savedModel *string
	if configured != nil && configured.Provider == "cloudflare" && pName == "cloudflare" && configured.DecisionModel != "" {
		dm := configured.DecisionModel
		savedModel = &dm
	}
	cloudflareModel := f.decisionModel
	if cloudflareModel == nil {
		cloudflareModel = savedModel
	}

	var mcpSessionOptions *perfdigest.SessionOptions
	if f.mcpCommand != nil || len(f.mcpArgs) > 0 {
		cmd := "uvx"
		if f.mcpCommand != nil && *f.mcpCommand != "" {
			cmd = *f.mcpCommand
		}
		mcpSessionOptions = &perfdigest.SessionOptions{
			Command: cmd,
			Args:    f.mcpArgs,
		}
	}
	decisionsMockURL := ""
	if f.decisionsMockURL != nil {
		decisionsMockURL = *f.decisionsMockURL
	}

	if command == "mcp" {
		return perfdigest.ServeMCP(ctx, workspace, routing, perfdigest.ServeMCPOptions{
			CloudflareModel:   cloudflareModel,
			DecisionsMockURL:  decisionsMockURL,
			McpSessionOptions: mcpSessionOptions,
			ReuseMcpSession:   f.reuseMcpSession,
		})
	}

	agent := "codex"
	if command == "demo" {
		agent = "none"
	}
	if f.agent != nil {
		agent = *f.agent
	}
	if agent != "none" && agent != "codex" && agent != "generic" {
		return errors.New("--agent must be none, codex or generic")
	}
	if agent != "generic" && (f.agentCommand != nil || f.agentSessions != nil) {
		return errors.New("--agent-command and --agent-sessions require --agent generic")
	}
	if agent == "generic" && (f.agentCommand == nil || *f.agentCommand == "") {
		return errors.New("--agent generic requires --agent-command PATH")
	}

	var agentAdapter perfdigest.AgentAdapter
	if agent == "generic" {
		sessions := f.agentSessions != nil && *f.agentSessions
		agentAdapter, err = perfdigest.GenericCliAdapter(perfdigest.GenericCliAgentOptions{
			Command:  *f.agentCommand,
			Sessions: sessions,
		})
		if err != nil {
			return err
		}
	}

	// Preflight credentials and model before creating/capturing a demo.
	if _, err := perfdigest.CreateDecisionProvider(routing, perfdigest.DecisionProviderOptions{
		CloudflareModel:  cloudflareModel,
		DecisionsMockURL: decisionsMockURL,
	}); err != nil {
		return err
	}

	if command == "run" && len(f.positionals) < 2 {
		return errors.New("run requires a manifest path")
	}

	var manifest perfdigest.Manifest
	if command == "demo" {
		manifest, err = perfdigest.DemoManifest(workspace, f.perf)
		if err != nil {
			return err
		}
	} else {
		manifestPath := f.positionals[1]
		if !filepath.IsAbs(manifestPath) {
			cwd, _ := os.Getwd()
			manifestPath = filepath.Join(cwd, manifestPath)
		}
		rawBytes, err := os.ReadFile(manifestPath)
		if err != nil {
			return err
		}
		manifest, err = perfdigest.ParseManifest(rawBytes)
		if err != nil {
			return err
		}
	}

	modelStr := ""
	if f.model != nil {
		modelStr = *f.model
	}
	agentDelivery := "two_turn"
	if f.agentDelivery != nil && *f.agentDelivery != "" {
		agentDelivery = *f.agentDelivery
	}
	if agentDelivery != "two_turn" && agentDelivery != "single_turn" {
		return errors.New("--agent-delivery must be two_turn or single_turn")
	}

	result, err := perfdigest.Investigate(ctx, perfdigest.RunOptions{
		Workspace:            workspace,
		Manifest:             manifest,
		Routing:              routing,
		Agent:                agent,
		AgentDelivery:        agentDelivery,
		Model:                modelStr,
		CloudflareModel:      cloudflareModel,
		DecisionsMockURL:     decisionsMockURL,
		AgentAdapter:         agentAdapter,
		McpSessionOptions:    mcpSessionOptions,
		ReuseMcpSession:      f.reuseMcpSession,
		IncludeCorroborating: f.includeCorroborating,
		CompactEvidence:      f.compactEvidence,
		OnEvent: func(event, detail string) {
			if detail != "" {
				_, _ = fmt.Fprintf(os.Stderr, "%s: %s\n", event, perfdigest.Redact(detail))
			} else {
				_, _ = fmt.Fprintf(os.Stderr, "%s\n", event)
			}
		},
	})
	if err != nil {
		return err
	}

	var verificationExit any = nil
	if result.Verification != nil && result.Verification.ExitCode != nil {
		verificationExit = *result.Verification.ExitCode
	}
	summary := map[string]any{
		"status":          result.Status,
		"decisionOutcome": result.DecisionOutcome,
		"agent":           agent,
		"routing":         routing,
		"provider":        pName,
		"directory":       result.Directory,
		"verification":    verificationExit,
		"decisionsError":  result.DecisionsError,
		"agentError":      result.AgentError,
		"telemetry":       result.Telemetry,
	}
	encoded, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	if result.Status != "complete" {
		os.Exit(1)
	}
	return nil
}

func main() {
	if err := runCLI(); err != nil {
		var decErr *perfdigest.DecisionsError
		if errors.As(err, &decErr) {
			encoded, _ := json.Marshal(decErr.ToJSON())
			fmt.Fprintln(os.Stderr, string(encoded))
		} else {
			fmt.Fprintln(os.Stderr, perfdigest.Redact(err.Error()))
		}
		os.Exit(1)
	}
}
