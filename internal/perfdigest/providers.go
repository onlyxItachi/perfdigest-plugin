package perfdigest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

type CloudflareModelSpec struct {
	Name                  string   `json:"name"`
	ID                    string   `json:"id"`
	RequestModel          string   `json:"requestModel"`
	Identities            []string `json:"identities"`
	ConfidenceSemantics   string   `json:"confidenceSemantics"`
	QuestionTypes         []string `json:"questionTypes"`
	PluginInputs          []string `json:"pluginInputs"`
	DocumentedMediaInputs []string `json:"documentedMediaInputs"`
	Documentation         string   `json:"documentation"`
	LiveQualified         *string  `json:"liveQualified"`
}

var liveDate = "2026-10-18"

var CloudflareModels = map[string]CloudflareModelSpec{
	"clef-flash": {
		Name:                  "clef-flash",
		ID:                    "@cf/cloudflare/clef-flash",
		RequestModel:          "clef-flash",
		Identities:            []string{"clef-flash", "@cf/cloudflare/clef-flash"},
		ConfidenceSemantics:   "systemone_uniform_zero",
		QuestionTypes:         []string{"noul", "choice", "score"},
		PluginInputs:          []string{"text"},
		DocumentedMediaInputs: []string{},
		Documentation:         "https://developers.cloudflare.com/workers-ai/models/clef-flash/",
		LiveQualified:         &liveDate,
	},
	"clef": {
		Name:                  "clef",
		ID:                    "@cf/cloudflare/clef",
		RequestModel:          "clef",
		Identities:            []string{"clef", "@cf/cloudflare/clef"},
		ConfidenceSemantics:   "systemone_uniform_zero",
		QuestionTypes:         []string{"noul", "choice", "score"},
		PluginInputs:          []string{"text"},
		DocumentedMediaInputs: []string{"image"},
		Documentation:         "https://developers.cloudflare.com/workers-ai/models/clef/",
		LiveQualified:         &liveDate,
	},
	"clef-omni": {
		Name:                  "clef-omni",
		ID:                    "@cf/cloudflare/clef-omni",
		RequestModel:          "clef-omni",
		Identities:            []string{"clef-omni", "@cf/cloudflare/clef-omni"},
		ConfidenceSemantics:   "systemone_uniform_zero",
		QuestionTypes:         []string{"noul", "choice", "score"},
		PluginInputs:          []string{"text"},
		DocumentedMediaInputs: []string{"image", "audio", "video"},
		Documentation:         "https://developers.cloudflare.com/workers-ai/models/clef-omni/",
		LiveQualified:         &liveDate,
	},
}

const DefaultCloudflareModel = "clef-flash"

func IsCloudflareModelName(name string) bool {
	_, ok := CloudflareModels[name]
	return ok
}

func ResolveCloudflareModel(name string) (CloudflareModelSpec, error) {
	if name == "" {
		name = DefaultCloudflareModel
	}
	spec, ok := CloudflareModels[name]
	if !ok {
		return CloudflareModelSpec{}, NewProviderError("cloudflare", ErrSchema, nil)
	}
	return spec, nil
}

func ProviderName(mode string) (string, error) {
	switch mode {
	case "decisions", "openai-luna", "openai":
		return "openai", nil
	case "clef-local", "local":
		return "local", nil
	case "clef-cloudflare", "cloudflare":
		return "cloudflare", nil
	case "offline":
		return "offline", nil
	default:
		return "", NewDecisionsError(ErrSchema, nil)
	}
}

type ChoiceOption struct {
	Value       any    `json:"value"`
	Description string `json:"description,omitempty"`
}

type ScoreLevel struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type DecisionQuestion struct {
	Type         string         `json:"type"`
	Name         string         `json:"name"`
	Instructions string         `json:"instructions"`
	Choices      []ChoiceOption `json:"choices,omitempty"`
	Levels       []ScoreLevel   `json:"levels,omitempty"`
}

