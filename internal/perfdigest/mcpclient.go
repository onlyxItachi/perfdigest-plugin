package perfdigest

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type SessionOptions struct {
	MaxCalls         int      `json:"maxCalls,omitempty"`
	TopN             int      `json:"topN,omitempty"`
	MaxLifetimeMs    int      `json:"maxLifetimeMs,omitempty"`
	ConnectTimeoutMs int      `json:"connectTimeoutMs,omitempty"`
	CallTimeoutMs    int      `json:"callTimeoutMs,omitempty"`
	Command          string   `json:"command,omitempty"`
	Args             []string `json:"args,omitempty"`
}

type SessionStats struct {
	Spawns      int  `json:"spawns"`
	Calls       int  `json:"calls"`
	ReusedCalls int  `json:"reusedCalls"`
	Closed      bool `json:"closed"`
	Tainted     bool `json:"tainted"`
}

type Session struct {
	workspace string
	opts      SessionOptions

	mu            sync.Mutex
	inFlight      bool
	spawns        int
	calls         int
	reusedCalls   int
	closed        bool
	tainted       bool
	nextReqID     int
	cmd           *exec.Cmd
	stdin         io.WriteCloser
	linesCh       chan string
	readErrCh     chan error
	waitDoneCh    chan struct{}
	stderrBuf          *tailBuffer
	lifetimeTimer      *time.Timer
	cachedDrillSupport *bool
}

type tailBuffer struct {
	mu  sync.Mutex
	buf string
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.buf + string(p)
	if len(s) > t.max {
		s = s[len(s)-t.max:]
	}
	t.buf = s
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(t.buf)
}

func OpenPerfDigestSession(workspace string, opts SessionOptions) (*Session, error) {
	if opts.MaxCalls == 0 {
		opts.MaxCalls = 8
	}
	if opts.MaxCalls < 1 || opts.MaxCalls > 16 {
		return nil, fmt.Errorf("PerfDigestSession maxCalls must be an integer between 1 and 16")
	}
	if opts.TopN == 0 {
		opts.TopN = 3
	}
	if opts.TopN < 1 || opts.TopN > 10 {
		return nil, fmt.Errorf("PerfDigestSession topN must be an integer between 1 and 10")
	}
	if opts.MaxLifetimeMs == 0 {
		opts.MaxLifetimeMs = 120_000
	}
	if opts.ConnectTimeoutMs == 0 {
		opts.ConnectTimeoutMs = 60_000
	}
	if opts.CallTimeoutMs == 0 {
		opts.CallTimeoutMs = 30_000
	}
	if opts.ConnectTimeoutMs <= 0 || opts.CallTimeoutMs <= 0 || opts.MaxLifetimeMs <= 0 {
		return nil, fmt.Errorf("PerfDigestSession timeouts must be positive")
	}
	return &Session{
		workspace: workspace,
		opts:      opts,
	}, nil
}

func (s *Session) MaxCalls() int {
	return s.opts.MaxCalls
}

func (s *Session) Stats() SessionStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionStats{
		Spawns:      s.spawns,
		Calls:       s.calls,
		ReusedCalls: s.reusedCalls,
		Closed:      s.closed,
		Tainted:     s.tainted,
	}
}

func (s *Session) markTaintedAndClose() {
	s.mu.Lock()
	s.tainted = true
	s.mu.Unlock()
	_ = s.Close()
}

func (s *Session) Close() error {
	s.mu.Lock()
	s.closed = true
	if s.lifetimeTimer != nil {
		s.lifetimeTimer.Stop()
		s.lifetimeTimer = nil
	}
	cmd := s.cmd
	stdin := s.stdin
	waitDone := s.waitDoneCh
	s.cmd = nil
	s.stdin = nil
	s.mu.Unlock()

	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && cmd.Process != nil {
		terminateProcessGroup(cmd, false)
		if waitDone != nil {
			select {
			case <-waitDone:
			case <-time.After(150 * time.Millisecond):
				terminateProcessGroup(cmd, true)
				select {
				case <-waitDone:
				case <-time.After(200 * time.Millisecond):
				}
			}
		}
	}
	return nil
}

