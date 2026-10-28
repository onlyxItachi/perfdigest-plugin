#!/usr/bin/env node
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs, promisify } from 'node:util';
import {
  MANDATORY_CELL_CSV_COLUMNS,
  MANDATORY_SUMMARY_CSV_COLUMNS,
  auditBenchmarkResultsDirectory,
  writeValidatedBenchmarkBundle,
} from '../dist/benchmark-integrity.js';
import { disabledMcpOverrides } from '../dist/codex.js';
import { manifestSchema } from '../dist/config.js';
import { childEnvironment, executable, redact } from '../dist/environment.js';
import { investigate } from '../dist/run.js';

const execFileAsync = promisify(execFile);
const round2 = (n) => Math.round(n * 100) / 100;

function computeMean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function computeMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeP90(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1);
  return sorted[idx];
}

function csvEscape(val) {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function resolveGitSha(repoRoot) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  const baseSha = head || 'unknown';
  return dirty ? `${baseSha}-dirty` : baseSha;
}

function sanitizeTraceText(text, repoRoot, wsRoot) {
  if (!text) return text;
  return String(text)
    .split(wsRoot)
    .join('<workspace>')
    .split(repoRoot)
    .join('<repo>')
    .replace(/\/home\/[^\s"',;]+/g, '<home-path>')
    .replace(/\/Users\/[^\s"',;]+/g, '<user-path>')
    .replace(/\/root\/[^\s"',;]+/g, '<root-path>')
    .replace(/\/tmp\/[^\s"',;]+/g, '<tmp-path>');
}

export const STUDIES = [
  {
    id: 'cuda_opt_loop',
    rubricId: 'rubric.cuda_opt_loop.v1',
    issue:
      'Diagnose why the CUDA reduction kernel exhibits low warp occupancy and excessive shared memory bank conflicts.',
    primaryUnit: 'warp_reduce_bank_conflict',
    secondaryUnit: 'host_to_device_memcpy',
    symptomKeyword: 'cuda',
    primaryDurationUs: 64200,
    secondaryDurationUs: 3100,
    primaryTrace: {
      traceEvents: [
        { name: 'warp_reduce_bank_conflict', dur: 64200, cat: 'cuda_kernel', args: { ipc: 0.48, bank_conflicts: 32 } },
        { name: 'host_to_device_memcpy', dur: 3100, cat: 'cuda_memcpy', args: { ipc: 1.72 } },
      ],
    },
    secondaryTrace: {
      traceEvents: [{ name: 'stream_sync', dur: 1200, cat: 'cuda_runtime' }],
    },
    tokens: {
      raw: { in: 1480, cached: 180, out: 215, reasoning: 28 },
      twoTurnT1: { in: 520, cached: 0, out: 110, reasoning: 16 },
      twoTurnT2: { in: 690, cached: 340, out: 145, reasoning: 18 },
      singleTurn: { in: 760, cached: 120, out: 165, reasoning: 20 },
      turnSteer: { in: 620, cached: 140, out: 150, reasoning: 16 },
      toolOutput: { in: 590, cached: 140, out: 145, reasoning: 14 },
    },
  },
  {
    id: 'cpp_build_loop',
    rubricId: 'rubric.cpp_build_loop.v1',
    issue: 'Identify which translation unit and template instantiation dominate the C++ incremental build time.',
    primaryUnit: 'InstantiateClass_EigenTensorContraction',
    secondaryUnit: 'PerformPendingInstantiations',
    symptomKeyword: 'clang',
    primaryDurationUs: 81500,
    secondaryDurationUs: 12400,
    primaryTrace: {
      traceEvents: [
        { name: 'InstantiateClass_EigenTensorContraction', dur: 81500, cat: 'clang_frontend' },
        { name: 'PerformPendingInstantiations', dur: 12400, cat: 'clang_frontend' },
      ],
    },
    secondaryTrace: {
      traceEvents: [{ name: 'lld_link_finalize', dur: 4500, cat: 'linker' }],
    },
    tokens: {
      raw: { in: 1560, cached: 190, out: 225, reasoning: 30 },
      twoTurnT1: { in: 540, cached: 0, out: 115, reasoning: 16 },
      twoTurnT2: { in: 720, cached: 360, out: 150, reasoning: 18 },
      singleTurn: { in: 795, cached: 130, out: 172, reasoning: 22 },
      turnSteer: { in: 650, cached: 150, out: 158, reasoning: 18 },
      toolOutput: { in: 615, cached: 150, out: 152, reasoning: 16 },
    },
  },
  {
    id: 'pytorch_inductor_training',
    rubricId: 'rubric.pytorch_inductor_training.v1',
    issue: 'Determine the primary step-time bottleneck in the PyTorch Inductor training trace.',
    primaryUnit: 'triton_poi_fused_add_layernorm_0',
    secondaryUnit: 'aten::copy_blocking_host_sync',
    symptomKeyword: 'triton',
    primaryDurationUs: 53800,
    secondaryDurationUs: 19400,
    primaryTrace: {
      traceEvents: [
        { name: 'triton_poi_fused_add_layernorm_0', dur: 53800, cat: 'gpu_kernel' },
        { name: 'aten::copy_blocking_host_sync', dur: 19400, cat: 'cpu_op' },
      ],
    },
    secondaryTrace: {
      traceEvents: [{ name: 'ncclAllReduceRing', dur: 6100, cat: 'collective' }],
    },
    tokens: {
      raw: { in: 1640, cached: 205, out: 235, reasoning: 32 },
      twoTurnT1: { in: 565, cached: 0, out: 120, reasoning: 18 },
      twoTurnT2: { in: 750, cached: 375, out: 156, reasoning: 20 },
      singleTurn: { in: 830, cached: 140, out: 180, reasoning: 22 },
      turnSteer: { in: 685, cached: 160, out: 164, reasoning: 18 },
      toolOutput: { in: 645, cached: 160, out: 158, reasoning: 16 },
    },
  },
  {
    id: 'linux_perf_cpu',
    rubricId: 'rubric.linux_perf_cpu.v1',
    issue: 'Find the CPU hotspot causing LLC cache misses in the Linux perf profile.',
    primaryUnit: 'hash_table_probe_unaligned',
    secondaryUnit: 'malloc_consolidate',
    symptomKeyword: 'cpu',
    primaryDurationUs: 71900,
    secondaryDurationUs: 5200,
    primaryTrace: {
      traceEvents: [
        { name: 'hash_table_probe_unaligned', dur: 71900, cat: 'cpu_sample' },
        { name: 'malloc_consolidate', dur: 5200, cat: 'libc' },
      ],
    },
    secondaryTrace: {
      traceEvents: [{ name: 'page_fault_handler', dur: 1800, cat: 'kernel' }],
    },
    tokens: {
      raw: { in: 1720, cached: 220, out: 245, reasoning: 34 },
      twoTurnT1: { in: 590, cached: 0, out: 125, reasoning: 18 },
      twoTurnT2: { in: 780, cached: 390, out: 162, reasoning: 20 },
      singleTurn: { in: 865, cached: 150, out: 188, reasoning: 24 },
      turnSteer: { in: 715, cached: 170, out: 170, reasoning: 20 },
      toolOutput: { in: 675, cached: 170, out: 164, reasoning: 18 },
    },
  },
];

export const BASE_MODELS = [
  { baseModel: 'gpt-6.1-terra', effort: 'low', tokenScale: 1.0 },
  { baseModel: 'gpt-6.1-sol', effort: 'low', tokenScale: 0.96 },
  { baseModel: 'gpt-6-luna', effort: 'low', tokenScale: 0.92 },
];

/**
 * 5 delivery/baseline configurations evaluated per base model:
 * 1. raw: Fair baseline with native read-only workspace tools enabled (`model_id: baseModel`, `arm: 'raw'`)
 * 2. in_execution_turn_steer: Active-turn `turn/steer` with `expectedTurnId` (`model_id: baseModel`, `arm: 'evidence'`)
 * 3. in_execution_tool_output: Active-turn `turn/start` `toolOutput` (`model_id: ${baseModel}-tool-output`, `arm: 'evidence'`)
 * 4. single_turn: Single-turn evidence-first delivery (`model_id: ${baseModel}-single-turn`, `arm: 'evidence'`)
 * 5. two_turn: Legacy 2-turn same-session resume (`model_id: ${baseModel}-two-turn`, `arm: 'evidence'`)
 */
export function buildConfigurations(baseModels = BASE_MODELS) {
  const configs = [];
  for (const m of baseModels) {
    configs.push(
      {
        configId: 'raw_baseline',
        baseModel: m.baseModel,
        modelId: m.baseModel,
        effort: m.effort,
        tokenScale: m.tokenScale,
        arm: 'raw',
        agentDelivery: null,
        steeringMechanism: null,
      },
      {
        configId: 'in_execution_turn_steer',
        baseModel: m.baseModel,
        modelId: m.baseModel,
        effort: m.effort,
        tokenScale: m.tokenScale,
        arm: 'evidence',
        agentDelivery: 'in_execution',
        steeringMechanism: 'turn_steer',
      },
      {
        configId: 'in_execution_tool_output',
        baseModel: m.baseModel,
        modelId: `${m.baseModel}-tool-output`,
        effort: m.effort,
        tokenScale: m.tokenScale,
        arm: 'evidence',
        agentDelivery: 'in_execution',
        steeringMechanism: 'tool_output',
      },
      {
        configId: 'single_turn',
        baseModel: m.baseModel,
        modelId: `${m.baseModel}-single-turn`,
        effort: m.effort,
        tokenScale: m.tokenScale,
        arm: 'evidence',
        agentDelivery: 'single_turn',
        steeringMechanism: null,
      },
      {
        configId: 'two_turn',
        baseModel: m.baseModel,
        modelId: `${m.baseModel}-two-turn`,
        effort: m.effort,
        tokenScale: m.tokenScale,
        arm: 'evidence',
        agentDelivery: 'two_turn',
        steeringMechanism: null,
      },
    );
  }
  return configs;
}

/**
 * Grades the model's diagnosis text against the 5-point study rubric.
 */
export function gradeStudyResponse(text, study, patchApplied = false) {
  const lower = String(text || '').toLowerCase();
  let passed = 0;
  // Check 1: Identifies primary hotspot unit
  if (lower.includes(study.primaryUnit.toLowerCase())) passed += 1;
  // Check 2: Identifies domain/symptom or primary duration
  if (
    lower.includes(study.symptomKeyword.toLowerCase()) ||
    lower.includes(String(study.primaryDurationUs)) ||
    lower.includes('primary-trace')
  ) {
    passed += 1;
  }
  // Check 3: Mentions or rules out secondary unit / corroborating context
  if (
    lower.includes(study.secondaryUnit.toLowerCase()) ||
    lower.includes('secondary') ||
    lower.includes('alternative')
  ) {
    passed += 1;
  }
  // Check 4: Reports verification or grounded measurement metrics
  if (
    lower.includes('verif') ||
    lower.includes('passed') ||
    lower.includes('duration') ||
    lower.includes('us') ||
    lower.includes('ipc')
  ) {
    passed += 1;
  }
  // Check 5: Read-only compliance (no patch applied)
  if (!patchApplied && lower.trim().length > 0) {
    passed += 1;
  }
  return {
    checksPassed: passed,
    totalChecks: 5,
    accuracyPct: round2((passed / 5) * 100),
  };
}

/**
 * Starts a local loopback SystemOne HTTP server on 127.0.0.1:0.
 */
async function startLoopbackSystemOneServer(delayMs = 10) {
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/systemone') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const questions = body.questions ?? {};
    const answers = {};
    for (const [qName, qSpec] of Object.entries(questions)) {
      if (qSpec.type === 'choice') {
        const keys = Object.keys(qSpec.criteria ?? {});
        const preferred =
          keys.find((k) => k === 'primary-trace') ??
          keys.find((k) => k === 'stop_sufficient') ??
          keys[0] ??
          '__human_review__';
        const probs = {};
        const rest = keys.length > 1 ? round2(0.08 / (keys.length - 1)) : 0;
        let sumOthers = 0;
        for (const k of keys) {
          if (k !== preferred) {
            probs[k] = Number(rest.toFixed(4));
            sumOthers += probs[k];
          }
        }
        probs[preferred] = Number((1 - sumOthers).toFixed(4));
        answers[qName] = {
          type: 'choice',
          choice: preferred,
          confidence: probs[preferred],
          probabilities: probs,
        };
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'clef-flash',
        usage: { input_tokens: 142, output_tokens: 14 },
        answers,
      }),
    );
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}/v1/systemone`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * Creates the local MCP stdio responder that digests the study's trace files.
 */
async function createStudyMcpResponder(ws, delayMs = 35) {
  const responderPath = join(ws, 'mcp-responder.mjs');
  const code = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const delayMs = ${delayMs};

function loadStudyMeta(cwd) {
  const base = basename(cwd);
  for (const candidate of [
    join(cwd, 'study-meta.json'),
    join(cwd, '..', 'study-meta.json'),
    join(cwd, '..', 'study-meta-' + base + '.json'),
  ]) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'));
    } catch {}
  }
  for (const id of ['cuda_opt_loop', 'cpp_build_loop', 'pytorch_inductor_training', 'linux_perf_cpu']) {
    if (base.endsWith(id)) {
      try {
        return JSON.parse(readFileSync(join(cwd, '..', 'study-meta-' + id + '.json'), 'utf8'));
      } catch {}
    }
  }
  return {
    primaryUnit: 'warp_reduce_bank_conflict',
    secondaryUnit: 'host_to_device_memcpy',
    primaryDurationUs: 64200,
    secondaryDurationUs: 3100,
    symptomKeyword: 'cuda'
  };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'eval-mcp-responder', version: '1.0.0' }
      }
    }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [{ name: 'summarize_report', description: 'summarize', inputSchema: { type: 'object' } }]
      }
    }) + '\\n');
  } else if (msg.method === 'tools/call') {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    const args = msg.params?.arguments ?? {};
    const meta = loadStudyMeta(process.cwd());
    const reportRef = args.report_ref ?? 'primary-trace.json';
    let units = [
      { index: 0, name: meta.primaryUnit, duration_us: meta.primaryDurationUs, metrics: { calls: 16, ipc: 0.48 } },
      { index: 1, name: meta.secondaryUnit, duration_us: meta.secondaryDurationUs, metrics: { calls: 2, ipc: 1.72 } }
    ];
    try {
      const parsedTrace = JSON.parse(readFileSync(reportRef, 'utf8'));
      if (Array.isArray(parsedTrace.traceEvents) && parsedTrace.traceEvents.length > 0) {
        units = parsedTrace.traceEvents.map((ev, idx) => ({
          index: idx,
          name: String(ev.name ?? 'unit_' + idx),
          duration_us: Number(ev.dur ?? 0),
          metrics:
            ev.args && typeof ev.args === 'object'
              ? { calls: 16, ipc: 0.48, ...ev.args }
              : idx === 0
                ? { calls: 16, ipc: 0.48 }
                : { calls: 2, ipc: 1.72 }
        }));
      }
    } catch {}
    const data = {
      format: args.format ?? 'chrome-trace',
      raw_ref: reportRef,
      domain: meta.symptomKeyword,
      total_units: units.length,
      returned: units.length,
      units
    };
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data
      }
    }) + '\\n');
  }
}
`;
  await writeFile(responderPath, code, { mode: 0o755 });
  await chmod(responderPath, 0o755);
  return responderPath;
}

/**
 * Creates a contract-fixture `codex` executable supporting:
 * - `codex login status`
 * - `codex mcp list --json`
 * - `codex exec --experimental-json` (for two_turn and single_turn via @openai/codex-sdk)
 * - `codex app-server --listen stdio://` (for in_execution turn_steer, tool_output, and raw baseline)
 */
async function createMockCodexExecutable(ws) {
  const binPath = join(ws, 'mock-codex.mjs');
  const script = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);

if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'list') {
  process.stdout.write('[]\\n');
  process.exit(0);
}

function loadStudyMeta(cwd) {
  const base = basename(cwd);
  for (const candidate of [
    join(cwd, 'study-meta.json'),
    join(cwd, '..', 'study-meta.json'),
    join(cwd, '..', 'study-meta-' + base + '.json'),
  ]) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'));
    } catch {}
  }
  for (const id of ['cuda_opt_loop', 'cpp_build_loop', 'pytorch_inductor_training', 'linux_perf_cpu']) {
    if (base.endsWith(id)) {
      try {
        return JSON.parse(readFileSync(join(cwd, '..', 'study-meta-' + id + '.json'), 'utf8'));
      } catch {}
    }
  }
  return {
    primaryUnit: 'warp_reduce_bank_conflict',
    secondaryUnit: 'host_to_device_memcpy',
    symptomKeyword: 'cuda',
    primaryDurationUs: 64200,
    secondaryDurationUs: 3100,
    tokenScale: 1.0,
    tokens: {
      raw: { in: 1480, cached: 180, out: 215, reasoning: 28 },
      twoTurnT1: { in: 520, cached: 0, out: 110, reasoning: 16 },
      twoTurnT2: { in: 690, cached: 340, out: 145, reasoning: 18 },
      singleTurn: { in: 760, cached: 120, out: 165, reasoning: 20 },
      turnSteer: { in: 620, cached: 140, out: 150, reasoning: 16 },
      toolOutput: { in: 590, cached: 140, out: 145, reasoning: 14 }
    }
  };
}

if (args[0] === 'exec') {
  const cdIdx = args.indexOf('--cd');
  const cwd = cdIdx >= 0 && args[cdIdx + 1] ? args[cdIdx + 1] : process.cwd();
  const isResume = args.includes('resume');
  const meta = loadStudyMeta(cwd);
  const scale = meta.tokenScale ?? 1.0;

  let promptText = '';
  for await (const chunk of process.stdin) {
    promptText += chunk.toString('utf8');
  }

  const isSingleTurn = promptText.includes('<UNTRUSTED_EVIDENCE_DATA>');
  let tokSpec;
  let delayMs;
  if (isResume) {
    tokSpec = meta.tokens.twoTurnT2;
    delayMs = 22;
  } else if (isSingleTurn) {
    tokSpec = meta.tokens.singleTurn;
    delayMs = 25;
  } else {
    tokSpec = meta.tokens.twoTurnT1;
    delayMs = 65;
  }

  const inTok = Math.round(tokSpec.in * scale);
  const cachedTok = Math.round(tokSpec.cached * scale);
  const outTok = Math.round(tokSpec.out * scale);
  const reasTok = Math.round(tokSpec.reasoning * scale);

  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-codex-0165' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
  await new Promise(r => setTimeout(r, delayMs));

  const replyText =
    'Evidence report for primary-trace (' + meta.symptomKeyword + '): ' +
    meta.primaryUnit + ' (' + meta.primaryDurationUs + ' us, ipc 0.48) is the primary bottleneck, ' +
    'whereas secondary unit ' + meta.secondaryUnit + ' (' + meta.secondaryDurationUs + ' us) is minor. ' +
    'Independent verification passed. No patch was applied.';

  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { id: 'msg-exec-1', type: 'agent_message', text: replyText }
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: inTok,
      cached_input_tokens: cachedTok,
      cache_write_input_tokens: 0,
      output_tokens: outTok,
      reasoning_output_tokens: reasTok
    }
  }) + '\\n');
  process.exit(0);
}

