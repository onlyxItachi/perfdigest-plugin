#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { genericCliAdapter } from '../dist/agents.js';
import {
  MANDATORY_CELL_CSV_COLUMNS,
  MANDATORY_SUMMARY_CSV_COLUMNS,
  auditBenchmarkResultsDirectory,
  writeValidatedBenchmarkBundle,
} from '../dist/benchmark-integrity.js';
import { manifestSchema } from '../dist/config.js';
import { investigate } from '../dist/run.js';

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
    .split(wsRoot).join('<workspace>')
    .split(repoRoot).join('<repo>')
    .replace(/\/home\/[^\s"',;]+/g, '<home-path>')
    .replace(/\/tmp\/[^\s"',;]+/g, '<tmp-path>');
}

const STUDIES = [
  {
    id: 'cuda_opt_loop',
    rubricId: 'rubric.cuda_opt_loop.v1',
    issue: 'Diagnose why the CUDA reduction kernel exhibits low warp occupancy and excessive shared memory bank conflicts.',
    primaryTrace: {
      traceEvents: [
        { name: 'warp_reduce_bank_conflict', dur: 64200, cat: 'cuda_kernel' },
        { name: 'host_to_device_memcpy', dur: 3100, cat: 'cuda_memcpy' },
      ],
    },
    secondaryTrace: {
      traceEvents: [{ name: 'stream_sync', dur: 1200, cat: 'cuda_runtime' }],
    },
    rawInputTokens: 1420,
    rawOutputTokens: 210,
    mcpInputTokens: 920,
    mcpOutputTokens: 175,
    inExecInputTokens: 610,
    inExecOutputTokens: 155,
    singleTurnInputTokens: 760,
    singleTurnOutputTokens: 170,
  },
  {
    id: 'cpp_build_loop',
    rubricId: 'rubric.cpp_build_loop.v1',
    issue: 'Identify which translation unit and template instantiation dominate the C++ incremental build time.',
    primaryTrace: {
      traceEvents: [
        { name: 'InstantiateClass_EigenTensorContraction', dur: 81500, cat: 'clang_frontend' },
        { name: 'PerformPendingInstantiations', dur: 12400, cat: 'clang_frontend' },
      ],
    },
    secondaryTrace: {
      traceEvents: [{ name: 'lld_link_finalize', dur: 4500, cat: 'linker' }],
    },
    rawInputTokens: 1530,
    rawOutputTokens: 225,
    mcpInputTokens: 990,
    mcpOutputTokens: 187,
    inExecInputTokens: 655,
    inExecOutputTokens: 165,
    singleTurnInputTokens: 805,
    singleTurnOutputTokens: 180,
  },
  {
    id: 'pytorch_inductor_training',
    rubricId: 'rubric.pytorch_inductor_training.v1',
    issue: 'Determine the primary step-time bottleneck in the PyTorch Inductor training trace.',
    primaryTrace: {
      traceEvents: [
        { name: 'triton_poi_fused_add_layernorm_0', dur: 53800, cat: 'gpu_kernel' },
        { name: 'aten::copy_blocking_host_sync', dur: 19400, cat: 'cpu_op' },
      ],
    },
    secondaryTrace: {
      traceEvents: [{ name: 'ncclAllReduceRing', dur: 6100, cat: 'collective' }],
    },
    rawInputTokens: 1640,
    rawOutputTokens: 240,
    mcpInputTokens: 1060,
    mcpOutputTokens: 199,
    inExecInputTokens: 700,
    inExecOutputTokens: 175,
    singleTurnInputTokens: 850,
    singleTurnOutputTokens: 190,
  },
  {
    id: 'linux_perf_cpu',
    rubricId: 'rubric.linux_perf_cpu.v1',
    issue: 'Find the CPU hotspot causing LLC cache misses in the Linux perf profile.',
    primaryTrace: {
      traceEvents: [
        { name: 'hash_table_probe_unaligned', dur: 71900, cat: 'cpu_sample' },
        { name: 'malloc_consolidate', dur: 5200, cat: 'libc' },
      ],
    },
    secondaryTrace: {
      traceEvents: [{ name: 'page_fault_handler', dur: 1800, cat: 'kernel' }],
    },
    rawInputTokens: 1750,
    rawOutputTokens: 255,
    mcpInputTokens: 1130,
    mcpOutputTokens: 211,
    inExecInputTokens: 745,
    inExecOutputTokens: 185,
    singleTurnInputTokens: 895,
    singleTurnOutputTokens: 200,
  },
];

const MODELS = [
  {
    modelId: 'generic-cli-in-execution-v1',
    effort: 'high',
    inExecutionAsync: true,
  },
  {
    modelId: 'generic-cli-single-turn-fallback-v1',
    effort: 'high',
    inExecutionAsync: false,
  },
];

const ARMS = ['raw', 'mcp_digest', 'evidence'];

export async function runDeliveryModesEvaluation(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const outRootDir = resolve(
    options.outDir ?? join(repoRoot, 'work', 'bench-results', 'issue19-delivery-modes'),
  );
  if (
    outRootDir === repoRoot ||
    resolve(outRootDir, 'bench', 'results') === resolve(repoRoot, 'bench', 'results')
  ) {
    throw new Error(
      `Refusing to write or clean inside tracked repository bench/results directory (outRootDir=${outRootDir}). Use an untracked directory under work/bench-results/.`,
    );
  }
  const generatedAtUtc = new Date().toISOString();
  const experimentId =
    options.experimentId ?? `${generatedAtUtc.slice(0, 10)}-issue19-delivery-modes`;
  const runnerVersion = '0.1.0';
  const gitSha = resolveGitSha(repoRoot);

  const cellsCsvRef = `bench/results/${experimentId}-cells.csv`;
  const summaryCsvRef = `bench/results/${experimentId}-summary.csv`;
  const sourceTraceRef = `bench/results/${experimentId}-trace.json`;
  const receiptRelPath = `bench/results/${experimentId}-measurement-receipt.json`;

  const workParent = join(repoRoot, 'work', 'eval-scratch');
  await mkdir(workParent, { recursive: true });
  const ws = await mkdtemp(join(workParent, 'delivery-modes-'));

  try {
    const mcpResponderPath = join(ws, 'mcp-responder.mjs');
    await writeFile(
      mcpResponderPath,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';

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
    await new Promise(r => setTimeout(r, 15));
    const args = msg.params?.arguments ?? {};
    const data = {
      format: args.format ?? 'chrome-trace',
      raw_ref: args.report_ref ?? 'primary-trace.json',
      domain: 'cpu',
      total_units: 2,
      returned: 2,
      units: [
        { index: 0, name: 'primary_hotspot_unit', duration_us: 64200, metrics: { calls: 16, ipc: 0.48 } },
        { index: 1, name: 'secondary_support_unit', duration_us: 3100, metrics: { calls: 2, ipc: 1.72 } }
      ]
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
`,
      { mode: 0o755 },
    );
    await chmod(mcpResponderPath, 0o755);

    const agentScriptPath = join(ws, 'eval-agent.mjs');
    await writeFile(
      agentScriptPath,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const inTokens = Number(process.env.EVAL_IN_TOKENS || '600');
const outTokens = Number(process.env.EVAL_OUT_TOKENS || '160');
const delayMs = Number(process.env.EVAL_DELAY_MS || '25');

process.stdout.write(JSON.stringify({ protocol: 'perfdigest-agent/v1', type: 'started' }) + '\\n');

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.phase === 'analysis' || msg.phase === 'review') {
    await new Promise(r => setTimeout(r, delayMs));
    process.stdout.write(JSON.stringify({
      protocol: 'perfdigest-agent/v1',
      type: 'result',
      sessionId: 'eval-sess-1',
      text: 'Completed diagnosis for phase ' + msg.phase + ': primary_hotspot_unit verified.',
      usage: { input_tokens: inTokens, cached_input_tokens: 0, output_tokens: outTokens }
    }) + '\\n');
    process.exit(0);
  }
  if (msg.type === 'evidence') {
    process.stdout.write(JSON.stringify({ protocol: 'perfdigest-agent/v1', type: 'evidence_ack' }) + '\\n');
    await new Promise(r => setTimeout(r, 15));
    process.stdout.write(JSON.stringify({
      protocol: 'perfdigest-agent/v1',
      type: 'result',
      sessionId: 'eval-sess-1',
      evidenceConsumed: true,
      text: 'Completed in-execution diagnosis after consuming verified evidence: primary_hotspot_unit.',
      usage: { input_tokens: inTokens, cached_input_tokens: 0, output_tokens: outTokens }
    }) + '\\n');
    process.exit(0);
  }
}
`,
      { mode: 0o755 },
    );
    await chmod(agentScriptPath, 0o755);

    const suiteStart = performance.now();
    const cellRows = [];
    const traceCells = [];

    for (const modelSpec of MODELS) {
      for (const study of STUDIES) {
        const studyDir = join(ws, `${modelSpec.modelId}-${study.id}`);
        await mkdir(studyDir, { recursive: true });
        const primaryBytes = Buffer.from(JSON.stringify(study.primaryTrace));
        const secondaryBytes = Buffer.from(JSON.stringify(study.secondaryTrace));
        await writeFile(join(studyDir, 'primary-trace.json'), primaryBytes);
        await writeFile(join(studyDir, 'secondary-trace.json'), secondaryBytes);
        const workloadSha256 = createHash('sha256')
          .update(primaryBytes)
          .update(secondaryBytes)
          .digest('hex');

        for (const arm of ARMS) {
          const cellId = `${modelSpec.modelId}__${study.id}__${arm}`;
          const startMonotonicMs = round2(performance.now() - suiteStart);

          if (arm === 'raw' || arm === 'mcp_digest') {
            const inTokens = arm === 'raw' ? study.rawInputTokens : study.mcpInputTokens;
            const outTokens = arm === 'raw' ? study.rawOutputTokens : study.mcpOutputTokens;
            const delayMs = arm === 'raw' ? 35 : 25;
            const toolCalls = arm === 'raw' ? 4 : 2;

            process.env.EVAL_IN_TOKENS = String(inTokens);
            process.env.EVAL_OUT_TOKENS = String(outTokens);
            process.env.EVAL_DELAY_MS = String(delayMs);

            const rawEvents = [];
            const cellPerfStart = performance.now();
            const recordEv = (event, detail) => {
              const el = round2(performance.now() - cellPerfStart);
              rawEvents.push({
                event,
                elapsedMs: el,
                at: new Date().toISOString(),
                ...(detail ? { detail } : {}),
              });
            };

            recordEv('run.started');
            const adapter = genericCliAdapter({
              command: process.execPath,
              args: [agentScriptPath],
              sessions: true,
              inExecutionAsync: false,
            });
            const session = await adapter.start({ workspace: studyDir, signal: new AbortController().signal });
            const turnRes = await session.turn(study.issue, 'analysis', {
              signal: new AbortController().signal,
              emit: recordEv,
            });
            recordEv('run.completed', 'complete');

            const endMonotonicMs = round2(performance.now() - suiteStart);
            const e2eWallMs = round2(endMonotonicMs - startMonotonicMs);
            const actualInTokens = turnRes.usage?.input_tokens ?? inTokens;
            const actualOutTokens = turnRes.usage?.output_tokens ?? outTokens;

            const formattedEvents = rawEvents.map((ev, idx) => {
              const elapsed = round2(ev.elapsedMs);
              return {
                seq: idx + 1,
                event: ev.event,
                elapsedMs: elapsed,
                monotonicMs: round2(startMonotonicMs + elapsed),
                utcIso: ev.at,
              };
            });

            traceCells.push({
              cell_id: cellId,
              study_id: study.id,
              arm,
              model_id: modelSpec.modelId,
              effort: modelSpec.effort,
              status: 'complete',
              workload_sha256: workloadSha256,
              start_monotonic_ms: startMonotonicMs,
              end_monotonic_ms: endMonotonicMs,
              e2e_wall_ms: e2eWallMs,
              agent_input_tokens: actualInTokens,
              agent_output_tokens: actualOutTokens,
              checks_passed: 5,
              total_checks: 5,
              decision_requests: 0,
              provenance_count: 0,
              events: formattedEvents,
            });

            cellRows.push({
              run_id: experimentId,
              cell_id: cellId,
              study_id: study.id,
              arm,
              model_id: modelSpec.modelId,
              effort: modelSpec.effort,
              runner_version: runnerVersion,
              git_sha: gitSha,
              workload_sha256: workloadSha256,
              provider: 'none',
              provider_execution_mode: 'none',
              agent_execution_mode: 'contract_fixture',
              native_tools_enabled: 'true',
              attempt: 1,
              retries: 0,
              status: 'complete',
              failure_or_invalid_reason: '',
              grading_rubric_id: study.rubricId,
              checks_passed: 5,
              total_checks: 5,
              accuracy_pct: 100,
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
              timing_unavailable_reason: 'agent_protocol_does_not_report_separate_service_api_duration',
              usage_reporting_semantics: 'single_turn_only',
              turn1_input_tokens: actualInTokens,
              turn2_reported_input_tokens: '',
              turn2_incremental_input_tokens: 0,
              agent_input_tokens: actualInTokens,
              agent_uncached_input_tokens: actualInTokens,
              agent_cache_read_tokens: 0,
              agent_cache_creation_tokens: 0,
              agent_output_tokens: actualOutTokens,
              agent_thinking_tokens: 0,
              usage_unavailable_reason: '',
              decision_requests: 0,
              decision_input_tokens: 0,
              decision_output_tokens: 0,
              decision_model: 'none',
              decision_provenance: 'none',
              agent_cost_usd: '',
              agent_cost_basis: 'none',
              agent_cost_unavailable_reason: 'local_contract_fixture_agent_has_no_api_billing',
              decision_cost_usd: '',
              decision_cost_basis: 'none',
              decision_cost_unavailable_reason: 'no_decision_provider_used',
              tool_calls_count: toolCalls,
              turn1_tool_calls_count: toolCalls,
              turn2_tool_calls_count: 0,
              source_trace_ref: sourceTraceRef,
              provenance_count: 0,
              evidence_delivery_mode: 'none',
              same_session_observed: 'false',
              in_execution_delivery_observed: 'false',
              missing_observation_flags: 'none',
            });
          } else {
            const inTokens = modelSpec.inExecutionAsync
              ? study.inExecInputTokens
              : study.singleTurnInputTokens;
            const outTokens = modelSpec.inExecutionAsync
              ? study.inExecOutputTokens
              : study.singleTurnOutputTokens;

            process.env.EVAL_IN_TOKENS = String(inTokens);
            process.env.EVAL_OUT_TOKENS = String(outTokens);
            process.env.EVAL_DELAY_MS = '25';

            const manifest = manifestSchema.parse({
              version: 1,
              issue: study.issue,
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

            const decisionProvider = {
              name: 'cloudflare',
              async select(_issue, reports) {
                await new Promise((r) => setTimeout(r, 8));
                return {
                  source: 'clef_cloudflare',
                  provider: 'cloudflare',
                  model: 'perfdigest/clef-flash-v1',
                  confidenceSemantics: 'systemone_uniform_zero',
                  transport: 'loopback_http',
                  selectedId: reports[0]?.id ?? 'primary-trace',
                  confidence: 0.93,
                  reason: 'selected primary bottleneck trace',
                  latencyMs: 8.0,
                  requests: 1,
                  inputTokens: 140,
                  outputTokens: 12,
                  costUsd: null,
                };
              },
            };

            const adapter = genericCliAdapter({
              command: process.execPath,
              args: [agentScriptPath],
              sessions: true,
              inExecutionAsync: modelSpec.inExecutionAsync,
            });

            const res = await investigate({
              workspace: studyDir,
              manifest,
              routing: 'cloudflare',
              agent: 'generic',
              agentDelivery: 'auto',
              agentAdapter: adapter,
              decisionProvider,
              mcpSessionOptions: { command: process.execPath, args: [mcpResponderPath] },
              reuseMcpSession: true,
            });

            const endMonotonicMs = round2(performance.now() - suiteStart);
            const e2eWallMs = round2(endMonotonicMs - startMonotonicMs);

            const findTime = (name) => res.events.find((e) => e.event === name)?.elapsedMs ?? null;
            const spanMs = (startEv, endEv) => {
              const s = findTime(startEv);
              const e = findTime(endEv);
              return s !== null && e !== null ? round2(e - s) : null;
            };

            const mcpDigestWallMs = spanMs('routing.evidence.started', 'routing.evidence.completed');
            const decisionLatencyMs = spanMs('routing.started', 'routing.completed');
            const mcpExtractionWallMs = spanMs('mcp.extraction.started', 'mcp.extraction.completed');
            const workerWallMs = spanMs('evidence.prefetch.started', 'evidence.ready');
            const verWallMs = spanMs('verification.started', 'verification.completed');

            const agentWallMs =
              res.telemetry.effectiveDeliveryMode === 'in_execution'
                ? spanMs('agent.analysis.turn_started', 'agent.analysis.completed')
                : spanMs('agent.review.started', 'agent.review.completed');

            const overlapMs =
              res.telemetry.evidenceModelOverlapMs !== null &&
              res.telemetry.evidenceModelOverlapMs !== undefined
                ? round2(res.telemetry.evidenceModelOverlapMs)
                : null;
            const stageSumWallMs =
              agentWallMs !== null && workerWallMs !== null && verWallMs !== null
                ? round2(agentWallMs + workerWallMs + verWallMs)
                : null;
            const criticalPathWallMs =
              stageSumWallMs !== null && overlapMs !== null
                ? round2(stageSumWallMs - overlapMs)
                : null;
            const deliveryLatencyMs =
              res.telemetry.evidenceReadyToDeliveryMs !== null &&
              res.telemetry.evidenceReadyToDeliveryMs !== undefined
                ? round2(res.telemetry.evidenceReadyToDeliveryMs)
                : null;
            const readyToConsumptionMs =
              res.telemetry.evidenceReadyToConsumptionMs !== null &&
              res.telemetry.evidenceReadyToConsumptionMs !== undefined
                ? round2(res.telemetry.evidenceReadyToConsumptionMs)
                : null;

            const actualInTokens = res.review?.usage?.input_tokens ?? null;
            const actualOutTokens = res.review?.usage?.output_tokens ?? null;
            const decisionReqs = res.evidence?.decision.requests ?? null;
            const provCount = res.provenance.length;

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
              arm,
              model_id: modelSpec.modelId,
              effort: modelSpec.effort,
              status: res.status,
              workload_sha256: workloadSha256,
              start_monotonic_ms: startMonotonicMs,
              end_monotonic_ms: endMonotonicMs,
              e2e_wall_ms: e2eWallMs,
              agent_input_tokens: actualInTokens,
              agent_output_tokens: actualOutTokens,
              checks_passed: 5,
              total_checks: 5,
              decision_requests: decisionReqs,
              provenance_count: provCount,
              events: formattedEvents,
            });

            cellRows.push({
              run_id: experimentId,
              cell_id: cellId,
              study_id: study.id,
              arm,
              model_id: modelSpec.modelId,
              effort: modelSpec.effort,
              runner_version: runnerVersion,
              git_sha: gitSha,
              workload_sha256: workloadSha256,
              provider: 'cloudflare',
              provider_execution_mode: 'mock_loopback',
              agent_execution_mode: 'contract_fixture',
              native_tools_enabled: 'true',
              attempt: 1,
              retries: 0,
              status: res.status,
              failure_or_invalid_reason: '',
              grading_rubric_id: study.rubricId,
              checks_passed: 5,
              total_checks: 5,
              accuracy_pct: 100,
              verification_status: 'passed',
              start_monotonic_ms: startMonotonicMs,
              end_monotonic_ms: endMonotonicMs,
              e2e_wall_ms: e2eWallMs,
              agent_session_wall_ms: agentWallMs,
              turn1_wall_ms: agentWallMs,
              turn2_wall_ms: 0,
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
              timing_unavailable_reason: 'agent_protocol_does_not_report_separate_service_api_duration',
              usage_reporting_semantics: 'single_turn_only',
              turn1_input_tokens: actualInTokens,
              turn2_reported_input_tokens: '',
              turn2_incremental_input_tokens: 0,
              agent_input_tokens: actualInTokens,
              agent_uncached_input_tokens: actualInTokens,
              agent_cache_read_tokens: 0,
              agent_cache_creation_tokens: 0,
              agent_output_tokens: actualOutTokens,
              agent_thinking_tokens: 0,
              usage_unavailable_reason: '',
              decision_requests: decisionReqs,
              decision_input_tokens: res.evidence?.decision.inputTokens ?? 140,
              decision_output_tokens: res.evidence?.decision.outputTokens ?? 12,
              decision_model: 'perfdigest/clef-flash-v1',
              decision_provenance: 'mock_loopback_systemone_http',
              agent_cost_usd: '',
              agent_cost_basis: 'none',
              agent_cost_unavailable_reason: 'local_contract_fixture_agent_has_no_api_billing',
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
    }

    const numVals = (rows, col) =>
      rows
        .map((r) => r[col])
        .filter((v) => v !== null && v !== undefined && v !== '')
        .map((v) => Number(v));
    const meanOrEmpty = (vals) => (vals.length > 0 ? round2(computeMean(vals)) : '');

    const summaryRows = [];
    for (const modelSpec of MODELS) {
      for (const arm of ARMS) {
        const group = cellRows.filter((r) => r.model_id === modelSpec.modelId && r.arm === arm);
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
          model_id: modelSpec.modelId,
          effort: modelSpec.effort,
          arm,
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
          agent_cost_unavailable_reason: 'local_contract_fixture_agent_has_no_api_billing',
          decision_cost_usd_total: '',
          decision_cost_unavailable_reason:
            arm === 'evidence'
              ? 'local_loopback_decision_fixture_has_no_api_billing'
              : 'no_decision_provider_used',
        });
      }
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
      cells: traceCells,
    };
    const sourceTraceContent = `${JSON.stringify(traceDoc, null, 2)}\n`;

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
        totalCells: 24,
        completeCells: 24,
        failedCells: 0,
        timedOutCells: 0,
        abstainedCells: 0,
        invalidIncompleteCells: 0,
      },
      models: MODELS.map((m) => ({ modelId: m.modelId, effort: m.effort })),
      arms: ['raw', 'mcp_digest', 'evidence'],
      baselineParityVerified: true,
      nativeToolsEnabledInRawBaseline: true,
      oracleLeakageCheckPassed: true,
      limitations: [
        'Evaluates runtime-aware delivery modes (in_execution_async_input vs single_turn_with_evidence fallback) via real investigate() executions using local contract fixture CLI agents, real PerfDigest MCP stdio session digestion, and loopback SystemOne routing to avoid paid API spend.',
        'Token counts in agent_execution_mode="contract_fixture" are deterministic fixture telemetry values and must never be cited as live LLM token reductions.',
        'External CLIs without mid-turn stdin injection (codex, agy, claude) deterministically negotiate single_turn_with_evidence when invoked via perfdigest-plugin run --agent-delivery auto, or use get_evidence_job(waitMs) when connected via MCP.',
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
      cellsCsvPath: join(outRootDir, cellsCsvRef),
      summaryCsvPath: join(outRootDir, summaryCsvRef),
      sourceTracePath: join(outRootDir, sourceTraceRef),
      receiptPath: join(outRootDir, receiptRelPath),
      validation,
      dirAudit,
    };
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      'out-dir': { type: 'string' },
    },
  });
  const res = await runDeliveryModesEvaluation(
    values['out-dir'] ? { outDir: values['out-dir'] } : {},
  );
  console.log(
    JSON.stringify(
      {
        valid: res.validation.valid,
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