func (s *Session) spawnAndHandshake(ctx context.Context) error {
	command := s.opts.Command
	if command == "" {
		var err error
		command, err = Executable("uvx", nil)
		if err != nil {
			return err
		}
	}
	args := s.opts.Args
	if len(args) == 0 && s.opts.Command == "" {
		args = []string{"perfdigest-mcp"}
	}
	cmd := exec.Command(command, args...)
	cmd.Dir = s.workspace
	cmd.Env = ChildEnvSlice(nil)
	configureProcessGroup(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderrBuf := &tailBuffer{max: 4000}
	cmd.Stderr = stderrBuf

	if err := cmd.Start(); err != nil {
		return err
	}

	linesCh := make(chan string, 32)
	readErrCh := make(chan error, 1)
	waitDoneCh := make(chan struct{})

	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			linesCh <- scanner.Text()
		}
		if err := scanner.Err(); err != nil {
			readErrCh <- err
		} else {
			readErrCh <- io.EOF
		}
		close(linesCh)
	}()

	go func() {
		_ = cmd.Wait()
		close(waitDoneCh)
	}()

	s.mu.Lock()
	s.spawns++
	s.cmd = cmd
	s.stdin = stdin
	s.linesCh = linesCh
	s.readErrCh = readErrCh
	s.waitDoneCh = waitDoneCh
	s.stderrBuf = stderrBuf
	s.lifetimeTimer = time.AfterFunc(time.Duration(s.opts.MaxLifetimeMs)*time.Millisecond, func() {
		s.markTaintedAndClose()
	})
	s.mu.Unlock()

	initCtx, cancel := context.WithTimeout(ctx, time.Duration(s.opts.ConnectTimeoutMs)*time.Millisecond)
	defer cancel()

	initParams := map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo": map[string]any{
			"name":    "perfdigest-plugin",
			"version": "0.1.0",
		},
	}
	initRes, err := s.rpcCall(initCtx, "initialize", initParams, s.opts.ConnectTimeoutMs)
	if err != nil {
		return err
	}
	if srvInfo, ok := initRes["serverInfo"].(map[string]any); ok {
		if srvName, ok := srvInfo["name"].(string); ok {
			if srvName == "mock" || srvName == "zero-cost-mcp" || srvName == "fixture-only" {
				f := false
				s.mu.Lock()
				s.cachedDrillSupport = &f
				s.mu.Unlock()
			}
		}
	}
	notif := map[string]any{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
	}
	rawNotif, _ := json.Marshal(notif)
	if _, err := stdin.Write(append(rawNotif, '\n')); err != nil {
		return err
	}
	return nil
}

func (s *Session) rpcCall(ctx context.Context, method string, params any, timeoutMs int) (map[string]any, error) {
	s.mu.Lock()
	s.nextReqID++
	reqID := s.nextReqID
	stdin := s.stdin
	linesCh := s.linesCh
	s.mu.Unlock()

	if stdin == nil || linesCh == nil {
		return nil, fmt.Errorf("MCP transport not connected")
	}

	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      reqID,
		"method":  method,
		"params":  params,
	}
	raw, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if _, err := stdin.Write(append(raw, '\n')); err != nil {
		return nil, err
	}

	timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return nil, fmt.Errorf("PerfDigest MCP timed out after %d ms", timeoutMs)
		case line, ok := <-linesCh:
			if !ok {
				return nil, fmt.Errorf("MCP connection closed unexpectedly")
			}
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var msg map[string]any
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				continue
			}
			idVal, hasID := msg["id"]
			if !hasID {
				continue
			}
			idInt, ok := toInt(idVal)
			if !ok || idInt != reqID {
				continue
			}
			if errObj, hasErr := msg["error"]; hasErr && errObj != nil {
				return nil, fmt.Errorf("MCP error: %v", errObj)
			}
			resObj, _ := msg["result"].(map[string]any)
			if resObj == nil {
				return nil, fmt.Errorf("invalid MCP result")
			}
			return resObj, nil
		}
	}
}

