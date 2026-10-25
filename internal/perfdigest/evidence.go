package perfdigest

import (
	"context"
	"fmt"
	"math"
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
	MaxSteps             int
	OnMcpSessionStats    func(SessionStats)
}

func getDigestUnits(entry CollectedEvidence) []map[string]any {
	if entry.Digest == nil {
		return nil
	}
	if uSlice, ok := entry.Digest["units"].([]map[string]any); ok {
		return uSlice
	}
	if rawSlice, ok := entry.Digest["units"].([]any); ok {
		out := make([]map[string]any, 0, len(rawSlice))
		for _, item := range rawSlice {
			if m, ok := item.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

func getTotalUnits(entry CollectedEvidence) int {
	if entry.Digest == nil {
		return 0
	}
	if n, ok := toInt(entry.Digest["total_units"]); ok {
		return n
	}
	return 0
}

func getReturnedUnits(entry CollectedEvidence) int {
	if entry.Digest == nil {
		return 0
	}
	if n, ok := toInt(entry.Digest["returned"]); ok {
		return n
	}
	return 0
}

func MightNeedIterativeDrillDown(reports []ReportSpec, measured []CollectedEvidence) bool {
	if len(measured) == 0 {
		return false
	}
	if len(reports) == 1 {
		only := measured[0]
		if only.Report.Format == "chrome-trace" && getTotalUnits(only) <= getReturnedUnits(only) {
			return false
		}
	}
	return true
}

func BuildCandidateActions(
	reports []ReportSpec,
	measured []CollectedEvidence,
	primaryID string,
	extractions []McpExtractionRecord,
) []CandidateMcpAction {
	if !MightNeedIterativeDrillDown(reports, measured) {
		return nil
	}
	var primary *CollectedEvidence
	for i := range measured {
		if measured[i].Report.ID == primaryID {
			primary = &measured[i]
			break
		}
	}
	if primary == nil {
		return nil
	}

	completed := make(map[string]bool)
	for _, ex := range extractions {
		switch ex.Tool {
		case "list_kernels":
			completed["list_kernels:"+ex.ReportID] = true
		case "get_metrics":
			u := ex.Unit
			if u == "" {
				u = "0"
			}
			completed[fmt.Sprintf("get_metrics:%s:%s", ex.ReportID, u)] = true
		case "expand":
			u := ex.Unit
			if u == "" {
				u = "0"
			}
			sec := ex.Section
			if sec == "" {
				sec = "all"
			}
			completed[fmt.Sprintf("expand:%s:%s:%s", ex.ReportID, u, sec)] = true
			completed[fmt.Sprintf("expand:%s:0:%s", ex.ReportID, sec)] = true
		case "compare_metrics":
			u := ex.Unit
			if u == "" {
				u = "0"
			}
			su := ex.SecondaryUnit
			if su == "" {
				su = "1"
			}
			if ex.SecondaryReportID != "" && ex.SecondaryReportID != ex.ReportID {
				completed[fmt.Sprintf("compare_reports:%s:%s:%s", ex.ReportID, ex.SecondaryReportID, u)] = true
				completed[fmt.Sprintf("compare_reports:%s:%s:%s", ex.SecondaryReportID, ex.ReportID, u)] = true
				completed[fmt.Sprintf("compare_reports:%s:%s:0", ex.ReportID, ex.SecondaryReportID)] = true
				completed[fmt.Sprintf("compare_reports:%s:%s:0", ex.SecondaryReportID, ex.ReportID)] = true
			} else {
				completed[fmt.Sprintf("compare_units:%s:%s:%s", ex.ReportID, u, su)] = true
				completed[fmt.Sprintf("compare_units:%s:%s:%s", ex.ReportID, su, u)] = true
			}
		}
	}

	actions := make([]CandidateMcpAction, 0, 6)
	pushAction := func(a CandidateMcpAction) {
		if len(actions) >= 6 || completed[a.ID] {
			return
		}
		for _, ex := range actions {
			if ex.ID == a.ID {
				return
			}
		}
		actions = append(actions, a)
	}

	// 1. Layer 2 — Unit Discovery
	if getTotalUnits(*primary) > getReturnedUnits(*primary) {
		pushAction(CandidateMcpAction{
			ID:          "list_kernels:" + primary.Report.ID,
			Layer:       "unit_discovery",
			McpTool:     "list_kernels",
			ReportID:    primary.Report.ID,
			Description: fmt.Sprintf("List all %d units/kernels in %s (%s) to discover units beyond the top-%d summary", getTotalUnits(*primary), primary.Report.ID, primary.Report.Format, getReturnedUnits(*primary)),
		})
	}

	// 2. Layer 2/3 — Unseen units discovered by list_kernels on the primary report
	var lkPrimary *McpExtractionRecord
	for i := range extractions {
		if extractions[i].Tool == "list_kernels" && extractions[i].ReportID == primary.Report.ID {
			lkPrimary = &extractions[i]
			break
		}
	}
	if lkPrimary != nil {
		summaryIndices := make(map[int]bool)
		for idx, u := range getDigestUnits(*primary) {
			if parsedIdx, ok := toInt(u["index"]); ok {
				summaryIndices[parsedIdx] = true
			} else {
				summaryIndices[idx] = true
			}
		}
		var lkUnits []map[string]any
		if uSlice, ok := lkPrimary.Data["units"].([]map[string]any); ok {
			lkUnits = uSlice
		} else if rawSlice, ok := lkPrimary.Data["units"].([]any); ok {
			for _, item := range rawSlice {
				if m, ok := item.(map[string]any); ok {
					lkUnits = append(lkUnits, m)
				}
			}
		}
		unseen := make([]map[string]any, 0)
		for idx, u := range lkUnits {
			uIdx := idx
			if parsedIdx, ok := toInt(u["index"]); ok {
				uIdx = parsedIdx
			}
			if !summaryIndices[uIdx] {
				unseen = append(unseen, u)
			}
		}
		hasNumericDuration := false
		if len(unseen) > 0 && unseen[0]["duration_us"] != nil {
			if _, ok := toFiniteFloat(unseen[0]["duration_us"]); ok {
				hasNumericDuration = true
			}
		}
		orderedUnseen := make([]map[string]any, len(unseen))
		if hasNumericDuration {
			copy(orderedUnseen, unseen)
		} else {
			for i := range unseen {
				orderedUnseen[i] = unseen[len(unseen)-1-i]
			}
		}
		compareCount := 0
		for i := 0; i+1 < len(orderedUnseen) && compareCount < 2; i++ {
			uA := orderedUnseen[i]
			uB := orderedUnseen[i+1]
			idxAInt, okA := toInt(uA["index"])
			if !okA {
				idxAInt = i
			}
			idxBInt, okB := toInt(uB["index"])
			if !okB {
				idxBInt = i + 1
			}
			idxA := strconv.Itoa(idxAInt)
			idxB := strconv.Itoa(idxBInt)
			nameA, _ := uA["name"].(string)
			if nameA == "" {
				nameA = idxA
			}
			nameB, _ := uB["name"].(string)
			if nameB == "" {
				nameB = idxB
			}
			labelA := SanitizeUnitLabel(nameA)
			labelB := SanitizeUnitLabel(nameB)
			beforeLen := len(actions)
			pushAction(CandidateMcpAction{
				ID:                fmt.Sprintf("compare_units:%s:%s:%s", primary.Report.ID, idxA, idxB),
				Layer:             "deep_extraction",
				McpTool:           "compare_metrics",
				ReportID:          primary.Report.ID,
				SecondaryReportID: primary.Report.ID,
				Unit:              idxA,
				SecondaryUnit:     idxB,
				Description:       fmt.Sprintf("Compare metrics between discovered units '%s' (#%s) and '%s' (#%s) in %s", labelA, idxA, labelB, idxB, primary.Report.ID),
			})
			if len(actions) > beforeLen {
				compareCount++
			}
		}
		if len(orderedUnseen) == 1 {
			u := orderedUnseen[0]
			idxInt, okIdx := toInt(u["index"])
			if !okIdx {
				idxInt = 0
			}
			idxStr := strconv.Itoa(idxInt)
			nameStr, _ := u["name"].(string)
			if nameStr == "" {
				nameStr = idxStr
			}
			label := SanitizeUnitLabel(nameStr)
			pushAction(CandidateMcpAction{
				ID:          fmt.Sprintf("get_metrics:%s:%s", primary.Report.ID, idxStr),
				Layer:       "deep_extraction",
				McpTool:     "get_metrics",
				ReportID:    primary.Report.ID,
				Unit:        idxStr,
				Description: fmt.Sprintf("Extract detailed metrics for discovered unit '%s' (#%s) in %s", label, idxStr, primary.Report.ID),
			})
		}
	}

	// 3. Layer 2/3 — Cross-report delta comparison across same-format candidate reports
	for i := 0; i < len(measured); i++ {
		for j := i + 1; j < len(measured); j++ {
			repA := measured[i]
			repB := measured[j]
			if repA.Report.Format != repB.Report.Format {
				continue
			}
			unitsA := getDigestUnits(repA)
			unitsB := getDigestUnits(repB)
			if len(unitsA) == 0 || len(unitsB) == 0 {
				continue
			}
			namesB := make(map[string]bool, len(unitsB))
			for _, u := range unitsB {
				if nStr, ok := u["name"].(string); ok && nStr != "" {
					namesB[nStr] = true
				}
			}
			commonName := ""
			for _, u := range unitsA {
				if nStr, ok := u["name"].(string); ok && nStr != "" && namesB[nStr] {
					commonName = nStr
					break
				}
			}
			unitRefA := "0"
			unitRefB := "0"
			if commonName != "" {
				unitRefA = commonName
				unitRefB = commonName
			} else {
				if nStr, ok := unitsA[0]["name"].(string); ok && nStr != "" {
					unitRefA = nStr
				}
				if nStr, ok := unitsB[0]["name"].(string); ok && nStr != "" {
					unitRefB = nStr
				}
			}
			labelA := SanitizeUnitLabel(unitRefA)
			labelB := SanitizeUnitLabel(unitRefB)
			desc := fmt.Sprintf("Compare '%s' metrics across %s and %s (%s)", labelA, repA.Report.ID, repB.Report.ID, repA.Report.Format)
			if unitRefA != unitRefB {
				desc = fmt.Sprintf("Compare hot unit '%s' in %s vs '%s' in %s (%s)", labelA, repA.Report.ID, labelB, repB.Report.ID, repA.Report.Format)
			}
			pushAction(CandidateMcpAction{
				ID:                fmt.Sprintf("compare_reports:%s:%s:0", repA.Report.ID, repB.Report.ID),
				Layer:             "deep_extraction",
				McpTool:           "compare_metrics",
				ReportID:          repA.Report.ID,
				SecondaryReportID: repB.Report.ID,
				Unit:              unitRefA,
				SecondaryUnit:     unitRefB,
				Description:       desc,
			})
		}
	}

	// 4. Layer 3 — Deep vendor section expansion on the hottest unit of the primary report
	primaryUnits := getDigestUnits(*primary)
	primaryHasDuration := false
	if len(primaryUnits) > 0 && primaryUnits[0]["duration_us"] != nil {
		if _, ok := toFiniteFloat(primaryUnits[0]["duration_us"]); ok {
			primaryHasDuration = true
		}
	}
	primaryNeedsDiscoveryFirst := lkPrimary == nil && getTotalUnits(*primary) > getReturnedUnits(*primary) && !primaryHasDuration

	if !primaryNeedsDiscoveryFirst && len(primaryUnits) > 0 && primary.Report.Format != "chrome-trace" {
		unitRef := "0"
		if nStr, ok := primaryUnits[0]["name"].(string); ok && nStr != "" {
			unitRef = nStr
		}
		label := SanitizeUnitLabel(unitRef)
		pushAction(CandidateMcpAction{
			ID:          fmt.Sprintf("expand:%s:0:all", primary.Report.ID),
			Layer:       "deep_extraction",
			McpTool:     "expand",
			ReportID:    primary.Report.ID,
			Unit:        unitRef,
			Section:     "all",
			Description: fmt.Sprintf("Expand raw vendor metrics and section details for hot unit '%s' in %s (%s)", label, primary.Report.ID, primary.Report.Format),
		})
	}

	// 5. Layer 3 — Within-report comparison of top 2 summary units in primary report
	if !primaryNeedsDiscoveryFirst && len(primaryUnits) >= 2 {
		u0 := primaryUnits[0]
		u1 := primaryUnits[1]
		idx0Int, ok0 := toInt(u0["index"])
		if !ok0 {
			idx0Int = 0
		}
		idx1Int, ok1 := toInt(u1["index"])
		if !ok1 {
			idx1Int = 1
		}
		idx0 := strconv.Itoa(idx0Int)
		idx1 := strconv.Itoa(idx1Int)
		name0, _ := u0["name"].(string)
		if name0 == "" {
			name0 = idx0
		}
		name1, _ := u1["name"].(string)
		if name1 == "" {
			name1 = idx1
		}
		label0 := SanitizeUnitLabel(name0)
		label1 := SanitizeUnitLabel(name1)
		pushAction(CandidateMcpAction{
			ID:                fmt.Sprintf("compare_units:%s:%s:%s", primary.Report.ID, idx0, idx1),
			Layer:             "deep_extraction",
			McpTool:           "compare_metrics",
			ReportID:          primary.Report.ID,
			SecondaryReportID: primary.Report.ID,
			Unit:              idx0,
			SecondaryUnit:     idx1,
			Description:       fmt.Sprintf("Compare metrics between top units '%s' and '%s' in %s (%s)", label0, label1, primary.Report.ID, primary.Report.Format),
		})
	}

	// 6. Complementary report unit discovery & comparison (e.g. ptxas alongside ncu-rep)
	for _, rep := range measured {
		if rep.Report.ID == primary.Report.ID {
			continue
		}
		var lkSecondary *McpExtractionRecord
		for i := range extractions {
			if extractions[i].Tool == "list_kernels" && extractions[i].ReportID == rep.Report.ID {
				lkSecondary = &extractions[i]
				break
			}
		}
		if lkSecondary == nil && getTotalUnits(rep) > getReturnedUnits(rep) {
			pushAction(CandidateMcpAction{
				ID:          "list_kernels:" + rep.Report.ID,
				Layer:       "unit_discovery",
				McpTool:     "list_kernels",
				ReportID:    rep.Report.ID,
				Description: fmt.Sprintf("List all %d units/kernels in complementary report %s (%s)", getTotalUnits(rep), rep.Report.ID, rep.Report.Format),
			})
		} else if lkSecondary != nil {
			secSummaryIndices := make(map[int]bool)
			for idx, u := range getDigestUnits(rep) {
				if parsedIdx, ok := toInt(u["index"]); ok {
					secSummaryIndices[parsedIdx] = true
				} else {
					secSummaryIndices[idx] = true
				}
			}
			var lkUnits []map[string]any
			if uSlice, ok := lkSecondary.Data["units"].([]map[string]any); ok {
				lkUnits = uSlice
			} else if rawSlice, ok := lkSecondary.Data["units"].([]any); ok {
				for _, item := range rawSlice {
					if m, ok := item.(map[string]any); ok {
						lkUnits = append(lkUnits, m)
					}
				}
			}
			unseen := make([]map[string]any, 0)
			for idx, u := range lkUnits {
				uIdx := idx
				if parsedIdx, ok := toInt(u["index"]); ok {
					uIdx = parsedIdx
				}
				if !secSummaryIndices[uIdx] {
					unseen = append(unseen, u)
				}
			}
			hasNumericDuration := false
			if len(unseen) > 0 && unseen[0]["duration_us"] != nil {
				if _, ok := toFiniteFloat(unseen[0]["duration_us"]); ok {
					hasNumericDuration = true
				}
			}
			orderedUnseen := make([]map[string]any, len(unseen))
			if hasNumericDuration {
				copy(orderedUnseen, unseen)
			} else {
				for i := range unseen {
					orderedUnseen[i] = unseen[len(unseen)-1-i]
				}
			}
			secCompareCount := 0
			for i := 0; i+1 < len(orderedUnseen) && secCompareCount < 2; i++ {
				uA := orderedUnseen[i]
				uB := orderedUnseen[i+1]
				idxAInt, okA := toInt(uA["index"])
				if !okA {
					idxAInt = i
				}
				idxBInt, okB := toInt(uB["index"])
				if !okB {
					idxBInt = i + 1
				}
				idxA := strconv.Itoa(idxAInt)
				idxB := strconv.Itoa(idxBInt)
				nameA, _ := uA["name"].(string)
				if nameA == "" {
					nameA = idxA
				}
				nameB, _ := uB["name"].(string)
				if nameB == "" {
					nameB = idxB
				}
				labelA := SanitizeUnitLabel(nameA)
				labelB := SanitizeUnitLabel(nameB)
				beforeLen := len(actions)
				pushAction(CandidateMcpAction{
					ID:                fmt.Sprintf("compare_units:%s:%s:%s", rep.Report.ID, idxA, idxB),
					Layer:             "deep_extraction",
					McpTool:           "compare_metrics",
					ReportID:          rep.Report.ID,
					SecondaryReportID: rep.Report.ID,
					Unit:              idxA,
					SecondaryUnit:     idxB,
					Description:       fmt.Sprintf("Compare metrics between discovered units '%s' (#%s) and '%s' (#%s) in complementary report %s", labelA, idxA, labelB, idxB, rep.Report.ID),
				})
				if len(actions) > beforeLen {
					secCompareCount++
				}
			}
		}
	}

	return actions
}

// GatherEvidence digests candidate reports via PerfDigest MCP (with bounded session reuse by default),
// checks pre/post SHA-256 artifact integrity, routes via the selected DecisionProvider, and progresses
// through adaptive Decision -> PerfDigest MCP -> Decision -> MCP steps when deeper evidence is available.
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
	maxSteps := args.MaxSteps
	if maxSteps <= 0 {
		maxSteps = 4
	}
	if maxSteps > 6 {
		maxSteps = 6
	}

	iterProvider, okIter := provider.(IterativeDecisionProvider)
	canProviderIterate := okIter && iterProvider.CanDecideAction()

	var sharedSession *Session
	if reuseMcp {
		opts := SessionOptions{}
		if args.McpSessionOptions != nil {
			opts = *args.McpSessionOptions
		}
		if opts.MaxCalls == 0 {
			mc := len(args.Reports)
			if canProviderIterate {
				mc = len(args.Reports) + 6
				if mc < 8 {
					mc = 8
				}
			}
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

	withTransientSession := func(fn func(*Session) (map[string]any, error)) (map[string]any, error) {
		if sharedSession != nil {
			return fn(sharedSession)
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
		return fn(singleSession)
	}

	checkSupportsDrillDown := func() bool {
		if sharedSession != nil {
			return sharedSession.SupportsDrillDown(ctx)
		}
		opts := SessionOptions{}
		if args.McpSessionOptions != nil {
			opts = *args.McpSessionOptions
		}
		opts.MaxCalls = 1
		singleSession, err := OpenPerfDigestSession(workspaceRealpath, opts)
		if err != nil {
			return false
		}
		defer func() {
			_ = singleSession.Close()
		}()
		return singleSession.SupportsDrillDown(ctx)
	}

	digestOne := func(report ReportSpec, absolutePath string) (map[string]any, error) {
		return withTransientSession(func(s *Session) (map[string]any, error) {
			return s.Digest(ctx, report, absolutePath)
		})
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
		emit("digest.completed", report.ID)
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

	verifyMeasuredUnchanged := func(measured []CollectedEvidence, phase string) error {
		for _, entry := range measured {
			curr, err := ReportFile(args.Workspace, entry.Report.Path, workspaceRealpath)
			if err != nil || curr.Sha256 != entry.Sha256 {
				return fmt.Errorf("Report changed while %s; recapture and retry", phase)
			}
		}
		return nil
	}

	measured := make([]CollectedEvidence, 0, len(args.Reports))
	drillDownSupported := false
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
		if canProviderIterate && maxSteps > 1 && MightNeedIterativeDrillDown(args.Reports, measured) {
			drillDownSupported = checkSupportsDrillDown()
		}
		if !drillDownSupported && sharedSession != nil {
			_ = sharedSession.Close()
		}
	}

	emit("routing.started", "")
	decision, err := provider.Select(ctx, args.Issue, args.Reports, measured)
	if err != nil {
		return EvidencePacket{}, err
	}
	if err := verifyMeasuredUnchanged(measured, "routing"); err != nil {
		return EvidencePacket{}, err
	}

	touchedReportIDs := make(map[string]bool)
	if drillDownSupported && len(args.Reports) >= 2 && len(decision.Probabilities) > 0 {
		reportIDs := make(map[string]bool, len(args.Reports))
		for _, r := range args.Reports {
			reportIDs[r.ID] = true
		}
		hrProb := 0.0
		type repProb struct {
			id   string
			prob float64
		}
		repProbs := make([]repProb, 0, len(args.Reports))
		for _, p := range decision.Probabilities {
			vStr, _ := p.Value.(string)
			if vStr == "__human_review__" {
				hrProb = p.Probability
			} else if reportIDs[vStr] {
				repProbs = append(repProbs, repProb{id: vStr, prob: p.Probability})
			}
		}
		for i := 0; i < len(repProbs); i++ {
			for j := i + 1; j < len(repProbs); j++ {
				if repProbs[j].prob > repProbs[i].prob {
					repProbs[i], repProbs[j] = repProbs[j], repProbs[i]
				}
			}
		}
		if decision.Reason == "low_confidence" && len(repProbs) >= 2 {
			p1 := repProbs[0]
			p2 := repProbs[1]
			k := float64(len(args.Reports) + 1)
			uniform := 1.0 / k
			pairConf := ((p1.prob + p2.prob) - uniform) / (1.0 - uniform)
			if p2.prob >= 0.15 && p1.prob > hrProb && pairConf >= 0.55 {
				sel := p1.id
				decision.SelectedID = &sel
				if pairConf > 1.0 {
					pairConf = 1.0
				}
				rounded := math.Round(pairConf*10000) / 10000
				decision.Confidence = &rounded
				decision.Reason = "selected"
				touchedReportIDs[p2.id] = true
			}
		} else if decision.SelectedID != nil {
			for _, rp := range repProbs {
				if rp.id != *decision.SelectedID && rp.prob >= 0.15 {
					touchedReportIDs[rp.id] = true
				}
			}
		}
	}

	emit("routing.completed", decision.Reason)
	if decision.SelectedID == nil {
		if sharedSession != nil {
			_ = sharedSession.Close()
		}
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

	selectedIdx := -1
	for i := range measured {
		if measured[i].Report.ID == targetReport.ID {
			selectedIdx = i
			break
		}
	}
	if selectedIdx < 0 {
		ce, err := collect(*targetReport)
		if err != nil {
			return EvidencePacket{}, err
		}
		measured = append(measured, ce)
		selectedIdx = len(measured) - 1
	}

	for i := range considered {
		if considered[i].ID == targetReport.ID && considered[i].Sha256 == measured[selectedIdx].Sha256 {
			considered[i].Delivered = true
		}
	}
	if args.Provenance != nil {
		for i := range *args.Provenance {
			if (*args.Provenance)[i].ID == targetReport.ID && (*args.Provenance)[i].Sha256 == measured[selectedIdx].Sha256 {
				(*args.Provenance)[i].Delivered = true
			}
		}
	}

	sumTool := "summarize_report"
	targetRepID := targetReport.ID
	steps := []EvidenceAcquisitionStep{
		{
			Step:           1,
			Layer:          "report_orientation",
			Action:         "select_report:" + targetReport.ID,
			McpTool:        &sumTool,
			TargetReportID: &targetRepID,
			Confidence:     decision.Confidence,
			Probabilities:  decision.Probabilities,
			Reason:         "selected",
			InputSha256:    decision.InputSha256,
			LatencyMs:      decision.LatencyMs,
			InputTokens:    decision.InputTokens,
			OutputTokens:   decision.OutputTokens,
		},
	}
	extractions := make([]McpExtractionRecord, 0)

	if measuredRouting && canProviderIterate && drillDownSupported && maxSteps > 1 {
		for stepNum := 2; stepNum <= maxSteps; stepNum++ {
			if sharedSession != nil && sharedSession.Stats().Calls >= sharedSession.MaxCalls() {
				steps = append(steps, EvidenceAcquisitionStep{
					Step:           stepNum,
					Layer:          "stopping",
					Action:         "stop_budget_reached",
					McpTool:        nil,
					TargetReportID: nil,
					Confidence:     nil,
					Reason:         "budget_reached",
					LatencyMs:      0,
					InputTokens:    nil,
					OutputTokens:   nil,
				})
				break
			}
			candidates := BuildCandidateActions(args.Reports, measured, targetReport.ID, extractions)
			if len(candidates) == 0 {
				break
			}
			stateJson, err := IterativeDecisionsInput(args.Issue, args.Reports, measured, extractions, stepNum)
			if err != nil {
				return EvidencePacket{}, err
			}
			emit("routing.step.started", strconv.Itoa(stepNum))
			stepDecision, err := iterProvider.DecideAction(ctx, stateJson, candidates, len(measured))
			if err != nil {
				return EvidencePacket{}, err
			}
			if err := verifyMeasuredUnchanged(measured, "routing"); err != nil {
				return EvidencePacket{}, err
			}

			decision.Requests += stepDecision.Requests
			decision.LatencyMs += stepDecision.LatencyMs
			if stepDecision.InputTokens != nil {
				totIn := 0
				if decision.InputTokens != nil {
					totIn = *decision.InputTokens
				}
				totIn += *stepDecision.InputTokens
				decision.InputTokens = &totIn
			}
			if stepDecision.OutputTokens != nil {
				totOut := 0
				if decision.OutputTokens != nil {
					totOut = *decision.OutputTokens
				}
				totOut += *stepDecision.OutputTokens
				decision.OutputTokens = &totOut
			}

			if stepDecision.SelectedID == nil || *stepDecision.SelectedID == "stop_sufficient" {
				stopReason := stepDecision.Reason
				actName := "stop_abstained"
				if stepDecision.SelectedID != nil && *stepDecision.SelectedID == "stop_sufficient" {
					stopReason = "sufficient"
					actName = "stop_sufficient"
				}
				steps = append(steps, EvidenceAcquisitionStep{
					Step:           stepNum,
					Layer:          "stopping",
					Action:         actName,
					McpTool:        nil,
					TargetReportID: nil,
					Confidence:     stepDecision.Confidence,
					Probabilities:  stepDecision.Probabilities,
					Reason:         stopReason,
					InputSha256:    stepDecision.InputSha256,
					LatencyMs:      stepDecision.LatencyMs,
					InputTokens:    stepDecision.InputTokens,
					OutputTokens:   stepDecision.OutputTokens,
				})
				emit("routing.step.completed", stopReason)
				break
			}

			var chosenAction *CandidateMcpAction
			for i := range candidates {
				if candidates[i].ID == *stepDecision.SelectedID {
					chosenAction = &candidates[i]
					break
				}
			}
			if chosenAction == nil {
				break
			}
			emit("routing.step.completed", strconv.Itoa(stepNum)+":"+chosenAction.ID)

			var stepTargetRep *ReportSpec
			for i := range args.Reports {
				if args.Reports[i].ID == chosenAction.ReportID {
					stepTargetRep = &args.Reports[i]
					break
				}
			}
			if stepTargetRep == nil {
				break
			}
			beforePrimary, err := ReportFile(args.Workspace, stepTargetRep.Path, workspaceRealpath)
			if err != nil {
				return EvidencePacket{}, err
			}

			var secondaryRep *ReportSpec
			var beforeSecondary *ReportFileInfo
			if chosenAction.SecondaryReportID != "" {
				for i := range args.Reports {
					if args.Reports[i].ID == chosenAction.SecondaryReportID {
						secondaryRep = &args.Reports[i]
						break
					}
				}
				if secondaryRep == nil {
					break
				}
				bs, err := ReportFile(args.Workspace, secondaryRep.Path, workspaceRealpath)
				if err != nil {
					return EvidencePacket{}, err
				}
				beforeSecondary = &bs
			}

			emit("extraction.started", chosenAction.McpTool+":"+chosenAction.ID)
			var extractedData map[string]any
			switch chosenAction.McpTool {
			case "list_kernels":
				extractedData, err = withTransientSession(func(s *Session) (map[string]any, error) {
					return s.ListKernels(ctx, *stepTargetRep, beforePrimary.Path)
				})
			case "get_metrics":
				u := chosenAction.Unit
				if u == "" {
					u = "0"
				}
				extractedData, err = withTransientSession(func(s *Session) (map[string]any, error) {
					return s.GetMetrics(ctx, *stepTargetRep, beforePrimary.Path, u, nil)
				})
			case "expand":
				u := chosenAction.Unit
				if u == "" {
					u = "0"
				}
				sec := chosenAction.Section
				if sec == "" {
					sec = "all"
				}
				extractedData, err = withTransientSession(func(s *Session) (map[string]any, error) {
					return s.ExpandUnit(ctx, *stepTargetRep, beforePrimary.Path, u, sec)
				})
			default:
				repB := *stepTargetRep
				pathB := beforePrimary.Path
				if secondaryRep != nil && beforeSecondary != nil {
					repB = *secondaryRep
					pathB = beforeSecondary.Path
				}
				u := chosenAction.Unit
				if u == "" {
					u = "0"
				}
				extractedData, err = withTransientSession(func(s *Session) (map[string]any, error) {
					return s.CompareMetrics(ctx, *stepTargetRep, beforePrimary.Path, repB, pathB, u, chosenAction.SecondaryUnit, nil)
				})
			}
			if err != nil {
				return EvidencePacket{}, err
			}

			afterPrimary, err := ReportFile(args.Workspace, stepTargetRep.Path, workspaceRealpath)
			if err != nil || beforePrimary.Sha256 != afterPrimary.Sha256 {
				return EvidencePacket{}, fmt.Errorf("Report changed while extracting metrics; recapture and retry")
			}
			if secondaryRep != nil && beforeSecondary != nil {
				afterSecondary, err := ReportFile(args.Workspace, secondaryRep.Path, workspaceRealpath)
				if err != nil || beforeSecondary.Sha256 != afterSecondary.Sha256 {
					return EvidencePacket{}, fmt.Errorf("Report changed while extracting metrics; recapture and retry")
				}
			}

			exRec := McpExtractionRecord{
				Step:              stepNum,
				Tool:              chosenAction.McpTool,
				ReportID:          stepTargetRep.ID,
				SecondaryReportID: chosenAction.SecondaryReportID,
				Unit:              chosenAction.Unit,
				SecondaryUnit:     chosenAction.SecondaryUnit,
				Section:           chosenAction.Section,
				Sha256:            beforePrimary.Sha256,
				Provenance:        "perfdigest_mcp",
				Data:              extractedData,
			}
			if beforeSecondary != nil {
				exRec.SecondarySha256 = beforeSecondary.Sha256
			}
			extractions = append(extractions, exRec)
			touchedReportIDs[stepTargetRep.ID] = true
			if secondaryRep != nil {
				touchedReportIDs[secondaryRep.ID] = true
			}
			for i := range measured {
				if measured[i].Report.ID == stepTargetRep.ID {
					measured[i].Extractions = append(measured[i].Extractions, exRec)
					break
				}
			}

			toolName := chosenAction.McpTool
			tRepID := stepTargetRep.ID
			steps = append(steps, EvidenceAcquisitionStep{
				Step:              stepNum,
				Layer:             chosenAction.Layer,
				Action:            chosenAction.ID,
				McpTool:           &toolName,
				TargetReportID:    &tRepID,
				SecondaryReportID: chosenAction.SecondaryReportID,
				TargetUnit:        chosenAction.Unit,
				SecondaryUnit:     chosenAction.SecondaryUnit,
				Confidence:        stepDecision.Confidence,
				Probabilities:     stepDecision.Probabilities,
				Reason:            "selected",
				InputSha256:       stepDecision.InputSha256,
				LatencyMs:         stepDecision.LatencyMs,
				InputTokens:       stepDecision.InputTokens,
				OutputTokens:      stepDecision.OutputTokens,
			})
			emit("extraction.completed", chosenAction.McpTool+":"+chosenAction.ID)
		}
	}

	if sharedSession != nil {
		_ = sharedSession.Close()
	}

	var corroborating []CollectedEvidence
	if args.IncludeCorroborating {
		for _, ce := range measured {
			if ce.Report.ID != targetReport.ID {
				corroborating = append(corroborating, ce)
			}
		}
	} else if len(touchedReportIDs) > 0 {
		for _, ce := range measured {
			if ce.Report.ID != targetReport.ID && touchedReportIDs[ce.Report.ID] {
				corroborating = append(corroborating, ce)
			}
		}
	}
	if len(corroborating) > 0 {
		compIDs := make([]string, 0, len(corroborating))
		for _, c := range corroborating {
			compIDs = append(compIDs, c.Report.ID)
		}
		decision.ComplementaryIDs = compIDs
	}
	if len(steps) > 1 || len(extractions) > 0 {
		decision.Steps = steps
	}

	emit("evidence.ready", targetReport.ID)
	pkt := EvidencePacket{
		Status:     "complete",
		Routing:    args.Routing,
		Decision:   decision,
		Considered: considered,
		Evidence:   []CollectedEvidence{measured[selectedIdx]},
	}
	if len(corroborating) > 0 {
		pkt.Corroborating = corroborating
	}
	if len(extractions) > 0 {
		pkt.Extractions = extractions
	}
	if len(steps) > 1 || len(extractions) > 0 {
		pkt.Steps = steps
	}
	return pkt, nil
}
