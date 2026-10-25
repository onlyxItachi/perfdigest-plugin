package perfdigest

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

type ServeMCPOptions struct {
	CloudflareModel   *string
	DecisionsMockURL  string
	McpSessionOptions *SessionOptions
	ReuseMcpSession   *bool
	Stdin             io.Reader
	Stdout            io.Writer
}

type evidenceJob struct {
	id        string
	createdAt time.Time
	cancel    context.CancelFunc
	cancelled bool
	done      chan struct{}
	mu        sync.Mutex
	state     string // "running", "complete", "needs_review", "failed", "cancelled"
	result    *EvidencePacket
	errText   string
}

func newUUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
}

func mcpToolReply(data map[string]any) map[string]any {
	encoded, _ := json.Marshal(data)
	return map[string]any{
		"content": []map[string]any{
			{
				"type": "text",
				"text": string(encoded),
			},
		},
		"structuredContent": data,
	}
}

func mcpToolError(msg string) map[string]any {
	return map[string]any{
		"content": []map[string]any{
			{
				"type": "text",
				"text": msg,
			},
		},
		"isError": true,
	}
}

func mcpToolsSchema(defaultRouting string) []map[string]any {
	if defaultRouting == "" {
		defaultRouting = "offline"
	}
	return []map[string]any{
		{
			"name":        "launch_evidence_prefetch",
			"description": "Start evidence collection without blocking. Uses existing reports; never runs a profiler or build. Select a provider explicitly; hosted modes need dedicated credentials in this server process.",
			"inputSchema": map[string]any{
				"$schema": "http://json-schema.org/draft-07/schema#",
				"type":    "object",
				"properties": map[string]any{
					"issue": map[string]any{
						"type":      "string",
						"minLength": 1,
						"maxLength": 12000,
					},
					"reports": map[string]any{
						"type":     "array",
						"minItems": 1,
						"maxItems": 8,
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"id": map[string]any{
									"type":    "string",
									"pattern": "^[a-zA-Z0-9_-]{1,80}$",
								},
								"path": map[string]any{
									"type":      "string",
									"minLength": 1,
								},
								"format": map[string]any{
									"type":      "string",
									"minLength": 1,
								},
								"description": map[string]any{
									"type":      "string",
									"maxLength": 1000,
								},
							},
							"required":             []string{"id", "path", "format", "description"},
							"additionalProperties": false,
						},
					},
					"mode": map[string]any{
						"default": defaultRouting,
						"type":    "string",
						"enum": []string{
							"offline", "cloudflare", "local", "openai",
							"decisions", "clef-local", "clef-cloudflare", "openai-luna",
						},
					},
				},
				"required": []string{"issue", "reports"},
			},
			"annotations": map[string]any{
				"readOnlyHint":    true,
				"destructiveHint": false,
				"openWorldHint":   true,
			},
			"execution": map[string]any{
				"taskSupport": "forbidden",
			},
		},
		{
			"name":        "get_evidence_job",
			"description": "Poll or await an evidence job in-execution. A terminal result is consumed once; jobs expire after five minutes.",
			"inputSchema": map[string]any{
				"$schema": "http://json-schema.org/draft-07/schema#",
				"type":    "object",
				"properties": map[string]any{
					"jobId": map[string]any{
						"type": "string",
					},
					"waitMs": map[string]any{
						"default": 0,
						"type":    "integer",
						"minimum": 0,
						"maximum": 60000,
					},
				},
				"required": []string{"jobId"},
			},
			"annotations": map[string]any{
				"readOnlyHint":    true,
				"destructiveHint": false,
				"openWorldHint":   false,
			},
			"execution": map[string]any{
				"taskSupport": "forbidden",
			},
		},
		{
			"name":        "cancel_evidence_job",
			"description": "Cancel an evidence job and release its slot.",
			"inputSchema": map[string]any{
				"$schema": "http://json-schema.org/draft-07/schema#",
				"type":    "object",
				"properties": map[string]any{
					"jobId": map[string]any{
						"type": "string",
					},
				},
				"required": []string{"jobId"},
			},
			"annotations": map[string]any{
				"readOnlyHint":    false,
				"destructiveHint": false,
				"openWorldHint":   false,
			},
			"execution": map[string]any{
				"taskSupport": "forbidden",
			},
		},
	}
}