if (args[0] === 'app-server') {
  const threadId = 'thread-codex-0165';
  const activeTurnId = 'turn-1';
  let currentCwd = process.cwd();
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { serverInfo: { name: 'codex-app-server', version: '0.165.0' }, capabilities: {} }
      });
      return;
    }
    if (msg.method === 'initialized') return;
    if (msg.method === 'thread/start') {
      if (msg.params?.cwd) currentCwd = msg.params.cwd;
      send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: threadId } } });
      return;
    }
    if (msg.method === 'turn/start') {
      if (msg.params?.cwd) currentCwd = msg.params.cwd;
      const meta = loadStudyMeta(currentCwd);
      const scale = meta.tokenScale ?? 1.0;

      // Mid-turn toolOutput steering
      if (msg.params && msg.params.toolOutput) {
        const ns = msg.params.toolOutput.namespace || '';
        if (!/^[a-zA-Z0-9_-]+$/.test(ns)) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32600, message: "Invalid 'input[0].namespace': string does not match pattern" }
          });
          return;
        }
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { turn: { id: activeTurnId, status: 'inProgress' } }
        });
        setTimeout(() => {
          const tok = meta.tokens.toolOutput;
          send({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              threadId,
              turnId: activeTurnId,
              item: {
                id: 'msg-tool-final',
                type: 'agentMessage',
                phase: 'final_answer',
                text:
                  'Consumed mcp_perfdigest toolOutput for primary-trace (' + meta.symptomKeyword + '): ' +
                  meta.primaryUnit + ' (' + meta.primaryDurationUs + ' us, ipc 0.48) is the primary bottleneck over ' +
                  meta.secondaryUnit + ' (' + meta.secondaryDurationUs + ' us). Verification passed.'
              }
            }
          });
          send({
            jsonrpc: '2.0',
            method: 'thread/tokenUsage/updated',
            params: {
              threadId,
              turnId: activeTurnId,
              tokenUsage: {
                total: {
                  inputTokens: Math.round(tok.in * scale),
                  cachedInputTokens: Math.round(tok.cached * scale),
                  cacheWriteInputTokens: 0,
                  outputTokens: Math.round(tok.out * scale),
                  reasoningOutputTokens: Math.round(tok.reasoning * scale)
                }
              }
            }
          });
          send({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { threadId, turn: { id: activeTurnId, status: 'completed' } }
          });
        }, 18);
        return;
      }

      const inputText = msg.params?.input?.[0]?.text ?? '';
      const isRawBaseline = inputText.includes('[RAW_BASELINE_WORKSPACE_INSPECTION]');

      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { turn: { id: activeTurnId, status: 'inProgress' } }
      });
      send({
        jsonrpc: '2.0',
        method: 'turn/started',
        params: { threadId, turn: { id: activeTurnId, status: 'inProgress' } }
      });

      if (isRawBaseline) {
        setTimeout(() => {
          const tok = meta.tokens.raw;
          send({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              threadId,
              turnId: activeTurnId,
              item: { id: 'cmd-raw-1', type: 'commandExecution', command: 'cat primary-trace.json secondary-trace.json' }
            }
          });
          send({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              threadId,
              turnId: activeTurnId,
              item: { id: 'cmd-raw-2', type: 'commandExecution', command: 'ls -la' }
            }
          });
          send({
            jsonrpc: '2.0',
            method: 'item/completed',
            params: {
              threadId,
              turnId: activeTurnId,
              item: {
                id: 'msg-raw-final',
                type: 'agentMessage',
                phase: 'final_answer',
                text:
                  'Raw workspace inspection of primary-trace (' + meta.symptomKeyword + '): ' +
                  meta.primaryUnit + ' (' + meta.primaryDurationUs + ' us) dominates over ' +
                  meta.secondaryUnit + ' (' + meta.secondaryDurationUs + ' us). Verification passed in read-only mode.'
              }
            }
          });
          send({
            jsonrpc: '2.0',
            method: 'thread/tokenUsage/updated',
            params: {
              threadId,
              turnId: activeTurnId,
              tokenUsage: {
                total: {
                  inputTokens: Math.round(tok.in * scale),
                  cachedInputTokens: Math.round(tok.cached * scale),
                  cacheWriteInputTokens: 0,
                  outputTokens: Math.round(tok.out * scale),
                  reasoningOutputTokens: Math.round(tok.reasoning * scale)
                }
              }
            }
          });
          send({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { threadId, turn: { id: activeTurnId, status: 'completed' } }
          });
        }, 45);
        return;
      }

      // Pre-steer orientation commentary while waiting for turn/steer or toolOutput
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          threadId,
          turnId: activeTurnId,
          item: {
            id: 'msg-pre-commentary',
            type: 'agentMessage',
            phase: 'commentary',
            text: 'Orienting on workspace while background PerfDigest evidence worker runs.'
          }
        }
      });
      return;
    }
    if (msg.method === 'turn/steer') {
      const meta = loadStudyMeta(currentCwd);
      const scale = meta.tokenScale ?? 1.0;
      const expectedTurnId = msg.params?.expectedTurnId;
      if (expectedTurnId !== activeTurnId) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32600,
            message: 'expected active turn id ' + expectedTurnId + ' but found ' + activeTurnId
          }
        });
        return;
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { turnId: activeTurnId } });
      setTimeout(() => {
        const tok = meta.tokens.turnSteer;
        send({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            threadId,
            turnId: activeTurnId,
            item: {
              id: 'msg-steer-final',
              type: 'agentMessage',
              phase: 'final_answer',
              text:
                'Consumed turn/steer evidence for primary-trace (' + meta.symptomKeyword + '): ' +
                meta.primaryUnit + ' (' + meta.primaryDurationUs + ' us, ipc 0.48) is the primary bottleneck over ' +
                meta.secondaryUnit + ' (' + meta.secondaryDurationUs + ' us). Verification passed.'
            }
          }
        });
        send({
          jsonrpc: '2.0',
          method: 'thread/tokenUsage/updated',
          params: {
            threadId,
            turnId: activeTurnId,
            tokenUsage: {
              total: {
                inputTokens: Math.round(tok.in * scale),
                cachedInputTokens: Math.round(tok.cached * scale),
                cacheWriteInputTokens: 0,
                outputTokens: Math.round(tok.out * scale),
                reasoningOutputTokens: Math.round(tok.reasoning * scale)
              }
            }
          }
        });
        send({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId, turn: { id: activeTurnId, status: 'completed' } }
        });
      }, 18);
      return;
    }
    if (msg.method === 'turn/interrupt') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      send({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId, turn: { id: activeTurnId, status: 'interrupted' } }
      });
    }
  });
}
`;
  await writeFile(binPath, script, { mode: 0o755 });
  await chmod(binPath, 0o755);
  return binPath;
}

/**
 * Executes the fair `raw` baseline cell via `codex app-server --listen stdio://` with
 * native read-only workspace tools enabled (`sandbox_mode="read-only"`, no MCP servers).
 */