var questionNamePattern = regexp.MustCompile(`^[\w.-]{1,100}$`)
var cfAccountPattern = regexp.MustCompile(`(?i)^[a-f0-9]{32}$`)

func choiceKeys(q DecisionQuestion) []string {
	hasBool := false
	for _, c := range q.Choices {
		if _, isBool := c.Value.(bool); isBool {
			hasBool = true
			break
		}
	}
	out := make([]string, len(q.Choices))
	for i, c := range q.Choices {
		if hasBool {
			out[i] = fmt.Sprintf("option_%d", i)
		} else {
			out[i] = fmt.Sprintf("%v", c.Value)
		}
	}
	return out
}

func validateQuestions(questions []DecisionQuestion) error {
	if len(questions) < 1 || len(questions) > 64 {
		return NewDecisionsError(ErrSchema, nil)
	}
	seenNames := make(map[string]bool, len(questions))
	for _, q := range questions {
		if !questionNamePattern.MatchString(q.Name) || seenNames[q.Name] {
			return NewDecisionsError(ErrSchema, nil)
		}
		seenNames[q.Name] = true
		switch q.Type {
		case "predicate":
		case "choice":
			if len(q.Choices) < 2 || len(q.Choices) > 255 {
				return NewDecisionsError(ErrSchema, nil)
			}
			seenVals := make(map[string]bool, len(q.Choices))
			for _, c := range q.Choices {
				switch v := c.Value.(type) {
				case string:
					if len(v) < 1 {
						return NewDecisionsError(ErrSchema, nil)
					}
				case bool:
				default:
					return NewDecisionsError(ErrSchema, nil)
				}
				rawVal, _ := json.Marshal(c.Value)
				key := string(rawVal)
				if seenVals[key] {
					return NewDecisionsError(ErrSchema, nil)
				}
				seenVals[key] = true
			}
		case "score":
			if len(q.Levels) < 2 || len(q.Levels) > 10 {
				return NewDecisionsError(ErrSchema, nil)
			}
		default:
			return NewDecisionsError(ErrSchema, nil)
		}
	}
	return nil
}

// ToSystemOne formats state and typed questions into a SystemOne/Clef request payload.
func ToSystemOne(state string, questions []DecisionQuestion, model string) (map[string]any, error) {
	if model == "" {
		model = DefaultCloudflareModel
	}
	if err := validateQuestions(questions); err != nil {
		return nil, err
	}
	qMap := make(map[string]any, len(questions))
	for _, q := range questions {
		switch q.Type {
		case "predicate":
			qMap[q.Name] = map[string]any{
				"type":         "noul",
				"instructions": q.Instructions,
			}
		case "score":
			criteria := make([]string, len(q.Levels))
			for i, l := range q.Levels {
				if l.Description != "" {
					criteria[i] = fmt.Sprintf("%s: %s", l.Label, l.Description)
				} else {
					criteria[i] = l.Label
				}
			}
			qMap[q.Name] = map[string]any{
				"type":         "score",
				"instructions": q.Instructions,
				"criteria":     criteria,
			}
		case "choice":
			keys := choiceKeys(q)
			criteria := make(map[string]string, len(q.Choices))
			for i, c := range q.Choices {
				desc := c.Description
				if desc == "" {
					desc = fmt.Sprintf("%v", c.Value)
				}
				criteria[keys[i]] = desc
			}
			qMap[q.Name] = map[string]any{
				"type":         "choice",
				"instructions": q.Instructions,
				"criteria":     criteria,
			}
		}
	}
	return map[string]any{
		"model":     model,
		"state":     state,
		"questions": qMap,
	}, nil
}

const (
	roundingHalfUnit  = 0.00005
	arithmeticEpsilon = 1e-12
)

