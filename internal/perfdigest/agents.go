package perfdigest

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

type AgentCapabilities struct {
	SameSessionContinuation bool   `json:"sameSessionContinuation"`
	NativeAsyncInput        bool   `json:"nativeAsyncInput"`
	Cancellation            bool   `json:"cancellation"`
	UsageReporting          bool   `json:"usageReporting"`
	Sandbox                 string `json:"sandbox"`
	InExecutionAsyncInput   string `json:"inExecutionAsyncInput,omitempty"`
	InExecutionToolDelivery string `json:"inExecutionToolDelivery,omitempty"`
	QueuedStdinNextTurn     string `json:"queuedStdinNextTurn,omitempty"`
	InterruptionAndSteering string `json:"interruptionAndSteering,omitempty"`
	UsageReportingSemantics string `json:"usageReportingSemantics,omitempty"`
}

type AgentCapabilitiesWithAdapter struct {
	Adapter                 string `json:"adapter"`
	SameSessionContinuation bool   `json:"sameSessionContinuation"`
	NativeAsyncInput        bool   `json:"nativeAsyncInput"`
	Cancellation            bool   `json:"cancellation"`
	UsageReporting          bool   `json:"usageReporting"`
	Sandbox                 string `json:"sandbox"`
	InExecutionAsyncInput   string `json:"inExecutionAsyncInput,omitempty"`
	InExecutionToolDelivery string `json:"inExecutionToolDelivery,omitempty"`
	QueuedStdinNextTurn     string `json:"queuedStdinNextTurn,omitempty"`
	InterruptionAndSteering string `json:"interruptionAndSteering,omitempty"`
	UsageReportingSemantics string `json:"usageReportingSemantics,omitempty"`
}

func GetRuntimeCapabilityProfile(runtimeID string, sessions bool) AgentCapabilities {
	switch runtimeID {
	case "codex":
		return AgentCapabilities{
			SameSessionContinuation: true,
			NativeAsyncInput:        false,
			Cancellation:            true,
			UsageReporting:          true,
			Sandbox:                 "read-only",
			InExecutionAsyncInput:   "unsupported",
			InExecutionToolDelivery: "supported",
			QueuedStdinNextTurn:     "unsupported",
			InterruptionAndSteering: "unsupported",
			UsageReportingSemantics: "incremental_per_turn",
		}
	case "agy":
		return AgentCapabilities{
			SameSessionContinuation: true,
			NativeAsyncInput:        false,
			Cancellation:            true,
			UsageReporting:          true,
			Sandbox:                 "agent-defined",
			InExecutionAsyncInput:   "unsupported",
			InExecutionToolDelivery: "supported",
			QueuedStdinNextTurn:     "supported",
			InterruptionAndSteering: "unsupported",
			UsageReportingSemantics: "cumulative_session_trajectory",
		}
	case "claude":
		return AgentCapabilities{
			SameSessionContinuation: true,
			NativeAsyncInput:        false,
			Cancellation:            true,
			UsageReporting:          true,
			Sandbox:                 "agent-defined",
			InExecutionAsyncInput:   "unsupported",
			InExecutionToolDelivery: "supported",
			QueuedStdinNextTurn:     "supported",
			InterruptionAndSteering: "unsupported",
			UsageReportingSemantics: "incremental_per_turn",
		}
	case "generic-cli-in-execution":
		return AgentCapabilities{
			SameSessionContinuation: true,
			NativeAsyncInput:        true,
			Cancellation:            true,
			UsageReporting:          true,
			Sandbox:                 "agent-defined",
			InExecutionAsyncInput:   "supported",
			InExecutionToolDelivery: "supported",
			QueuedStdinNextTurn:     "supported",
			InterruptionAndSteering: "supported",
			UsageReportingSemantics: "single_turn_only",
		}
	default:
		return AgentCapabilities{
			SameSessionContinuation: sessions,
			NativeAsyncInput:        false,
			Cancellation:            true,
			UsageReporting:          true,
			Sandbox:                 "agent-defined",
			InExecutionAsyncInput:   "unsupported",
			InExecutionToolDelivery: "unsupported",
			QueuedStdinNextTurn:     "unsupported",
			InterruptionAndSteering: "unsupported",
			UsageReportingSemantics: "incremental_per_turn",
		}
	}
}

type NegotiatedDeliveryPlan struct {
	RequestedMode           string
	EffectiveMode           string
	PlannedEvidenceDelivery string
	Reason                  string
	FellBack                bool
}