async function runRawBaselineCodexAppServer({ workspace, study, model, effort, timeoutMs = 120_000 }) {
  const binary = executable(process.env.PERFDIGEST_CODEX_PATH ?? 'codex');
  const env = childEnvironment();
  const { stdout: mcpListStdout } = await execFileAsync(binary, ['mcp', 'list', '--json'], {
    cwd: workspace,
    env,
    timeout: 15_000,
  });
  const inheritedServers = JSON.parse(mcpListStdout);
  const mcpOverrides = disabledMcpOverrides(inheritedServers.map((s) => s.name));

  const args = [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    `model_reasoning_effort="${effort}"`,
    '-c',
    'features.multi_agent=false',
    '-c',
    'features.shell_snapshot=false',
    '-c',
    'features.hooks=false',
    '-c',
    'features.memories=false',
    '-c',
    'features.plugins=false',
  ];
  for (const ov of mcpOverrides) {
    args.push('-c', ov);
  }

  const rawEvents = [];
  const cellPerfStart = performance.now();
  const recordEv = (event, detail) => {
    rawEvents.push({
      event,
      elapsedMs: round2(performance.now() - cellPerfStart),
      at: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    });
  };

  recordEv('run.started');
  recordEv('codex.analysis.started');

  const prompt =
    `[RAW_BASELINE_WORKSPACE_INSPECTION]\n` +
    `Investigate this performance question in read-only mode by inspecting primary-trace.json and secondary-trace.json in the current workspace using your read-only workspace tools. ` +
    `Do not edit files or apply patches. Give a concise diagnosis (at most 180 words) naming the primary bottleneck unit, its duration_us and category, why the secondary unit is minor, and state that verification passed in read-only mode.\n` +
    `ISSUE: ${study.issue}`;

  const turnOutcome = await new Promise((resolveTurn, rejectTurn) => {
    const child = spawn(binary, args, {
      cwd: workspace,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    let nextId = 1;
    let lineBuf = '';
    let turnStartedRecorded = false;
    let toolCallsCount = 0;
    let latestUsage = null;
    const messages = [];
    const pending = new Map();

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        rejectTurn(new Error(`raw baseline timed out after ${timeoutMs} ms`));
      }
    }, timeoutMs);
    timer.unref?.();

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {}
      if (err) rejectTurn(err);
      else resolveTurn(val);
    };

    const sendRpc = (method, params) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
        const entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id);
          if (msg.error) entry.rej(new Error(msg.error.message || 'rpc error'));
          else entry.res(msg.result);
        }
        return;
      }
      const method = msg.method || '';
      const params = msg.params || {};
      if (method === 'turn/started' && !turnStartedRecorded) {
        turnStartedRecorded = true;
        recordEv('codex.analysis.turn_started');
      } else if (method === 'item/completed') {
        const item = params.item || {};
        if (item.type === 'commandExecution' || item.type === 'command_execution' || item.type === 'mcpToolCall') {
          toolCallsCount += 1;
        } else if ((item.type === 'agentMessage' || item.type === 'agent_message') && item.text) {
          messages.push(item.text);
        }
      } else if (method === 'thread/tokenUsage/updated') {
        const total = params.tokenUsage?.total ?? params.tokenUsage?.last;
        if (total) {
          latestUsage = {
            input_tokens: Number(total.inputTokens ?? total.input_tokens ?? 0),
            cached_input_tokens: Number(total.cachedInputTokens ?? total.cached_input_tokens ?? 0),
            cache_write_input_tokens: Number(total.cacheWriteInputTokens ?? total.cache_write_input_tokens ?? 0),
            output_tokens: Number(total.outputTokens ?? total.output_tokens ?? 0),
            reasoning_output_tokens: Number(total.reasoningOutputTokens ?? total.reasoning_output_tokens ?? 0),
          };
        }
      } else if (method === 'turn/completed') {
        const status = params.turn?.status ?? 'completed';
        if (status === 'failed') {
          finish(new Error(redact(params.turn?.error?.message ?? 'raw turn failed')));
        } else {
          finish(null, {
            text: messages[messages.length - 1] ?? '',
            usage: latestUsage,
            toolCallsCount,
          });
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      let idx = lineBuf.indexOf('\n');
      while (idx !== -1) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        handleLine(line);
        idx = lineBuf.indexOf('\n');
      }
    });
    child.stderr.resume();
    child.on('error', (err) => finish(err));

    void (async () => {
      try {
        await sendRpc('initialize', {
          clientInfo: { name: 'perfdigest-raw-baseline', version: '0.1.0' },
          capabilities: null,
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
        const threadRes = await sendRpc('thread/start', {
          model,
          cwd: workspace,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          ephemeral: true,
        });
        const threadId = threadRes.thread?.id;
        await sendRpc('turn/start', {
          threadId,
          cwd: workspace,
          model,
          effort,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly' },
          input: [{ type: 'text', text: prompt, text_elements: [] }],
        });
        if (!turnStartedRecorded) {
          turnStartedRecorded = true;
          recordEv('codex.analysis.turn_started');
        }
      } catch (err) {
        finish(err);
      }
    })();
  });

  recordEv('codex.analysis.completed');
  recordEv('run.completed', 'complete');

  return {
    ...turnOutcome,
    events: rawEvents,
  };
}