func (s *Session) SupportsDrillDown(ctx context.Context) bool {
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return false
	}
	s.mu.Lock()
	if s.cachedDrillSupport != nil {
		val := *s.cachedDrillSupport
		s.mu.Unlock()
		return val
	}
	if s.inFlight || s.tainted || s.closed {
		s.mu.Unlock()
		return false
	}
	s.inFlight = true
	needSpawn := s.cmd == nil
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.inFlight = false
		s.mu.Unlock()
	}()

	if needSpawn {
		if err := s.spawnAndHandshake(ctx); err != nil {
			f := false
			s.mu.Lock()
			s.cachedDrillSupport = &f
			s.mu.Unlock()
			return false
		}
		s.mu.Lock()
		if s.cachedDrillSupport != nil {
			val := *s.cachedDrillSupport
			s.mu.Unlock()
			return val
		}
		s.mu.Unlock()
	}

	probeTimeoutMs := s.opts.CallTimeoutMs
	if probeTimeoutMs > 2000 {
		probeTimeoutMs = 2000
	}
	res, err := s.rpcCall(ctx, "tools/list", map[string]any{}, probeTimeoutMs)
	if err != nil {
		f := false
		s.mu.Lock()
		s.cachedDrillSupport = &f
		s.mu.Unlock()
		return false
	}
	toolsSlice, _ := res["tools"].([]any)
	names := make(map[string]bool, len(toolsSlice))
	for _, item := range toolsSlice {
		if m, ok := item.(map[string]any); ok {
			if n, ok := m["name"].(string); ok {
				names[n] = true
			}
		}
	}
	supported := names["list_kernels"] && names["get_metrics"] && names["expand"] && names["compare_metrics"]
	s.mu.Lock()
	s.cachedDrillSupport = &supported
	s.mu.Unlock()
	return supported
}

func (s *Session) invokeTool(
	ctx context.Context,
	toolName string,
	toolArgs map[string]any,
	validate func(any) (map[string]any, error),
) (map[string]any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		s.markTaintedAndClose()
		return nil, err
	}

	s.mu.Lock()
	if s.inFlight {
		s.mu.Unlock()
		s.markTaintedAndClose()
		return nil, fmt.Errorf("PerfDigest MCP session does not allow concurrent calls")
	}
	if s.tainted {
		s.mu.Unlock()
		return nil, fmt.Errorf("PerfDigest MCP session was tainted by a prior error and cannot be reused")
	}
	if s.closed {
		s.mu.Unlock()
		return nil, fmt.Errorf("PerfDigest MCP session is closed")
	}
	if s.calls >= s.opts.MaxCalls {
		s.mu.Unlock()
		s.markTaintedAndClose()
		return nil, fmt.Errorf("PerfDigest MCP session call limit (%d) exceeded", s.opts.MaxCalls)
	}
	s.inFlight = true
	s.calls++
	needSpawn := s.cmd == nil
	if !needSpawn {
		s.reusedCalls++
	}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.inFlight = false
		s.mu.Unlock()
	}()

	runCall := func() (map[string]any, error) {
		if needSpawn {
			if err := s.spawnAndHandshake(ctx); err != nil {
				return nil, err
			}
		}
		callParams := map[string]any{
			"name":      toolName,
			"arguments": toolArgs,
		}
		res, err := s.rpcCall(ctx, "tools/call", callParams, s.opts.CallTimeoutMs)
		if err != nil {
			return nil, err
		}
		if isErr, _ := res["isError"].(bool); isErr {
			return nil, fmt.Errorf("%s returned an MCP tool error", toolName)
		}
		var rawValue any
		if sc, ok := res["structuredContent"]; ok && sc != nil {
			rawValue = sc
		} else if contentList, ok := res["content"].([]any); ok {
			var parts []string
			for _, item := range contentList {
				if m, ok := item.(map[string]any); ok && m["type"] == "text" {
					if txt, ok := m["text"].(string); ok {
						parts = append(parts, txt)
					}
				}
			}
			if err := json.Unmarshal([]byte(strings.Join(parts, "\n")), &rawValue); err != nil {
				return nil, err
			}
		} else {
			return nil, fmt.Errorf("missing content in %s response", toolName)
		}
		return validate(rawValue)
	}

	out, err := runCall()
	if err != nil {
		stderrStr := ""
		if s.stderrBuf != nil {
			stderrStr = s.stderrBuf.String()
		}
		s.markTaintedAndClose()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		suffix := ""
		if stderrStr != "" {
			suffix = "\n" + stderrStr
		}
		return nil, fmt.Errorf("%s", Redact(fmt.Sprintf("PerfDigest MCP failed: %v%s", err, suffix)))
	}
	return out, nil
}

func (s *Session) Digest(ctx context.Context, report ReportSpec, absolutePath string) (map[string]any, error) {
	return s.invokeTool(
		ctx,
		"summarize_report",
		map[string]any{
			"report_ref": absolutePath,
			"format":     report.Format,
			"top_n":      s.opts.TopN,
		},
		func(raw any) (map[string]any, error) {
			return ValidateDigest(raw, report.Format, absolutePath)
		},
	)
}