func NegotiateEvidenceDeliveryMode(requestedMode string, caps *AgentCapabilities, strictDeliveryMode bool) (NegotiatedDeliveryPlan, error) {
	if requestedMode == "" {
		requestedMode = "two_turn"
	}
	supportsInExec := caps != nil && (caps.InExecutionAsyncInput == "supported" || caps.NativeAsyncInput)
	supportsSameSession := caps != nil && caps.SameSessionContinuation

	switch requestedMode {
	case "auto":
		if supportsInExec {
			return NegotiatedDeliveryPlan{
				RequestedMode:           requestedMode,
				EffectiveMode:           "in_execution",
				PlannedEvidenceDelivery: "in_execution_async_input",
				Reason:                  "runtime_supports_in_execution_async_input",
				FellBack:                false,
			}, nil
		}
		return NegotiatedDeliveryPlan{
			RequestedMode:           requestedMode,
			EffectiveMode:           "single_turn",
			PlannedEvidenceDelivery: "single_turn_with_evidence",
			Reason:                  "runtime_lacks_in_execution_async_input_selected_single_turn_fallback",
			FellBack:                true,
		}, nil
	case "in_execution":
		if supportsInExec {
			return NegotiatedDeliveryPlan{
				RequestedMode:           requestedMode,
				EffectiveMode:           "in_execution",
				PlannedEvidenceDelivery: "in_execution_async_input",
				Reason:                  "explicit_in_execution_supported_by_runtime",
				FellBack:                false,
			}, nil
		}
		if strictDeliveryMode {
			return NegotiatedDeliveryPlan{}, NewAgentError(AgentErrUnsupported, "start", "in_execution delivery requires an adapter with inExecutionAsyncInput=supported")
		}
		return NegotiatedDeliveryPlan{
			RequestedMode:           requestedMode,
			EffectiveMode:           "single_turn",
			PlannedEvidenceDelivery: "single_turn_with_evidence",
			Reason:                  "requested_in_execution_unsupported_by_runtime_fell_back_to_single_turn",
			FellBack:                true,
		}, nil
	case "single_turn":
		return NegotiatedDeliveryPlan{
			RequestedMode:           requestedMode,
			EffectiveMode:           "single_turn",
			PlannedEvidenceDelivery: "single_turn_with_evidence",
			Reason:                  "explicit_single_turn_with_evidence",
			FellBack:                false,
		}, nil
	case "two_turn":
		planned := "fresh_session_with_context"
		reason := "explicit_two_turn_fresh_session_with_context"
		if supportsSameSession {
			planned = "same_session_next_turn"
			reason = "explicit_two_turn_same_session_next_turn"
		}
		return NegotiatedDeliveryPlan{
			RequestedMode:           requestedMode,
			EffectiveMode:           "two_turn",
			PlannedEvidenceDelivery: planned,
			Reason:                  reason,
			FellBack:                !supportsSameSession,
		}, nil
	default:
		return NegotiatedDeliveryPlan{}, NewAgentError(AgentErrUnsupported, "start", "agentDelivery must be auto, in_execution, two_turn or single_turn")
	}
}

type InExecutionTurnResult struct {
	Turn                         AgentTurn
	EvidenceDeliveredInExecution bool
	EvidenceConsumedInExecution  bool
	EarlyAgentCompletion         bool
	DeliveryCount                int
}

type InExecutionAgentSession interface {
	AgentSession
	TurnInExecution(ctx context.Context, prompt string, supplyEvidence func() (string, error), emit EmitFunc) (InExecutionTurnResult, error)
}

type AgentTurn struct {
	Text     string         `json:"text"`
	Usage    map[string]any `json:"usage"`
	ThreadID *string        `json:"threadId"`
}

type AgentErrorKind string

const (
	AgentErrFailed      AgentErrorKind = "failed"
	AgentErrTimedOut    AgentErrorKind = "timed_out"
	AgentErrCancelled   AgentErrorKind = "cancelled"
	AgentErrProtocol    AgentErrorKind = "protocol"
	AgentErrUnsupported AgentErrorKind = "unsupported"
)

type AgentErrorReceipt struct {
	Kind    AgentErrorKind `json:"kind"`
	Phase   string         `json:"phase"`
	Message string         `json:"message"`
}

type AgentError struct {
	Kind       AgentErrorKind
	Phase      string
	RawMessage string
	Msg        string
}

func NewAgentError(kind AgentErrorKind, phase string, message string) *AgentError {
	redacted := Redact(message)
	return &AgentError{
		Kind:       kind,
		Phase:      phase,
		RawMessage: redacted,
		Msg:        fmt.Sprintf("Agent %s %s: %s", phase, kind, redacted),
	}
}

