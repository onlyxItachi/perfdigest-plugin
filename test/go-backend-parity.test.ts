import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const goBinary = join(repoRoot, 'dist/perfdigest-plugin');
const zeroCostMcp = join(repoRoot, 'bench/probes/zero-cost-mcp.mjs');

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolvePort((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

test('Go binary init contract parity: offline, local endpoint, and external env-file boundaries', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'pd-go-init-'));
  const workspace = join(scratch, 'ws');
  await mkdir(workspace, { recursive: true });

  try {
    // 1. Offline init
    await execFileAsync(goBinary, ['init', '--workspace', workspace, '--provider', 'offline', '--yes']);
    const cfgOffline = JSON.parse(await readFile(join(workspace, '.perfdigest/config.json'), 'utf8'));
    assert.equal(cfgOffline.version, 1);
    assert.equal(cfgOffline.provider, 'offline');

    // 2. Reject env-file inside workspace
    const insideEnv = join(workspace, 'bad.env');
    await writeFile(insideEnv, 'PERFDIGEST_CLOUDFLARE_API_TOKEN=secret\n', { mode: 0o600 });
    await assert.rejects(
      execFileAsync(goBinary, ['init', '--workspace', workspace, '--provider', 'cloudflare', '--env-file', insideEnv, '--yes']),
      /outside the investigated workspace/,
    );

    // 3. Accept private 0600 env-file outside workspace & repo
    const outsideEnv = join(scratch, 'external.env');
    await writeFile(
      outsideEnv,
      'PERFDIGEST_CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef\nPERFDIGEST_CLOUDFLARE_API_TOKEN=cf-test-token-value\n',
      { mode: 0o600 },
    );
    await chmod(outsideEnv, 0o600);
    await execFileAsync(goBinary, [
      'init',
      '--workspace', workspace,
      '--provider', 'cloudflare',
      '--env-file', outsideEnv,
      '--decision-model', 'clef-flash',
      '--yes',
    ]);
    const cfgCf = JSON.parse(await readFile(join(workspace, '.perfdigest/config.json'), 'utf8'));
    assert.equal(cfgCf.provider, 'cloudflare');
    assert.equal(cfgCf.decisionModel, 'clef-flash');
    assert.ok(cfgCf.envFile.endsWith('external.env'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('Go binary run contract parity with loopback SystemOne HTTP: accepted, abstained, rejected, failed', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pd-go-sysone-'));
  let confidence = 0.65;
  let model = '@cf/cloudflare/clef-flash';
  let statusCode = 200;

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url !== '/v1/systemone') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (statusCode !== 200) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'simulated upstream failure' }));
      return;
    }
    const rem = Number(((1 - confidence) / 2).toFixed(4));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model,
        usage: { input_tokens: 42, output_tokens: 8 },
        answers: {
          next_evidence: {
            type: 'choice',
            choice: 'r2',
            confidence,
            probabilities: { r1: rem, r2: confidence, __human_review__: Number((1 - confidence - rem).toFixed(4)) },
          },
        },
      }),
    );
  });

  const port = await listen(server);
  try {
    await writeFile(join(workspace, 'r1.json'), JSON.stringify({ traceEvents: [{ name: 'k1', dur: 100 }] }));
    await writeFile(join(workspace, 'r2.json'), JSON.stringify({ traceEvents: [{ name: 'k2', dur: 250 }] }));
    const manifestPath = join(workspace, 'manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        issue: 'Investigate CUDA kernel latency regression',
        captures: [],
        reports: [
          { id: 'r1', path: 'r1.json', format: 'chrome-trace', description: 'baseline trace' },
          { id: 'r2', path: 'r2.json', format: 'chrome-trace', description: 'candidate trace' },
        ],
        verification: { command: '/bin/true', args: [] },
      }),
    );

    const env = { ...process.env, PERFDIGEST_CLEF_URL: `http://127.0.0.1:${port}/v1/systemone` };
    const commonArgs = [
      'run',
      manifestPath,
      '--workspace', workspace,
      '--routing', 'local',
      '--agent', 'none',
      '--mcp-command', process.execPath,
      '--mcp-arg', zeroCostMcp,
    ];

    // 1. Accepted at exact 0.65 boundary
    const { stdout: out1 } = await execFileAsync(goBinary, commonArgs, { env });
    const summary1 = JSON.parse(out1);
    assert.equal(summary1.status, 'complete');
    assert.equal(summary1.decisionOutcome, 'accepted');
    const run1 = JSON.parse(await readFile(join(summary1.directory, 'run.json'), 'utf8'));
    assert.equal(run1.evidence.decision.selectedId, 'r2');
    assert.equal(run1.provenance.length, 2);

    // 2. Abstained at 0.6468 (< 0.65) with retained hash-checked provenance
    confidence = 0.6468;
    const res2 = await execFileAsync(goBinary, commonArgs, { env }).catch((e) => e);
    const summary2 = JSON.parse(res2.stdout);
    assert.equal(summary2.status, 'needs_review');
    assert.equal(summary2.decisionOutcome, 'abstained');
    const run2 = JSON.parse(await readFile(join(summary2.directory, 'run.json'), 'utf8'));
    assert.equal(run2.provenance.length, 2);

    // 3. Rejected on unexpected model identity
    confidence = 0.85;
    model = 'wrong-model-id';
    const res3 = await execFileAsync(goBinary, commonArgs, { env }).catch((e) => e);
    const summary3 = JSON.parse(res3.stdout);
    assert.equal(summary3.status, 'failed');
    assert.equal(summary3.decisionOutcome, 'rejected');
    const run3 = JSON.parse(await readFile(join(summary3.directory, 'run.json'), 'utf8'));
    assert.equal(run3.provenance.length, 2);

    // 4. Failed on HTTP 500
    model = '@cf/cloudflare/clef-flash';
    statusCode = 500;
    const res4 = await execFileAsync(goBinary, commonArgs, { env }).catch((e) => e);
    const summary4 = JSON.parse(res4.stdout);
    assert.equal(summary4.status, 'failed');
    assert.equal(summary4.decisionOutcome, 'failed');
    const run4 = JSON.parse(await readFile(join(summary4.directory, 'run.json'), 'utf8'));
    assert.equal(run4.provenance.length, 2);
  } finally {
    await closeServer(server);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Go binary run contract parity with loopback OpenAI --decisions-mock-url and generic CLI agent', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pd-go-openai-agent-'));
  const server = createServer((req, res) => {
    if (req.url !== '/v1/decisions' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'gpt-6-luna',
        usage: { input_tokens: 30, output_tokens: 6, cost_usd: 0.00012 },
        answers: [
          {
            name: 'next_evidence',
            type: 'choice',
            choice: 'r1',
            confidence: 0.91,
            probabilities: [
              { value: 'r1', probability: 0.91 },
              { value: '__human_review__', probability: 0.09 },
            ],
          },
        ],
      }),
    );
  });

  const port = await listen(server);
  try {
    await writeFile(join(workspace, 'r1.json'), JSON.stringify({ traceEvents: [{ name: 'k1', dur: 100 }] }));
    const agentScript = join(workspace, 'mock-agent.mjs');
    await writeFile(
      agentScript,
      `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const sid = req.sessionId ?? 'sess-go-parity-1';
  process.stdout.write(JSON.stringify({ type: 'started', sessionId: sid }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    sessionId: sid,
    text: 'Completed phase ' + req.phase,
    usage: { input_tokens: 15, output_tokens: 5 }
  }) + '\\n');
});
`,
      { mode: 0o700 },
    );
    await chmod(agentScript, 0o700);

    const manifestPath = join(workspace, 'manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        issue: 'Verify OpenAI mock routing and generic CLI agent two-turn session continuation',
        captures: [],
        reports: [{ id: 'r1', path: 'r1.json', format: 'chrome-trace', description: 'trace 1' }],
        verification: { command: '/bin/true', args: [] },
      }),
    );

    const { stdout } = await execFileAsync(goBinary, [
      'run',
      manifestPath,
      '--workspace', workspace,
      '--routing', 'openai',
      '--decisions-mock-url', `http://127.0.0.1:${port}/v1`,
      '--agent', 'generic',
      '--agent-command', agentScript,
      '--agent-sessions',
      '--mcp-command', process.execPath,
      '--mcp-arg', zeroCostMcp,
    ]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.status, 'complete');
    assert.equal(summary.decisionOutcome, 'accepted');
    assert.equal(summary.provider, 'openai');
    const runJson = JSON.parse(await readFile(join(summary.directory, 'run.json'), 'utf8'));
    assert.equal(runJson.analysis.threadId, 'sess-go-parity-1');
    assert.equal(runJson.review.threadId, 'sess-go-parity-1');
    assert.equal(runJson.telemetry.evidenceDelivery, 'same_session_next_turn');

    // Also verify single_turn delivery and stateless generic CLI agent
    const { stdout: singleOut } = await execFileAsync(goBinary, [
      'run',
      manifestPath,
      '--workspace', workspace,
      '--routing', 'openai',
      '--decisions-mock-url', `http://127.0.0.1:${port}/v1`,
      '--agent', 'generic',
      '--agent-command', agentScript,
      '--agent-delivery', 'single_turn',
      '--mcp-command', process.execPath,
      '--mcp-arg', zeroCostMcp,
    ]);
    const singleSummary = JSON.parse(singleOut);
    assert.equal(singleSummary.status, 'complete');
    const singleRun = JSON.parse(await readFile(join(singleSummary.directory, 'run.json'), 'utf8'));
    assert.equal(singleRun.analysis, null);
    assert.equal(singleRun.review.text, 'Completed phase review');
    assert.equal(singleRun.telemetry.evidenceDelivery, 'single_turn_with_evidence');

    // Verify demo command with --mcp-command override
    const { stdout: demoOut } = await execFileAsync(goBinary, [
      'demo',
      '--workspace', workspace,
      '--routing', 'offline',
      '--agent', 'none',
      '--mcp-command', process.execPath,
      '--mcp-arg', zeroCostMcp,
    ]);
    const demoSummary = JSON.parse(demoOut);
    assert.equal(demoSummary.status, 'complete');
    assert.equal(demoSummary.decisionOutcome, 'accepted');
    assert.equal(demoSummary.provider, 'offline');
    assert.equal(demoSummary.verification, 0);
  } finally {
    await closeServer(server);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Go binary mcp stdio server contract parity via official MCP SDK client', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pd-go-mcp-'));
  try {
    await writeFile(join(workspace, 'r1.json'), JSON.stringify({ traceEvents: [{ name: 'k1', dur: 100 }] }));
    const client = new Client({ name: 'go-parity-test', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: goBinary,
      args: [
        'mcp',
        '--workspace', workspace,
        '--mcp-command', process.execPath,
        '--mcp-arg', zeroCostMcp,
      ],
      cwd: workspace,
      stderr: 'pipe',
    });

    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ['cancel_evidence_job', 'get_evidence_job', 'launch_evidence_prefetch'],
      );

      // Duplicate report IDs rejected
      const dupRes = await client.callTool({
        name: 'launch_evidence_prefetch',
        arguments: {
          issue: 'duplicate test',
          reports: [
            { id: 'dup', path: 'r1.json', format: 'chrome-trace', description: 'a' },
            { id: 'dup', path: 'r1.json', format: 'chrome-trace', description: 'b' },
          ],
          mode: 'offline',
        },
      });
      assert.equal(dupRes.isError, true);

      // Launch valid job and consume once
      const launchRes = await client.callTool({
        name: 'launch_evidence_prefetch',
        arguments: {
          issue: 'valid offline prefetch',
          reports: [{ id: 'r1', path: 'r1.json', format: 'chrome-trace', description: 'trace 1' }],
          mode: 'offline',
        },
      });
      const launchData = launchRes.structuredContent as { jobId: string; status: string };
      assert.equal(launchData.status, 'running');

      const poll1 = await client.callTool({
        name: 'get_evidence_job',
        arguments: { jobId: launchData.jobId, waitMs: 5000 },
      });
      const poll1Data = poll1.structuredContent as { status: string; packet?: { status: string } };
      assert.equal(poll1Data.status, 'complete');
      assert.equal(poll1Data.packet?.status, 'complete');

      const poll2 = await client.callTool({
        name: 'get_evidence_job',
        arguments: { jobId: launchData.jobId },
      });
      const poll2Data = poll2.structuredContent as { status: string };
      assert.equal(poll2Data.status, 'not_found');
    } finally {
      await client.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
