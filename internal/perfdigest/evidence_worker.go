package perfdigest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"
)

const (
	SkillBackgroundDeliveryMode  = "skill_background_worker"
	DefaultEvidenceWaitTimeoutMs = 30_000
	MaxEvidenceWaitTimeoutMs     = 300_000
)

var (
	evidenceJobIDPattern  = regexp.MustCompile(`^[a-zA-Z0-9_-]{8,80}$`)
	evidenceSha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type EvidenceReadyReceipt struct {
	Version              int     `json:"version"`
	DeliveryMode         string  `json:"deliveryMode"`
	JobID                string  `json:"jobId"`
	Status               string  `json:"status"`
	DecisionOutcome      string  `json:"decisionOutcome"`
	CompletedAt          string  `json:"completedAt"`
	RunDir               string  `json:"runDir"`
	RunJsonPath          string  `json:"runJsonPath"`
	EvidencePath         string  `json:"evidencePath"`
	ReadyPath            string  `json:"readyPath"`
	EvidenceSha256       string  `json:"evidenceSha256"`
	VerificationExitCode *int    `json:"verificationExitCode"`
	ProvenanceCount      int     `json:"provenanceCount"`
	Error                *string `json:"error"`
}

type EvidenceJobState struct {
	Version              int     `json:"version"`
	DeliveryMode         string  `json:"deliveryMode"`
	JobID                string  `json:"jobId"`
	PID                  *int    `json:"pid"`
	ProcessStartID       *string `json:"processStartId"`
	WorkerMarker         string  `json:"workerMarker"`
	Status               string  `json:"status"`
	StartedAt            string  `json:"startedAt"`
	UpdatedAt            string  `json:"updatedAt"`
	CompletedAt          *string `json:"completedAt"`
	Workspace            string  `json:"workspace"`
	RunDir               string  `json:"runDir"`
	RunJsonPath          string  `json:"runJsonPath"`
	EvidencePath         string  `json:"evidencePath"`
	ReadyPath            string  `json:"readyPath"`
	StatusPath           string  `json:"statusPath"`
	LogPath              string  `json:"logPath"`
	Routing              string  `json:"routing"`
	DecisionOutcome      *string `json:"decisionOutcome"`
	VerificationExitCode *int    `json:"verificationExitCode"`
	ProvenanceCount      int     `json:"provenanceCount"`
	Error                *string `json:"error"`
}

type EvidenceRunOutput struct {
	Version              int            `json:"version"`
	DeliveryMode         string         `json:"deliveryMode"`
	JobID                string         `json:"jobId"`
	Status               string         `json:"status"`
	DecisionOutcome      string         `json:"decisionOutcome"`
	RunDir               string         `json:"runDir"`
	RunJsonPath          string         `json:"runJsonPath"`
	EvidencePath         string         `json:"evidencePath"`
	ReadyPath            string         `json:"readyPath"`
	EvidenceSha256       string         `json:"evidenceSha256"`
	VerificationExitCode *int           `json:"verificationExitCode"`
	ProvenanceCount      int            `json:"provenanceCount"`
	Error                *string        `json:"error"`
	Packet               map[string]any `json:"packet"`
}

type EvidenceStartOutput struct {
	Version      int    `json:"version"`
	DeliveryMode string `json:"deliveryMode"`
	JobID        string `json:"jobId"`
	PID          int    `json:"pid"`
	Status       string `json:"status"`
	StatusPath   string `json:"statusPath"`
	ReadyPath    string `json:"readyPath"`
	RunDir       string `json:"runDir"`
}

type EvidenceStatusOutput struct {
	Version              int     `json:"version"`
	DeliveryMode         string  `json:"deliveryMode"`
	JobID                string  `json:"jobId"`
	PID                  *int    `json:"pid"`
	Status               string  `json:"status"`
	Ready                bool    `json:"ready"`
	StartedAt            string  `json:"startedAt"`
	UpdatedAt            string  `json:"updatedAt"`
	CompletedAt          *string `json:"completedAt"`
	ElapsedMs            int64   `json:"elapsedMs"`
	RunDir               string  `json:"runDir"`
	RunJsonPath          string  `json:"runJsonPath"`
	EvidencePath         string  `json:"evidencePath"`
	ReadyPath            string  `json:"readyPath"`
	StatusPath           string  `json:"statusPath"`
	DecisionOutcome      *string `json:"decisionOutcome"`
	VerificationExitCode *int    `json:"verificationExitCode"`
	ProvenanceCount      int     `json:"provenanceCount"`
	EvidenceSha256       *string `json:"evidenceSha256"`
	Error                *string `json:"error"`
}

type EvidenceWaitOutput struct {
	Version              int            `json:"version"`
	DeliveryMode         string         `json:"deliveryMode"`
	JobID                string         `json:"jobId"`
	Status               string         `json:"status"`
	TimedOut             bool           `json:"timedOut"`
	WaitedMs             int64          `json:"waitedMs"`
	DecisionOutcome      *string        `json:"decisionOutcome"`
	RunDir               string         `json:"runDir"`
	RunJsonPath          string         `json:"runJsonPath"`
	EvidencePath         string         `json:"evidencePath"`
	ReadyPath            string         `json:"readyPath"`
	EvidenceSha256       *string        `json:"evidenceSha256"`
	VerificationExitCode *int           `json:"verificationExitCode"`
	ProvenanceCount      int            `json:"provenanceCount"`
	Error                *string        `json:"error"`
	Packet               map[string]any `json:"packet"`
}

type EvidenceCollectOutput struct {
	Version              int            `json:"version"`
	DeliveryMode         string         `json:"deliveryMode"`
	JobID                string         `json:"jobId"`
	Status               string         `json:"status"`
	DecisionOutcome      string         `json:"decisionOutcome"`
	RunDir               string         `json:"runDir"`
	RunJsonPath          string         `json:"runJsonPath"`
	EvidencePath         string         `json:"evidencePath"`
	ReadyPath            string         `json:"readyPath"`
	EvidenceSha256       string         `json:"evidenceSha256"`
	VerifiedSha256       bool           `json:"verifiedSha256"`
	VerificationExitCode *int           `json:"verificationExitCode"`
	ProvenanceCount      int            `json:"provenanceCount"`
	Error                *string        `json:"error"`
	Packet               map[string]any `json:"packet"`
	Run                  *RunResult     `json:"run,omitempty"`
}

type EvidenceCancelOutput struct {
	Version         int     `json:"version"`
	DeliveryMode    string  `json:"deliveryMode"`
	JobID           string  `json:"jobId"`
	Status          string  `json:"status"`
	AlreadyTerminal bool    `json:"alreadyTerminal"`
	SignalSent      *string `json:"signalSent"`
	Note            string  `json:"note,omitempty"`
}

type workerRequestFile struct {
	Version              int      `json:"version"`
	JobID                string   `json:"jobId"`
	Routing              string   `json:"routing"`
	CloudflareModel      *string  `json:"cloudflareModel,omitempty"`
	CompactEvidence      bool     `json:"compactEvidence"`
	IncludeCorroborating bool     `json:"includeCorroborating"`
	DecisionsMockURL     string   `json:"decisionsMockURL,omitempty"`
	LocalEndpoint        string   `json:"localEndpoint,omitempty"`
	McpCommand           string   `json:"mcpCommand,omitempty"`
	McpArgs              []string `json:"mcpArgs,omitempty"`
	ReuseMcpSession      *bool    `json:"reuseMcpSession,omitempty"`
}

type EvidenceWorkerRunOptions struct {
	Workspace              string
	Manifest               Manifest
	Routing                string
	JobID                  string
	CloudflareModel        *string
	CompactEvidence        *bool
	IncludeCorroborating   bool
	DecisionsMockURL       string
	DecisionProvider       DecisionProvider
	McpSessionOptions      *SessionOptions
	ReuseMcpSession        *bool
	OnEvent                EmitFunc
	PreserveCancelledState bool
}

type EvidenceWorkerStartOptions struct {
	Workspace            string
	Manifest             Manifest
	Routing              string
	JobID                string
	CloudflareModel      *string
	CompactEvidence      *bool
	IncludeCorroborating bool
	DecisionsMockURL     string
	McpSessionOptions    *SessionOptions
	ReuseMcpSession      *bool
	WorkerCommand        string
	WorkerArgsPrefix     []string
}

type evidenceJobPaths struct {
	workspace           string
	jobID               string
	jobDir              string
	runDir              string
	statusPath          string
	requestPath         string
	manifestCopyPath    string
	cancelledMarkerPath string
	logPath             string
	runJsonPath         string
	evidencePath        string
	readyPath           string
}

func ValidateEvidenceJobID(jobID string) (string, error) {
	if !evidenceJobIDPattern.MatchString(jobID) {
		return "", errors.New("Invalid jobId: must be 8 to 80 characters matching ^[a-zA-Z0-9_-]+$")
	}
	return jobID, nil
}

func GenerateEvidenceJobID() string {
	ts := time.Now().UTC().Format("20060102T150405Z")
	return fmt.Sprintf("ev-%s-%s", ts, randomHex(4))
}

func utcISO(t time.Time) string {
	return t.UTC().Round(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func sha256HexBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func resolveEvidenceJobPaths(workspace, jobID string, createExclusive bool) (evidenceJobPaths, error) {
	validID, err := ValidateEvidenceJobID(jobID)
	if err != nil {
		return evidenceJobPaths{}, err
	}
	root, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return evidenceJobPaths{}, err
	}
	var jobDir, runDir string
	if createExclusive {
		jobDir, err = CreateExclusiveDirectory(root, validID, ".perfdigest", "jobs")
		if err != nil {
			if os.IsExist(err) {
				return evidenceJobPaths{}, fmt.Errorf("Evidence job already exists: %s", validID)
			}
			return evidenceJobPaths{}, err
		}
		runDir, err = CreateExclusiveDirectory(root, validID, ".perfdigest", "runs")
		if err != nil {
			_ = os.RemoveAll(jobDir)
			if os.IsExist(err) {
				return evidenceJobPaths{}, fmt.Errorf("Evidence job already exists: %s", validID)
			}
			return evidenceJobPaths{}, err
		}
	} else {
		jobDir = filepath.Join(root, ".perfdigest", "jobs", validID)
		runDir = filepath.Join(root, ".perfdigest", "runs", validID)
	}
	return evidenceJobPaths{
		workspace:           root,
		jobID:               validID,
		jobDir:              jobDir,
		runDir:              runDir,
		statusPath:          filepath.Join(jobDir, "state.json"),
		requestPath:         filepath.Join(jobDir, "request.json"),
		manifestCopyPath:    filepath.Join(jobDir, "manifest.json"),
		cancelledMarkerPath: filepath.Join(jobDir, "cancelled.marker"),
		logPath:             filepath.Join(jobDir, "worker.log"),
		runJsonPath:         filepath.Join(runDir, "run.json"),
		evidencePath:        filepath.Join(runDir, "evidence.v1.json"),
		readyPath:           filepath.Join(runDir, "ready.json"),
	}, nil
}

func readContainedJSON[T any](workspace, filePath string) (*T, error) {
	safePath, err := AssertContainedRegularFile(workspace, filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	raw, err := os.ReadFile(safePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func hasCancelledMarker(workspace, markerPath string) (bool, error) {
	_, err := AssertContainedRegularFile(workspace, markerPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func createCancelledMarker(markerPath, jobID string) error {
	f, err := os.OpenFile(markerPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return nil
		}
		return err
	}
	payload, _ := json.Marshal(map[string]string{
		"jobId":       jobID,
		"cancelledAt": utcISO(time.Now()),
	})
	_, werr := f.Write(append(payload, '\n'))
	_ = f.Sync()
	cerr := f.Close()
	_ = os.Chmod(markerPath, 0o600)
	if werr != nil {
		return werr
	}
	return cerr
}

func strPtrIfNonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}

func computeElapsedSinceISO(startedAt string, endAt *string) int64 {
	startT, err := time.Parse(time.RFC3339Nano, startedAt)
	if err != nil {
		return 0
	}
	endT := time.Now().UTC()
	if endAt != nil && *endAt != "" {
		if parsed, perr := time.Parse(time.RFC3339Nano, *endAt); perr == nil {
			endT = parsed
		}
	}
	ms := endT.Sub(startT).Milliseconds()
	if ms < 0 {
		return 0
	}
	return ms
}

// RunEvidenceWorker executes the blocking foreground evidence worker, writing atomic 0600
// run.json, evidence.v1.json, ready.json (last-renamed with SHA-256), and state.json.
func RunEvidenceWorker(ctx context.Context, options EvidenceWorkerRunOptions) (EvidenceRunOutput, error) {
	manifest, err := ValidateManifest(options.Manifest)
	if err != nil {
		return EvidenceRunOutput{}, err
	}
	jobID := options.JobID
	if jobID == "" {
		jobID = GenerateEvidenceJobID()
	}
	paths, err := resolveEvidenceJobPaths(options.Workspace, jobID, !options.PreserveCancelledState)
	if err != nil {
		return EvidenceRunOutput{}, err
	}
	compact := true
	if options.CompactEvidence != nil {
		compact = *options.CompactEvidence
	}
	startedAt := utcISO(time.Now())

	// Check cancellation BEFORE starting investigate() so pre-PID cancel prevents captures/verification.
	if options.PreserveCancelledState {
		marked, _ := hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)
		existingState, _ := readContainedJSON[EvidenceJobState](paths.workspace, paths.statusPath)
		if marked || (existingState != nil && existingState.Status == "cancelled") || (ctx != nil && ctx.Err() != nil) {
			return EvidenceRunOutput{}, errors.New("Background evidence worker was cancelled")
		}
	}

	res, err := Investigate(ctx, RunOptions{
		Workspace:                paths.workspace,
		Manifest:                 manifest,
		Routing:                  options.Routing,
		Agent:                    "none",
		RunDirectory:             paths.runDir,
		EvidenceDeliveryOverride: SkillBackgroundDeliveryMode,
		CompactEvidence:          &compact,
		CloudflareModel:          options.CloudflareModel,
		IncludeCorroborating:     options.IncludeCorroborating,
		DecisionsMockURL:         options.DecisionsMockURL,
		DecisionProvider:         options.DecisionProvider,
		McpSessionOptions:        options.McpSessionOptions,
		ReuseMcpSession:          options.ReuseMcpSession,
		OnEvent:                  options.OnEvent,
	})
	if err != nil {
		return EvidenceRunOutput{}, err
	}

	formattedRaw := FormatAgentEvidence(res.Evidence, res.Verification, res.Status, compact)
	redactedText := Redact(formattedRaw) + "\n"
	redactedBytes := []byte(redactedText)
	evidenceSha256 := sha256HexBytes(redactedBytes)

	var packet map[string]any
	if err := json.Unmarshal(redactedBytes, &packet); err != nil {
		return EvidenceRunOutput{}, err
	}

	// Atomically write evidence.v1.json first (0600).
	if err := WritePrivateFile(paths.evidencePath, redactedBytes); err != nil {
		return EvidenceRunOutput{}, err
	}

	// Re-check cancelled.marker RIGHT BEFORE sealing ready.json so cancel and completion never conflict.
	if options.PreserveCancelledState {
		marked, _ := hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)
		existingState, _ := readContainedJSON[EvidenceJobState](paths.workspace, paths.statusPath)
		if marked || (existingState != nil && existingState.Status == "cancelled") || (ctx != nil && ctx.Err() != nil) {
			_ = os.Remove(paths.evidencePath)
			return EvidenceRunOutput{}, errors.New("Background evidence worker was cancelled")
		}
	}

	completedAt := utcISO(time.Now())
	var verExit *int
	if res.Verification != nil {
		verExit = res.Verification.ExitCode
	}
	var redactedErr *string
	if res.Error != nil {
		e := Redact(*res.Error)
		redactedErr = &e
	}

	readyReceipt := EvidenceReadyReceipt{
		Version:              1,
		DeliveryMode:         SkillBackgroundDeliveryMode,
		JobID:                paths.jobID,
		Status:               res.Status,
		DecisionOutcome:      res.DecisionOutcome,
		CompletedAt:          completedAt,
		RunDir:               paths.runDir,
		RunJsonPath:          paths.runJsonPath,
		EvidencePath:         paths.evidencePath,
		ReadyPath:            paths.readyPath,
		EvidenceSha256:       evidenceSha256,
		VerificationExitCode: verExit,
		ProvenanceCount:      len(res.Provenance),
		Error:                redactedErr,
	}
	if err := WriteJSON(paths.readyPath, readyReceipt); err != nil {
		return EvidenceRunOutput{}, err
	}

	existingState, _ := readContainedJSON[EvidenceJobState](paths.workspace, paths.statusPath)
	marked, _ := hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)
	if !options.PreserveCancelledState || (!marked && (existingState == nil || existingState.Status != "cancelled")) {
		pid := os.Getpid()
		pidPtr := &pid
		startIDPtr := strPtrIfNonEmpty(readProcessStartID(pid))
		marker := paths.jobID
		stateStartedAt := startedAt
		if existingState != nil {
			if existingState.PID != nil {
				pidPtr = existingState.PID
			}
			if existingState.ProcessStartID != nil {
				startIDPtr = existingState.ProcessStartID
			}
			if existingState.WorkerMarker != "" {
				marker = existingState.WorkerMarker
			}
			if existingState.StartedAt != "" {
				stateStartedAt = existingState.StartedAt
			}
		}
		outcome := res.DecisionOutcome
		finalState := EvidenceJobState{
			Version:              1,
			DeliveryMode:         SkillBackgroundDeliveryMode,
			JobID:                paths.jobID,
			PID:                  pidPtr,
			ProcessStartID:       startIDPtr,
			WorkerMarker:         marker,
			Status:               res.Status,
			StartedAt:            stateStartedAt,
			UpdatedAt:            completedAt,
			CompletedAt:          &completedAt,
			Workspace:            paths.workspace,
			RunDir:               paths.runDir,
			RunJsonPath:          paths.runJsonPath,
			EvidencePath:         paths.evidencePath,
			ReadyPath:            paths.readyPath,
			StatusPath:           paths.statusPath,
			LogPath:              paths.logPath,
			Routing:              options.Routing,
			DecisionOutcome:      &outcome,
			VerificationExitCode: verExit,
			ProvenanceCount:      len(res.Provenance),
			Error:                redactedErr,
		}
		if err := WriteJSON(paths.statusPath, finalState); err != nil {
			return EvidenceRunOutput{}, err
		}
	}

	return EvidenceRunOutput{
		Version:              1,
		DeliveryMode:         SkillBackgroundDeliveryMode,
		JobID:                paths.jobID,
		Status:               res.Status,
		DecisionOutcome:      res.DecisionOutcome,
		RunDir:               paths.runDir,
		RunJsonPath:          paths.runJsonPath,
		EvidencePath:         paths.evidencePath,
		ReadyPath:            paths.readyPath,
		EvidenceSha256:       evidenceSha256,
		VerificationExitCode: verExit,
		ProvenanceCount:      len(res.Provenance),
		Error:                redactedErr,
		Packet:               packet,
	}, nil
}

// StartEvidenceWorker validates manifest and provider preflight synchronously, reserves exclusive job dirs,
// and spawns a detached background worker process without shell or secrets on argv/env.
func StartEvidenceWorker(options EvidenceWorkerStartOptions) (EvidenceStartOutput, error) {
	manifest, err := ValidateManifest(options.Manifest)
	if err != nil {
		return EvidenceStartOutput{}, err
	}
	workspace, err := filepath.EvalSymlinks(options.Workspace)
	if err != nil {
		return EvidenceStartOutput{}, err
	}
	pName, err := ProviderName(options.Routing)
	if err != nil {
		return EvidenceStartOutput{}, err
	}
	if _, err := CreateDecisionProvider(options.Routing, DecisionProviderOptions{
		CloudflareModel:  options.CloudflareModel,
		DecisionsMockURL: options.DecisionsMockURL,
	}); err != nil {
		return EvidenceStartOutput{}, err
	}

	jobID := options.JobID
	if jobID == "" {
		jobID = GenerateEvidenceJobID()
	}
	paths, err := resolveEvidenceJobPaths(workspace, jobID, true)
	if err != nil {
		return EvidenceStartOutput{}, err
	}

	compact := true
	if options.CompactEvidence != nil {
		compact = *options.CompactEvidence
	}
	localEndpoint := ""
	if pName == "local" {
		if raw := os.Getenv("PERFDIGEST_CLEF_URL"); raw != "" {
			validEp, epErr := ValidateLocalEndpoint(raw)
			if epErr != nil {
				return EvidenceStartOutput{}, epErr
			}
			localEndpoint = validEp
		}
	}

	reqFile := workerRequestFile{
		Version:              1,
		JobID:                paths.jobID,
		Routing:              options.Routing,
		CloudflareModel:      options.CloudflareModel,
		CompactEvidence:      compact,
		IncludeCorroborating: options.IncludeCorroborating,
		DecisionsMockURL:     options.DecisionsMockURL,
		LocalEndpoint:        localEndpoint,
		ReuseMcpSession:      options.ReuseMcpSession,
	}
	if options.McpSessionOptions != nil {
		reqFile.McpCommand = options.McpSessionOptions.Command
		reqFile.McpArgs = append([]string(nil), options.McpSessionOptions.Args...)
	}

	if err := WriteJSON(paths.manifestCopyPath, manifest); err != nil {
		return EvidenceStartOutput{}, err
	}
	if err := WriteJSON(paths.requestPath, reqFile); err != nil {
		return EvidenceStartOutput{}, err
	}

	startedAt := utcISO(time.Now())
	initialState := EvidenceJobState{
		Version:      1,
		DeliveryMode: SkillBackgroundDeliveryMode,
		JobID:        paths.jobID,
		WorkerMarker: paths.jobID,
		Status:       "running",
		StartedAt:    startedAt,
		UpdatedAt:    startedAt,
		Workspace:    paths.workspace,
		RunDir:       paths.runDir,
		RunJsonPath:  paths.runJsonPath,
		EvidencePath: paths.evidencePath,
		ReadyPath:    paths.readyPath,
		StatusPath:   paths.statusPath,
		LogPath:      paths.logPath,
		Routing:      options.Routing,
	}
	if err := WriteJSON(paths.statusPath, initialState); err != nil {
		return EvidenceStartOutput{}, err
	}

	workerCmd := options.WorkerCommand
	if workerCmd == "" {
		exe, exeErr := os.Executable()
		if exeErr != nil {
			return EvidenceStartOutput{}, exeErr
		}
		workerCmd = exe
	}
	workerArgs := append([]string(nil), options.WorkerArgsPrefix...)
	workerArgs = append(workerArgs, "evidence", "_worker", "--workspace", paths.workspace, "--job-id", paths.jobID)

	logFile, err := os.OpenFile(paths.logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return EvidenceStartOutput{}, err
	}
	_ = os.Chmod(paths.logPath, 0o600)

	cmd := exec.Command(workerCmd, workerArgs...)
	cmd.Dir = paths.workspace
	cmd.Env = ChildEnvSlice(nil)
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	configureDetachedProcess(cmd)

	startErr := cmd.Start()
	_ = logFile.Close()
	if startErr != nil {
		return EvidenceStartOutput{}, startErr
	}

	pid := cmd.Process.Pid
	startID := readProcessStartID(pid)
	startIDPtr := strPtrIfNonEmpty(startID)
	_ = cmd.Process.Release()

	now := utcISO(time.Now())
	if marked, _ := hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath); marked {
		if alive, owned := checkWorkerProcessStatus(pid, startID, paths.jobID); alive && owned {
			signalProcessGroupByPID(pid, false)
		}
		errMsg := "Cancelled during startup"
		cancelledState := initialState
		cancelledState.PID = &pid
		cancelledState.ProcessStartID = startIDPtr
		cancelledState.Status = "cancelled"
		cancelledState.UpdatedAt = now
		cancelledState.CompletedAt = &now
		cancelledState.Error = &errMsg
		_ = WriteJSON(paths.statusPath, cancelledState)
		return EvidenceStartOutput{
			Version:      1,
			DeliveryMode: SkillBackgroundDeliveryMode,
			JobID:        paths.jobID,
			PID:          pid,
			Status:       "running",
			StatusPath:   paths.statusPath,
			ReadyPath:    paths.readyPath,
			RunDir:       paths.runDir,
		}, nil
	}

	readyAlready, _ := readContainedJSON[EvidenceReadyReceipt](paths.workspace, paths.readyPath)
	updatedState := initialState
	updatedState.PID = &pid
	updatedState.ProcessStartID = startIDPtr
	updatedState.UpdatedAt = now
	if readyAlready != nil {
		updatedState.Status = readyAlready.Status
		updatedState.CompletedAt = &readyAlready.CompletedAt
		outcome := readyAlready.DecisionOutcome
		updatedState.DecisionOutcome = &outcome
		updatedState.VerificationExitCode = readyAlready.VerificationExitCode
		updatedState.ProvenanceCount = readyAlready.ProvenanceCount
		updatedState.Error = readyAlready.Error
	}
	if err := WriteJSON(paths.statusPath, updatedState); err != nil {
		return EvidenceStartOutput{}, err
	}

	return EvidenceStartOutput{
		Version:      1,
		DeliveryMode: SkillBackgroundDeliveryMode,
		JobID:        paths.jobID,
		PID:          pid,
		Status:       "running",
		StatusPath:   paths.statusPath,
		ReadyPath:    paths.readyPath,
		RunDir:       paths.runDir,
	}, nil
}

// RunDetachedEvidenceWorker executes a previously started background job inside the detached child process.
func RunDetachedEvidenceWorker(ctx context.Context, workspace, jobID string) error {
	paths, err := resolveEvidenceJobPaths(workspace, jobID, false)
	if err != nil {
		return err
	}
	if marked, _ := hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath); marked {
		return nil
	}
	if st, _ := readContainedJSON[EvidenceJobState](paths.workspace, paths.statusPath); st != nil && st.Status == "cancelled" {
		return nil
	}
	if ctx != nil && ctx.Err() != nil {
		return nil
	}

	req, err := readContainedJSON[workerRequestFile](paths.workspace, paths.requestPath)
	if err != nil {
		return err
	}
	if req == nil || req.JobID != paths.jobID {
		return fmt.Errorf("Missing or invalid worker request for job %s", paths.jobID)
	}
	safeManifestPath, err := AssertContainedRegularFile(paths.workspace, paths.manifestCopyPath)
	if err != nil {
		return err
	}
	rawManifest, err := os.ReadFile(safeManifestPath)
	if err != nil {
		return err
	}
	manifest, err := ParseManifest(rawManifest)
	if err != nil {
		return err
	}

	pName, err := ProviderName(req.Routing)
	if err != nil {
		return err
	}
	// Load private envFile credentials strictly inside the worker process (never on argv or request.json).
	configured, err := LoadConfiguration(paths.workspace)
	if err != nil {
		return err
	}
	if configured != nil && pName != "offline" {
		if err := ApplyConfigurationEnvironment(*configured, paths.workspace, nil); err != nil {
			return err
		}
	}
	if req.LocalEndpoint != "" && pName == "local" && os.Getenv("PERFDIGEST_CLEF_URL") == "" {
		validEp, epErr := ValidateLocalEndpoint(req.LocalEndpoint)
		if epErr != nil {
			return epErr
		}
		_ = os.Setenv("PERFDIGEST_CLEF_URL", validEp)
	}

	var mcpOpts *SessionOptions
	if req.McpCommand != "" || len(req.McpArgs) > 0 {
		cmd := req.McpCommand
		if cmd == "" {
			cmd = "uvx"
		}
		mcpOpts = &SessionOptions{
			Command: cmd,
			Args:    req.McpArgs,
		}
	}

	compact := req.CompactEvidence
	_, runErr := RunEvidenceWorker(ctx, EvidenceWorkerRunOptions{
		Workspace:              paths.workspace,
		Manifest:               manifest,
		Routing:                req.Routing,
		JobID:                  paths.jobID,
		CloudflareModel:        req.CloudflareModel,
		CompactEvidence:        &compact,
		IncludeCorroborating:   req.IncludeCorroborating,
		DecisionsMockURL:       req.DecisionsMockURL,
		McpSessionOptions:      mcpOpts,
		ReuseMcpSession:        req.ReuseMcpSession,
		PreserveCancelledState: true,
	})
	if runErr != nil {
		marked, _ := hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)
		existingState, _ := readContainedJSON[EvidenceJobState](paths.workspace, paths.statusPath)
		if marked || (existingState != nil && existingState.Status == "cancelled") || (ctx != nil && ctx.Err() != nil) {
			return nil
		}
		errText := Redact(runErr.Error())
		failedPacket := map[string]any{
			"schema":       "perfdigest.agent-evidence.v1",
			"status":       "failed",
			"decision":     nil,
			"selected":     []any{},
			"verification": nil,
			"error":        errText,
		}
		rawPkt, _ := json.Marshal(failedPacket)
		failedBytes := []byte(Redact(string(rawPkt)) + "\n")
		evidenceSha256 := sha256HexBytes(failedBytes)
		completedAt := utcISO(time.Now())

		_ = WritePrivateFile(paths.evidencePath, failedBytes)
		if markedNow, _ := hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath); markedNow {
			_ = os.Remove(paths.evidencePath)
			return nil
		}
		readyReceipt := EvidenceReadyReceipt{
			Version:         1,
			DeliveryMode:    SkillBackgroundDeliveryMode,
			JobID:           paths.jobID,
			Status:          "failed",
			DecisionOutcome: "not_reached",
			CompletedAt:     completedAt,
			RunDir:          paths.runDir,
			RunJsonPath:     paths.runJsonPath,
			EvidencePath:    paths.evidencePath,
			ReadyPath:       paths.readyPath,
			EvidenceSha256:  evidenceSha256,
			ProvenanceCount: 0,
			Error:           &errText,
		}
		_ = WriteJSON(paths.readyPath, readyReceipt)

		pid := os.Getpid()
		pidPtr := &pid
		startIDPtr := strPtrIfNonEmpty(readProcessStartID(pid))
		startedAt := completedAt
		marker := paths.jobID
		if existingState != nil {
			if existingState.PID != nil {
				pidPtr = existingState.PID
			}
			if existingState.ProcessStartID != nil {
				startIDPtr = existingState.ProcessStartID
			}
			if existingState.StartedAt != "" {
				startedAt = existingState.StartedAt
			}
			if existingState.WorkerMarker != "" {
				marker = existingState.WorkerMarker
			}
		}
		outcome := "not_reached"
		failedState := EvidenceJobState{
			Version:         1,
			DeliveryMode:    SkillBackgroundDeliveryMode,
			JobID:           paths.jobID,
			PID:             pidPtr,
			ProcessStartID:  startIDPtr,
			WorkerMarker:    marker,
			Status:          "failed",
			StartedAt:       startedAt,
			UpdatedAt:       completedAt,
			CompletedAt:     &completedAt,
			Workspace:       paths.workspace,
			RunDir:          paths.runDir,
			RunJsonPath:     paths.runJsonPath,
			EvidencePath:    paths.evidencePath,
			ReadyPath:       paths.readyPath,
			StatusPath:      paths.statusPath,
			LogPath:         paths.logPath,
			Routing:         req.Routing,
			DecisionOutcome: &outcome,
			ProvenanceCount: 0,
			Error:           &errText,
		}
		_ = WriteJSON(paths.statusPath, failedState)
		return runErr
	}
	return nil
}