func (e *AgentError) Error() string {
	return e.Msg
}

func (e *AgentError) ToJSON() AgentErrorReceipt {
	return AgentErrorReceipt{
		Kind:    e.Kind,
		Phase:   e.Phase,
		Message: e.Msg,
	}
}

type AgentSession interface {
	ID() *string
	Turn(ctx context.Context, prompt string, phase string, emit EmitFunc) (AgentTurn, error)
}

type AgentAdapter interface {
	Name() string
	EventPrefix() string
	Capabilities() AgentCapabilities
	Start(ctx context.Context, workspace string) (AgentSession, error)
}

type GenericCliAgentOptions struct {
	Command          string
	Args             []string
	Sessions         bool
	TimeoutMs        int
	MaxOutputBytes   int
	NativeAsyncInput bool
	InExecutionAsync bool
}

var sessionIDPattern = regexp.MustCompile(`^[\w.-]{1,128}$`)
var mcpServerNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

const agentProtocol = "perfdigest-agent/v1"

func GenericCliAdapter(opts GenericCliAgentOptions) (AgentAdapter, error) {
	if strings.TrimSpace(opts.Command) == "" {
		return nil, NewAgentError(AgentErrUnsupported, "start", "generic CLI adapter requires a non-empty command")
	}
	if opts.NativeAsyncInput && !opts.InExecutionAsync {
		return nil, NewAgentError(AgentErrUnsupported, "start", "generic CLI adapter does not support nativeAsyncInput")
	}
	timeoutMs := opts.TimeoutMs
	if timeoutMs == 0 {
		timeoutMs = 120_000
	}
	if timeoutMs < 0 {
		return nil, NewAgentError(AgentErrUnsupported, "start", "timeoutMs must be a positive number")
	}
	maxOutputBytes := opts.MaxOutputBytes
	if maxOutputBytes <= 0 {
		maxOutputBytes = 1_048_576
	}

	return &genericAdapterImpl{
		opts:           opts,
		timeoutMs:      timeoutMs,
		maxOutputBytes: maxOutputBytes,
	}, nil
}

type genericAdapterImpl struct {
	opts           GenericCliAgentOptions
	timeoutMs      int
	maxOutputBytes int
}

func (a *genericAdapterImpl) Name() string        { return "generic-cli" }
func (a *genericAdapterImpl) EventPrefix() string { return "agent" }
func (a *genericAdapterImpl) Capabilities() AgentCapabilities {
	if a.opts.InExecutionAsync {
		return GetRuntimeCapabilityProfile("generic-cli-in-execution", true)
	}
	return AgentCapabilities{
		SameSessionContinuation: a.opts.Sessions,
		NativeAsyncInput:        false,
		Cancellation:            true,
		UsageReporting:          true,
		Sandbox:                 "agent-defined",
	}
}

func (a *genericAdapterImpl) Start(_ context.Context, workspace string) (AgentSession, error) {
	return &genericSessionImpl{
		adapter:   a,
		workspace: workspace,
	}, nil
}

type genericSessionImpl struct {
	adapter   *genericAdapterImpl
	workspace string
	sessionID *string
}

func (s *genericSessionImpl) ID() *string {
	return s.sessionID
}

func (s *genericSessionImpl) Turn(ctx context.Context, prompt string, phase string, emit EmitFunc) (AgentTurn, error) {
	if emit == nil {
		emit = func(string, string) {}
	}
	emit(fmt.Sprintf("agent.%s.started", phase), "")

	reqMap := map[string]any{
		"protocol":  agentProtocol,
		"phase":     phase,
		"prompt":    prompt,
		"sessionId": nil,
	}
	if s.adapter.opts.Sessions && s.sessionID != nil {
		reqMap["sessionId"] = *s.sessionID
	}
	inputBytes, _ := json.Marshal(reqMap)

	res, err := runGenericTurn(
		ctx,
		s.adapter.opts.Command,
		s.adapter.opts.Args,
		s.workspace,
		string(inputBytes),
		s.adapter.timeoutMs,
		s.adapter.maxOutputBytes,
		phase,
		func() {
			emit(fmt.Sprintf("agent.%s.turn_started", phase), "")
		},
	)
	if err != nil {
		if ae, ok := err.(*AgentError); ok {
			return AgentTurn{}, NewAgentError(ae.Kind, phase, ae.RawMessage)
		}
		return AgentTurn{}, NewAgentError(AgentErrFailed, phase, err.Error())
	}

	if s.adapter.opts.Sessions {
		if res.sessionID == nil || *res.sessionID == "" {
			return AgentTurn{}, NewAgentError(AgentErrProtocol, phase, "sessions were declared but no sessionId was returned")
		}
		if s.sessionID != nil && *res.sessionID != *s.sessionID {
			return AgentTurn{}, NewAgentError(AgentErrProtocol, phase, "session continuation was declared but not honored")
		}
		sid := *res.sessionID
		s.sessionID = &sid
	}

	emit(fmt.Sprintf("agent.%s.completed", phase), "")
	var tid *string
	if s.adapter.opts.Sessions && s.sessionID != nil {
		val := *s.sessionID
		tid = &val
	}
	return AgentTurn{
		Text:     Redact(res.text),
		Usage:    res.usage,
		ThreadID: tid,
	}, nil
}

