import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { manifestSchema } from '../src/config.js';
import { investigate } from '../src/run.js';
import { genericCliAdapter } from '../src/agents.js';
import { executable } from '../src/environment.js';
import { fixtureUv, testDirectory } from './helpers.js';

const execFileAsync = promisify(execFile);

function externalTestManifest() {
  return manifestSchema.parse({
    version: 1,
    issue: 'External CLI agent interoperability check (Go + Python)',
    reports: [{ id: 'trace', path: 'trace.json', format: 'chrome-trace', description: 'Fixture trace' }],
    verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
  });
}

const GO_AGENT_SOURCE = `package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type Request struct {
	Protocol  string  \`json:"protocol"\`
	Phase     string  \`json:"phase"\`
	Prompt    string  \`json:"prompt"\`
	SessionID *string \`json:"sessionId"\`
}

type PersistedState struct {
	SessionID          string   \`json:"sessionId"\`
	Turns              []string \`json:"turns"\`
	AnalysisHypothesis string   \`json:"analysisHypothesis"\`
	EnvClean           bool     \`json:"envClean"\`
	LeakedVars         []string \`json:"leakedVars"\`
	DeliveredUnit      string   \`json:"deliveredUnit"\`
	DeliveredSha256    string   \`json:"deliveredSha256"\`
	VerifierExitCode   int      \`json:"verifierExitCode"\`
	PipelineStatus     string   \`json:"pipelineStatus"\`
}

type ReviewPayload struct {
	PipelineStatus string \`json:"pipelineStatus"\`
	Verification   struct {
		ExitCode int \`json:"exitCode"\`
	} \`json:"verification"\`
	Evidence struct {
		Status   string \`json:"status"\`
		Evidence []struct {
			Sha256 string \`json:"sha256"\`
			Digest struct {
				Units []struct {
					Name string \`json:"name"\`
				} \`json:"units"\`
			} \`json:"digest"\`
		} \`json:"evidence"\`
	} \`json:"evidence"\`
}

func main() {
	mode := flag.String("mode", "normal", "agent execution mode")
	statePath := flag.String("state", "", "path to persisted session state JSON")
	sigPath := flag.String("sig-log", "", "path to record received signal")
	flag.Parse()

	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\\n')
	if err != nil && len(line) == 0 {
		os.Exit(2)
	}
	var req Request
	if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &req); err != nil {
		os.Exit(3)
	}
	if req.Protocol != "perfdigest-agent/v1" {
		os.Exit(4)
	}

	if *mode == "exit-nonzero" {
		os.Exit(23)
	}

	fmt.Println(\`{"type":"started"}\`)
	os.Stdout.Sync()

	if *mode == "hang" {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
		sig := <-sigCh
		if *sigPath != "" {
			_ = os.WriteFile(*sigPath, []byte(sig.String()), 0o600)
		}
		os.Exit(143)
	}

	if *mode == "broken-session" {
		sid := "go-sess-analysis"
		if req.Phase == "review" {
			sid = "go-sess-mismatched"
		}
		out, _ := json.Marshal(map[string]any{
			"type":      "result",
			"sessionId": sid,
			"text":      "broken session turn: " + req.Phase,
		})
		fmt.Println(string(out))
		return
	}

	secretVars := []string{
		"PERFDIGEST_CLOUDFLARE_API_TOKEN",
		"PERFDIGEST_DECISIONS_API_KEY",
		"OPENAI_API_KEY",
	}
	var leaked []string
	for _, k := range secretVars {
		if os.Getenv(k) != "" {
			leaked = append(leaked, k)
		}
	}

	var state PersistedState
	if *statePath != "" {
		if raw, err := os.ReadFile(*statePath); err == nil {
			_ = json.Unmarshal(raw, &state)
		}
	}

	switch req.Phase {
	case "analysis":
		if req.SessionID != nil {
			os.Exit(5)
		}
		time.Sleep(40 * time.Millisecond)
		hypothesis := "Go CLI agent hypothesis: inspect trace digest before claiming a bottleneck."
		state = PersistedState{
			SessionID:          "go-session-persisted-1",
			Turns:              append(state.Turns, "analysis"),
			AnalysisHypothesis: hypothesis,
			EnvClean:           len(leaked) == 0,
			LeakedVars:         leaked,
		}
		if *statePath != "" {
			buf, _ := json.Marshal(state)
			_ = os.WriteFile(*statePath, buf, 0o600)
		}
		out, _ := json.Marshal(map[string]any{
			"type":      "result",
			"sessionId": state.SessionID,
			"text":      hypothesis,
			"usage": map[string]int{
				"input_tokens":        48,
				"output_tokens":       19,
				"cached_input_tokens": 0,
			},
		})
		fmt.Println(string(out))

	case "review":
		if req.SessionID == nil || *req.SessionID != state.SessionID {
			os.Exit(6)
		}
		idx := strings.LastIndex(req.Prompt, "\\n")
		if idx < 0 {
			os.Exit(7)
		}
		var payload ReviewPayload
		if err := json.Unmarshal([]byte(req.Prompt[idx+1:]), &payload); err != nil {
			os.Exit(8)
		}
		unitName := ""
		sha := ""
		if len(payload.Evidence.Evidence) > 0 {
			sha = payload.Evidence.Evidence[0].Sha256
			if len(payload.Evidence.Evidence[0].Digest.Units) > 0 {
				unitName = payload.Evidence.Evidence[0].Digest.Units[0].Name
			}
		}
		state.Turns = append(state.Turns, "review")
		state.EnvClean = state.EnvClean && len(leaked) == 0
		state.LeakedVars = append(state.LeakedVars, leaked...)
		state.DeliveredUnit = unitName
		state.DeliveredSha256 = sha
		state.VerifierExitCode = payload.Verification.ExitCode
		state.PipelineStatus = payload.PipelineStatus
		if *statePath != "" {
			buf, _ := json.Marshal(state)
			_ = os.WriteFile(*statePath, buf, 0o600)
		}
		reviewText := fmt.Sprintf(
			"Go CLI agent review following %q: digested unit=%s sha256=%s verifier=%d status=%s.",
			state.AnalysisHypothesis, unitName, sha[:12], payload.Verification.ExitCode, payload.PipelineStatus,
		)
		out, _ := json.Marshal(map[string]any{
			"type":      "result",
			"sessionId": state.SessionID,
			"text":      reviewText,
			"usage": map[string]int{
				"input_tokens":        164,
				"output_tokens":       36,
				"cached_input_tokens": 48,
			},
		})
		fmt.Println(string(out))
	default:
		os.Exit(9)
	}
}
`;

