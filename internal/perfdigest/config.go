package perfdigest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
)

var reportIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

type CommandSpec struct {
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	TimeoutMs int      `json:"timeoutMs,omitempty"`
}

func (c *CommandSpec) UnmarshalJSON(data []byte) error {
	type rawCommand struct {
		Command   *string   `json:"command"`
		Args      *[]string `json:"args"`
		TimeoutMs *int      `json:"timeoutMs"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var rc rawCommand
	if err := dec.Decode(&rc); err != nil {
		return err
	}
	if rc.Command == nil || len(*rc.Command) < 1 {
		return fmt.Errorf("command must be a non-empty string")
	}
	c.Command = *rc.Command
	if rc.Args == nil {
		c.Args = []string{}
	} else {
		if len(*rc.Args) > 100 {
			return fmt.Errorf("args cannot exceed 100 items")
		}
		c.Args = *rc.Args
	}
	if rc.TimeoutMs == nil {
		c.TimeoutMs = 30_000
	} else {
		if *rc.TimeoutMs < 100 || *rc.TimeoutMs > 120_000 {
			return fmt.Errorf("timeoutMs must be between 100 and 120000")
		}
		c.TimeoutMs = *rc.TimeoutMs
	}
	return nil
}

type ReportSpec struct {
	ID          string `json:"id"`
	Path        string `json:"path"`
	Format      string `json:"format"`
	Description string `json:"description"`
}

func (r *ReportSpec) UnmarshalJSON(data []byte) error {
	type rawReport struct {
		ID          *string `json:"id"`
		Path        *string `json:"path"`
		Format      *string `json:"format"`
		Description *string `json:"description"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var rr rawReport
	if err := dec.Decode(&rr); err != nil {
		return err
	}
	if rr.ID == nil || !reportIDPattern.MatchString(*rr.ID) {
		return fmt.Errorf("invalid report id")
	}
	if *rr.ID == "__human_review__" {
		return fmt.Errorf("Reserved routing choice")
	}
	if rr.Path == nil || len(*rr.Path) < 1 {
		return fmt.Errorf("report path is required")
	}
	if rr.Format == nil || len(*rr.Format) < 1 {
		return fmt.Errorf("report format is required")
	}
	if rr.Description == nil || len(*rr.Description) > 1000 {
		return fmt.Errorf("report description is required and at most 1000 characters")
	}
	r.ID = *rr.ID
	r.Path = *rr.Path
	r.Format = *rr.Format
	r.Description = *rr.Description
	return nil
}

type Manifest struct {
	Version      int           `json:"version"`
	Issue        string        `json:"issue"`
	Captures     []CommandSpec `json:"captures"`
	Reports      []ReportSpec  `json:"reports"`
	Verification CommandSpec   `json:"verification"`
}

func ParseManifest(data []byte) (Manifest, error) {
	type rawManifest struct {
		Version      *int           `json:"version"`
		Issue        *string        `json:"issue"`
		Captures     *[]CommandSpec `json:"captures"`
		Reports      *[]ReportSpec  `json:"reports"`
		Verification *CommandSpec   `json:"verification"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var rm rawManifest
	if err := dec.Decode(&rm); err != nil {
		return Manifest{}, err
	}
	if rm.Version == nil || *rm.Version != 1 {
		return Manifest{}, fmt.Errorf("manifest version must be 1")
	}
	if rm.Issue == nil || len(*rm.Issue) < 1 || len(*rm.Issue) > 12_000 {
		return Manifest{}, fmt.Errorf("issue must be between 1 and 12000 characters")
	}
	captures := []CommandSpec{}
	if rm.Captures != nil {
		if len(*rm.Captures) > 4 {
			return Manifest{}, fmt.Errorf("at most 4 captures allowed")
		}
		captures = *rm.Captures
	}
	if rm.Reports == nil || len(*rm.Reports) < 1 || len(*rm.Reports) > 8 {
		return Manifest{}, fmt.Errorf("manifest must declare 1 to 8 reports")
	}
	seen := make(map[string]bool, len(*rm.Reports))
	for _, rep := range *rm.Reports {
		if seen[rep.ID] {
			return Manifest{}, fmt.Errorf("Report IDs must be unique")
		}
		seen[rep.ID] = true
	}
	if rm.Verification == nil {
		return Manifest{}, fmt.Errorf("verification command is required")
	}
	return Manifest{
		Version:      1,
		Issue:        *rm.Issue,
		Captures:     captures,
		Reports:      *rm.Reports,
		Verification: *rm.Verification,
	}, nil
}

func ValidateManifest(m Manifest) (Manifest, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return Manifest{}, err
	}
	return ParseManifest(raw)
}

type TimelineEvent struct {
	Event     string  `json:"event"`
	At        string  `json:"at"`
	ElapsedMs float64 `json:"elapsedMs"`
	Detail    string  `json:"detail,omitempty"`
}

type EmitFunc func(event string, detail string)

type CommandReceipt struct {
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	StartedAt string   `json:"startedAt"`
	ElapsedMs float64  `json:"elapsedMs"`
	ExitCode  *int     `json:"exitCode"`
	Signal    *string  `json:"signal"`
	TimedOut  bool     `json:"timedOut"`
	Aborted   bool     `json:"aborted"`
	Stdout    string   `json:"stdout"`
	Stderr    string   `json:"stderr"`
}

type ProbabilityEntry struct {
	Value       any     `json:"value"`
	Label       string  `json:"label,omitempty"`
	Probability float64 `json:"probability"`
}

type RouteDecision struct {
	Source              string             `json:"source"`
	Provider            string             `json:"provider,omitempty"`
	Model               string             `json:"model,omitempty"`
	RequestedModel      string             `json:"requestedModel,omitempty"`
	ConfidenceSemantics string             `json:"confidenceSemantics,omitempty"`
	Transport           string             `json:"transport,omitempty"`
	InputSha256         string             `json:"inputSha256,omitempty"`
	EvidenceCount       *int               `json:"evidenceCount,omitempty"`
	SelectedID          *string            `json:"selectedId"`
	Confidence          *float64           `json:"confidence"`
	Probabilities       []ProbabilityEntry `json:"probabilities,omitempty"`
	Reason              string             `json:"reason"`
	LatencyMs           float64            `json:"latencyMs"`
	Requests            int                `json:"requests"`
	InputTokens         *int               `json:"inputTokens"`
	OutputTokens        *int               `json:"outputTokens"`
	CostUsd             any                `json:"costUsd"`
}

type EvidenceProvenance struct {
	ID         string `json:"id"`
	Reference  string `json:"reference"`
	Format     string `json:"format"`
	Sha256     string `json:"sha256"`
	Bytes      int64  `json:"bytes"`
	ModifiedAt string `json:"modifiedAt"`
	Provenance string `json:"provenance"`
	Delivered  bool   `json:"delivered"`
}

type CollectedEvidence struct {
	Report     ReportSpec     `json:"report"`
	Sha256     string         `json:"sha256"`
	Bytes      int64          `json:"bytes"`
	ModifiedAt string         `json:"modifiedAt"`
	Provenance string         `json:"provenance"`
	Digest     map[string]any `json:"digest"`
}

type EvidencePacket struct {
	Status        string               `json:"status"`
	Routing       string               `json:"routing"`
	Decision      RouteDecision        `json:"decision"`
	Considered    []EvidenceProvenance `json:"considered"`
	Evidence      []CollectedEvidence  `json:"evidence"`
	Corroborating []CollectedEvidence  `json:"corroborating,omitempty"`
}