func (s *genericSessionImpl) TurnInExecution(
	ctx context.Context,
	prompt string,
	supplyEvidence func() (string, error),
	emit EmitFunc,
) (InExecutionTurnResult, error) {
	if !s.adapter.opts.InExecutionAsync {
		return InExecutionTurnResult{}, NewAgentError(AgentErrUnsupported, "in_execution", "adapter does not have InExecutionAsync enabled")
	}
	if emit == nil {
		emit = func(string, string) {}
	}
	emit("agent.in_execution.started", "")
	emit("agent.analysis.started", "")

	reqMap := map[string]any{
		"protocol":  agentProtocol,
		"phase":     "in_execution",
		"prompt":    prompt,
		"sessionId": nil,
	}
	if s.adapter.opts.Sessions && s.sessionID != nil {
		reqMap["sessionId"] = *s.sessionID
	}
	inputBytes, _ := json.Marshal(reqMap)

	res, err := runGenericInExecutionTurn(
		ctx,
		s.adapter.opts.Command,
		s.adapter.opts.Args,
		s.workspace,
		string(inputBytes),
		supplyEvidence,
		s.adapter.timeoutMs,
		s.adapter.maxOutputBytes,
		emit,
	)
	if err != nil {
		if ae, ok := err.(*AgentError); ok {
			return InExecutionTurnResult{}, NewAgentError(ae.Kind, "in_execution", ae.RawMessage)
		}
		return InExecutionTurnResult{}, NewAgentError(AgentErrFailed, "in_execution", err.Error())
	}
	if s.adapter.opts.Sessions && res.turn.sessionID != nil && *res.turn.sessionID != "" {
		sid := *res.turn.sessionID
		s.sessionID = &sid
	}
	emit("agent.analysis.completed", "")
	emit("agent.review.completed", "")
	emit("agent.in_execution.completed", "")
	var tid *string
	if res.turn.sessionID != nil {
		val := *res.turn.sessionID
		tid = &val
	} else if s.adapter.opts.Sessions && s.sessionID != nil {
		val := *s.sessionID
		tid = &val
	}
	return InExecutionTurnResult{
		Turn: AgentTurn{
			Text:     Redact(res.turn.text),
			Usage:    res.turn.usage,
			ThreadID: tid,
		},
		EvidenceDeliveredInExecution: res.evidenceDelivered,
		EvidenceConsumedInExecution:  res.evidenceConsumed,
		EarlyAgentCompletion:         res.earlyCompletion,
		DeliveryCount:                res.deliveryCount,
	}, nil
}

type genericInExecutionResult struct {
	turn              genericTurnResult
	evidenceDelivered bool
	evidenceConsumed  bool
	earlyCompletion   bool
	deliveryCount     int
}