func (s *Session) ListKernels(ctx context.Context, report ReportSpec, absolutePath string) (map[string]any, error) {
	return s.invokeTool(
		ctx,
		"list_kernels",
		map[string]any{
			"report_ref": absolutePath,
			"format":     report.Format,
		},
		func(raw any) (map[string]any, error) {
			return ValidateListKernels(raw, report)
		},
	)
}

func (s *Session) GetMetrics(ctx context.Context, report ReportSpec, absolutePath string, kernel string, metrics []string) (map[string]any, error) {
	args := map[string]any{
		"report_ref": absolutePath,
		"format":     report.Format,
		"kernel":     kernel,
	}
	if len(metrics) > 0 {
		args["metrics"] = metrics
	}
	return s.invokeTool(
		ctx,
		"get_metrics",
		args,
		func(raw any) (map[string]any, error) {
			return ValidateGetMetrics(raw, report, absolutePath)
		},
	)
}

func (s *Session) ExpandUnit(ctx context.Context, report ReportSpec, absolutePath string, kernel string, section string) (map[string]any, error) {
	if section == "" {
		section = "all"
	}
	return s.invokeTool(
		ctx,
		"expand",
		map[string]any{
			"report_ref": absolutePath,
			"format":     report.Format,
			"kernel":     kernel,
			"section":    section,
		},
		func(raw any) (map[string]any, error) {
			return ValidateExpand(raw, report, absolutePath, section)
		},
	)
}

func (s *Session) CompareMetrics(
	ctx context.Context,
	reportA ReportSpec,
	absolutePathA string,
	reportB ReportSpec,
	absolutePathB string,
	kernel string,
	kernelB string,
	metrics []string,
) (map[string]any, error) {
	if reportA.Format != reportB.Format {
		return nil, fmt.Errorf("compare_metrics requires reports with matching format")
	}
	args := map[string]any{
		"report_a": absolutePathA,
		"report_b": absolutePathB,
		"format":   reportA.Format,
		"kernel":   kernel,
	}
	if kernelB != "" {
		args["kernel_b"] = kernelB
	}
	if len(metrics) > 0 {
		args["metrics"] = metrics
	}
	return s.invokeTool(
		ctx,
		"compare_metrics",
		args,
		func(raw any) (map[string]any, error) {
			return ValidateCompareMetrics(raw, reportA, absolutePathA, reportB, absolutePathB)
		},
	)
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		if math.Trunc(n) == n && !math.IsNaN(n) && !math.IsInf(n, 0) {
			return int(n), true
		}
		return 0, false
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	default:
		return 0, false
	}
}

// ValidateDigest enforces exact structural and context-budget invariants from src/perfdigest.ts
// without coercing null metric values to zero.
func ValidateDigest(value any, format string, reportPath string) (map[string]any, error) {
	digest, ok := value.(map[string]any)
	if !ok || digest == nil {
		return nil, fmt.Errorf("Invalid PerfDigest result")
	}
	if errVal, hasErr := digest["error"]; hasErr && errVal != nil && errVal != false && errVal != "" {
		return nil, fmt.Errorf("PerfDigest did not return a nonempty digest for the requested report and format")
	}
	fmtStr, _ := digest["format"].(string)
	rawRef, _ := digest["raw_ref"].(string)
	totalUnits, okTotal := toInt(digest["total_units"])
	returned, okRet := toInt(digest["returned"])
	units, okUnits := digest["units"].([]any)
	if fmtStr != format || rawRef != reportPath || !okTotal || totalUnits < 1 || !okUnits || len(units) < 1 || !okRet || returned != len(units) || len(units) > totalUnits {
		return nil, fmt.Errorf("PerfDigest did not return a nonempty digest for the requested report and format")
	}
	encoded, err := json.Marshal(digest)
	if err != nil {
		return nil, fmt.Errorf("Invalid PerfDigest result")
	}
	if len(encoded) > 40_000 {
		return nil, fmt.Errorf("Digest exceeds MVP context budget; raw report remains on disk")
	}
	return digest, nil
}

func truncStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

