package perfdigest

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
)

type GatherEvidenceArgs struct {
	Workspace            string
	Issue                string
	Reports              []ReportSpec
	Routing              string
	Provider             DecisionProvider
	Emit                 EmitFunc
	Provenance           *[]EvidenceProvenance
	McpSessionOptions    *SessionOptions
	ReuseMcpSession      *bool
	IncludeCorroborating bool
	OnMcpSessionStats    func(SessionStats)
}

// GatherEvidence digests candidate reports via PerfDigest MCP (with bounded session reuse by default),
// checks pre/post SHA-256 artifact integrity, routes via the selected DecisionProvider, and records
// hash-checked provenance even on abstention, rejection, or failure.
func GatherEvidence(ctx context.Context, args GatherEvidenceArgs) (EvidencePacket, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return EvidencePacket{}, err
	}
	emit := args.Emit
	if emit == nil {
		emit = func(string, string) {}
	}

	selectedProvider, err := ProviderName(args.Routing)
	if err != nil {
		return EvidencePacket{}, err
	}
	if args.Provider != nil && args.Provider.Name() != selectedProvider {
		return EvidencePacket{}, fmt.Errorf("Injected provider does not match the explicit routing selection")
	}
	provider := args.Provider
	if provider == nil {
		provider, err = CreateDecisionProvider(args.Routing, DecisionProviderOptions{})
		if err != nil {
			return EvidencePacket{}, err
		}
	}

	workspaceRealpath, err := filepath.EvalSymlinks(args.Workspace)
	if err != nil {
		return EvidencePacket{}, err
	}

	measuredRouting := selectedProvider != "offline"
	reuseMcp := true
	if args.ReuseMcpSession != nil {
		reuseMcp = *args.ReuseMcpSession
	}

	var sharedSession *Session
	if reuseMcp {
		opts := SessionOptions{}
		if args.McpSessionOptions != nil {
			opts = *args.McpSessionOptions
		}
		if opts.MaxCalls == 0 {
			mc := len(args.Reports)
			if mc < 1 {
				mc = 1
			}
			if mc > 16 {
				mc = 16
			}
			opts.MaxCalls = mc
		}
		sharedSession, err = OpenPerfDigestSession(workspaceRealpath, opts)
		if err != nil {
			return EvidencePacket{}, err
		}
	}

	perReportAggregate := SessionStats{
		Spawns:      0,
		Calls:       0,
		ReusedCalls: 0,
		Closed:      true,
		Tainted:     false,
	}

	defer func() {
		if sharedSession != nil {
			_ = sharedSession.Close()
		}
		if args.OnMcpSessionStats != nil {
			if sharedSession != nil {
				args.OnMcpSessionStats(sharedSession.Stats())
			} else {
				args.OnMcpSessionStats(perReportAggregate)
			}
		}
	}()

	digestOne := func(report ReportSpec, absolutePath string) (map[string]any, error) {
		if sharedSession != nil {
			return sharedSession.Digest(ctx, report, absolutePath)
		}
		opts := SessionOptions{}
		if args.McpSessionOptions != nil {
			opts = *args.McpSessionOptions
		}
		opts.MaxCalls = 1
		singleSession, err := OpenPerfDigestSession(workspaceRealpath, opts)
		if err != nil {
			return nil, err
		}
		defer func() {
			_ = singleSession.Close()
			st := singleSession.Stats()
			perReportAggregate.Spawns += st.Spawns
			perReportAggregate.Calls += st.Calls
			perReportAggregate.ReusedCalls += st.ReusedCalls
			perReportAggregate.Closed = perReportAggregate.Closed && st.Closed
			perReportAggregate.Tainted = perReportAggregate.Tainted || st.Tainted
		}()
		return singleSession.Digest(ctx, report, absolutePath)
	}

	considered := make([]EvidenceProvenance, 0, len(args.Reports))

	collect := func(report ReportSpec) (CollectedEvidence, error) {
		if err := ctx.Err(); err != nil {
			return CollectedEvidence{}, err
		}
		before, err := ReportFile(args.Workspace, report.Path, workspaceRealpath)
		if err != nil {
			return CollectedEvidence{}, err
		}
		emit("digest.started", report.ID)
		digest, err := digestOne(report, before.Path)
		if err != nil {
			return CollectedEvidence{}, err
		}
		after, err := ReportFile(args.Workspace, report.Path, workspaceRealpath)
		if err != nil {
			return CollectedEvidence{}, err
		}
		if before.Sha256 != after.Sha256 {
			return CollectedEvidence{}, fmt.Errorf("Report changed while digesting; recapture and retry")
		}
		rec := EvidenceProvenance{
			ID:         report.ID,
			Reference:  report.Path,
			Format:     report.Format,
			Sha256:     before.Sha256,
			Bytes:      before.Bytes,
			ModifiedAt: before.ModifiedAt,
			Provenance: "perfdigest_mcp",
			Delivered:  false,
		}
		considered = append(considered, rec)
		if args.Provenance != nil {
			*args.Provenance = append(*args.Provenance, rec)
		}
		return CollectedEvidence{
			Report:     report,
			Sha256:     before.Sha256,
			Bytes:      before.Bytes,
			ModifiedAt: before.ModifiedAt,
			Provenance: "perfdigest_mcp",
			Digest:     digest,
		}, nil
	}

	measured := make([]CollectedEvidence, 0, len(args.Reports))
	if measuredRouting {
		emit("routing.evidence.started", "")
		for _, rep := range args.Reports {
			ce, err := collect(rep)
			if err != nil {
				return EvidencePacket{}, err
			}
			measured = append(measured, ce)
		}
		emit("routing.evidence.completed", strconv.Itoa(len(measured)))
		if sharedSession != nil {
			_ = sharedSession.Close()
		}
	}

	emit("routing.started", "")
	decision, err := provider.Select(ctx, args.Issue, args.Reports, measured)
	if err != nil {
		return EvidencePacket{}, err
	}

	for _, entry := range measured {
		curr, err := ReportFile(args.Workspace, entry.Report.Path, workspaceRealpath)
		if err != nil || curr.Sha256 != entry.Sha256 {
			return EvidencePacket{}, fmt.Errorf("Report changed while routing; recapture and retry")
		}
	}

	emit("routing.completed", decision.Reason)
	if decision.SelectedID == nil {
		return EvidencePacket{
			Status:     "needs_review",
			Routing:    args.Routing,
			Decision:   decision,
			Considered: considered,
			Evidence:   []CollectedEvidence{},
		}, nil
	}

	var targetReport *ReportSpec
	for i := range args.Reports {
		if args.Reports[i].ID == *decision.SelectedID {
			targetReport = &args.Reports[i]
			break
		}
	}
	if targetReport == nil {
		return EvidencePacket{}, NewDecisionsError(ErrSchema, nil)
	}

	var selected *CollectedEvidence
	for i := range measured {
		if measured[i].Report.ID == targetReport.ID {
			selected = &measured[i]
			break
		}
	}
	if selected == nil {
		ce, err := collect(*targetReport)
		if err != nil {
			return EvidencePacket{}, err
		}
		selected = &ce
	}

	for i := range considered {
		if considered[i].ID == targetReport.ID && considered[i].Sha256 == selected.Sha256 {
			considered[i].Delivered = true
		}
	}
	if args.Provenance != nil {
		for i := range *args.Provenance {
			if (*args.Provenance)[i].ID == targetReport.ID && (*args.Provenance)[i].Sha256 == selected.Sha256 {
				(*args.Provenance)[i].Delivered = true
			}
		}
	}

	var corroborating []CollectedEvidence
	if args.IncludeCorroborating {
		for _, ce := range measured {
			if ce.Report.ID != targetReport.ID {
				corroborating = append(corroborating, ce)
			}
		}
	}

	emit("evidence.ready", targetReport.ID)
	pkt := EvidencePacket{
		Status:     "complete",
		Routing:    args.Routing,
		Decision:   decision,
		Considered: considered,
		Evidence:   []CollectedEvidence{*selected},
	}
	if len(corroborating) > 0 {
		pkt.Corroborating = corroborating
	}
	return pkt, nil
}