// GetEvidenceWorkerStatus returns non-blocking job status, combining state.json, ready.json,
// cancelled.marker, and fail-closed OS PID liveness/ownership checks.
func GetEvidenceWorkerStatus(workspace, jobID string) (EvidenceStatusOutput, error) {
	paths, err := resolveEvidenceJobPaths(workspace, jobID, false)
	if err != nil {
		return EvidenceStatusOutput{}, err
	}
	state, err := readContainedJSON[EvidenceJobState](paths.workspace, paths.statusPath)
	if err != nil {
		return EvidenceStatusOutput{}, err
	}
	if state == nil || state.JobID != paths.jobID {
		return EvidenceStatusOutput{}, fmt.Errorf("Evidence job not found: %s", paths.jobID)
	}

	makeFromReady := func(ready *EvidenceReadyReceipt) EvidenceStatusOutput {
		outcome := ready.DecisionOutcome
		sha := ready.EvidenceSha256
		comp := ready.CompletedAt
		return EvidenceStatusOutput{
			Version:              1,
			DeliveryMode:         SkillBackgroundDeliveryMode,
			JobID:                paths.jobID,
			PID:                  state.PID,
			Status:               ready.Status,
			Ready:                true,
			StartedAt:            state.StartedAt,
			UpdatedAt:            ready.CompletedAt,
			CompletedAt:          &comp,
			ElapsedMs:            computeElapsedSinceISO(state.StartedAt, &comp),
			RunDir:               paths.runDir,
			RunJsonPath:          paths.runJsonPath,
			EvidencePath:         paths.evidencePath,
			ReadyPath:            paths.readyPath,
			StatusPath:           paths.statusPath,
			DecisionOutcome:      &outcome,
			VerificationExitCode: ready.VerificationExitCode,
			ProvenanceCount:      ready.ProvenanceCount,
			EvidenceSha256:       &sha,
			Error:                ready.Error,
		}
	}

	makeFromState := func(st *EvidenceJobState, overrideStatus string) EvidenceStatusOutput {
		statusStr := st.Status
		if overrideStatus != "" {
			statusStr = overrideStatus
		}
		return EvidenceStatusOutput{
			Version:              1,
			DeliveryMode:         SkillBackgroundDeliveryMode,
			JobID:                paths.jobID,
			PID:                  st.PID,
			Status:               statusStr,
			Ready:                false,
			StartedAt:            st.StartedAt,
			UpdatedAt:            st.UpdatedAt,
			CompletedAt:          st.CompletedAt,
			ElapsedMs:            computeElapsedSinceISO(st.StartedAt, st.CompletedAt),
			RunDir:               paths.runDir,
			RunJsonPath:          paths.runJsonPath,
			EvidencePath:         paths.evidencePath,
			ReadyPath:            paths.readyPath,
			StatusPath:           paths.statusPath,
			DecisionOutcome:      st.DecisionOutcome,
			VerificationExitCode: st.VerificationExitCode,
			ProvenanceCount:      st.ProvenanceCount,
			EvidenceSha256:       nil,
			Error:                st.Error,
		}
	}

	ready, err := readContainedJSON[EvidenceReadyReceipt](paths.workspace, paths.readyPath)
	if err != nil {
		return EvidenceStatusOutput{}, err
	}
	if ready != nil {
		return makeFromReady(ready), nil
	}
	marked, merr := hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)
	if merr != nil {
		return EvidenceStatusOutput{}, merr
	}
	if state.Status == "cancelled" || marked {
		return makeFromState(state, "cancelled"), nil
	}
	if state.Status != "running" {
		return makeFromState(state, ""), nil
	}

	pid := 0
	if state.PID != nil {
		pid = *state.PID
	}
	startID := ""
	if state.ProcessStartID != nil {
		startID = *state.ProcessStartID
	}
	marker := state.WorkerMarker
	if marker == "" {
		marker = paths.jobID
	}
	alive, owned := checkWorkerProcessStatus(pid, startID, marker)
	if alive && owned {
		return EvidenceStatusOutput{
			Version:      1,
			DeliveryMode: SkillBackgroundDeliveryMode,
			JobID:        paths.jobID,
			PID:          state.PID,
			Status:       "running",
			Ready:        false,
			StartedAt:    state.StartedAt,
			UpdatedAt:    state.UpdatedAt,
			CompletedAt:  nil,
			ElapsedMs:    computeElapsedSinceISO(state.StartedAt, nil),
			RunDir:       paths.runDir,
			RunJsonPath:  paths.runJsonPath,
			EvidencePath: paths.evidencePath,
			ReadyPath:    paths.readyPath,
			StatusPath:   paths.statusPath,
		}, nil
	}

	// Re-check ready.json and cancellation once to guard against normal exit right before liveness check.
	readyRetry, _ := readContainedJSON[EvidenceReadyReceipt](paths.workspace, paths.readyPath)
	if readyRetry != nil {
		return makeFromReady(readyRetry), nil
	}
	stateRetry, _ := readContainedJSON[EvidenceJobState](paths.workspace, paths.statusPath)
	markedRetry, _ := hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)
	if (stateRetry != nil && stateRetry.Status == "cancelled") || markedRetry {
		if stateRetry != nil {
			return makeFromState(stateRetry, "cancelled"), nil
		}
		return makeFromState(state, "cancelled"), nil
	}

	crashMsg := "Background evidence worker process is no longer running and no ready.json receipt was produced"
	now := utcISO(time.Now())
	return EvidenceStatusOutput{
		Version:      1,
		DeliveryMode: SkillBackgroundDeliveryMode,
		JobID:        paths.jobID,
		PID:          state.PID,
		Status:       "crashed",
		Ready:        false,
		StartedAt:    state.StartedAt,
		UpdatedAt:    now,
		CompletedAt:  nil,
		ElapsedMs:    computeElapsedSinceISO(state.StartedAt, nil),
		RunDir:       paths.runDir,
		RunJsonPath:  paths.runJsonPath,
		EvidencePath: paths.evidencePath,
		ReadyPath:    paths.readyPath,
		StatusPath:   paths.statusPath,
		Error:        &crashMsg,
	}, nil
}