func runGenericInExecutionTurn(
	ctx context.Context,
	command string,
	args []string,
	cwd string,
	initialInput string,
	supplyEvidence func() (string, error),
	timeoutMs int,
	maxOutputBytes int,
	emit EmitFunc,
) (genericInExecutionResult, error) {
	if ctx != nil && ctx.Err() != nil {
		return genericInExecutionResult{}, NewAgentError(AgentErrCancelled, "in_execution", "run cancelled")
	}

	cmd := exec.Command(command, args...)
	cmd.Dir = cwd
	cmd.Env = ChildEnvSlice(nil)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return genericInExecutionResult{}, NewAgentError(AgentErrFailed, "in_execution", err.Error())
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return genericInExecutionResult{}, NewAgentError(AgentErrFailed, "in_execution", err.Error())
	}
	cmd.Stderr = io.Discard

	if err := cmd.Start(); err != nil {
		return genericInExecutionResult{}, NewAgentError(AgentErrFailed, "in_execution", err.Error())
	}

	var stdinMu sync.Mutex
	stdinClosed := false
	evidenceDelivered := false
	deliveryCount := 0
	processDone := make(chan struct{})

	_, _ = stdin.Write([]byte(initialInput + "\n"))

	supplyErrCh := make(chan error, 1)
	go func() {
		evPayload, serr := supplyEvidence()
		if serr != nil {
			supplyErrCh <- serr
			return
		}
		stdinMu.Lock()
		defer stdinMu.Unlock()
		select {
		case <-processDone:
			return
		default:
		}
		if stdinClosed || evidenceDelivered {
			return
		}
		evidenceDelivered = true
		deliveryCount++
		emit("evidence.delivered", "In-execution asynchronous evidence frame sent to active generic-cli stream")
		frame, _ := json.Marshal(map[string]any{
			"protocol": agentProtocol,
			"type":     "evidence",
			"evidence": evPayload,
		})
		_, _ = stdin.Write(append(frame, '\n'))
		_ = stdin.Close()
		stdinClosed = true
	}()

	var mu sync.Mutex
	var outBuf bytes.Buffer
	startedEmitted := false
	ackEmitted := false
	exceededLimit := false

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, 4096)
		for {
			n, rerr := stdout.Read(buf)
			if n > 0 {
				mu.Lock()
				if outBuf.Len()+n > maxOutputBytes {
					exceededLimit = true
					mu.Unlock()
					if cmd.Process != nil {
						_ = cmd.Process.Kill()
					}
					return
				}
				outBuf.Write(buf[:n])
				s := outBuf.String()
				shouldStart := !startedEmitted && (strings.Contains(s, `"type":"started"`) || strings.Contains(s, `"type": "started"`))
				if shouldStart {
					startedEmitted = true
				}
				shouldAck := !ackEmitted && (strings.Contains(s, `"type":"evidence_ack"`) || strings.Contains(s, `"type": "evidence_ack"`))
				if shouldAck {
					ackEmitted = true
				}
				mu.Unlock()
				if shouldStart {
					emit("agent.analysis.turn_started", "")
				}
				if shouldAck {
					emit("evidence.accepted_by_runtime", "generic-cli in-execution evidence_ack")
					emit("evidence.model_visible", "generic-cli in-execution stream")
				}
			}
			if rerr != nil {
				return
			}
		}
	}()

	waitCh := make(chan error, 1)
	go func() {
		<-readDone
		werr := cmd.Wait()
		close(processDone)
		waitCh <- werr
	}()

	timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
	defer timer.Stop()

	var ctxDone <-chan struct{}
	if ctx != nil {
		ctxDone = ctx.Done()
	}

	terminate := func() {
		stdinMu.Lock()
		if !stdinClosed {
			_ = stdin.Close()
			stdinClosed = true
		}
		stdinMu.Unlock()
		if cmd.Process == nil {
			return
		}
		_ = cmd.Process.Signal(syscall.SIGTERM)
		killTimer := time.AfterFunc(2*time.Second, func() {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		})
		<-waitCh
		killTimer.Stop()
	}

	var waitErr error
	select {
	case waitErr = <-waitCh:
	case serr := <-supplyErrCh:
		terminate()
		return genericInExecutionResult{}, serr
	case <-timer.C:
		terminate()
		return genericInExecutionResult{}, NewAgentError(AgentErrTimedOut, "in_execution", fmt.Sprintf("no result within %d ms", timeoutMs))
	case <-ctxDone:
		terminate()
		return genericInExecutionResult{}, NewAgentError(AgentErrCancelled, "in_execution", "run cancelled")
	}

	mu.Lock()
	overLimit := exceededLimit
	rawOut := outBuf.String()
	didAck := ackEmitted
	mu.Unlock()

	if overLimit {
		return genericInExecutionResult{}, NewAgentError(AgentErrProtocol, "in_execution", "agent output exceeded the limit")
	}
	if waitErr != nil {
		code := -1
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
		return genericInExecutionResult{}, NewAgentError(AgentErrFailed, "in_execution", fmt.Sprintf("agent exited with code %d", code))
	}

	rawLines := strings.Split(rawOut, "\n")
	var results []map[string]any
	sawAckLine := false
	for _, l := range rawLines {
		trimmed := strings.TrimSpace(l)
		if trimmed == "" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
			return genericInExecutionResult{}, NewAgentError(AgentErrProtocol, "in_execution", "agent output did not follow perfdigest-agent/v1")
		}
		t, _ := obj["type"].(string)
		if t != "started" && t != "progress" && t != "awaiting_evidence" && t != "evidence_ack" && t != "result" {
			return genericInExecutionResult{}, NewAgentError(AgentErrProtocol, "in_execution", "agent output did not follow perfdigest-agent/v1")
		}
		if t == "evidence_ack" {
			sawAckLine = true
		}
		if t == "result" {
			results = append(results, obj)
		}
	}
	if len(results) != 1 {
		return genericInExecutionResult{}, NewAgentError(AgentErrProtocol, "in_execution", "agent output did not follow perfdigest-agent/v1")
	}

	r := results[0]
	txt, ok := r["text"].(string)
	if !ok || txt == "" {
		return genericInExecutionResult{}, NewAgentError(AgentErrProtocol, "in_execution", "agent output did not follow perfdigest-agent/v1")
	}

	var sidPtr *string
	if sidRaw, hasSid := r["sessionId"]; hasSid && sidRaw != nil {
		sidStr, ok := sidRaw.(string)
		if !ok || !sessionIDPattern.MatchString(sidStr) {
			return genericInExecutionResult{}, NewAgentError(AgentErrProtocol, "in_execution", "agent output did not follow perfdigest-agent/v1")
		}
		sidPtr = &sidStr
	}

	var usageMap map[string]any
	if uRaw, hasU := r["usage"]; hasU && uRaw != nil {
		if um, ok := uRaw.(map[string]any); ok {
			usageMap = um
		}
	}

	stdinMu.Lock()
	delivered := evidenceDelivered
	delCount := deliveryCount
	stdinMu.Unlock()

	earlyCompletion := !delivered
	evConsumedFlag, _ := r["evidenceConsumed"].(bool)
	consumed := delivered && (evConsumedFlag || sawAckLine)
	if earlyCompletion {
		emit("agent.in_execution.completed_before_evidence", "Agent solved and exited before background evidence arrived")
	} else if consumed {
		if !didAck {
			emit("evidence.accepted_by_runtime", "generic-cli in-execution result")
			emit("evidence.model_visible", "generic-cli in-execution stream")
		}
		emit("evidence.consumed", "Agent consumed in-execution evidence in single execution")
	}

	return genericInExecutionResult{
		turn: genericTurnResult{
			text:      txt,
			sessionID: sidPtr,
			usage:     usageMap,
		},
		evidenceDelivered: delivered,
		evidenceConsumed:  consumed,
		earlyCompletion:   earlyCompletion,
		deliveryCount:     delCount,
	}, nil
}

