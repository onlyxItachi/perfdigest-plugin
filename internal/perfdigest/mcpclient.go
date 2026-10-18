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
	"syscall"
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
	stderrBuf     *tailBuffer
	lifetimeTimer *time.Timer
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
		pid := cmd.Process.Pid
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		if waitDone != nil {
			select {
			case <-waitDone:
			case <-time.After(150 * time.Millisecond):
				_ = syscall.Kill(-pid, syscall.SIGKILL)
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
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

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
	if _, err := s.rpcCall(initCtx, "initialize", initParams, s.opts.ConnectTimeoutMs); err != nil {
		return err
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

func (s *Session) Digest(ctx context.Context, report ReportSpec, absolutePath string) (map[string]any, error) {
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

	runDigest := func() (map[string]any, error) {
		if needSpawn {
			if err := s.spawnAndHandshake(ctx); err != nil {
				return nil, err
			}
		}
		callParams := map[string]any{
			"name": "summarize_report",
			"arguments": map[string]any{
				"report_ref": absolutePath,
				"format":     report.Format,
				"top_n":      s.opts.TopN,
			},
		}
		res, err := s.rpcCall(ctx, "tools/call", callParams, s.opts.CallTimeoutMs)
		if err != nil {
			return nil, err
		}
		if isErr, _ := res["isError"].(bool); isErr {
			return nil, fmt.Errorf("summarize_report returned an MCP tool error")
		}
		var rawDigest any
		if sc, ok := res["structuredContent"]; ok && sc != nil {
			rawDigest = sc
		} else if contentList, ok := res["content"].([]any); ok {
			var parts []string
			for _, item := range contentList {
				if m, ok := item.(map[string]any); ok && m["type"] == "text" {
					if txt, ok := m["text"].(string); ok {
						parts = append(parts, txt)
					}
				}
			}
			if err := json.Unmarshal([]byte(strings.Join(parts, "\n")), &rawDigest); err != nil {
				return nil, err
			}
		} else {
			return nil, fmt.Errorf("missing content in summarize_report response")
		}
		return ValidateDigest(rawDigest, report.Format, absolutePath)
	}

	digest, err := runDigest()
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
	return digest, nil
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