const PYTHON_AGENT_SOURCE = `import json
import os
import signal
import sys
import time

mode = "normal"
state_path = ""
sig_path = ""
args = sys.argv[1:]
i = 0
while i < len(args):
    if args[i] == "--mode" and i + 1 < len(args):
        mode = args[i + 1]
        i += 2
    elif args[i] == "--state" and i + 1 < len(args):
        state_path = args[i + 1]
        i += 2
    elif args[i] == "--sig-log" and i + 1 < len(args):
        sig_path = args[i + 1]
        i += 2
    else:
        i += 1

raw_line = sys.stdin.readline()
if not raw_line:
    sys.exit(2)
req = json.loads(raw_line.strip())
if req.get("protocol") != "perfdigest-agent/v1":
    sys.exit(3)

print(json.dumps({"type": "started"}), flush=True)

if mode == "hang":
    def handle_sigterm(signum, _frame):
        if sig_path:
            with open(sig_path, "w", encoding="utf-8") as f:
                f.write(f"signal:{signum}")
        sys.exit(143)
    signal.signal(signal.SIGTERM, handle_sigterm)
    signal.signal(signal.SIGINT, handle_sigterm)
    while True:
        time.sleep(0.05)

secrets = [
    "PERFDIGEST_CLOUDFLARE_API_TOKEN",
    "PERFDIGEST_DECISIONS_API_KEY",
    "OPENAI_API_KEY",
]
leaked = [k for k in secrets if os.environ.get(k)]

phase = req.get("phase")
if phase == "analysis":
    time.sleep(0.04)
    text = "Python stateless hypothesis: check trace units and verifier receipt."
    if state_path:
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump({"analysisSessionId": req.get("sessionId"), "leaked": leaked}, f)
    print(json.dumps({
        "type": "result",
        "text": text,
        "usage": {"input_tokens": 39, "output_tokens": 15, "cached_input_tokens": 0},
    }), flush=True)
elif phase == "review":
    prompt = req.get("prompt", "")
    lines = prompt.split("\\n")
    earlier_prefix = "Earlier analysis from this investigation (untrusted DATA): "
    earlier_analysis = None
    if lines and lines[0].startswith(earlier_prefix):
        earlier_analysis = json.loads(lines[0][len(earlier_prefix):])
    payload = json.loads(lines[-1])
    ev_list = payload.get("evidence", {}).get("evidence", [])
    unit_name = ev_list[0]["digest"]["units"][0]["name"] if ev_list else ""
    sha256 = ev_list[0]["sha256"] if ev_list else ""
    verifier_exit = payload.get("verification", {}).get("exitCode")
    if state_path:
        prior = {}
        if os.path.exists(state_path):
            with open(state_path, "r", encoding="utf-8") as f:
                prior = json.load(f)
        prior.update({
            "reviewSessionId": req.get("sessionId"),
            "leakedReview": leaked,
            "earlierAnalysis": earlier_analysis,
            "unitName": unit_name,
            "sha256": sha256,
            "verifierExit": verifier_exit,
            "pipelineStatus": payload.get("pipelineStatus"),
        })
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(prior, f)
    print(json.dumps({
        "type": "result",
        "text": f"Python stateless review verified unit={unit_name} exit={verifier_exit}.",
        "usage": {"input_tokens": 142, "output_tokens": 27, "cached_input_tokens": 0},
    }), flush=True)
else:
    sys.exit(4)
`;