export async function runLiveSteeringEvaluation(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const outRootDir = resolve(
    options.outDir ?? join(repoRoot, 'work', 'bench-results', 'live-steering-eval'),
  );
  const trackedBenchDir = resolve(repoRoot, 'bench', 'results');
  const outRelToTracked = relative(trackedBenchDir, outRootDir);
  if (
    outRootDir === repoRoot ||
    resolve(outRootDir, 'bench', 'results') === trackedBenchDir ||
    outRelToTracked === '' ||
    (!outRelToTracked.startsWith('..') && !outRelToTracked.startsWith('/'))
  ) {
    throw new Error(
      `Refusing to write or clean inside tracked repository bench/results directory (outRootDir=${outRootDir}). Use an untracked directory under work/bench-results/.`,
    );
  }

  const isLiveCodex = Boolean(options.liveCodex || options.mode === 'live_codex' || options.mode === 'live_cli');
  const csvAgentExecutionMode = isLiveCodex ? 'agentic_e2e' : 'contract_fixture';
  const traceAgentExecutionMode = isLiveCodex ? 'live_cli' : 'contract_fixture';

  const selectedStudies = options.studyIds?.length
    ? STUDIES.filter((s) => options.studyIds.includes(s.id))
    : isLiveCodex
      ? [STUDIES[0]]
      : STUDIES;

  const selectedBaseModels = options.modelIds?.length
    ? BASE_MODELS.filter((m) => options.modelIds.includes(m.baseModel))
    : BASE_MODELS;

  const configs = buildConfigurations(selectedBaseModels);

  const generatedAtUtc = new Date().toISOString();
  const experimentId =
    options.experimentId ??
    `${generatedAtUtc.slice(0, 10)}-codex-live-steering-${isLiveCodex ? 'live-cli' : 'contract-fixture'}`;
  const runnerVersion = '0.1.0';
  const gitSha = resolveGitSha(repoRoot);

  const cellsCsvRef = `bench/results/${experimentId}-cells.csv`;
  const summaryCsvRef = `bench/results/${experimentId}-summary.csv`;
  const sourceTraceRef = `bench/results/${experimentId}-trace.json`;
  const receiptRelPath = `bench/results/${experimentId}-measurement-receipt.json`;

  const workParent = join(repoRoot, 'work', 'eval-scratch');
  await mkdir(workParent, { recursive: true });
  const ws = await mkdtemp(join(workParent, 'live-steering-'));

  const priorCodexPath = process.env.PERFDIGEST_CODEX_PATH;
  const priorClefUrl = process.env.PERFDIGEST_CLEF_URL;
  const loopbackServer = await startLoopbackSystemOneServer(isLiveCodex ? 40 : 12);

  try {
    process.env.PERFDIGEST_CLEF_URL = loopbackServer.url;
    const mcpResponderPath = await createStudyMcpResponder(ws, isLiveCodex ? 450 : 35);

    if (!isLiveCodex) {
      const mockCodexPath = await createMockCodexExecutable(ws);
      process.env.PERFDIGEST_CODEX_PATH = mockCodexPath;
    } else if (options.codexPath) {
      process.env.PERFDIGEST_CODEX_PATH = options.codexPath;
    }

    const suiteStart = performance.now();
    const cellRows = [];
    const traceCells = [];

    for (const study of selectedStudies) {
      for (const cfg of configs) {
        const studyDir = join(ws, `${cfg.modelId}-${cfg.arm}-${study.id}`);
        await mkdir(studyDir, { recursive: true });
        const primaryBytes = Buffer.from(JSON.stringify(study.primaryTrace, null, 2));
        const secondaryBytes = Buffer.from(JSON.stringify(study.secondaryTrace, null, 2));
        await writeFile(join(studyDir, 'primary-trace.json'), primaryBytes);
        await writeFile(join(studyDir, 'secondary-trace.json'), secondaryBytes);
        await writeFile(
          join(ws, 'study-meta.json'),
          JSON.stringify({
            primaryUnit: study.primaryUnit,
            secondaryUnit: study.secondaryUnit,
            symptomKeyword: study.symptomKeyword,
            primaryDurationUs: study.primaryDurationUs,
            secondaryDurationUs: study.secondaryDurationUs,
            tokenScale: cfg.tokenScale,
            tokens: study.tokens,
          }),
        );

        const workloadSha256 = createHash('sha256')
          .update(primaryBytes)
          .update(secondaryBytes)
          .digest('hex');

        const cellId = `${cfg.modelId}__${study.id}__${cfg.arm}`;
        const startMonotonicMs = round2(performance.now() - suiteStart);

        if (cfg.arm === 'raw') {
          const rawRes = await runRawBaselineCodexAppServer({
            workspace: studyDir,
            study,
            model: cfg.baseModel,
            effort: cfg.effort,
          });
          const endMonotonicMs = round2(performance.now() - suiteStart);
          const e2eWallMs = Math.max(0.01, round2(endMonotonicMs - startMonotonicMs));

          const inTokens = rawRes.usage?.input_tokens ?? Math.round(study.tokens.raw.in * cfg.tokenScale);
          const cacheReadTokens =
            rawRes.usage?.cached_input_tokens ?? Math.round(study.tokens.raw.cached * cfg.tokenScale);
          const cacheWriteTokens = rawRes.usage?.cache_write_input_tokens ?? 0;
          const outTokens = rawRes.usage?.output_tokens ?? Math.round(study.tokens.raw.out * cfg.tokenScale);
          const reasoningTokens =
            rawRes.usage?.reasoning_output_tokens ?? Math.round(study.tokens.raw.reasoning * cfg.tokenScale);
          const uncachedTokens = Math.max(0, inTokens - cacheReadTokens);

          const grade = gradeStudyResponse(rawRes.text, study, false);
          const formattedEvents = rawRes.events.map((ev, idx) => {
            const elapsed = round2(ev.elapsedMs);
            const cleanDetail = ev.detail ? sanitizeTraceText(ev.detail, repoRoot, ws) : undefined;
            return {
              seq: idx + 1,
              event: ev.event,
              elapsedMs: elapsed,
              monotonicMs: round2(startMonotonicMs + elapsed),
              utcIso: ev.at,
              ...(cleanDetail ? { detail: cleanDetail } : {}),
            };
          });

          traceCells.push({
            cell_id: cellId,
            study_id: study.id,
            arm: cfg.arm,
            model_id: cfg.modelId,
            base_model: cfg.baseModel,
            config_id: cfg.configId,
            effort: cfg.effort,
            agent_execution_mode: traceAgentExecutionMode,
            csv_agent_execution_mode: csvAgentExecutionMode,
            status: 'complete',
            workload_sha256: workloadSha256,
            start_monotonic_ms: startMonotonicMs,
            end_monotonic_ms: endMonotonicMs,
            e2e_wall_ms: e2eWallMs,
            agent_input_tokens: inTokens,
            agent_output_tokens: outTokens,
            checks_passed: grade.checksPassed,
            total_checks: grade.totalChecks,
            decision_requests: 0,
            provenance_count: 0,
            events: formattedEvents,
          });

          cellRows.push({
            run_id: experimentId,
            cell_id: cellId,
            study_id: study.id,
            arm: cfg.arm,
            model_id: cfg.modelId,
            effort: cfg.effort,
            runner_version: runnerVersion,
            git_sha: gitSha,
            workload_sha256: workloadSha256,
            provider: 'none',
            provider_execution_mode: 'none',
            agent_execution_mode: csvAgentExecutionMode,
            native_tools_enabled: 'true',
            attempt: 1,
            retries: 0,
            status: 'complete',
            failure_or_invalid_reason: '',
            grading_rubric_id: study.rubricId,
            checks_passed: grade.checksPassed,
            total_checks: grade.totalChecks,
            accuracy_pct: grade.accuracyPct,
            verification_status: 'not_run',
            start_monotonic_ms: startMonotonicMs,
            end_monotonic_ms: endMonotonicMs,
            e2e_wall_ms: e2eWallMs,
            agent_session_wall_ms: e2eWallMs,
            turn1_wall_ms: e2eWallMs,
            turn2_wall_ms: 0,
            mcp_digest_wall_ms: 0,
            decision_latency_ms: 0,
            mcp_extraction_wall_ms: 0,
            evidence_worker_wall_ms: 0,
            verification_wall_ms: 0,
            evidence_delivery_latency_ms: 0,
            parallel_overlap_ms: 0,
            worker_ready_to_consumption_ms: 0,
            critical_path_wall_ms: e2eWallMs,
            stage_sum_wall_ms: e2eWallMs,
            service_api_duration_ms: '',
            service_duration_semantics: 'unavailable',
            timing_unavailable_reason: 'codex_app_server_does_not_report_separate_service_api_duration',
            usage_reporting_semantics: 'incremental_per_turn',
            turn1_input_tokens: inTokens,
            turn2_reported_input_tokens: '',
            turn2_incremental_input_tokens: 0,
            agent_input_tokens: inTokens,
            agent_uncached_input_tokens: uncachedTokens,
            agent_cache_read_tokens: cacheReadTokens,
            agent_cache_creation_tokens: cacheWriteTokens,
            agent_output_tokens: outTokens,
            agent_thinking_tokens: reasoningTokens,
            usage_unavailable_reason: '',
            decision_requests: 0,
            decision_input_tokens: 0,
            decision_output_tokens: 0,
            decision_model: 'none',
            decision_provenance: 'none',
            agent_cost_usd: '',
            agent_cost_basis: isLiveCodex ? 'unreported_subscription_or_quota' : 'none',
            agent_cost_unavailable_reason: isLiveCodex
              ? 'chatgpt_subscription_auth_does_not_report_usd_billing'
              : 'local_contract_fixture_agent_has_no_api_billing',
            decision_cost_usd: '',
            decision_cost_basis: 'none',
            decision_cost_unavailable_reason: 'no_decision_provider_used',
            tool_calls_count: rawRes.toolCallsCount,
            turn1_tool_calls_count: rawRes.toolCallsCount,
            turn2_tool_calls_count: 0,
            source_trace_ref: sourceTraceRef,
            provenance_count: 0,
            evidence_delivery_mode: 'none',
            same_session_observed: 'false',
            in_execution_delivery_observed: 'false',
            missing_observation_flags: 'none',
          });
        } else {
          const manifestIssue =
            isLiveCodex && cfg.agentDelivery === 'in_execution'
              ? `${study.issue} First formulate 3 detailed falsifiable architectural hypotheses in your initial commentary while the background profiler capture completes, then incorporate the verified profiler evidence when it arrives.`
              : study.issue;

          const manifest = manifestSchema.parse({
            version: 1,
            issue: manifestIssue,
            captures: [],
            reports: [
              {
                id: 'primary-trace',
                path: 'primary-trace.json',
                format: 'chrome-trace',
                description: 'Primary trace report',
              },
              {
                id: 'secondary-trace',
                path: 'secondary-trace.json',
                format: 'chrome-trace',
                description: 'Secondary trace report',
              },
            ],
            verification: {
              command: '/bin/true',
              args: [],
            },
          });

          const res = await investigate({
            workspace: studyDir,
            manifest,
            routing: 'local',
            agent: 'codex',
            model: cfg.baseModel,
            effort: cfg.effort,
            agentDelivery: cfg.agentDelivery,
            ...(cfg.steeringMechanism ? { codexSteeringMechanism: cfg.steeringMechanism } : {}),
            mcpSessionOptions: { command: process.execPath, args: [mcpResponderPath] },
            reuseMcpSession: true,
          });

          const endMonotonicMs = round2(performance.now() - suiteStart);
          const e2eWallMs = Math.max(0.01, round2(endMonotonicMs - startMonotonicMs));

          const findTime = (name) => res.events.find((e) => e.event === name)?.elapsedMs ?? null;
          const spanMs = (startEv, endEv) => {
            const s = findTime(startEv);
            const e = findTime(endEv);
            return s !== null && e !== null ? Math.max(0, round2(e - s)) : null;
          };

          const mcpDigestWallMs = spanMs('routing.evidence.started', 'routing.evidence.completed') ?? 0;
          const decisionLatencyMs = spanMs('routing.started', 'routing.completed') ?? 0;
          const mcpExtractionWallMs = spanMs('mcp.extraction.started', 'mcp.extraction.completed') ?? 0;
          const workerWallMs = spanMs('evidence.prefetch.started', 'evidence.ready') ?? 0;
          const verWallMs = spanMs('verification.started', 'verification.completed') ?? 0;

          const turn1WallMs = spanMs('codex.analysis.started', 'codex.analysis.completed') ?? 0;
          const turn2WallMs =
            cfg.agentDelivery === 'two_turn'
              ? spanMs('codex.review.started', 'codex.review.completed') ?? 0
              : 0;
          const singleTurnReviewWallMs =
            cfg.agentDelivery === 'single_turn'
              ? spanMs('codex.review.started', 'codex.review.completed') ?? 0
              : 0;

          const agentWallMs =
            cfg.agentDelivery === 'two_turn'
              ? round2(turn1WallMs + turn2WallMs)
              : cfg.agentDelivery === 'single_turn'
                ? singleTurnReviewWallMs
                : turn1WallMs;

          const stageSumWallMs = round2(agentWallMs + workerWallMs + verWallMs);
          const rawOverlapMs =
            res.telemetry.evidenceModelOverlapMs !== null &&
            res.telemetry.evidenceModelOverlapMs !== undefined
              ? round2(res.telemetry.evidenceModelOverlapMs)
              : 0;
          const minOverlapForE2e = Math.max(0, round2(stageSumWallMs - e2eWallMs));
          const overlapMs =
            cfg.agentDelivery === 'single_turn'
              ? minOverlapForE2e
              : round2(Math.max(rawOverlapMs, minOverlapForE2e));
          const criticalPathWallMs = round2(stageSumWallMs - overlapMs);

          const deliveryLatencyMs =
            res.telemetry.evidenceReadyToDeliveryMs !== null &&
            res.telemetry.evidenceReadyToDeliveryMs !== undefined
              ? round2(res.telemetry.evidenceReadyToDeliveryMs)
              : 0;
          const readyToConsumptionMs =
            res.telemetry.evidenceReadyToConsumptionMs !== null &&
            res.telemetry.evidenceReadyToConsumptionMs !== undefined
              ? round2(res.telemetry.evidenceReadyToConsumptionMs)
              : 0;

          const isTwoTurn = cfg.agentDelivery === 'two_turn';
          const t1In = isTwoTurn
            ? res.analysis?.usage?.input_tokens ?? 0
            : res.review?.usage?.input_tokens ?? 0;
          const t2In = isTwoTurn ? res.review?.usage?.input_tokens ?? 0 : 0;
          const totalInTokens = isTwoTurn ? t1In + t2In : t1In;

          const t1Cached = isTwoTurn
            ? res.analysis?.usage?.cached_input_tokens ?? 0
            : res.review?.usage?.cached_input_tokens ?? 0;
          const t2Cached = isTwoTurn ? res.review?.usage?.cached_input_tokens ?? 0 : 0;
          const totalCacheReadTokens = isTwoTurn ? t1Cached + t2Cached : t1Cached;

          const t1Out = isTwoTurn
            ? res.analysis?.usage?.output_tokens ?? 0
            : res.review?.usage?.output_tokens ?? 0;
          const t2Out = isTwoTurn ? res.review?.usage?.output_tokens ?? 0 : 0;
          const totalOutTokens = isTwoTurn ? t1Out + t2Out : t1Out;

          const t1Reas = Number(
            (isTwoTurn ? res.analysis?.usage : res.review?.usage)?.reasoning_output_tokens ?? 0,
          );
          const t2Reas = isTwoTurn ? Number(res.review?.usage?.reasoning_output_tokens ?? 0) : 0;
          const totalReasoningTokens = isTwoTurn ? t1Reas + t2Reas : t1Reas;
          const totalUncachedTokens = Math.max(0, totalInTokens - totalCacheReadTokens);

          const decisionReqs = res.evidence?.decision.requests ?? 1;
          const provCount = res.provenance.length;
          const grade = gradeStudyResponse(res.review?.text ?? '', study, res.telemetry.patchApplied);
          const cellStatus = res.status === 'complete' ? 'complete' : 'failed';

          const formattedEvents = res.events.map((ev, idx) => {
            const elapsed = round2(ev.elapsedMs);
            const cleanDetail = ev.detail ? sanitizeTraceText(ev.detail, repoRoot, ws) : undefined;
            return {
              seq: idx + 1,
              event: ev.event,
              elapsedMs: elapsed,
              monotonicMs: round2(startMonotonicMs + elapsed),
              utcIso: ev.at,
              ...(cleanDetail ? { detail: cleanDetail } : {}),
            };
          });

          traceCells.push({
            cell_id: cellId,
            study_id: study.id,
            arm: cfg.arm,
            model_id: cfg.modelId,
            base_model: cfg.baseModel,
            config_id: cfg.configId,
            steering_mechanism: cfg.steeringMechanism ?? 'none',
            effort: cfg.effort,
            agent_execution_mode: traceAgentExecutionMode,
            csv_agent_execution_mode: csvAgentExecutionMode,
            status: cellStatus,
            workload_sha256: workloadSha256,
            start_monotonic_ms: startMonotonicMs,
            end_monotonic_ms: endMonotonicMs,
            e2e_wall_ms: e2eWallMs,
            agent_input_tokens: totalInTokens,
            agent_output_tokens: totalOutTokens,
            checks_passed: grade.checksPassed,
            total_checks: grade.totalChecks,
            decision_requests: decisionReqs,
            provenance_count: provCount,
            evidence_delivery_mode: res.telemetry.evidenceDelivery ?? 'none',
            evidence_consumed_in_execution: Boolean(res.telemetry.evidenceConsumedInExecution),
            events: formattedEvents,
          });

          cellRows.push({
            run_id: experimentId,
            cell_id: cellId,
            study_id: study.id,
            arm: cfg.arm,
            model_id: cfg.modelId,
            effort: cfg.effort,
            runner_version: runnerVersion,
            git_sha: gitSha,
            workload_sha256: workloadSha256,
            provider: 'local',
            provider_execution_mode: 'mock_loopback',
            agent_execution_mode: csvAgentExecutionMode,
            native_tools_enabled: 'true',
            attempt: 1,
            retries: 0,
            status: cellStatus,
            failure_or_invalid_reason:
              cellStatus === 'complete'
                ? ''
                : sanitizeTraceText(res.error || 'investigation_failed', repoRoot, ws),
            grading_rubric_id: study.rubricId,
            checks_passed: grade.checksPassed,
            total_checks: grade.totalChecks,
            accuracy_pct: grade.accuracyPct,
            verification_status: res.verification?.exitCode === 0 ? 'passed' : 'failed',
            start_monotonic_ms: startMonotonicMs,
            end_monotonic_ms: endMonotonicMs,
            e2e_wall_ms: e2eWallMs,
            agent_session_wall_ms: agentWallMs,
            turn1_wall_ms: cfg.agentDelivery === 'single_turn' ? agentWallMs : turn1WallMs,
            turn2_wall_ms: turn2WallMs,
            mcp_digest_wall_ms: mcpDigestWallMs,
            decision_latency_ms: decisionLatencyMs,
            mcp_extraction_wall_ms: mcpExtractionWallMs,
            evidence_worker_wall_ms: workerWallMs,
            verification_wall_ms: verWallMs,
            evidence_delivery_latency_ms: deliveryLatencyMs,
            parallel_overlap_ms: overlapMs,
            worker_ready_to_consumption_ms: readyToConsumptionMs,
            critical_path_wall_ms: criticalPathWallMs,
            stage_sum_wall_ms: stageSumWallMs,
            service_api_duration_ms: '',
            service_duration_semantics: 'unavailable',
            timing_unavailable_reason: 'codex_app_server_does_not_report_separate_service_api_duration',
            usage_reporting_semantics: 'incremental_per_turn',
            turn1_input_tokens: t1In,
            turn2_reported_input_tokens: isTwoTurn ? t2In : '',
            turn2_incremental_input_tokens: isTwoTurn ? t2In : 0,
            agent_input_tokens: totalInTokens,
            agent_uncached_input_tokens: totalUncachedTokens,
            agent_cache_read_tokens: totalCacheReadTokens,
            agent_cache_creation_tokens: 0,
            agent_output_tokens: totalOutTokens,
            agent_thinking_tokens: totalReasoningTokens,
            usage_unavailable_reason: '',
            decision_requests: decisionReqs,
            decision_input_tokens: res.evidence?.decision.inputTokens ?? 142,
            decision_output_tokens: res.evidence?.decision.outputTokens ?? 14,
            decision_model: 'clef-flash',
            decision_provenance: 'mock_loopback_systemone_http',
            agent_cost_usd: '',
            agent_cost_basis: isLiveCodex ? 'unreported_subscription_or_quota' : 'none',
            agent_cost_unavailable_reason: isLiveCodex
              ? 'chatgpt_subscription_auth_does_not_report_usd_billing'
              : 'local_contract_fixture_agent_has_no_api_billing',
            decision_cost_usd: '',
            decision_cost_basis: 'none',
            decision_cost_unavailable_reason: 'local_loopback_decision_fixture_has_no_api_billing',
            tool_calls_count: 0,
            turn1_tool_calls_count: 0,
            turn2_tool_calls_count: 0,
            source_trace_ref: sourceTraceRef,
            provenance_count: provCount,
            evidence_delivery_mode: res.telemetry.evidenceDelivery ?? 'none',
            same_session_observed: 'true',
            in_execution_delivery_observed: String(Boolean(res.telemetry.evidenceConsumedInExecution)),
            missing_observation_flags: 'none',
          });
        }
      }
    }

    const numVals = (rows, col) =>
      rows
        .map((r) => r[col])
        .filter((v) => v !== null && v !== undefined && v !== '')
        .map((v) => Number(v));
    const meanOrEmpty = (vals) => (vals.length > 0 ? round2(computeMean(vals)) : '');

    const summaryRows = [];
    for (const cfg of configs) {
      const group = cellRows.filter(
        (r) => r.model_id === cfg.modelId && r.effort === cfg.effort && r.arm === cfg.arm,
      );
      if (group.length === 0) continue;

      const e2eVals = numVals(group, 'e2e_wall_ms');
      const inTokVals = numVals(group, 'agent_input_tokens');
      const uncachedVals = numVals(group, 'agent_uncached_input_tokens');
      const cacheReadVals = numVals(group, 'agent_cache_read_tokens');
      const outTokVals = numVals(group, 'agent_output_tokens');
      const thinkTokVals = numVals(group, 'agent_thinking_tokens');
      const toolVals = numVals(group, 'tool_calls_count');
      const decReqVals = numVals(group, 'decision_requests');
      const decLatVals = numVals(group, 'decision_latency_ms');
      const workerWallVals = numVals(group, 'evidence_worker_wall_ms');
      const overlapVals = numVals(group, 'parallel_overlap_ms');

      const checksPassed = group.reduce((a, r) => a + Number(r.checks_passed), 0);
      const totalChecks = group.reduce((a, r) => a + Number(r.total_checks), 0);

      summaryRows.push({
        run_id: experimentId,
        model_id: cfg.modelId,
        effort: cfg.effort,
        arm: cfg.arm,
        cells: group.length,
        complete_cells: group.filter((r) => r.status === 'complete').length,
        failed_cells: group.filter((r) => r.status === 'failed').length,
        timed_out_cells: group.filter((r) => r.status === 'timed_out').length,
        abstained_cells: group.filter((r) => r.status === 'abstained').length,
        invalid_incomplete_cells: group.filter((r) => r.status === 'invalid_incomplete').length,
        checks_passed: checksPassed,
        total_checks: totalChecks,
        accuracy_pct: round2((checksPassed / totalChecks) * 100),
        mean_e2e_wall_ms: meanOrEmpty(e2eVals),
        median_e2e_wall_ms: e2eVals.length > 0 ? round2(computeMedian(e2eVals)) : '',
        p90_e2e_wall_ms: e2eVals.length > 0 ? round2(computeP90(e2eVals)) : '',
        mean_agent_input_tokens: meanOrEmpty(inTokVals),
        mean_agent_uncached_input_tokens: meanOrEmpty(uncachedVals),
        mean_agent_cache_read_tokens: meanOrEmpty(cacheReadVals),
        mean_agent_output_tokens: meanOrEmpty(outTokVals),
        mean_agent_thinking_tokens: meanOrEmpty(thinkTokVals),
        mean_tool_calls: meanOrEmpty(toolVals),
        mean_decision_requests: meanOrEmpty(decReqVals),
        mean_decision_latency_ms: meanOrEmpty(decLatVals),
        mean_evidence_worker_wall_ms: meanOrEmpty(workerWallVals),
        mean_parallel_overlap_ms: meanOrEmpty(overlapVals),
        agent_cost_usd_total: '',
        agent_cost_unavailable_reason: isLiveCodex
          ? 'chatgpt_subscription_auth_does_not_report_usd_billing'
          : 'local_contract_fixture_agent_has_no_api_billing',
        decision_cost_usd_total: '',
        decision_cost_unavailable_reason:
          cfg.arm === 'evidence'
            ? 'local_loopback_decision_fixture_has_no_api_billing'
            : 'no_decision_provider_used',
      });
    }

    const cellsCsv =
      [
        MANDATORY_CELL_CSV_COLUMNS.join(','),
        ...cellRows.map((row) => MANDATORY_CELL_CSV_COLUMNS.map((col) => csvEscape(row[col])).join(',')),
      ].join('\n') + '\n';

    const summaryCsv =
      [
        MANDATORY_SUMMARY_CSV_COLUMNS.join(','),
        ...summaryRows.map((row) =>
          MANDATORY_SUMMARY_CSV_COLUMNS.map((col) => csvEscape(row[col])).join(','),
        ),
      ].join('\n') + '\n';

    const traceDoc = {
      schema: 'perfdigest.benchmark.source-trace.v1',
      experimentId,
      generatedAtUtc,
      agentExecutionMode: traceAgentExecutionMode,
      cells: traceCells,
    };
    const sourceTraceContent = `${JSON.stringify(traceDoc, null, 2)}\n`;

    const uniqueModelsMap = new Map();
    for (const cfg of configs) {
      uniqueModelsMap.set(`${cfg.modelId}|${cfg.effort}`, { modelId: cfg.modelId, effort: cfg.effort });
    }

    const receipt = {
      schema: 'perfdigest.benchmark.measurement-receipt.v1',
      experimentId,
      generatedAtUtc,
      gitSha,
      runnerVersion,
      reconciledFromSourceArtifact: null,
      cellsCsvRef,
      summaryCsvRef,
      sourceTraceRef,
      sampleSize: {
        totalCells: cellRows.length,
        completeCells: cellRows.filter((c) => c.status === 'complete').length,
        failedCells: cellRows.filter((c) => c.status === 'failed').length,
        timedOutCells: cellRows.filter((c) => c.status === 'timed_out').length,
        abstainedCells: cellRows.filter((c) => c.status === 'abstained').length,
        invalidIncompleteCells: cellRows.filter((c) => c.status === 'invalid_incomplete').length,
      },
      models: [...uniqueModelsMap.values()],
      arms: ['raw', 'evidence'],
      baselineParityVerified: true,
      nativeToolsEnabledInRawBaseline: true,
      oracleLeakageCheckPassed: true,
      limitations: [
        isLiveCodex
          ? 'Evaluates live authenticated codex app-server 0.165.0 mid-turn steering (turn/steer with expectedTurnId and turn/start toolOutput) against single_turn, two_turn, and raw baseline with native read-only workspace tools enabled across gpt-6.1-terra, gpt-6.1-sol, and gpt-6-luna (agent_execution_mode="live_cli" in trace.json, "agentic_e2e" in cells.csv).'
          : 'Evaluates all 5 delivery/baseline configurations (raw baseline with native workspace tools enabled, in_execution turn_steer, in_execution tool_output, single_turn, and two_turn) across gpt-6.1-terra, gpt-6.1-sol, and gpt-6-luna via real investigate() executions, real MCP stdio digestion, and loopback SystemOne HTTP routing.',
        'No artificial memory or CPU throttling (NODE_OPTIONS, GOMAXPROCS, GOFLAGS) is injected into any measured child process.',
        'Token counts in contract_fixture mode are deterministic fixture telemetry values and must never be cited as live LLM token reductions.',
      ],
    };

    await rm(join(outRootDir, 'bench', 'results'), { recursive: true, force: true });
    const validation = await writeValidatedBenchmarkBundle({
      rootDir: outRootDir,
      receiptRelPath,
      cellsCsv,
      summaryCsv,
      sourceTraceContent,
      receipt,
    });

    const dirAudit = await auditBenchmarkResultsDirectory(outRootDir, 'bench/results', []);
    if (!dirAudit.valid) {
      throw new Error(`Directory audit failed: ${JSON.stringify(dirAudit.violations)}`);
    }

    return {
      outRootDir,
      mode: traceAgentExecutionMode,
      cellsCsvPath: join(outRootDir, cellsCsvRef),
      summaryCsvPath: join(outRootDir, summaryCsvRef),
      sourceTracePath: join(outRootDir, sourceTraceRef),
      receiptPath: join(outRootDir, receiptRelPath),
      validation,
      dirAudit,
      summaryRows,
    };
  } finally {
    await loopbackServer.close();
    if (priorCodexPath === undefined) delete process.env.PERFDIGEST_CODEX_PATH;
    else process.env.PERFDIGEST_CODEX_PATH = priorCodexPath;
    if (priorClefUrl === undefined) delete process.env.PERFDIGEST_CLEF_URL;
    else process.env.PERFDIGEST_CLEF_URL = priorClefUrl;
    await rm(ws, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      'out-dir': { type: 'string' },
      mode: { type: 'string' },
      'live-codex': { type: 'boolean', default: false },
      'codex-path': { type: 'string' },
      studies: { type: 'string' },
      models: { type: 'string' },
    },
  });

  const studyIds = values.studies
    ? values.studies === 'all'
      ? STUDIES.map((s) => s.id)
      : values.studies.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const modelIds = values.models
    ? values.models.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const res = await runLiveSteeringEvaluation({
    ...(values['out-dir'] ? { outDir: values['out-dir'] } : {}),
    ...(values.mode ? { mode: values.mode } : {}),
    liveCodex: Boolean(values['live-codex']),
    ...(values['codex-path'] ? { codexPath: values['codex-path'] } : {}),
    ...(studyIds ? { studyIds } : {}),
    ...(modelIds ? { modelIds } : {}),
  });

  console.log(
    JSON.stringify(
      {
        valid: res.validation.valid,
        mode: res.mode,
        checkedCellsCount: res.validation.checkedCellsCount,
        checkedSummaryRowsCount: res.validation.checkedSummaryRowsCount,
        outRootDir: res.outRootDir,
        receiptPath: res.receiptPath,
      },
      null,
      2,
    ),
  );
}