type genericTurnResult struct {
	text      string
	sessionID *string
	usage     map[string]any
}

func runGenericTurn(
	ctx context.Context,
	command string,
	args []string,
	cwd string,
	inputLine string,
	timeoutMs int,
	maxOutputBytes int,
	phase string,
	onStarted func(),
) (genericTurnResult, error) {
	if ctx != nil && ctx.Err() != nil {
		return genericTurnResult{}, NewAgentError(AgentErrCancelled, phase, "run cancelled")
	}

	cmd := exec.Command(command, args...)
	cmd.Dir = cwd
	cmd.Env = ChildEnvSlice(nil)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return genericTurnResult{}, NewAgentError(AgentErrFailed, phase, err.Error())
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return genericTurnResult{}, NewAgentError(AgentErrFailed, phase, err.Error())
	}
	cmd.Stderr = io.Discard

	if err := cmd.Start(); err != nil {
		return genericTurnResult{}, NewAgentError(AgentErrFailed, phase, err.Error())
	}

	_, _ = stdin.Write([]byte(inputLine + "\n"))
	_ = stdin.Close()

	var mu sync.Mutex
	var outBuf bytes.Buffer
	startedEmitted := false
	exceededLimit := false

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, 4096)
		for {
			n, rerr := stdout.Read(buf)
			if n > 0 {
				mu.Lock()
				if outBuf.Len()+n > maxOutputBytes {
					exceededLimit = true
					mu.Unlock()
					if cmd.Process != nil {
						_ = cmd.Process.Kill()
					}
					return
				}
				outBuf.Write(buf[:n])
				s := outBuf.String()
				shouldEmit := !startedEmitted && (strings.Contains(s, `"type":"started"`) || strings.Contains(s, `"type": "started"`))
				if shouldEmit {
					startedEmitted = true
				}
				mu.Unlock()
				if shouldEmit && onStarted != nil {
					onStarted()
				}
			}
			if rerr != nil {
				return
			}
		}
	}()

	waitCh := make(chan error, 1)
	go func() {
		<-readDone
		waitCh <- cmd.Wait()
	}()

	timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
	defer timer.Stop()

	var ctxDone <-chan struct{}
	if ctx != nil {
		ctxDone = ctx.Done()
	}

	terminate := func() {
		if cmd.Process == nil {
			return
		}
		_ = cmd.Process.Signal(syscall.SIGTERM)
		killTimer := time.AfterFunc(2*time.Second, func() {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		})
		<-waitCh
		killTimer.Stop()
	}

	var waitErr error
	select {
	case waitErr = <-waitCh:
	case <-timer.C:
		terminate()
		return genericTurnResult{}, NewAgentError(AgentErrTimedOut, phase, fmt.Sprintf("no result within %d ms", timeoutMs))
	case <-ctxDone:
		terminate()
		return genericTurnResult{}, NewAgentError(AgentErrCancelled, phase, "run cancelled")
	}

	mu.Lock()
	overLimit := exceededLimit
	rawOut := outBuf.String()
	mu.Unlock()

	if overLimit {
		return genericTurnResult{}, NewAgentError(AgentErrProtocol, phase, "agent output exceeded the limit")
	}

	if waitErr != nil {
		code := -1
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		}
		return genericTurnResult{}, NewAgentError(AgentErrFailed, phase, fmt.Sprintf("agent exited with code %d", code))
	}

	rawLines := strings.Split(rawOut, "\n")
	var results []map[string]any
	for _, l := range rawLines {
		trimmed := strings.TrimSpace(l)
		if trimmed == "" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
			return genericTurnResult{}, NewAgentError(AgentErrProtocol, phase, "agent output did not follow perfdigest-agent/v1")
		}
		t, _ := obj["type"].(string)
		if t != "started" && t != "result" {
			return genericTurnResult{}, NewAgentError(AgentErrProtocol, phase, "agent output did not follow perfdigest-agent/v1")
		}
		if t == "result" {
			results = append(results, obj)
		}
	}
	if len(results) != 1 {
		return genericTurnResult{}, NewAgentError(AgentErrProtocol, phase, "agent output did not follow perfdigest-agent/v1")
	}

	r := results[0]
	txt, ok := r["text"].(string)
	if !ok || txt == "" {
		return genericTurnResult{}, NewAgentError(AgentErrProtocol, phase, "agent output did not follow perfdigest-agent/v1")
	}

	var sidPtr *string
	if sidRaw, hasSid := r["sessionId"]; hasSid && sidRaw != nil {
		sidStr, ok := sidRaw.(string)
		if !ok || !sessionIDPattern.MatchString(sidStr) {
			return genericTurnResult{}, NewAgentError(AgentErrProtocol, phase, "agent output did not follow perfdigest-agent/v1")
		}
		sidPtr = &sidStr
	}

	var usageMap map[string]any
	if uRaw, hasU := r["usage"]; hasU && uRaw != nil {
		if um, ok := uRaw.(map[string]any); ok {
			usageMap = um
		}
	}

	return genericTurnResult{
		text:      txt,
		sessionID: sidPtr,
		usage:     usageMap,
	}, nil
}

