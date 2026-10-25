import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  buildCandidateActions,
  gatherEvidence,
  investigate,
  iterativeDecisionsInput,
  manifestSchema,
  sanitizeUnitLabel,
  type ReportSpec,
} from '../src/index.js';
import { formatAgentEvidence } from '../src/agents.js';
import { testDirectory } from './helpers.js';

const execFileAsync = promisify(execFile);
const goBinary = resolve('dist/perfdigest-plugin');

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolvePort((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolveClose => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
}

async function createIterativeFixtureUv(root: string, callsLogPath: string): Promise<string> {
  const binDir = join(root, 'bin-iter-mcp');
  await mkdir(binDir, { recursive: true });
  const serverScript = join(binDir, 'iter-mcp-server.mjs');
  const sdkServerUrl = pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js')).href;
  const sdkStdioUrl = pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js')).href;
  const zodUrl = pathToFileURL(resolve('node_modules/zod/index.js')).href;

  await writeFile(
    serverScript,
    `import { McpServer } from ${JSON.stringify(sdkServerUrl)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};
import fs from 'node:fs/promises';

const callsLog = ${JSON.stringify(callsLogPath)};
const server = new McpServer({ name: 'iterative-fixture-mcp', version: '1.0.0' });

async function logCall(tool, args) {
  await fs.appendFile(callsLog, JSON.stringify({ pid: process.pid, tool, args }) + '\\n');
}

server.registerTool('summarize_report', {
  inputSchema: { report_ref: z.string(), format: z.string(), top_n: z.number().optional() },
}, async ({ report_ref, format, top_n = 3 }) => {
  await logCall('summarize_report', { report_ref, format, top_n });
  const raw = JSON.parse(await fs.readFile(report_ref, 'utf8'));
  const allUnits = raw.units ?? [];
  const sliced = allUnits.slice(0, top_n);
  const data = {
    format,
    raw_ref: report_ref,
    total_units: allUnits.length,
    returned: sliced.length,
    units: sliced,
  };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
});

server.registerTool('list_kernels', {
  inputSchema: { report_ref: z.string(), format: z.string() },
}, async ({ report_ref, format }) => {
  await logCall('list_kernels', { report_ref, format });
  const raw = JSON.parse(await fs.readFile(report_ref, 'utf8'));
  const list = (raw.units ?? []).map((u, idx) => ({
    index: u.index ?? idx,
    name: u.name,
    duration_us: u.duration_us ?? null,
    domain: u.domain ?? 'kernel',
  }));
  return { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: { result: list } };
});

server.registerTool('get_metrics', {
  inputSchema: { report_ref: z.string(), format: z.string(), kernel: z.string() },
}, async ({ report_ref, format, kernel }) => {
  await logCall('get_metrics', { report_ref, format, kernel });
  const raw = JSON.parse(await fs.readFile(report_ref, 'utf8'));
  const units = raw.units ?? [];
  const found = units.find((u, idx) => String(u.index ?? idx) === kernel || u.name === kernel || u.name.includes(kernel)) ?? units[0];
  if (raw.mutateOnGetMetrics) {
    await fs.appendFile(report_ref, ' ');
  }
  const data = {
    kernel: found.name,
    index: found.index ?? 0,
    format,
    domain: found.domain ?? 'kernel',
    raw_ref: report_ref,
    metrics: found.metrics,
  };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
});

server.registerTool('expand', {
  inputSchema: { report_ref: z.string(), format: z.string(), kernel: z.string(), section: z.string().optional() },
}, async ({ report_ref, format, kernel, section = 'all' }) => {
  await logCall('expand', { report_ref, format, kernel, section });
  const raw = JSON.parse(await fs.readFile(report_ref, 'utf8'));
  const units = raw.units ?? [];
  const found = units.find((u, idx) => String(u.index ?? idx) === kernel || u.name === kernel || u.name.includes(kernel)) ?? units[0];
  const expanded = { ...found.metrics, ...(found.expanded ?? { stall_dram_pct: 78.5, bank_conflicts: 0 }) };
  const data = {
    kernel: found.name,
    index: found.index ?? 0,
    domain: found.domain ?? 'kernel',
    section_filter: section,
    metric_count: Object.keys(expanded).length,
    raw_ref: report_ref,
    metrics: expanded,
  };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
});

server.registerTool('compare_metrics', {
  inputSchema: { report_a: z.string(), report_b: z.string(), format: z.string(), kernel: z.string(), kernel_b: z.string().optional() },
}, async ({ report_a, report_b, format, kernel, kernel_b }) => {
  await logCall('compare_metrics', { report_a, report_b, format, kernel, kernel_b });
  const rawA = JSON.parse(await fs.readFile(report_a, 'utf8'));
  const rawB = JSON.parse(await fs.readFile(report_b, 'utf8'));
  const unitsA = rawA.units ?? [];
  const unitsB = rawB.units ?? [];
  const targetB = kernel_b ?? kernel;
  const uA = unitsA.find((u, idx) => String(u.index ?? idx) === kernel || u.name === kernel || u.name.includes(kernel)) ?? unitsA[0];
  const uB = unitsB.find((u, idx) => String(u.index ?? idx) === targetB || u.name === targetB || u.name.includes(targetB)) ?? unitsB[0];
  const metrics = {};
  for (const k of Object.keys(uA.metrics ?? {})) {
    const a = uA.metrics[k];
    const b = uB.metrics?.[k] ?? null;
    const delta = typeof a === 'number' && typeof b === 'number' ? b - a : null;
    const delta_pct = typeof a === 'number' && typeof b === 'number' && a !== 0 ? ((b - a) / a) * 100 : 'undefined_baseline_is_zero';
    metrics[k] = { a, b, delta, delta_pct };
  }
  const data = {
    kernel_a: uA.name,
    kernel_b: uB.name,
    index_a: uA.index ?? 0,
    index_b: uB.index ?? 0,
    format,
    domain: uA.domain ?? 'kernel',
    raw_ref_a: report_a,
    raw_ref_b: report_b,
    sign_convention: 'delta = b - a',
    metrics,
  };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
});

await server.connect(new StdioServerTransport());
`,
    'utf8',
  );

  const uvxWrapper = join(binDir, 'uvx');
  await writeFile(
    uvxWrapper,
    `#!${process.execPath}
import(${JSON.stringify(new URL(`file://${serverScript}`).href)});
`,
    { mode: 0o755 },
  );
  await chmod(uvxWrapper, 0o755);
  return binDir;
}

test('sanitizeUnitLabel strips filesystem directories while preserving kernel and phase symbols', () => {
  assert.equal(sanitizeUnitLabel('/private/workspace/src/lib_template_heavy.cpp.o'), 'lib_template_heavy.cpp.o');
  assert.equal(sanitizeUnitLabel('C:\\Users\\secret\\build\\kernel.obj'), 'kernel.obj');
  assert.equal(sanitizeUnitLabel('_Z15kernel_v0_naivePfPKfi [sm_89]'), '_Z15kernel_v0_naivePfPKfi [sm_89]');
  assert.equal(sanitizeUnitLabel('InstantiateClass'), 'InstantiateClass');
});

test('iterative Decision -> MCP -> Decision -> MCP loop discovers hidden units, compares variants, retains complementary reports, and matches between TS and Go', async () => {
  const root = await testDirectory('iterative-ts-go-parity');
  const priorPath = process.env.PATH;
  const priorClefUrl = process.env.PERFDIGEST_CLEF_URL;
  const callsLog = join(root, 'mcp-calls.jsonl');

  const stepStates: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    if (req.url !== '/v1/systemone') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const state = JSON.parse(parsed.state);
      stepStates.push(state);
      const criteria = parsed.questions.next_evidence.criteria as Record<string, string>;
      const keys = Object.keys(criteria);

      let choiceKey: string;
      const stepNum = (state.step as number | undefined) ?? 1;
      if (stepNum === 1) {
        choiceKey = 'ptxas-main';
      } else if (stepNum === 2) {
        // Layer 2: discover all 5 units via list_kernels
        choiceKey = keys.find(k => k.startsWith('list_kernels:ptxas-main')) ?? keys[0]!;
      } else if (stepNum === 3) {
        // Layer 3: compare discovered unseen kernels (#4 v0_naive vs #3 v1_coalesced)
        choiceKey = keys.find(k => k.startsWith('compare_units:ptxas-main:4:3')) ?? keys[0]!;
      } else {
        // Stop once sufficient
        choiceKey = 'stop_sufficient';
      }

      const conf = 0.85;
      const others = keys.filter(k => k !== choiceKey);
      const probs: Record<string, number> = { [choiceKey]: conf };
      let allocated = conf;
      others.forEach((k, idx) => {
        if (idx === others.length - 1) {
          probs[k] = Number((1 - allocated).toFixed(4));
        } else {
          const share = Number(((1 - conf) / others.length).toFixed(4));
          probs[k] = share;
          allocated += share;
        }
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: '@cf/cloudflare/clef-flash',
          usage: { input_tokens: 50, output_tokens: 5 },
          answers: {
            next_evidence: {
              type: 'choice',
              choice: choiceKey,
              confidence: conf,
              probabilities: probs,
            },
          },
        }),
      );
    });
  });

  const port = await listen(server);
  try {
    const binDir = await createIterativeFixtureUv(root, callsLog);
    process.env.PATH = `${binDir}${delimiter}${priorPath}`;
    process.env.PERFDIGEST_CLEF_URL = `http://127.0.0.1:${port}/v1/systemone`;

    // Report with 5 kernels where top-3 are utility kernels and indices 3, 4 are v1_coalesced and v0_naive
    const ptxasData = {
      units: [
        { index: 0, name: '/private/path/checksum_kernel', duration_us: null, domain: 'kernel_codegen', metrics: { registers_per_thread: 14, static_smem_bytes: 0 } },
        { index: 1, name: 'compare_kernel', duration_us: null, domain: 'kernel_codegen', metrics: { registers_per_thread: 8, static_smem_bytes: 0 } },
        { index: 2, name: 'spot_check_kernel', duration_us: null, domain: 'kernel_codegen', metrics: { registers_per_thread: 18, static_smem_bytes: 0 } },
        { index: 3, name: 'kernel_v1_coalesced', duration_us: null, domain: 'kernel_codegen', metrics: { registers_per_thread: 26, static_smem_bytes: 4224 } },
        { index: 4, name: 'kernel_v0_naive', duration_us: null, domain: 'kernel_codegen', metrics: { registers_per_thread: 14, static_smem_bytes: 0 } },
      ],
    };
    await writeFile(join(root, 'ptxas.json'), JSON.stringify(ptxasData));
    await writeFile(
      join(root, 'baseline.json'),
      JSON.stringify({
        units: [{ index: 0, name: 'checksum_kernel', duration_us: null, domain: 'kernel_codegen', metrics: { registers_per_thread: 12, static_smem_bytes: 0 } }],
      }),
    );

    const reports: ReportSpec[] = [
      { id: 'ptxas-main', path: 'ptxas.json', format: 'ptxas-verbose', description: 'Primary ptxas output' },
      { id: 'ptxas-base', path: 'baseline.json', format: 'ptxas-verbose', description: 'Baseline ptxas output' },
    ];

    const tsPacket = await gatherEvidence({
      workspace: root,
      issue: 'Compare register pressure and shared memory between kernel_v0_naive and kernel_v1_coalesced',
      reports,
      routing: 'local',
      maxSteps: 4,
    });

    assert.equal(tsPacket.status, 'complete');
    assert.equal(tsPacket.decision.selectedId, 'ptxas-main');
    assert.equal(tsPacket.decision.requests, 4, 'Expected 4 decision steps: select -> list_kernels -> compare_units -> stop_sufficient');
    assert.equal(tsPacket.decision.inputTokens, 200);
    assert.equal(tsPacket.decision.outputTokens, 20);
    assert.equal(tsPacket.extractions?.length, 2);
    assert.equal(tsPacket.extractions?.[0]?.tool, 'list_kernels');
    assert.equal(tsPacket.extractions?.[1]?.tool, 'compare_metrics');
    assert.equal(tsPacket.extractions?.[1]?.unit, '4');
    assert.equal(tsPacket.extractions?.[1]?.secondaryUnit, '3');
    assert.equal(tsPacket.steps?.length, 4);
    assert.equal(tsPacket.steps?.[0]?.layer, 'report_orientation');
    assert.equal(tsPacket.steps?.[1]?.layer, 'unit_discovery');
    assert.equal(tsPacket.steps?.[2]?.layer, 'deep_extraction');
    assert.equal(tsPacket.steps?.[3]?.layer, 'stopping');
    assert.equal(tsPacket.steps?.[3]?.reason, 'sufficient');

    // Verify no local paths (/private/path) leaked into decision states or extraction records
    for (const st of stepStates) {
      assert.equal(JSON.stringify(st).includes('/private/path'), false, 'Local path must be stripped from decision state');
    }
    assert.equal(JSON.stringify(tsPacket.extractions).includes(root), false, 'Workspace path must be stripped from extractions');

    // Verify compact agent formatting includes the iterative extractions
    const compactJson = JSON.parse(formatAgentEvidence(tsPacket, null, 'complete', true));
    assert.equal(compactJson.extractions.length, 2);
    assert.equal(compactJson.selected[0].extractions.length, 2);
    assert.deepEqual(compactJson.extractions[1].data.metrics.static_smem_bytes, {
      a: 0,
      b: 4224,
      delta: 4224,
      delta_pct: 'undefined_baseline_is_zero',
    });

    // Now run the production Go binary on the exact same manifest and verify parity
    const manifestPath = join(root, 'manifest.json');
    const manifestRaw = {
      version: 1,
      issue: 'Compare register pressure and shared memory between kernel_v0_naive and kernel_v1_coalesced',
      captures: [],
      reports,
      verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    };
    await writeFile(manifestPath, JSON.stringify(manifestSchema.parse(manifestRaw)));

    const { stdout: goStdout } = await execFileAsync(goBinary, [
      'run',
      manifestPath,
      '--workspace',
      root,
      '--routing',
      'local',
      '--agent',
      'none',
    ]);
    const goSummary = JSON.parse(goStdout);
    const goRun = JSON.parse(await readFile(join(goSummary.directory, 'run.json'), 'utf8'));

    assert.equal(goRun.status, 'complete');
    assert.equal(goRun.evidence.decision.requests, tsPacket.decision.requests);
    assert.deepEqual(goRun.evidence.extractions, tsPacket.extractions);
    assert.equal(goRun.evidence.steps.length, tsPacket.steps?.length);
  } finally {
    process.env.PATH = priorPath;
    if (priorClefUrl === undefined) delete process.env.PERFDIGEST_CLEF_URL;
    else process.env.PERFDIGEST_CLEF_URL = priorClefUrl;
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('cross-report compare_metrics automatically retains the secondary report in corroborating and detects mid-extraction file mutation', async () => {
  const root = await testDirectory('iterative-corroborating-and-mutation');
  const priorPath = process.env.PATH;
  const priorClefUrl = process.env.PERFDIGEST_CLEF_URL;
  const callsLog = join(root, 'mcp-calls.jsonl');

  let mutateMode = false;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const state = JSON.parse(parsed.state);
      const stepNum = (state.step as number | undefined) ?? 1;
      const keys = Object.keys(parsed.questions.next_evidence.criteria as Record<string, string>);
      let choiceKey: string;
      if (stepNum === 1) {
        choiceKey = 'cold';
      } else if (stepNum === 2) {
        choiceKey = keys.find(k => (mutateMode ? k.startsWith('get_metrics:') || k.startsWith('list_kernels:') : k.startsWith('compare_reports:cold:warm'))) ?? keys[0]!;
      } else if (stepNum === 3 && mutateMode) {
        choiceKey = keys.find(k => k.startsWith('get_metrics:')) ?? keys[0]!;
      } else {
        choiceKey = 'stop_sufficient';
      }
      const conf = 0.9;
      const others = keys.filter(k => k !== choiceKey);
      const probs: Record<string, number> = { [choiceKey]: conf };
      let allocated = conf;
      others.forEach((k, idx) => {
        if (idx === others.length - 1) probs[k] = Number((1 - allocated).toFixed(4));
        else {
          const share = Number(((1 - conf) / others.length).toFixed(4));
          probs[k] = share;
          allocated += share;
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'clef-flash',
          usage: { input_tokens: 20, output_tokens: 2 },
          answers: { next_evidence: { type: 'choice', choice: choiceKey, confidence: conf, probabilities: probs } },
        }),
      );
    });
  });

  const port = await listen(server);
  try {
    const binDir = await createIterativeFixtureUv(root, callsLog);
    process.env.PATH = `${binDir}${delimiter}${priorPath}`;
    process.env.PERFDIGEST_CLEF_URL = `http://127.0.0.1:${port}/v1/systemone`;

    await writeFile(
      join(root, 'cold.json'),
      JSON.stringify({
        units: [
          { index: 0, name: 'configure', duration_us: 390000, domain: 'build_phase', metrics: { total_time_us: 390000 } },
          { index: 1, name: 'generate', duration_us: 12000, domain: 'build_phase', metrics: { total_time_us: 12000 } },
          { index: 2, name: 'finalize', duration_us: 4000, domain: 'build_phase', metrics: { total_time_us: 4000 } },
          { index: 3, name: 'hidden_step', duration_us: 1000, domain: 'build_phase', metrics: { total_time_us: 1000 } },
        ],
      }),
    );
    await writeFile(
      join(root, 'warm.json'),
      JSON.stringify({
        units: [{ index: 0, name: 'configure', duration_us: 14000, domain: 'build_phase', metrics: { total_time_us: 14000 } }],
      }),
    );

    const reports: ReportSpec[] = [
      { id: 'cold', path: 'cold.json', format: 'cmake-profile', description: 'Cold CMake configure' },
      { id: 'warm', path: 'warm.json', format: 'cmake-profile', description: 'Warm CMake configure' },
    ];

    const packet = await gatherEvidence({
      workspace: root,
      issue: 'Compare cold vs warm CMake configure',
      reports,
      routing: 'local',
      includeCorroborating: false,
    });

    assert.equal(packet.status, 'complete');
    assert.equal(packet.corroborating?.length, 1, 'Secondary report touched by compare_metrics must be retained in corroborating');
    assert.equal(packet.corroborating?.[0]?.report.id, 'warm');
    assert.deepEqual(packet.decision.complementaryIds, ['warm']);

    // Now test tamper detection when a report changes during get_metrics extraction
    mutateMode = true;
    await writeFile(
      join(root, 'cold.json'),
      JSON.stringify({
        mutateOnGetMetrics: true,
        units: [
          { index: 0, name: 'configure', duration_us: 390000, domain: 'build_phase', metrics: { total_time_us: 390000 } },
          { index: 1, name: 'generate', duration_us: 12000, domain: 'build_phase', metrics: { total_time_us: 12000 } },
          { index: 2, name: 'finalize', duration_us: 4000, domain: 'build_phase', metrics: { total_time_us: 4000 } },
          { index: 3, name: 'hidden_step', duration_us: 1000, domain: 'build_phase', metrics: { total_time_us: 1000 } },
        ],
      }),
    );

    await assert.rejects(
      gatherEvidence({
        workspace: root,
        issue: 'Tamper detection during iterative extraction',
        reports,
        routing: 'local',
      }),
      /changed while (extracting metrics|routing)/,
    );
  } finally {
    process.env.PATH = priorPath;
    if (priorClefUrl === undefined) delete process.env.PERFDIGEST_CLEF_URL;
    else process.env.PERFDIGEST_CLEF_URL = priorClefUrl;
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});