func ValidateListKernels(value any, report ReportSpec) (map[string]any, error) {
	var rawList []any
	if arr, ok := value.([]any); ok {
		rawList = arr
	} else if m, ok := value.(map[string]any); ok && m != nil {
		if arr, ok := m["result"].([]any); ok {
			rawList = arr
		}
	}
	if len(rawList) < 1 {
		return nil, fmt.Errorf("PerfDigest list_kernels did not return a nonempty unit list")
	}
	limit := len(rawList)
	if limit > 64 {
		limit = 64
	}
	units := make([]map[string]any, 0, limit)
	for fallbackIdx, item := range rawList[:limit] {
		u, ok := item.(map[string]any)
		if !ok || u == nil {
			return nil, fmt.Errorf("Invalid unit entry in list_kernels result")
		}
		nameStr, _ := u["name"].(string)
		if nameStr == "" {
			return nil, fmt.Errorf("Unit in list_kernels is missing name")
		}
		idx, okIdx := toInt(u["index"])
		if !okIdx || idx < 0 {
			idx = fallbackIdx
		}
		var durVal any = nil
		if f, ok := toFiniteFloat(u["duration_us"]); ok && f >= 0 {
			durVal = f
		}
		var domVal any = nil
		if d, ok := u["domain"].(string); ok && d != "" {
			domVal = truncStr(d, 80)
		}
		units = append(units, map[string]any{
			"index":       idx,
			"name":        truncStr(Redact(nameStr), 160),
			"duration_us": durVal,
			"domain":      domVal,
		})
	}
	return map[string]any{
		"report_id":   report.ID,
		"format":      report.Format,
		"total_units": len(rawList),
		"returned":    len(units),
		"units":       units,
	}, nil
}

func sanitizeFlatMetricsMap(rawMetrics any) (map[string]any, error) {
	m, ok := rawMetrics.(map[string]any)
	if !ok || m == nil {
		return nil, fmt.Errorf("PerfDigest tool result is missing metrics object")
	}
	clean := make(map[string]any, len(m))
	for k, v := range m {
		key := truncStr(Redact(k), 120)
		if v == nil {
			clean[key] = nil
		} else if f, ok := toFiniteFloat(v); ok {
			clean[key] = f
		} else if s, ok := v.(string); ok {
			clean[key] = truncStr(Redact(s), 200)
		} else if arr, ok := v.([]any); ok {
			lim := len(arr)
			if lim > 16 {
				lim = 16
			}
			nums := make([]float64, 0, lim)
			for _, elem := range arr[:lim] {
				if nf, ok := toFiniteFloat(elem); ok {
					nums = append(nums, nf)
				}
			}
			clean[key] = nums
		}
	}
	return clean, nil
}

func ValidateGetMetrics(value any, report ReportSpec, reportPath string) (map[string]any, error) {
	obj, ok := value.(map[string]any)
	if !ok || obj == nil {
		return nil, fmt.Errorf("Invalid get_metrics result")
	}
	if errVal, hasErr := obj["error"]; hasErr && errVal != nil && errVal != false && errVal != "" {
		return nil, fmt.Errorf("PerfDigest get_metrics did not match requested report and format")
	}
	fmtStr, _ := obj["format"].(string)
	rawRef, _ := obj["raw_ref"].(string)
	kernelStr, _ := obj["kernel"].(string)
	if fmtStr != report.Format || rawRef != reportPath || kernelStr == "" {
		return nil, fmt.Errorf("PerfDigest get_metrics did not match requested report and format")
	}
	metrics, err := sanitizeFlatMetricsMap(obj["metrics"])
	if err != nil {
		return nil, err
	}
	idx, okIdx := toInt(obj["index"])
	if !okIdx {
		idx = 0
	}
	var domVal any = nil
	if d, ok := obj["domain"].(string); ok {
		domVal = truncStr(d, 80)
	}
	out := map[string]any{
		"report_id": report.ID,
		"format":    report.Format,
		"kernel":    truncStr(Redact(kernelStr), 160),
		"index":     idx,
		"domain":    domVal,
		"metrics":   metrics,
	}
	encoded, err := json.Marshal(out)
	if err != nil || len(encoded) > 32_000 {
		return nil, fmt.Errorf("get_metrics result exceeds context budget")
	}
	return out, nil
}