// NormalizeSystemOne validates a SystemOne response against the requested questions,
// checking probability sums, argmax choice consistency, and score expectation/legend.
func NormalizeSystemOne(raw any, questions []DecisionQuestion) (map[string]any, error) {
	if err := validateQuestions(questions); err != nil {
		return nil, err
	}
	rm, ok := raw.(map[string]any)
	if !ok || rm == nil {
		return nil, NewDecisionsError(ErrSchema, nil)
	}
	modelStr, ok := rm["model"].(string)
	if !ok || len(modelStr) < 1 {
		return nil, NewDecisionsError(ErrSchema, nil)
	}
	usageRaw, ok := rm["usage"].(map[string]any)
	if !ok || usageRaw == nil {
		return nil, NewDecisionsError(ErrSchema, nil)
	}
	inTok, okIn := toInt(usageRaw["input_tokens"])
	outTok, okOut := toInt(usageRaw["output_tokens"])
	if !okIn || !okOut || inTok < 0 || outTok < 0 {
		return nil, NewDecisionsError(ErrSchema, nil)
	}
	answersRaw, ok := rm["answers"].(map[string]any)
	if !ok || len(answersRaw) != len(questions) {
		return nil, NewDecisionsError(ErrSchema, nil)
	}

	normalizedAnswers := make([]any, 0, len(questions))
	for _, q := range questions {
		ansObj, ok := answersRaw[q.Name].(map[string]any)
		if !ok || ansObj == nil {
			return nil, NewDecisionsError(ErrSchema, nil)
		}
		ansType, _ := ansObj["type"].(string)
		expectedType := q.Type
		if q.Type == "predicate" {
			expectedType = "noul"
		}
		if ansType != expectedType {
			return nil, NewDecisionsError(ErrSchema, nil)
		}
		if ansType == "noul" {
			noulVal, ok := toFiniteFloat(ansObj["noul"])
			if !ok || noulVal < 0 || noulVal > 1 {
				return nil, NewDecisionsError(ErrSchema, nil)
			}
			normalizedAnswers = append(normalizedAnswers, map[string]any{
				"name":        q.Name,
				"type":        "predicate",
				"probability": noulVal,
			})
			continue
		}

		var allowed []string
		if q.Type == "choice" {
			allowed = choiceKeys(q)
		} else {
			allowed = make([]string, len(q.Levels))
			for i := range q.Levels {
				allowed[i] = strconv.Itoa(i)
			}
		}

		probsMap, ok := ansObj["probabilities"].(map[string]any)
		if !ok || len(probsMap) != len(allowed) {
			return nil, NewDecisionsError(ErrSchema, nil)
		}
		probsFloat := make(map[string]float64, len(allowed))
		sumProb := 0.0
		maxProb := -1.0
		for _, k := range allowed {
			pv, exists := probsMap[k]
			if !exists {
				return nil, NewDecisionsError(ErrSchema, nil)
			}
			pf, ok := toFiniteFloat(pv)
			if !ok || pf < 0 || pf > 1 {
				return nil, NewDecisionsError(ErrSchema, nil)
			}
			probsFloat[k] = pf
			sumProb += pf
			if pf > maxProb {
				maxProb = pf
			}
		}
		if math.Abs(sumProb-1.0) > float64(len(allowed))*roundingHalfUnit+arithmeticEpsilon {
			return nil, NewDecisionsError(ErrSchema, nil)
		}

		conf, ok := toFiniteFloat(ansObj["confidence"])
		if !ok || conf < 0 || conf > 1 {
			return nil, NewDecisionsError(ErrSchema, nil)
		}

		if ansType == "choice" && q.Type == "choice" {
			choiceKey, ok := ansObj["choice"].(string)
			if !ok {
				return nil, NewDecisionsError(ErrSchema, nil)
			}
			idx := slices.Index(allowed, choiceKey)
			if idx < 0 || probsFloat[choiceKey]+arithmeticEpsilon < maxProb {
				return nil, NewDecisionsError(ErrSchema, nil)
			}
			probEntries := make([]any, len(allowed))
			for i, k := range allowed {
				probEntries[i] = map[string]any{
					"value":       q.Choices[i].Value,
					"probability": probsFloat[k],
				}
			}
			normalizedAnswers = append(normalizedAnswers, map[string]any{
				"name":          q.Name,
				"type":          "choice",
				"choice":        q.Choices[idx].Value,
				"confidence":    conf,
				"probabilities": probEntries,
			})
			continue
		}

		if ansType == "score" && q.Type == "score" {
			scoreVal, ok := toFiniteFloat(ansObj["score"])
			if !ok {
				return nil, NewDecisionsError(ErrSchema, nil)
			}
			expectedScore := 0.0
			for i, k := range allowed {
				expectedScore += float64(i) * probsFloat[k]
			}
			kLen := float64(len(allowed))
			scoreTolerance := (1.0+kLen*(kLen-1.0)/2.0)*roundingHalfUnit + arithmeticEpsilon
			if scoreVal < 0 || scoreVal > float64(len(q.Levels)-1) || math.Abs(scoreVal-expectedScore) > scoreTolerance {
				return nil, NewDecisionsError(ErrSchema, nil)
			}
			legendMap, ok := ansObj["legend"].(map[string]any)
			if !ok || len(legendMap) != len(allowed) {
				return nil, NewDecisionsError(ErrSchema, nil)
			}
			for i, k := range allowed {
				lv, ok := legendMap[k].(string)
				if !ok {
					return nil, NewDecisionsError(ErrSchema, nil)
				}
				expectedLegend := q.Levels[i].Label
				if q.Levels[i].Description != "" {
					expectedLegend = fmt.Sprintf("%s: %s", q.Levels[i].Label, q.Levels[i].Description)
				}
				if lv != expectedLegend {
					return nil, NewDecisionsError(ErrSchema, nil)
				}
			}
			probEntries := make([]any, len(allowed))
			for i, k := range allowed {
				probEntries[i] = map[string]any{
					"value":       i,
					"label":       q.Levels[i].Label,
					"probability": probsFloat[k],
				}
			}
			normalizedAnswers = append(normalizedAnswers, map[string]any{
				"name":          q.Name,
				"type":          "score",
				"score":         scoreVal,
				"confidence":    conf,
				"probabilities": probEntries,
			})
			continue
		}
		return nil, NewDecisionsError(ErrSchema, nil)
	}

	return map[string]any{
		"model": rm["model"],
		"usage": map[string]any{
			"input_tokens":  inTok,
			"output_tokens": outTok,
		},
		"answers": normalizedAnswers,
	}, nil
}

