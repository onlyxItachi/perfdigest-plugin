#!/usr/bin/env node
// Probe driver for Table B & Table B2: runs investigate() under node/bun/deno with either
// the zero-cost local MCP responder (Table B) or real uvx perfdigest-mcp + loopback SystemOne HTTP (Table B2).
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { investigate } from '../../dist/run.js';
import { createDecisionProvider } from '../../dist/providers.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    workspace: '',
    manifest: '',
    mcpCommand: '',
    mcpArgs: [],
    mcpServer: '',
    liveMcp: false,
    systemOneUrl: '',
    reuse: true,
    lifecycle: 'one_shot',
    runs: 1,
    warmup: 0,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace' && i + 1 < args.length) opts.workspace = args[++i];
    else if (a === '--manifest' && i + 1 < args.length) opts.manifest = args[++i];
    else if (a === '--mcp-command' && i + 1 < args.length) opts.mcpCommand = args[++i];
    else if (a === '--mcp-arg' && i + 1 < args.length) opts.mcpArgs.push(args[++i]);
    else if (a === '--mcp-server' && i + 1 < args.length) opts.mcpServer = args[++i];
    else if (a === '--live-mcp') opts.liveMcp = true;
    else if (a === '--systemone-url' && i + 1 < args.length) opts.systemOneUrl = args[++i];
    else if (a === '--reuse' && i + 1 < args.length) opts.reuse = args[++i] === 'true';
    else if (a === '--lifecycle' && i + 1 < args.length) opts.lifecycle = args[++i];
    else if (a === '--runs' && i + 1 < args.length) opts.runs = parseInt(args[++i], 10);
    else if (a === '--warmup' && i + 1 < args.length) opts.warmup = parseInt(args[++i], 10);
  }
  return opts;
}

const opts = parseArgs();
const manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));

const mockProvider = {
  name: 'cloudflare',
  async select(issue, reports) {
    return {
      selectedId: reports[0]?.id ?? null,
      confidence: 0.95,
      reason: 'zero-latency local mock decision',
      source: 'clef_cloudflare',
      provider: 'cloudflare',
      model: 'perfdigest/clef-flash-v1',
      confidenceSemantics: 'systemone_uniform_zero',
      transport: 'local_mock',
      requests: 1,
      latencyMs: 0.05,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: null,
    };
  },
};

let routing = 'cloudflare';
let decisionProvider = mockProvider;
if (opts.systemOneUrl) {
  process.env.PERFDIGEST_CLEF_URL = opts.systemOneUrl;
  routing = 'local';
  decisionProvider = createDecisionProvider('local');
}

const mcpSessionOptions = opts.liveMcp
  ? undefined
  : {
      command: opts.mcpCommand || process.execPath,
      args: [
        ...opts.mcpArgs,
        ...(opts.mcpServer ? [opts.mcpServer] : []),
      ],
      connectTimeoutMs: 10_000,
      callTimeoutMs: 10_000,
    };

async function runOnce() {
  const t0 = performance.now();
  const res = await investigate({
    workspace: opts.workspace,
    manifest,
    routing,
    agent: 'none',
    decisionProvider,
    ...(mcpSessionOptions ? { mcpSessionOptions } : {}),
    reuseMcpSession: opts.reuse,
  });
  const elapsedMs = performance.now() - t0;
  return { res, elapsedMs };
}

if (opts.lifecycle === 'one_shot') {
  const { res, elapsedMs } = await runOnce();
  const pass = res.status === 'complete' && res.verification?.exitCode === 0;
  const out = {
    ok: pass,
    elapsedMs,
    status: res.status,
    decisionOutcome: res.decisionOutcome,
    verificationExitCode: res.verification?.exitCode,
    provenance: res.provenance.map((p) => ({ id: p.id, sha256: p.sha256, bytes: p.bytes })),
  };
  process.stdout.write(JSON.stringify(out) + '\n');
} else {
  for (let i = 0; i < opts.warmup; i++) {
    await runOnce();
  }
  const samplesMs = [];
  let lastRes = null;
  for (let i = 0; i < opts.runs; i++) {
    const { res, elapsedMs } = await runOnce();
    samplesMs.push(elapsedMs);
    lastRes = res;
  }
  const pass = lastRes && lastRes.status === 'complete' && lastRes.verification?.exitCode === 0;
  const out = {
    ok: pass,
    samplesMs,
    status: lastRes?.status,
    decisionOutcome: lastRes?.decisionOutcome,
    verificationExitCode: lastRes?.verification?.exitCode,
    provenance: lastRes?.provenance.map((p) => ({ id: p.id, sha256: p.sha256, bytes: p.bytes })),
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}