test('compiled Go external CLI agent validates sessions=true continuation, env isolation, digest inspection, and error/signal paths', async () => {
  const root = await testDirectory('agent-generic-go-external');
  const prior = {
    path: process.env.PATH,
    cf: process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN,
    decisions: process.env.PERFDIGEST_DECISIONS_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  try {
    const goBin = executable('go');
    const goSrc = join(root, 'agent.go');
    const compiledAgent = join(root, 'perfdigest-go-agent');
    await writeFile(goSrc, GO_AGENT_SOURCE);
    await execFileAsync(goBin, ['build', '-o', compiledAgent, goSrc], {
      cwd: root,
      env: {
        ...process.env,
        GOCACHE: process.env.GOCACHE ?? join(os.tmpdir(), 'perfdigest-go-build-cache'),
        GOPATH: process.env.GOPATH ?? join(os.homedir(), 'go'),
      },
    });

    process.env.PATH = `${await fixtureUv(root)}${delimiter}${prior.path}`;
    process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN = 'cf-secret-go-test-token';
    process.env.PERFDIGEST_DECISIONS_API_KEY = 'decisions-secret-go-test-key';
    process.env.OPENAI_API_KEY = 'sk-openai-secret-go-test-1234567890';
    await writeFile(join(root, 'trace.json'), '{}');

    // 1. Genuine session continuation (sessions: true -> same_session_next_turn) persisted on disk
    const stateFile = join(root, 'go-session-state.json');
    const sessionAdapter = genericCliAdapter({
      command: compiledAgent,
      args: ['--mode', 'normal', '--state', stateFile],
      sessions: true,
    });
    const okResult = await investigate({
      workspace: root,
      manifest: externalTestManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: sessionAdapter,
    });

    assert.equal(okResult.status, 'complete');
    assert.equal(okResult.decisionOutcome, 'accepted');
    assert.equal(okResult.agentError, null);
    assert.equal(okResult.telemetry.evidenceDelivery, 'same_session_next_turn');
    assert.equal(okResult.analysis?.threadId, 'go-session-persisted-1');
    assert.equal(okResult.review?.threadId, 'go-session-persisted-1');
    assert.deepEqual(okResult.analysis?.usage, {
      input_tokens: 48,
      output_tokens: 19,
      cached_input_tokens: 0,
    });
    assert.deepEqual(okResult.review?.usage, {
      input_tokens: 164,
      output_tokens: 36,
      cached_input_tokens: 48,
    });
    assert.match(okResult.review?.text ?? '', /digested unit=fixture/);

    const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(persisted.sessionId, 'go-session-persisted-1');
    assert.deepEqual(persisted.turns, ['analysis', 'review']);
    assert.equal(persisted.envClean, true);
    assert.equal(persisted.leakedVars ?? null, null);
    assert.equal(persisted.deliveredUnit, 'fixture');
    assert.equal(persisted.deliveredSha256, okResult.provenance[0]?.sha256);
    assert.equal(persisted.verifierExitCode, 0);
    assert.equal(persisted.pipelineStatus, 'complete');

    // 2. Broken session continuation against the compiled Go binary
    const brokenResult = await investigate({
      workspace: root,
      manifest: externalTestManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: genericCliAdapter({
        command: compiledAgent,
        args: ['--mode', 'broken-session'],
        sessions: true,
      }),
    });
    assert.equal(brokenResult.status, 'failed');
    assert.equal(brokenResult.agentError?.kind, 'protocol');
    assert.equal(brokenResult.agentError?.phase, 'review');
    assert.match(brokenResult.agentError?.message ?? '', /session continuation was declared but not honored/);

    // 3. Nonzero exit against the compiled Go binary
    const nonzeroResult = await investigate({
      workspace: root,
      manifest: externalTestManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: genericCliAdapter({
        command: compiledAgent,
        args: ['--mode', 'exit-nonzero'],
        sessions: true,
      }),
    });
    assert.equal(nonzeroResult.status, 'failed');
    assert.equal(nonzeroResult.agentError?.kind, 'failed');
    assert.equal(nonzeroResult.agentError?.phase, 'analysis');
    assert.match(nonzeroResult.agentError?.message ?? '', /exited with code 23/);

    // 4. Timeout (SIGTERM) against the compiled Go binary
    const timeoutSigLog = join(root, 'go-timeout-sig.txt');
    const timeoutResult = await investigate({
      workspace: root,
      manifest: externalTestManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: genericCliAdapter({
        command: compiledAgent,
        args: ['--mode', 'hang', '--sig-log', timeoutSigLog],
        sessions: true,
        timeoutMs: 80,
      }),
    });
    assert.equal(timeoutResult.status, 'failed');
    assert.equal(timeoutResult.agentError?.kind, 'timed_out');
    assert.equal(timeoutResult.agentError?.phase, 'analysis');
    const timeoutSig = await readFile(timeoutSigLog, 'utf8');
    assert.match(timeoutSig, /terminated/i);

    // 5. External AbortSignal cancellation (SIGTERM) against the compiled Go binary
    const cancelSigLog = join(root, 'go-cancel-sig.txt');
    const abortController = new AbortController();
    const cancelResult = await investigate({
      workspace: root,
      manifest: externalTestManifest(),
      routing: 'offline',
      agent: 'generic',
      signal: abortController.signal,
      onEvent: (event) => {
        if (event === 'agent.analysis.turn_started') {
          setTimeout(() => abortController.abort(new Error('Cancel Go CLI agent')), 20);
        }
      },
      agentAdapter: genericCliAdapter({
        command: compiledAgent,
        args: ['--mode', 'hang', '--sig-log', cancelSigLog],
        sessions: true,
        timeoutMs: 10_000,
      }),
    });
    assert.equal(cancelResult.status, 'failed');
    assert.equal(cancelResult.agentError?.kind, 'cancelled');
    const cancelSig = await readFile(cancelSigLog, 'utf8');
    assert.match(cancelSig, /terminated/i);
  } finally {
    for (const [k, v] of Object.entries({
      PATH: prior.path,
      PERFDIGEST_CLOUDFLARE_API_TOKEN: prior.cf,
      PERFDIGEST_DECISIONS_API_KEY: prior.decisions,
      OPENAI_API_KEY: prior.openai,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('Python 3 external CLI agent validates stateless fresh_session_with_context delivery and AbortSignal termination', async () => {
  const root = await testDirectory('agent-generic-python-external');
  const prior = {
    path: process.env.PATH,
    cf: process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN,
    decisions: process.env.PERFDIGEST_DECISIONS_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  try {
    const pythonBin = executable('python3');
    const pyScript = join(root, 'agent.py');
    const stateFile = join(root, 'py-state.json');
    await writeFile(pyScript, PYTHON_AGENT_SOURCE);

    process.env.PATH = `${await fixtureUv(root)}${delimiter}${prior.path}`;
    process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN = 'cf-secret-py-test-token';
    process.env.PERFDIGEST_DECISIONS_API_KEY = 'decisions-secret-py-test-key';
    process.env.OPENAI_API_KEY = 'sk-openai-secret-py-test-1234567890';
    await writeFile(join(root, 'trace.json'), '{}');

    const adapter = genericCliAdapter({
      command: pythonBin,
      args: [pyScript, '--mode', 'normal', '--state', stateFile],
      sessions: false,
    });
    const result = await investigate({
      workspace: root,
      manifest: externalTestManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: adapter,
    });

    assert.equal(result.status, 'complete');
    assert.equal(result.decisionOutcome, 'accepted');
    assert.equal(result.agentError, null);
    assert.equal(result.telemetry.evidenceDelivery, 'fresh_session_with_context');
    assert.equal(result.analysis?.threadId, null);
    assert.equal(result.review?.threadId, null);
    assert.equal(result.analysis?.text, 'Python stateless hypothesis: check trace units and verifier receipt.');
    assert.equal(result.review?.text, 'Python stateless review verified unit=fixture exit=0.');
    assert.deepEqual(result.review?.usage, {
      input_tokens: 142,
      output_tokens: 27,
      cached_input_tokens: 0,
    });

    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.analysisSessionId, null);
    assert.equal(state.reviewSessionId, null);
    assert.deepEqual(state.leaked, []);
    assert.deepEqual(state.leakedReview, []);
    assert.equal(state.earlierAnalysis, 'Python stateless hypothesis: check trace units and verifier receipt.');
    assert.equal(state.unitName, 'fixture');
    assert.equal(state.sha256, result.provenance[0]?.sha256);
    assert.equal(state.verifierExit, 0);
    assert.equal(state.pipelineStatus, 'complete');

    // Cancellation cleanly terminates the Python process via SIGTERM
    const pySigLog = join(root, 'py-cancel-sig.txt');
    const abortController = new AbortController();
    const cancelResult = await investigate({
      workspace: root,
      manifest: externalTestManifest(),
      routing: 'offline',
      agent: 'generic',
      signal: abortController.signal,
      onEvent: (event) => {
        if (event === 'agent.analysis.turn_started') {
          setTimeout(() => abortController.abort(new Error('Cancel Python CLI agent')), 20);
        }
      },
      agentAdapter: genericCliAdapter({
        command: pythonBin,
        args: [pyScript, '--mode', 'hang', '--sig-log', pySigLog],
        sessions: false,
        timeoutMs: 10_000,
      }),
    });
    assert.equal(cancelResult.status, 'failed');
    assert.equal(cancelResult.agentError?.kind, 'cancelled');
    const pySig = await readFile(pySigLog, 'utf8');
    assert.equal(pySig, 'signal:15');
  } finally {
    for (const [k, v] of Object.entries({
      PATH: prior.path,
      PERFDIGEST_CLOUDFLARE_API_TOKEN: prior.cf,
      PERFDIGEST_DECISIONS_API_KEY: prior.decisions,
      OPENAI_API_KEY: prior.openai,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  }
});