func ServeMCP(ctx context.Context, workspace string, defaultRouting string, options ServeMCPOptions) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if defaultRouting == "" {
		defaultRouting = "offline"
	}
	in := options.Stdin
	if in == nil {
		in = os.Stdin
	}
	out := options.Stdout
	if out == nil {
		out = os.Stdout
	}

	serverCtx, serverCancel := context.WithCancel(ctx)
	defer serverCancel()

	var jobsMu sync.Mutex
	jobs := make(map[string]*evidenceJob)

	cleanupLocked := func() {
		now := time.Now()
		for id, job := range jobs {
			if now.Sub(job.createdAt) > 300*time.Second {
				job.mu.Lock()
				job.cancelled = true
				job.mu.Unlock()
				job.cancel()
				delete(jobs, id)
			}
		}
	}

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	go func() {
		for {
			select {
			case <-serverCtx.Done():
				return
			case <-ticker.C:
				jobsMu.Lock()
				cleanupLocked()
				jobsMu.Unlock()
			}
		}
	}()

	defer func() {
		jobsMu.Lock()
		for _, job := range jobs {
			job.cancel()
		}
		jobsMu.Unlock()
	}()

	var writeMu sync.Mutex
	sendJSON := func(msg map[string]any) {
		encoded, err := json.Marshal(msg)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_, _ = out.Write(append(encoded, '\n'))
	}

	sendResult := func(id any, result any) {
		sendJSON(map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"result":  result,
		})
	}

	sendError := func(id any, code int, message string) {
		sendJSON(map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"error": map[string]any{
				"code":    code,
				"message": message,
			},
		})
	}

	handleToolCall := func(id any, params map[string]any) {
		name, _ := params["name"].(string)
		argsRaw, _ := params["arguments"].(map[string]any)
		if argsRaw == nil {
			argsRaw = map[string]any{}
		}

		switch name {
		case "launch_evidence_prefetch":
			issue, okIssue := argsRaw["issue"].(string)
			if !okIssue || len(issue) < 1 || len(issue) > 12000 {
				sendResult(id, mcpToolError("Invalid issue: must be a string between 1 and 12000 characters"))
				return
			}
			reportsSlice, okReports := argsRaw["reports"].([]any)
			if !okReports || len(reportsSlice) < 1 || len(reportsSlice) > 8 {
				sendResult(id, mcpToolError("Invalid reports: must be an array of 1 to 8 reports"))
				return
			}
			reportsBytes, err := json.Marshal(reportsSlice)
			if err != nil {
				sendResult(id, mcpToolError("Invalid reports"))
				return
			}
			var reports []ReportSpec
			if err := json.Unmarshal(reportsBytes, &reports); err != nil {
				sendResult(id, mcpToolError(Redact(err.Error())))
				return
			}
			seen := make(map[string]bool, len(reports))
			for _, r := range reports {
				if seen[r.ID] {
					sendResult(id, mcpToolError("Report IDs must be unique"))
					return
				}
				seen[r.ID] = true
			}
			mode := defaultRouting
			if mStr, ok := argsRaw["mode"].(string); ok && mStr != "" {
				mode = mStr
			}
			pName, err := ProviderName(mode)
			if err != nil {
				sendResult(id, mcpToolError(Redact(err.Error())))
				return
			}

			jobsMu.Lock()
			cleanupLocked()
			if len(jobs) >= 32 {
				jobsMu.Unlock()
				sendResult(id, mcpToolError("Job limit reached; collect or cancel existing jobs"))
				return
			}

			var cfModel *string
			if pName == "cloudflare" && options.CloudflareModel != nil {
				cfModel = options.CloudflareModel
			}
			provider, err := CreateDecisionProvider(mode, DecisionProviderOptions{
				CloudflareModel:  cfModel,
				DecisionsMockURL: options.DecisionsMockURL,
			})
			if err != nil {
				jobsMu.Unlock()
				sendResult(id, mcpToolError(Redact(err.Error())))
				return
			}

			jobCtx, jobCancel := context.WithTimeout(serverCtx, 90*time.Second)
			jobID := newUUIDv4()
			job := &evidenceJob{
				id:        jobID,
				createdAt: time.Now(),
				cancel:    jobCancel,
				done:      make(chan struct{}),
				state:     "running",
			}
			jobs[jobID] = job
			jobsMu.Unlock()

			go func() {
				defer close(job.done)
				defer jobCancel()
				pkt, err := GatherEvidence(jobCtx, GatherEvidenceArgs{
					Workspace:         workspace,
					Issue:             issue,
					Reports:           reports,
					Routing:           mode,
					Provider:          provider,
					McpSessionOptions: options.McpSessionOptions,
					ReuseMcpSession:   options.ReuseMcpSession,
				})
				job.mu.Lock()
				defer job.mu.Unlock()
				if err != nil {
					if job.cancelled || errors.Is(jobCtx.Err(), context.Canceled) {
						job.state = "cancelled"
					} else {
						job.state = "failed"
					}
					job.errText = Redact(err.Error())
					return
				}
				job.state = pkt.Status
				job.result = &pkt
			}()

			sendResult(id, mcpToolReply(map[string]any{
				"jobId":   jobID,
				"status":  "running",
				"routing": mode,
			}))

		case "get_evidence_job":
			jobID, okID := argsRaw["jobId"].(string)
			if !okID {
				sendResult(id, mcpToolError("Invalid jobId"))
				return
			}
			waitMs := 0
			if wRaw, exists := argsRaw["waitMs"]; exists && wRaw != nil {
				switch v := wRaw.(type) {
				case float64:
					if v < 0 || v > 60000 || v != float64(int(v)) {
						sendResult(id, mcpToolError("Invalid waitMs: must be an integer between 0 and 60000"))
						return
					}
					waitMs = int(v)
				case int:
					if v < 0 || v > 60000 {
						sendResult(id, mcpToolError("Invalid waitMs: must be an integer between 0 and 60000"))
						return
					}
					waitMs = v
				default:
					sendResult(id, mcpToolError("Invalid waitMs"))
					return
				}
			}

			jobsMu.Lock()
			cleanupLocked()
			job, exists := jobs[jobID]
			jobsMu.Unlock()
			if !exists {
				sendResult(id, mcpToolReply(map[string]any{
					"jobId":  jobID,
					"status": "not_found",
				}))
				return
			}

			waitStart := time.Now()
			job.mu.Lock()
			st := job.state
			job.mu.Unlock()
			if st == "running" && waitMs > 0 {
				timer := time.NewTimer(time.Duration(waitMs) * time.Millisecond)
				select {
				case <-job.done:
				case <-timer.C:
				case <-serverCtx.Done():
				}
				timer.Stop()
			}
			waitedMs := int(time.Since(waitStart).Milliseconds())

			job.mu.Lock()
			st = job.state
			resPkt := job.result
			errTxt := job.errText
			job.mu.Unlock()

			if st != "running" {
				jobsMu.Lock()
				delete(jobs, jobID)
				jobsMu.Unlock()
			}
			payload := map[string]any{
				"jobId":        jobID,
				"status":       st,
				"deliveryMode": "in_execution_tool_delivery",
				"waitedMs":     waitedMs,
			}
			if resPkt != nil {
				payload["packet"] = resPkt
			}
			if errTxt != "" {
				payload["error"] = errTxt
			}
			sendResult(id, mcpToolReply(payload))

		case "cancel_evidence_job":
			jobID, okID := argsRaw["jobId"].(string)
			if !okID {
				sendResult(id, mcpToolError("Invalid jobId"))
				return
			}
			jobsMu.Lock()
			job, exists := jobs[jobID]
			if exists {
				delete(jobs, jobID)
			}
			jobsMu.Unlock()
			if !exists {
				sendResult(id, mcpToolReply(map[string]any{
					"jobId":  jobID,
					"status": "not_found",
				}))
				return
			}
			job.mu.Lock()
			job.cancelled = true
			job.state = "cancelled"
			job.mu.Unlock()
			job.cancel()
			sendResult(id, mcpToolReply(map[string]any{
				"jobId":  jobID,
				"status": "cancelled",
			}))

		default:
			sendResult(id, mcpToolError(fmt.Sprintf("Unknown tool: %s", name)))
		}
	}

	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var wg sync.WaitGroup
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req map[string]any
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}
		method, _ := req["method"].(string)
		id, hasID := req["id"]
		params, _ := req["params"].(map[string]any)

		switch method {
		case "initialize":
			protoVer := "2024-11-05"
			if params != nil {
				if pv, ok := params["protocolVersion"].(string); ok && pv != "" {
					protoVer = pv
				}
			}
			sendResult(id, map[string]any{
				"protocolVersion": protoVer,
				"capabilities": map[string]any{
					"tools": map[string]any{
						"listChanged": true,
					},
				},
				"serverInfo": map[string]any{
					"name":    "perfdigest-evidence",
					"version": "0.1.0",
				},
				"instructions": "Read-only asynchronous evidence from saved local reports. Launch a job, continue independent work, then collect it. Confidence is not correctness. This server never runs capture commands or applies patches. Offline routing is explicitly labeled.",
			})
		case "notifications/initialized", "notifications/cancelled":
			// Notifications do not receive a response.
		case "ping":
			if hasID {
				sendResult(id, map[string]any{})
			}
		case "tools/list":
			if hasID {
				sendResult(id, map[string]any{
					"tools": mcpToolsSchema(defaultRouting),
				})
			}
		case "tools/call":
			if hasID {
				wg.Add(1)
				go func(reqID any, reqParams map[string]any) {
					defer wg.Done()
					handleToolCall(reqID, reqParams)
				}(id, params)
			}
		default:
			if hasID {
				sendError(id, -32601, "Method not found")
			}
		}
	}
	serverCancel()
	wg.Wait()
	return nil
}