// DisabledMcpOverrides builds config override strings for disabling inherited MCP servers in Codex.
func DisabledMcpOverrides(names []string) ([]string, error) {
	out := make([]string, len(names))
	for i, name := range names {
		if !mcpServerNamePattern.MatchString(name) {
			return nil, fmt.Errorf("Unsupported inherited MCP name; cannot isolate this Codex run")
		}
		out[i] = fmt.Sprintf(`mcp_servers.%s={command="false",enabled=false}`, name)
	}
	return out, nil
}

func CodexAdapter(model string, effort string) AgentAdapter {
	if effort == "" {
		effort = "low"
	}
	return &codexAdapterImpl{
		model:  model,
		effort: effort,
	}
}

type codexAdapterImpl struct {
	model  string
	effort string
}

func (c *codexAdapterImpl) Name() string        { return "codex" }
func (c *codexAdapterImpl) EventPrefix() string { return "codex" }
func (c *codexAdapterImpl) Capabilities() AgentCapabilities {
	return AgentCapabilities{
		SameSessionContinuation: true,
		NativeAsyncInput:        false,
		Cancellation:            true,
		UsageReporting:          true,
		Sandbox:                 "read-only",
	}
}

func (c *codexAdapterImpl) Start(ctx context.Context, workspace string) (AgentSession, error) {
	binName := os.Getenv("PERFDIGEST_CODEX_PATH")
	if binName == "" {
		binName = "codex"
	}
	binary, err := Executable(binName, nil)
	if err != nil {
		return nil, err
	}
	envSlice := ChildEnvSlice(nil)

	loginCtx, cancelLogin := context.WithTimeout(ctxOrBg(ctx), 15*time.Second)
	defer cancelLogin()
	loginCmd := exec.CommandContext(loginCtx, binary, "login", "status")
	loginCmd.Env = envSlice
	loginOut, err := loginCmd.CombinedOutput()
	if err != nil || !strings.Contains(strings.ToLower(string(loginOut)), "logged in using chatgpt") {
		return nil, fmt.Errorf("This MVP requires an existing ChatGPT Codex login. Run codex login first.")
	}

	listCtx, cancelList := context.WithTimeout(ctxOrBg(ctx), 15*time.Second)
	defer cancelList()
	listCmd := exec.CommandContext(listCtx, binary, "mcp", "list", "--json")
	listCmd.Dir = workspace
	listCmd.Env = envSlice
	listOut, err := listCmd.Output()
	if err != nil {
		return nil, err
	}
	var servers []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(listOut, &servers); err != nil {
		return nil, err
	}
	names := make([]string, len(servers))
	for i, s := range servers {
		names[i] = s.Name
	}
	overrides, err := DisabledMcpOverrides(names)
	if err != nil {
		return nil, err
	}

	return &codexSessionImpl{
		binary:    binary,
		workspace: workspace,
		envSlice:  envSlice,
		overrides: overrides,
		model:     c.model,
		effort:    c.effort,
	}, nil
}