// CollectEvidenceWorker verifies ready.json SHA-256 against evidence.v1.json (fail-closed)
// and returns the verified packet (plus run.json when full is true) idempotently.
func CollectEvidenceWorker(workspace, jobID string, full bool) (EvidenceCollectOutput, error) {
	paths, err := resolveEvidenceJobPaths(workspace, jobID, false)
	if err != nil {
		return EvidenceCollectOutput{}, err
	}
	state, err := readContainedJSON[EvidenceJobState](paths.workspace, paths.statusPath)
	if err != nil {
		return EvidenceCollectOutput{}, err
	}
	if state == nil || state.JobID != paths.jobID {
		return EvidenceCollectOutput{}, fmt.Errorf("Evidence job not found: %s", paths.jobID)
	}
	ready, err := readContainedJSON[EvidenceReadyReceipt](paths.workspace, paths.readyPath)
	if err != nil {
		return EvidenceCollectOutput{}, err
	}
	if ready == nil {
		marked, _ := hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)
		if state.Status == "cancelled" || marked {
			return EvidenceCollectOutput{}, fmt.Errorf("Evidence job %s was cancelled", paths.jobID)
		}
		st, stErr := GetEvidenceWorkerStatus(paths.workspace, paths.jobID)
		if stErr != nil {
			return EvidenceCollectOutput{}, stErr
		}
		return EvidenceCollectOutput{}, fmt.Errorf("Evidence job %s is not ready (status: %s)", paths.jobID, st.Status)
	}
	if ready.JobID != paths.jobID {
		return EvidenceCollectOutput{}, errors.New("Evidence integrity check failed: ready.json jobId mismatch")
	}
	if !evidenceSha256Pattern.MatchString(ready.EvidenceSha256) {
		return EvidenceCollectOutput{}, errors.New("Evidence integrity check failed: invalid evidenceSha256 in ready.json")
	}

	safeEvidencePath, err := AssertContainedRegularFile(paths.workspace, paths.evidencePath)
	if err != nil {
		return EvidenceCollectOutput{}, err
	}
	evidenceBytes, err := os.ReadFile(safeEvidencePath)
	if err != nil {
		return EvidenceCollectOutput{}, err
	}
	actualSha := sha256HexBytes(evidenceBytes)
	if actualSha != ready.EvidenceSha256 {
		return EvidenceCollectOutput{}, fmt.Errorf(
			"Evidence integrity check failed: evidence.v1.json SHA-256 mismatch (expected %s, got %s)",
			ready.EvidenceSha256,
			actualSha,
		)
	}

	var packet map[string]any
	if err := json.Unmarshal(evidenceBytes, &packet); err != nil {
		return EvidenceCollectOutput{}, err
	}

	var fullRun *RunResult
	if full {
		safeRunPath, err := AssertContainedRegularFile(paths.workspace, paths.runJsonPath)
		if err != nil {
			return EvidenceCollectOutput{}, err
		}
		rawRun, err := os.ReadFile(safeRunPath)
		if err != nil {
			return EvidenceCollectOutput{}, err
		}
		var parsedRun RunResult
		if err := json.Unmarshal(rawRun, &parsedRun); err != nil {
			return EvidenceCollectOutput{}, err
		}
		fullRun = &parsedRun
	}

	return EvidenceCollectOutput{
		Version:              1,
		DeliveryMode:         SkillBackgroundDeliveryMode,
		JobID:                paths.jobID,
		Status:               ready.Status,
		DecisionOutcome:      ready.DecisionOutcome,
		RunDir:               paths.runDir,
		RunJsonPath:          paths.runJsonPath,
		EvidencePath:         paths.evidencePath,
		ReadyPath:            paths.readyPath,
		EvidenceSha256:       actualSha,
		VerifiedSha256:       true,
		VerificationExitCode: ready.VerificationExitCode,
		ProvenanceCount:      ready.ProvenanceCount,
		Error:                ready.Error,
		Packet:               packet,
		Run:                  fullRun,
	}, nil
}

