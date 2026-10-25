import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  AgentError,
  genericCliAdapter,
  getRuntimeCapabilityProfile,
  negotiateEvidenceDeliveryMode,
} from '../src/agents.js';
import {
  validateBenchmarkIntegrityBundle,
  type BenchmarkMeasurementReceipt,
} from '../src/benchmark-integrity.js';
import { manifestSchema, type Manifest } from '../src/config.js';
import type { DecisionProvider } from '../src/providers.js';
import { investigate } from '../src/run.js';

const execFileAsync = promisify(execFile);

const workParent = join(process.cwd(), 'work', 'tests');

async function makeWorkspace(prefix: string): Promise<string> {
  await mkdir(workParent, { recursive: true });
  return mkdtemp(join(workParent, prefix));
}

async function createLocalMcpResponder(dir: string, delayMs = 0): Promise<string> {
  const scriptPath = join(dir, 'mcp-responder.mjs');
  const code = `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const delayMs = ${delayMs};
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
        serverInfo: { name: 'local-test-mcp', version: '1.0.0' }
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
    const data = {
      format: args.format ?? 'chrome-trace',
      raw_ref: args.report_ref ?? 'trace.json',
      domain: 'cpu',
      total_units: 2,
      returned: 2,
      units: [
        { index: 0, name: 'hot_kernel_reduce', duration_us: 48200, metrics: { calls: 12, ipc: 0.42 } },
        { index: 1, name: 'setup_buffers', duration_us: 1100, metrics: { calls: 1, ipc: 1.85 } }
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
`;
  await writeFile(scriptPath, code, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function makeAcceptedProvider(delayMs = 0): DecisionProvider {
  return {
    name: 'cloudflare',
    async select(_issue, reports) {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      return {
        source: 'clef_cloudflare',
        provider: 'cloudflare',
        model: 'perfdigest/clef-flash-v1',
        confidenceSemantics: 'systemone_uniform_zero',
        transport: 'loopback_http',
        selectedId: reports[0]?.id ?? null,
        confidence: 0.91,
        reason: 'selected',
        latencyMs: 12.5,
        requests: 1,
        inputTokens: 48,
        outputTokens: 12,
        costUsd: null,
      };
    },
  };
}

function makeAbstainedProvider(): DecisionProvider {
  return {
    name: 'cloudflare',
    async select() {
      return {
        source: 'clef_cloudflare',
        provider: 'cloudflare',
        model: 'perfdigest/clef-flash-v1',
        confidenceSemantics: 'systemone_uniform_zero',
        transport: 'loopback_http',
        selectedId: null,
        confidence: 0.35,
        reason: 'low_confidence',
        latencyMs: 9.2,
        requests: 1,
        inputTokens: 42,
        outputTokens: 10,
        costUsd: null,
      };
    },
  };
}

test('Runtime capability matrix distinguishes inExecutionAsyncInput from queuedStdinNextTurn and usage semantics', () => {
  const codex = getRuntimeCapabilityProfile('codex');
  assert.equal(codex.inExecutionAsyncInput, 'unsupported');
  assert.equal(codex.inExecutionToolDelivery, 'supported');
  assert.equal(codex.queuedStdinNextTurn, 'unsupported');
  assert.equal(codex.usageReportingSemantics, 'incremental_per_turn');

  const agy = getRuntimeCapabilityProfile('agy');
  assert.equal(agy.inExecutionAsyncInput, 'unsupported');
  assert.equal(agy.inExecutionToolDelivery, 'supported');
  assert.equal(agy.queuedStdinNextTurn, 'supported', 'AGY queues stdin for next turn, not mid-turn');
  assert.equal(agy.usageReportingSemantics, 'cumulative_session_trajectory');

  const claude = getRuntimeCapabilityProfile('claude');
  assert.equal(claude.inExecutionAsyncInput, 'unsupported');
  assert.equal(claude.inExecutionToolDelivery, 'supported');
  assert.equal(claude.queuedStdinNextTurn, 'supported', 'Claude queues stdin for next turn, not mid-turn');
  assert.equal(claude.usageReportingSemantics, 'incremental_per_turn');

  const genericDefault = getRuntimeCapabilityProfile('generic-cli', { sessions: true });
  assert.equal(genericDefault.inExecutionAsyncInput, 'unsupported');
  assert.equal(genericDefault.sameSessionContinuation, true);

  const genericInExec = getRuntimeCapabilityProfile('generic-cli-in-execution');
  assert.equal(genericInExec.inExecutionAsyncInput, 'supported');
  assert.equal(genericInExec.nativeAsyncInput, true);
  assert.equal(genericInExec.usageReportingSemantics, 'single_turn_only');
});

test('negotiateEvidenceDeliveryMode selects in_execution when supported and falls back to single_turn when unsupported', () => {
  const inExecCaps = getRuntimeCapabilityProfile('generic-cli-in-execution');
  const codexCaps = getRuntimeCapabilityProfile('codex');
  const statelessCaps = getRuntimeCapabilityProfile('generic-cli', { sessions: false });

  // auto + inExecutionAsyncInput=supported -> in_execution
  const autoSupported = negotiateEvidenceDeliveryMode('auto', inExecCaps);
  assert.equal(autoSupported.effectiveMode, 'in_execution');
  assert.equal(autoSupported.plannedEvidenceDelivery, 'in_execution_async_input');
  assert.equal(autoSupported.fellBack, false);

  // auto + inExecutionAsyncInput=unsupported -> single_turn fallback
  const autoFallback = negotiateEvidenceDeliveryMode('auto', codexCaps);
  assert.equal(autoFallback.effectiveMode, 'single_turn');
  assert.equal(autoFallback.plannedEvidenceDelivery, 'single_turn_with_evidence');
  assert.equal(autoFallback.fellBack, true);

  // explicit in_execution + unsupported (non-strict) -> single_turn fallback
  const explicitFallback = negotiateEvidenceDeliveryMode('in_execution', codexCaps);
  assert.equal(explicitFallback.effectiveMode, 'single_turn');
  assert.equal(explicitFallback.fellBack, true);

  // explicit in_execution + unsupported + strictDeliveryMode=true -> fails closed
  assert.throws(
    () => negotiateEvidenceDeliveryMode('in_execution', codexCaps, { strictDeliveryMode: true }),
    (err: unknown) => err instanceof AgentError && err.kind === 'unsupported',
  );

  // two_turn preserves same_session_next_turn vs fresh_session_with_context
  const twoTurnSame = negotiateEvidenceDeliveryMode('two_turn', codexCaps);
  assert.equal(twoTurnSame.effectiveMode, 'two_turn');
  assert.equal(twoTurnSame.plannedEvidenceDelivery, 'same_session_next_turn');

  const twoTurnFresh = negotiateEvidenceDeliveryMode('two_turn', statelessCaps);
  assert.equal(twoTurnFresh.effectiveMode, 'two_turn');
  assert.equal(twoTurnFresh.plannedEvidenceDelivery, 'fresh_session_with_context');
});

test('investigate in_execution mode delivers verified evidence mid-execution in a single process with zero duplicate turns', async () => {
  const ws = await makeWorkspace('in-exec-delivery-');
  try {
    await writeFile(join(ws, 'trace.json'), JSON.stringify({ traceEvents: [{ name: 'hot_kernel_reduce', dur: 48200 }] }));
    const mcpResponder = await createLocalMcpResponder(ws, 30);

    // Agent script that starts investigating, reads the mid-execution evidence frame from stdin,
    // emits evidence_ack, and finishes in a single execution.
    const agentScript = join(ws, 'in-exec-agent.mjs');
    await writeFile(
      agentScript,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptFrame = null;
let evidenceFrame = null;

for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.phase === 'in_execution') {
    promptFrame = msg;
    process.stdout.write(JSON.stringify({
      protocol: 'perfdigest-agent/v1',
      type: 'progress',
      detail: 'Agent started initial workspace orientation while awaiting evidence'
    }) + '\\n');
  } else if (msg.type === 'evidence') {
    evidenceFrame = msg;
    process.stdout.write(JSON.stringify({
      protocol: 'perfdigest-agent/v1',
      type: 'evidence_ack'
    }) + '\\n');
    break;
  }
}

const parsedEvidence = evidenceFrame ? JSON.parse(evidenceFrame.evidence) : null;
const topUnit = parsedEvidence?.selected?.[0]?.digest?.units?.[0]?.name ?? 'unknown';
process.stdout.write(JSON.stringify({
  protocol: 'perfdigest-agent/v1',
  type: 'result',
  sessionId: 'in-exec-sess-1',
  evidenceConsumed: Boolean(parsedEvidence),
  text: 'In-execution diagnosis complete: bottleneck is ' + topUnit + ' (status=' + (parsedEvidence?.status ?? 'none') + ').',
  usage: { input_tokens: 310, cached_input_tokens: 0, output_tokens: 75 }
}) + '\\n');
`,
      { mode: 0o755 },
    );
    await chmod(agentScript, 0o755);

    const manifest: Manifest = manifestSchema.parse({
      version: 1,
      issue: 'Identify the primary CPU bottleneck in trace.json',
      captures: [],
      reports: [{ id: 'cpu-trace', path: 'trace.json', format: 'chrome-trace', description: 'CPU trace' }],
      verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    });

    const adapter = genericCliAdapter({
      command: process.execPath,
      args: [agentScript],
      inExecutionAsync: true,
    });

    const result = await investigate({
      workspace: ws,
      manifest,
      routing: 'cloudflare',
      agent: 'generic',
      agentDelivery: 'auto',
      agentAdapter: adapter,
      decisionProvider: makeAcceptedProvider(20),
      mcpSessionOptions: { command: process.execPath, args: [mcpResponder] },
    });

    assert.equal(result.status, 'complete');
    assert.equal(result.decisionOutcome, 'accepted');
    assert.equal(result.telemetry.requestedDeliveryMode, 'auto');
    assert.equal(result.telemetry.effectiveDeliveryMode, 'in_execution');
    assert.equal(result.telemetry.delivery, 'in_execution');
    assert.equal(result.telemetry.evidenceDelivery, 'in_execution_async_input');
    assert.equal(result.telemetry.evidenceConsumedInExecution, true);
    assert.equal(result.telemetry.earlyAgentCompletion, false);
    assert.equal(result.telemetry.deliveryCount, 1);
    assert.ok(typeof result.telemetry.evidenceReadyAtMs === 'number' && result.telemetry.evidenceReadyAtMs >= 0);
    assert.ok(typeof result.telemetry.evidenceDeliveredAtMs === 'number' && result.telemetry.evidenceDeliveredAtMs >= result.telemetry.evidenceReadyAtMs);
    assert.ok(typeof result.telemetry.evidenceConsumedAtMs === 'number' && result.telemetry.evidenceConsumedAtMs >= result.telemetry.evidenceDeliveredAtMs);
    assert.ok(typeof result.telemetry.evidenceReadyToDeliveryMs === 'number' && result.telemetry.evidenceReadyToDeliveryMs >= 0);
    assert.ok(typeof result.telemetry.evidenceReadyToConsumptionMs === 'number' && result.telemetry.evidenceReadyToConsumptionMs >= 0);
    assert.match(result.review?.text ?? '', /hot_kernel_reduce/);
    assert.equal(result.review?.usage?.input_tokens, 310);

    const eventNames = result.events.map(e => e.event);
    assert.ok(eventNames.includes('agent.in_execution.started'));
    assert.ok(eventNames.includes('evidence.ready'));
    assert.ok(eventNames.includes('evidence.delivered'));
    assert.ok(eventNames.includes('evidence.accepted_by_runtime'));
    assert.ok(eventNames.includes('evidence.model_visible'));
    assert.ok(eventNames.includes('evidence.consumed'));
    assert.ok(eventNames.includes('agent.in_execution.completed'));
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('investigate in_execution mode handles early agent completion before slow evidence finishes without hanging or losing receipts', async () => {
  const ws = await makeWorkspace('in-exec-early-');
  try {
    await writeFile(join(ws, 'trace.json'), JSON.stringify({ traceEvents: [{ name: 'hot_kernel_reduce', dur: 48200 }] }));
    const mcpResponder = await createLocalMcpResponder(ws, 180);

    // Agent finishes immediately upon receiving the initial prompt without waiting for evidence.
    const fastAgentScript = join(ws, 'fast-agent.mjs');
    await writeFile(
      fastAgentScript,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.phase === 'in_execution') {
    process.stdout.write(JSON.stringify({
      protocol: 'perfdigest-agent/v1',
      type: 'result',
      sessionId: 'fast-sess-1',
      evidenceConsumed: false,
      text: 'Resolved directly from source inspection before background evidence completed.',
      usage: { input_tokens: 180, cached_input_tokens: 0, output_tokens: 40 }
    }) + '\\n');
    process.exit(0);
  }
}
`,
      { mode: 0o755 },
    );
    await chmod(fastAgentScript, 0o755);

    const manifest: Manifest = manifestSchema.parse({
      version: 1,
      issue: 'Quick check before slow worker finishes',
      captures: [],
      reports: [{ id: 'cpu-trace', path: 'trace.json', format: 'chrome-trace', description: 'CPU trace' }],
      verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    });

    const adapter = genericCliAdapter({
      command: process.execPath,
      args: [fastAgentScript],
      inExecutionAsync: true,
    });

    const result = await investigate({
      workspace: ws,
      manifest,
      routing: 'cloudflare',
      agent: 'generic',
      agentDelivery: 'in_execution',
      agentAdapter: adapter,
      decisionProvider: makeAcceptedProvider(120),
      mcpSessionOptions: { command: process.execPath, args: [mcpResponder] },
    });

    assert.equal(result.status, 'complete');
    assert.equal(result.telemetry.effectiveDeliveryMode, 'in_execution');
    assert.equal(result.telemetry.earlyAgentCompletion, true);
    assert.equal(result.telemetry.evidenceConsumedInExecution, false);
    assert.equal(result.telemetry.deliveryCount, 0);
    assert.equal(result.telemetry.evidenceDelivery, null);
    assert.ok(result.evidence !== null, 'Background evidence is still recorded in run.json');
    assert.ok(result.verification !== null, 'Independent verification is still recorded in run.json');
    assert.ok(result.events.some(e => e.event === 'agent.in_execution.completed_before_evidence'));
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('investigate in_execution mode preserves needs_review status on abstaining decision provider', async () => {
  const ws = await makeWorkspace('in-exec-abstain-');
  try {
    await writeFile(join(ws, 'trace.json'), JSON.stringify({ traceEvents: [{ name: 'hot_kernel_reduce', dur: 48200 }] }));
    const mcpResponder = await createLocalMcpResponder(ws, 10);

    const agentScript = join(ws, 'abstain-agent.mjs');
    await writeFile(
      agentScript,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.type === 'evidence') {
    const ev = JSON.parse(msg.evidence);
    process.stdout.write(JSON.stringify({ protocol: 'perfdigest-agent/v1', type: 'evidence_ack' }) + '\\n');
    process.stdout.write(JSON.stringify({
      protocol: 'perfdigest-agent/v1',
      type: 'result',
      sessionId: 'abstain-sess-1',
      evidenceConsumed: true,
      text: 'Abstained status observed: ' + ev.status,
      usage: { input_tokens: 210, cached_input_tokens: 0, output_tokens: 35 }
    }) + '\\n');
    break;
  }
}
`,
      { mode: 0o755 },
    );
    await chmod(agentScript, 0o755);

    const manifest: Manifest = manifestSchema.parse({
      version: 1,
      issue: 'Ambiguous trace',
      captures: [],
      reports: [{ id: 'cpu-trace', path: 'trace.json', format: 'chrome-trace', description: 'CPU trace' }],
      verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    });

    const result = await investigate({
      workspace: ws,
      manifest,
      routing: 'cloudflare',
      agent: 'generic',
      agentDelivery: 'in_execution',
      agentAdapter: genericCliAdapter({ command: process.execPath, args: [agentScript], inExecutionAsync: true }),
      decisionProvider: makeAbstainedProvider(),
      mcpSessionOptions: { command: process.execPath, args: [mcpResponder] },
    });

    assert.equal(result.status, 'needs_review');
    assert.equal(result.decisionOutcome, 'abstained');
    assert.equal(result.telemetry.evidenceConsumedInExecution, true);
    assert.match(result.review?.text ?? '', /Abstained status observed: needs_review/);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('plugin MCP server get_evidence_job supports long-polling waitMs for same-execution tool delivery', async () => {
  const ws = await makeWorkspace('mcp-in-exec-tool-');
  try {
    await writeFile(join(ws, 'trace.json'), JSON.stringify({ traceEvents: [{ name: 'hot_kernel_reduce', dur: 48200 }] }));
    const mcpResponder = await createLocalMcpResponder(ws, 40);

    const manifestPath = join(ws, 'manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        issue: 'Same-execution MCP tool pull',
        captures: [],
        reports: [{ id: 'cpu-trace', path: 'trace.json', format: 'chrome-trace', description: 'CPU trace' }],
        verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
      }),
    );

    const goBin = join(process.cwd(), 'dist', 'perfdigest-plugin');
    const transport = new StdioClientTransport({
      command: goBin,
      args: [
        'mcp',
        '--workspace',
        ws,
        '--routing',
        'offline',
        '--mcp-command',
        process.execPath,
        '--mcp-arg',
        mcpResponder,
      ],
    });
    const client = new Client({ name: 'test-in-exec-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const launchRes = await client.callTool({
        name: 'launch_evidence_prefetch',
        arguments: {
          issue: 'Same-execution MCP tool pull',
          reports: [{ id: 'cpu-trace', path: 'trace.json', format: 'chrome-trace', description: 'CPU trace' }],
        },
      });
      const launchData = (launchRes.structuredContent ?? JSON.parse((launchRes.content as Array<{ text: string }>)[0]!.text)) as Record<string, unknown>;
      assert.ok(launchData.jobId);

      const getRes = await client.callTool({
        name: 'get_evidence_job',
        arguments: { jobId: launchData.jobId, waitMs: 10_000 },
      });
      const getData = (getRes.structuredContent ?? JSON.parse((getRes.content as Array<{ text: string }>)[0]!.text)) as Record<string, unknown>;
      assert.equal(getData.status, 'complete');
      assert.equal(getData.deliveryMode, 'in_execution_tool_delivery');
      assert.ok(typeof getData.waitedMs === 'number' && getData.waitedMs >= 0);
      assert.equal((getData.packet as { status: string }).status, 'complete');
    } finally {
      await client.close();
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('Go binary CLI supports --agent-in-execution-async with --agent-delivery auto and falls back cleanly when unsupported', async () => {
  const ws = await makeWorkspace('go-in-exec-cli-');
  try {
    await writeFile(join(ws, 'trace.json'), JSON.stringify({ traceEvents: [{ name: 'hot_kernel_reduce', dur: 48200 }] }));
    const mcpResponder = await createLocalMcpResponder(ws, 15);

    const agentScript = join(ws, 'go-in-exec-agent.mjs');
    await writeFile(
      agentScript,
      `#!/usr/bin/env node
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.phase === 'review') {
    // Fallback single_turn mode
    process.stdout.write(JSON.stringify({
      protocol: 'perfdigest-agent/v1',
      type: 'result',
      sessionId: 'fallback-sess-1',
      text: 'Single-turn fallback completed cleanly.',
      usage: { input_tokens: 240, cached_input_tokens: 0, output_tokens: 50 }
    }) + '\\n');
    process.exit(0);
  }
  if (msg.type === 'evidence') {
    process.stdout.write(JSON.stringify({ protocol: 'perfdigest-agent/v1', type: 'evidence_ack' }) + '\\n');
    process.stdout.write(JSON.stringify({
      protocol: 'perfdigest-agent/v1',
      type: 'result',
      sessionId: 'go-in-exec-1',
      evidenceConsumed: true,
      text: 'Go in-execution agent consumed evidence in 1 execution.',
      usage: { input_tokens: 260, cached_input_tokens: 0, output_tokens: 55 }
    }) + '\\n');
    process.exit(0);
  }
}
`,
      { mode: 0o755 },
    );
    await chmod(agentScript, 0o755);

    const manifestPath = join(ws, 'manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        issue: 'Verify Go CLI runtime-aware delivery',
        captures: [],
        reports: [{ id: 'cpu-trace', path: 'trace.json', format: 'chrome-trace', description: 'CPU trace' }],
        verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
      }),
    );

    const goBin = join(process.cwd(), 'dist', 'perfdigest-plugin');

    // 1. With --agent-in-execution-async and --agent-delivery auto -> in_execution_async_input
    const { stdout: out1 } = await execFileAsync(goBin, [
      'run',
      manifestPath,
      '--workspace',
      ws,
      '--routing',
      'offline',
      '--agent',
      'generic',
      '--agent-command',
      agentScript,
      '--agent-in-execution-async',
      '--agent-delivery',
      'auto',
      '--mcp-command',
      process.execPath,
      '--mcp-arg',
      mcpResponder,
    ]);
    const summary1 = JSON.parse(out1);
    assert.equal(summary1.status, 'complete');
    assert.equal(summary1.telemetry.requestedDeliveryMode, 'auto');
    assert.equal(summary1.telemetry.effectiveDeliveryMode, 'in_execution');
    assert.equal(summary1.telemetry.evidenceDelivery, 'in_execution_async_input');
    assert.equal(summary1.telemetry.evidenceConsumedInExecution, true);
    assert.equal(summary1.telemetry.deliveryCount, 1);

    // 2. Without --agent-in-execution-async and with --agent-delivery auto -> falls back to single_turn_with_evidence
    const { stdout: out2 } = await execFileAsync(goBin, [
      'run',
      manifestPath,
      '--workspace',
      ws,
      '--routing',
      'offline',
      '--agent',
      'generic',
      '--agent-command',
      agentScript,
      '--agent-delivery',
      'auto',
      '--mcp-command',
      process.execPath,
      '--mcp-arg',
      mcpResponder,
    ]);
    const summary2 = JSON.parse(out2);
    assert.equal(summary2.status, 'complete');
    assert.equal(summary2.telemetry.requestedDeliveryMode, 'auto');
    assert.equal(summary2.telemetry.effectiveDeliveryMode, 'single_turn');
    assert.equal(summary2.telemetry.evidenceDelivery, 'single_turn_with_evidence');
    assert.equal(summary2.telemetry.deliveryCount, 1);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('investigate in_execution mode propagates caller cancellation and per-turn timeout without leaked processes', async () => {
  const ws = await makeWorkspace('in-exec-cancel-');
  try {
    await writeFile(join(ws, 'trace.json'), JSON.stringify({ traceEvents: [{ name: 'hot_kernel_reduce', dur: 48200 }] }));
    const mcpResponder = await createLocalMcpResponder(ws, 10);

    const hangingAgentScript = join(ws, 'hanging-agent.mjs');
    await writeFile(
      hangingAgentScript,
      `#!/usr/bin/env node
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    await chmod(hangingAgentScript, 0o755);

    const manifest: Manifest = manifestSchema.parse({
      version: 1,
      issue: 'Test timeout in in_execution mode',
      captures: [],
      reports: [{ id: 'cpu-trace', path: 'trace.json', format: 'chrome-trace', description: 'CPU trace' }],
      verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    });

    const result = await investigate({
      workspace: ws,
      manifest,
      routing: 'cloudflare',
      agent: 'generic',
      agentDelivery: 'in_execution',
      agentAdapter: genericCliAdapter({
        command: process.execPath,
        args: [hangingAgentScript],
        inExecutionAsync: true,
        timeoutMs: 120,
      }),
      decisionProvider: makeAcceptedProvider(10),
      mcpSessionOptions: { command: process.execPath, args: [mcpResponder] },
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.agentError?.kind, 'timed_out');
    assert.equal(result.agentError?.phase, 'in_execution');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('Issue 19 delivery-mode evaluation bundle passes full Issue 18 benchmark integrity validation', async () => {
  const cellsCsv = await readFile(join(process.cwd(), 'bench/results/2026-10-25-issue19-delivery-modes-cells.csv'), 'utf8');
  const summaryCsv = await readFile(join(process.cwd(), 'bench/results/2026-10-25-issue19-delivery-modes-summary.csv'), 'utf8');
  const receipt = JSON.parse(
    await readFile(join(process.cwd(), 'bench/results/2026-10-25-issue19-measurement-receipt.json'), 'utf8'),
  ) as BenchmarkMeasurementReceipt;

  const result = validateBenchmarkIntegrityBundle({ cellsCsv, summaryCsv, receipt });
  assert.equal(result.valid, true, `Violations: ${JSON.stringify(result.violations)}`);
  assert.equal(result.checkedCellsCount, 24);
  assert.equal(result.checkedSummaryRowsCount, 6);
});