type DecisionProviderOptions struct {
	DecisionsMockURL string
	CloudflareModel  *string
}

type DecisionProvider interface {
	Name() string
	Select(ctx context.Context, issue string, reports []ReportSpec, evidence []CollectedEvidence) (RouteDecision, error)
}

type IterativeDecisionProvider interface {
	DecisionProvider
	CanDecideAction() bool
	DecideAction(ctx context.Context, stateJson string, actions []CandidateMcpAction, evidenceCount int) (RouteDecision, error)
}

type funcProvider struct {
	name       string
	fn         func(ctx context.Context, issue string, reports []ReportSpec, evidence []CollectedEvidence) (RouteDecision, error)
	actionFn   func(ctx context.Context, stateJson string, actions []CandidateMcpAction, evidenceCount int) (RouteDecision, error)
}

func (p *funcProvider) Name() string { return p.name }
func (p *funcProvider) Select(ctx context.Context, issue string, reports []ReportSpec, evidence []CollectedEvidence) (RouteDecision, error) {
	return p.fn(ctx, issue, reports, evidence)
}
func (p *funcProvider) CanDecideAction() bool {
	return p.actionFn != nil
}
func (p *funcProvider) DecideAction(ctx context.Context, stateJson string, actions []CandidateMcpAction, evidenceCount int) (RouteDecision, error) {
	if p.actionFn == nil {
		return RouteDecision{}, NewDecisionsError(ErrUnexpected, nil)
	}
	return p.actionFn(ctx, stateJson, actions, evidenceCount)
}