// WaitEvidenceWorker blocks up to timeoutMs (0..300000) for ready.json or worker exit,
// returning the verified compact packet when terminal.
func WaitEvidenceWorker(ctx context.Context, workspace, jobID string, timeoutMs int) (EvidenceWaitOutput, error) {
	if timeoutMs < 0 || timeoutMs > MaxEvidenceWaitTimeoutMs {
		return EvidenceWaitOutput{}, fmt.Errorf("timeoutMs must be an integer between 0 and %d", MaxEvidenceWaitTimeoutMs)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	start := time.Now()
	deadline := start.Add(time.Duration(timeoutMs) * time.Millisecond)

	for {
		status, err := GetEvidenceWorkerStatus(workspace, jobID)
		if err != nil {
			return EvidenceWaitOutput{}, err
		}
		if status.Status != "running" {
			waitedMs := time.Since(start).Milliseconds()
			if waitedMs < 0 {
				waitedMs = 0
			}
			if status.Ready && status.Status != "cancelled" {
				collected, cerr := CollectEvidenceWorker(workspace, jobID, false)
				if cerr != nil {
					return EvidenceWaitOutput{}, cerr
				}
				outcome := collected.DecisionOutcome
				sha := collected.EvidenceSha256
				return EvidenceWaitOutput{
					Version:              1,
					DeliveryMode:         SkillBackgroundDeliveryMode,
					JobID:                collected.JobID,
					Status:               collected.Status,
					TimedOut:             false,
					WaitedMs:             waitedMs,
					DecisionOutcome:      &outcome,
					RunDir:               collected.RunDir,
					RunJsonPath:          collected.RunJsonPath,
					EvidencePath:         collected.EvidencePath,
					ReadyPath:            collected.ReadyPath,
					EvidenceSha256:       &sha,
					VerificationExitCode: collected.VerificationExitCode,
					ProvenanceCount:      collected.ProvenanceCount,
					Error:                collected.Error,
					Packet:               collected.Packet,
				}, nil
			}
			return EvidenceWaitOutput{
				Version:              1,
				DeliveryMode:         SkillBackgroundDeliveryMode,
				JobID:                status.JobID,
				Status:               status.Status,
				TimedOut:             false,
				WaitedMs:             waitedMs,
				DecisionOutcome:      status.DecisionOutcome,
				RunDir:               status.RunDir,
				RunJsonPath:          status.RunJsonPath,
				EvidencePath:         status.EvidencePath,
				ReadyPath:            status.ReadyPath,
				EvidenceSha256:       status.EvidenceSha256,
				VerificationExitCode: status.VerificationExitCode,
				ProvenanceCount:      status.ProvenanceCount,
				Error:                status.Error,
				Packet:               nil,
			}, nil
		}

		remaining := time.Until(deadline)
		if remaining <= 0 {
			waitedMs := time.Since(start).Milliseconds()
			if waitedMs < 0 {
				waitedMs = 0
			}
			return EvidenceWaitOutput{
				Version:      1,
				DeliveryMode: SkillBackgroundDeliveryMode,
				JobID:        status.JobID,
				Status:       "running",
				TimedOut:     true,
				WaitedMs:     waitedMs,
				RunDir:       status.RunDir,
				RunJsonPath:  status.RunJsonPath,
				EvidencePath: status.EvidencePath,
				ReadyPath:    status.ReadyPath,
			}, nil
		}
		sleepDur := 50 * time.Millisecond
		if remaining < sleepDur {
			sleepDur = remaining
		}
		timer := time.NewTimer(sleepDur)
		select {
		case <-ctx.Done():
			timer.Stop()
			return EvidenceWaitOutput{}, ctx.Err()
		case <-timer.C:
		}
	}
}

// CancelEvidenceWorker uses an atomic cancelled.marker + post-marker ready.json re-check,
// verifies fail-closed PID + job ownership, terminates the worker process group
// (SIGTERM then SIGKILL), and atomically updates state.json to cancelled.
func CancelEvidenceWorker(workspace, jobID string) (EvidenceCancelOutput, error) {
	paths, err := resolveEvidenceJobPaths(workspace, jobID, false)
	if err != nil {
		return EvidenceCancelOutput{}, err
	}
	state, err := readContainedJSON[EvidenceJobState](paths.workspace, paths.statusPath)
	if err != nil {
		return EvidenceCancelOutput{}, err
	}
	if state == nil || state.JobID != paths.jobID {
		return EvidenceCancelOutput{}, fmt.Errorf("Evidence job not found: %s", paths.jobID)
	}
	readyBefore, err := readContainedJSON[EvidenceReadyReceipt](paths.workspace, paths.readyPath)
	if err != nil {
		return EvidenceCancelOutput{}, err
	}
	if readyBefore != nil {
		return EvidenceCancelOutput{
			Version:         1,
			DeliveryMode:    SkillBackgroundDeliveryMode,
			JobID:           paths.jobID,
			Status:          readyBefore.Status,
			AlreadyTerminal: true,
			SignalSent:      nil,
		}, nil
	}
	if state.Status == "cancelled" {
		return EvidenceCancelOutput{
			Version:         1,
			DeliveryMode:    SkillBackgroundDeliveryMode,
			JobID:           paths.jobID,
			Status:          "cancelled",
			AlreadyTerminal: true,
			SignalSent:      nil,
		}, nil
	}
	if state.Status != "running" {
		return EvidenceCancelOutput{
			Version:         1,
			DeliveryMode:    SkillBackgroundDeliveryMode,
			JobID:           paths.jobID,
			Status:          state.Status,
			AlreadyTerminal: true,
			SignalSent:      nil,
		}, nil
	}

	// Atomically create exclusive cancelled.marker first, then re-check ready.json to prevent cancel/complete conflict.
	if err := createCancelledMarker(paths.cancelledMarkerPath, paths.jobID); err != nil {
		return EvidenceCancelOutput{}, err
	}
	readyAfter, err := readContainedJSON[EvidenceReadyReceipt](paths.workspace, paths.readyPath)
	if err != nil {
		return EvidenceCancelOutput{}, err
	}
	if readyAfter != nil {
		_ = os.Remove(paths.cancelledMarkerPath)
		return EvidenceCancelOutput{
			Version:         1,
			DeliveryMode:    SkillBackgroundDeliveryMode,
			JobID:           paths.jobID,
			Status:          readyAfter.Status,
			AlreadyTerminal: true,
			SignalSent:      nil,
		}, nil
	}

	// Re-read state.json so a PID recorded just before cancel is observed.
	latestState, _ := readContainedJSON[EvidenceJobState](paths.workspace, paths.statusPath)
	if latestState == nil {
		latestState = state
	}

	pid := 0
	if latestState.PID != nil {
		pid = *latestState.PID
	}
	startID := ""
	if latestState.ProcessStartID != nil {
		startID = *latestState.ProcessStartID
	}
	marker := latestState.WorkerMarker
	if marker == "" {
		marker = paths.jobID
	}
	alive, owned := checkWorkerProcessStatus(pid, startID, marker)

	markCancelled := func(errMsg string) error {
		now := utcISO(time.Now())
		cancelled := *latestState
		cancelled.Status = "cancelled"
		cancelled.UpdatedAt = now
		cancelled.CompletedAt = &now
		msg := Redact(errMsg)
		cancelled.Error = &msg
		return WriteJSON(paths.statusPath, cancelled)
	}

	if alive && !owned {
		if err := markCancelled("PID ownership mismatch; skipped signal"); err != nil {
			return EvidenceCancelOutput{}, err
		}
		return EvidenceCancelOutput{
			Version:         1,
			DeliveryMode:    SkillBackgroundDeliveryMode,
			JobID:           paths.jobID,
			Status:          "cancelled",
			AlreadyTerminal: false,
			SignalSent:      nil,
			Note:            "pid_ownership_mismatch_skipped_signal",
		}, nil
	}

	if err := markCancelled("Cancelled by caller"); err != nil {
		return EvidenceCancelOutput{}, err
	}

	var signalSent *string
	if alive && owned && pid > 0 {
		if signalProcessGroupByPID(pid, false) {
			s := "SIGTERM"
			signalSent = &s
		}
		termDeadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(termDeadline) {
			a, o := checkWorkerProcessStatus(pid, startID, marker)
			if !a || !o {
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
		if a, o := checkWorkerProcessStatus(pid, startID, marker); a && o {
			if signalProcessGroupByPID(pid, true) {
				s := "SIGKILL"
				signalSent = &s
			}
			killDeadline := time.Now().Add(500 * time.Millisecond)
			for time.Now().Before(killDeadline) {
				a2, o2 := checkWorkerProcessStatus(pid, startID, marker)
				if !a2 || !o2 {
					break
				}
				time.Sleep(25 * time.Millisecond)
			}
		}
	}

	return EvidenceCancelOutput{
		Version:         1,
		DeliveryMode:    SkillBackgroundDeliveryMode,
		JobID:           paths.jobID,
		Status:          "cancelled",
		AlreadyTerminal: false,
		SignalSent:      signalSent,
	}, nil
}