func ValidateExpand(value any, report ReportSpec, reportPath string, section string) (map[string]any, error) {
	obj, ok := value.(map[string]any)
	if !ok || obj == nil {
		return nil, fmt.Errorf("Invalid expand result")
	}
	if errVal, hasErr := obj["error"]; hasErr && errVal != nil && errVal != false && errVal != "" {
		return nil, fmt.Errorf("PerfDigest expand did not match requested report")
	}
	rawRef, _ := obj["raw_ref"].(string)
	kernelStr, _ := obj["kernel"].(string)
	if rawRef != reportPath || kernelStr == "" {
		return nil, fmt.Errorf("PerfDigest expand did not match requested report")
	}
	metrics, err := sanitizeFlatMetricsMap(obj["metrics"])
	if err != nil {
		return nil, err
	}
	idx, okIdx := toInt(obj["index"])
	if !okIdx {
		idx = 0
	}
	var domVal any = nil
	if d, ok := obj["domain"].(string); ok {
		domVal = truncStr(d, 80)
	}
	secFilter := section
	if sf, ok := obj["section_filter"].(string); ok && sf != "" {
		secFilter = truncStr(Redact(sf), 80)
	}
	mCount, okMc := toInt(obj["metric_count"])
	if !okMc {
		mCount = len(metrics)
	}
	out := map[string]any{
		"report_id":      report.ID,
		"format":         report.Format,
		"kernel":         truncStr(Redact(kernelStr), 160),
		"index":          idx,
		"domain":         domVal,
		"section_filter": secFilter,
		"metric_count":   mCount,
		"metrics":        metrics,
	}
	encoded, err := json.Marshal(out)
	if err != nil || len(encoded) > 32_000 {
		return nil, fmt.Errorf("expand result exceeds context budget")
	}
	return out, nil
}

func ValidateCompareMetrics(value any, reportA ReportSpec, pathA string, reportB ReportSpec, pathB string) (map[string]any, error) {
	obj, ok := value.(map[string]any)
	if !ok || obj == nil {
		return nil, fmt.Errorf("Invalid compare_metrics result")
	}
	if errVal, hasErr := obj["error"]; hasErr && errVal != nil && errVal != false && errVal != "" {
		return nil, fmt.Errorf("PerfDigest compare_metrics did not match requested reports and format")
	}
	fmtStr, _ := obj["format"].(string)
	rawRefA, _ := obj["raw_ref_a"].(string)
	rawRefB, _ := obj["raw_ref_b"].(string)
	kernelA, _ := obj["kernel_a"].(string)
	kernelB, _ := obj["kernel_b"].(string)
	rawMetrics, okMetrics := obj["metrics"].(map[string]any)
	if fmtStr != reportA.Format || rawRefA != pathA || rawRefB != pathB || kernelA == "" || kernelB == "" || !okMetrics || rawMetrics == nil {
		return nil, fmt.Errorf("PerfDigest compare_metrics did not match requested reports and format")
	}
	normVal := func(v any) any {
		if v == nil {
			return nil
		}
		if f, ok := toFiniteFloat(v); ok {
			return f
		}
		if s, ok := v.(string); ok {
			return truncStr(Redact(s), 120)
		}
		return nil
	}
	cleanMetrics := make(map[string]any, len(rawMetrics))
	for k, rawEntry := range rawMetrics {
		entry, ok := rawEntry.(map[string]any)
		if !ok || entry == nil {
			continue
		}
		cleanMetrics[truncStr(Redact(k), 120)] = map[string]any{
			"a":         normVal(entry["a"]),
			"b":         normVal(entry["b"]),
			"delta":     normVal(entry["delta"]),
			"delta_pct": normVal(entry["delta_pct"]),
		}
	}
	idxA, okA := toInt(obj["index_a"])
	if !okA {
		idxA = 0
	}
	idxB, okB := toInt(obj["index_b"])
	if !okB {
		idxB = 0
	}
	var domVal any = nil
	if d, ok := obj["domain"].(string); ok {
		domVal = truncStr(d, 80)
	}
	signConv := "delta = b - a"
	if sc, ok := obj["sign_convention"].(string); ok && sc != "" {
		signConv = truncStr(Redact(sc), 80)
	}
	out := map[string]any{
		"report_id_a":     reportA.ID,
		"report_id_b":     reportB.ID,
		"format":          reportA.Format,
		"domain":          domVal,
		"kernel_a":        truncStr(Redact(kernelA), 160),
		"kernel_b":        truncStr(Redact(kernelB), 160),
		"index_a":         idxA,
		"index_b":         idxB,
		"sign_convention": signConv,
		"metrics":         cleanMetrics,
	}
	encoded, err := json.Marshal(out)
	if err != nil || len(encoded) > 32_000 {
		return nil, fmt.Errorf("compare_metrics result exceeds context budget")
	}
	return out, nil
}