type codexSessionImpl struct {
	binary    string
	workspace string
	envSlice  []string
	overrides []string
	model     string
	effort    string
	threadID  *string
}

func (s *codexSessionImpl) ID() *string {
	return s.threadID
}

func (s *codexSessionImpl) Turn(ctx context.Context, prompt string, phase string, emit EmitFunc) (AgentTurn, error) {
	if emit == nil {
		emit = func(string, string) {}
	}
	emit(fmt.Sprintf("codex.%s.started", phase), "")

	args := []string{
		"exec",
		"--experimental-json",
		"--cd", s.workspace,
		"--skip-git-repo-check",
		"--sandbox", "read-only",
		"--config", `approval_policy="never"`,
		"--config", fmt.Sprintf(`model_reasoning_effort="%s"`, s.effort),
		"--config", "features.multi_agent=false",
		"--config", "features.shell_tool=false",
		"--config", "features.shell_snapshot=false",
		"--config", "features.hooks=false",
		"--config", "features.memories=false",
		"--config", "features.plugins=false",
	}
	for _, ov := range s.overrides {
		args = append(args, "--config", ov)
	}
	if s.model != "" {
		args = append(args, "--model", s.model)
	}
	if s.threadID != nil && *s.threadID != "" {
		args = append(args, "resume", *s.threadID)
	}

	cmd := exec.CommandContext(ctxOrBg(ctx), s.binary, args...)
	cmd.Dir = s.workspace
	cmd.Env = s.envSlice
	cmd.Stdin = strings.NewReader(prompt)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return AgentTurn{}, err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return AgentTurn{}, err
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var text string
	var usage map[string]any
	completed := false

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			continue
		}
		evType, _ := ev["type"].(string)
		switch evType {
		case "thread.started":
			if tid, ok := ev["thread_id"].(string); ok && tid != "" {
				s.threadID = &tid
			}
		case "turn.started":
			emit(fmt.Sprintf("codex.%s.turn_started", phase), "")
		case "turn.failed":
			if errObj, ok := ev["error"].(map[string]any); ok {
				msg, _ := errObj["message"].(string)
				_ = cmd.Wait()
				return AgentTurn{}, fmt.Errorf("%s", Redact(msg))
			}
			_ = cmd.Wait()
			return AgentTurn{}, fmt.Errorf("Codex turn failed")
		case "error":
			msg, _ := ev["message"].(string)
			_ = cmd.Wait()
			return AgentTurn{}, fmt.Errorf("%s", Redact(msg))
		case "item.completed":
			if item, ok := ev["item"].(map[string]any); ok && item["type"] == "agent_message" {
				if t, ok := item["text"].(string); ok {
					text = Redact(t)
				}
			}
		case "turn.completed":
			if u, ok := ev["usage"].(map[string]any); ok {
				usage = u
			}
			completed = true
		}
	}
	_ = cmd.Wait()
	if !completed || text == "" {
		return AgentTurn{}, fmt.Errorf("Codex ended without a completed response")
	}
	emit(fmt.Sprintf("codex.%s.completed", phase), "")
	return AgentTurn{
		Text:     text,
		Usage:    usage,
		ThreadID: s.threadID,
	}, nil
}