func NewMockDecisionProvider(name string, fn func(ctx context.Context, issue string, reports []ReportSpec, evidence []CollectedEvidence) (RouteDecision, error)) DecisionProvider {
	return &funcProvider{name: name, fn: fn}
}

func classifySystemOneHttpFailure(provider string, status int, code int) *DecisionsError {
	st := status
	kind := ErrService
	if code == 3036 || code == 5035 {
		kind = ErrBilling
	} else if status == 401 {
		kind = ErrAuthentication
	} else if status == 402 {
		kind = ErrBilling
	} else if status == 403 {
		kind = ErrPermission
	} else if status == 429 {
		kind = ErrRateLimit
	} else if status == 400 || status == 422 {
		kind = ErrSchema
	}
	return NewProviderError(provider, kind, &st)
}

func CreateDecisionProvider(mode string, opts DecisionProviderOptions) (DecisionProvider, error) {
	name, err := ProviderName(mode)
	if err != nil {
		return nil, err
	}
	if opts.DecisionsMockURL != "" && name != "openai" {
		return nil, NewDecisionsError(ErrSchema, nil)
	}
	if opts.CloudflareModel != nil && name != "cloudflare" {
		return nil, NewProviderError(name, ErrSchema, nil)
	}

	var cfModel *CloudflareModelSpec
	if name == "cloudflare" {
		modelName := DefaultCloudflareModel
		if opts.CloudflareModel != nil {
			modelName = *opts.CloudflareModel
		}
		spec, err := ResolveCloudflareModel(modelName)
		if err != nil {
			return nil, err
		}
		cfModel = &spec
	}

	if name == "offline" {
		return &funcProvider{
			name: "offline",
			fn: func(_ context.Context, _ string, reports []ReportSpec, _ []CollectedEvidence) (RouteDecision, error) {
				return OfflineSelection(reports)
			},
		}, nil
	}

	if name == "openai" {
		if opts.DecisionsMockURL != "" {
			if _, err := validateDecisionsMockURL(opts.DecisionsMockURL); err != nil {
				return nil, err
			}
		} else {
			if strings.TrimSpace(os.Getenv("PERFDIGEST_DECISIONS_API_KEY")) == "" {
				return nil, NewDecisionsError(ErrMissingCredential, nil)
			}
		}
		return &funcProvider{
			name: "openai",
			fn: func(ctx context.Context, issue string, reports []ReportSpec, evidence []CollectedEvidence) (RouteDecision, error) {
				return selectOpenAIReport(ctx, opts.DecisionsMockURL, issue, reports, evidence)
			},
			actionFn: func(ctx context.Context, stateJson string, actions []CandidateMcpAction, evidenceCount int) (RouteDecision, error) {
				return selectOpenAIAction(ctx, opts.DecisionsMockURL, stateJson, actions, evidenceCount)
			},
		}, nil
	}

	var endpoint string
	headers := map[string]string{
		"Content-Type": "application/json",
	}
	if name == "local" {
		rawURL := os.Getenv("PERFDIGEST_CLEF_URL")
		if rawURL == "" {
			rawURL = DefaultLocalEndpoint
		}
		validated, err := ValidateLocalEndpoint(rawURL)
		if err != nil {
			return nil, NewProviderError("local", ErrSchema, nil)
		}
		endpoint = validated
	} else {
		account := strings.TrimSpace(os.Getenv("PERFDIGEST_CLOUDFLARE_ACCOUNT_ID"))
		token := strings.TrimSpace(os.Getenv("PERFDIGEST_CLOUDFLARE_API_TOKEN"))
		if account == "" || token == "" {
			return nil, NewProviderError(name, ErrMissingCredential, nil)
		}
		if !cfAccountPattern.MatchString(account) || strings.ContainsAny(token, "\r\n") {
			return nil, NewProviderError(name, ErrSchema, nil)
		}
		endpoint = fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/ai/run/%s", account, cfModel.ID)
		headers["Authorization"] = "Bearer " + token
	}

	querySystemOne := func(ctx context.Context, inputStr string, questions []DecisionQuestion) (map[string]any, error) {
		wrapErr := func(err error) error {
			if de, ok := err.(*DecisionsError); ok {
				if de.Provider != "" {
					return de
				}
				if ctx != nil && ctx.Err() != nil {
					return NewProviderError(name, ErrCancelled, nil)
				}
				return NewProviderError(name, de.Kind, de.HttpStatus)
			}
			if ctx != nil && ctx.Err() != nil {
				return NewProviderError(name, ErrCancelled, nil)
			}
			return NewProviderError(name, ErrUnexpected, nil)
		}

		if ctx != nil && ctx.Err() != nil {
			return nil, NewProviderError(name, ErrCancelled, nil)
		}
		reqModel := DefaultCloudflareModel
		if cfModel != nil {
			reqModel = cfModel.RequestModel
		}
		sysReq, err := ToSystemOne(inputStr, questions, reqModel)
		if err != nil {
			return nil, wrapErr(err)
		}
		reqBytes, err := json.Marshal(sysReq)
		if err != nil {
			return nil, NewProviderError(name, ErrSchema, nil)
		}

		timeout := 30 * time.Second
		if name == "local" {
			timeout = 120 * time.Second
		}
		reqCtx, cancel := context.WithTimeout(ctxOrBg(ctx), timeout)
		defer cancel()

		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(reqBytes))
		if err != nil {
			return nil, NewProviderError(name, ErrNetwork, nil)
		}
		for hk, hv := range headers {
			req.Header.Set(hk, hv)
		}
		client := &http.Client{
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		resp, err := client.Do(req)
		if err != nil {
			if ctx != nil && ctx.Err() != nil {
				return nil, NewProviderError(name, ErrCancelled, nil)
			}
			return nil, NewProviderError(name, ErrNetwork, nil)
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			return nil, NewProviderError(name, ErrNetwork, nil)
		}

		bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 128_001))
		if err != nil {
			if ctx != nil && ctx.Err() != nil {
				return nil, NewProviderError(name, ErrCancelled, nil)
			}
			return nil, NewProviderError(name, ErrNetwork, nil)
		}
		if len(bodyBytes) > 128_000 {
			return nil, NewProviderError(name, ErrSchema, nil)
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			code := 0
			if name == "cloudflare" {
				var errEnv struct {
					Errors []struct {
						Code int `json:"code"`
					} `json:"errors"`
				}
				if json.Unmarshal(bodyBytes, &errEnv) == nil {
					for _, e := range errEnv.Errors {
						if e.Code == 3036 || e.Code == 5035 {
							code = e.Code
							break
						}
					}
				}
			}
			return nil, classifySystemOneHttpFailure(name, resp.StatusCode, code)
		}

		var raw any
		if err := json.Unmarshal(bodyBytes, &raw); err != nil {
			return nil, NewProviderError(name, ErrSchema, nil)
		}
		if name == "cloudflare" {
			envMap, ok := raw.(map[string]any)
			if !ok || envMap == nil {
				return nil, NewProviderError(name, ErrSchema, nil)
			}
			succ, ok := envMap["success"].(bool)
			if !ok {
				return nil, NewProviderError(name, ErrSchema, nil)
			}
			if !succ {
				st := resp.StatusCode
				return nil, NewProviderError(name, ErrService, &st)
			}
			raw = envMap["result"]
		}

		normalized, err := NormalizeSystemOne(raw, questions)
		if err != nil {
			return nil, wrapErr(err)
		}
		normModel, _ := normalized["model"].(string)
		allowedIdentities := []string{"clef-flash", "@cf/cloudflare/clef-flash"}
		if cfModel != nil {
			allowedIdentities = cfModel.Identities
		}
		if !slices.Contains(allowedIdentities, normModel) {
			return nil, NewProviderError(name, ErrSchema, nil)
		}
		return normalized, nil
	}

	source := "clef_local"
	transport := "loopback_http"
	reqModelID := ""
	if name == "cloudflare" {
		source = "clef_cloudflare"
		transport = "cloudflare_https"
		if cfModel != nil {
			reqModelID = cfModel.ID
		}
	}

	return &funcProvider{
		name: name,
		fn: func(ctx context.Context, issue string, reports []ReportSpec, evidence []CollectedEvidence) (RouteDecision, error) {
			start := time.Now()
			wrapErr := func(err error) error {
				if de, ok := err.(*DecisionsError); ok {
					if de.Provider != "" {
						return de
					}
					if ctx != nil && ctx.Err() != nil {
						return NewProviderError(name, ErrCancelled, nil)
					}
					return NewProviderError(name, de.Kind, de.HttpStatus)
				}
				if ctx != nil && ctx.Err() != nil {
					return NewProviderError(name, ErrCancelled, nil)
				}
				return NewProviderError(name, ErrUnexpected, nil)
			}
			if ctx != nil && ctx.Err() != nil {
				return RouteDecision{}, NewProviderError(name, ErrCancelled, nil)
			}
			inputStr, err := DecisionsInput(issue, reports, evidence)
			if err != nil {
				return RouteDecision{}, wrapErr(err)
			}
			questions := []DecisionQuestion{RoutingQuestion(reports)}
			normalized, err := querySystemOne(ctx, inputStr, questions)
			if err != nil {
				return RouteDecision{}, wrapErr(err)
			}
			sum := sha256.Sum256([]byte(inputStr))
			inputSha := hex.EncodeToString(sum[:])
			evCount := len(evidence)
			latencyMs := math.Round(float64(time.Since(start).Microseconds()) / 1000.0)
			dec, err := RouteDecisionFromResponse(normalized, reports, RouteDecision{
				Source:              source,
				Provider:            name,
				RequestedModel:      reqModelID,
				ConfidenceSemantics: "systemone_uniform_zero",
				Transport:           transport,
				InputSha256:         inputSha,
				EvidenceCount:       &evCount,
				LatencyMs:           latencyMs,
			})
			if err != nil {
				return RouteDecision{}, wrapErr(err)
			}
			return dec, nil
		},
		actionFn: func(ctx context.Context, stateJson string, actions []CandidateMcpAction, evidenceCount int) (RouteDecision, error) {
			start := time.Now()
			wrapErr := func(err error) error {
				if de, ok := err.(*DecisionsError); ok {
					if de.Provider != "" {
						return de
					}
					if ctx != nil && ctx.Err() != nil {
						return NewProviderError(name, ErrCancelled, nil)
					}
					return NewProviderError(name, de.Kind, de.HttpStatus)
				}
				if ctx != nil && ctx.Err() != nil {
					return NewProviderError(name, ErrCancelled, nil)
				}
				return NewProviderError(name, ErrUnexpected, nil)
			}
			if ctx != nil && ctx.Err() != nil {
				return RouteDecision{}, NewProviderError(name, ErrCancelled, nil)
			}
			q, err := IterativeActionQuestion(actions)
			if err != nil {
				return RouteDecision{}, wrapErr(err)
			}
			normalized, err := querySystemOne(ctx, stateJson, []DecisionQuestion{q})
			if err != nil {
				return RouteDecision{}, wrapErr(err)
			}
			sum := sha256.Sum256([]byte(stateJson))
			inputSha := hex.EncodeToString(sum[:])
			evCount := evidenceCount
			latencyMs := math.Round(float64(time.Since(start).Microseconds()) / 1000.0)
			dec, err := RouteActionDecisionFromResponse(normalized, actions, RouteDecision{
				Source:              source,
				Provider:            name,
				RequestedModel:      reqModelID,
				ConfidenceSemantics: "systemone_uniform_zero",
				Transport:           transport,
				InputSha256:         inputSha,
				EvidenceCount:       &evCount,
				LatencyMs:           latencyMs,
			})
			if err != nil {
				return RouteDecision{}, wrapErr(err)
			}
			return dec, nil
		},
	}, nil
}
