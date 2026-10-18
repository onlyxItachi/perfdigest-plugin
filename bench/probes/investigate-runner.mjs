#!/usr/bin/env node
// Probe driver for Table B: runs investigate() under node/bun/deno with a zero-cost local MCP responder.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { investigate } from '../../dist/run.js';

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, '../..');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    workspace: '',
    manifest: '',
    mcpServer: '',
    reuse: true,
    lifecycle: 'one_shot',
    runs: 1,
    warmup: 0,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace' && i + 1 < args.length) opts.workspace = args[++i];
    else if (a === '--manifest' && i + 1 < args.length) opts.manifest = args[++i];
    else if (a === '--mcp-server' && i + 1 < args.length) opts.mcpServer = args[++i];
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

const mcpSessionOptions = {
  command: process.execPath,
  args: [opts.mcpServer],
  connectTimeoutMs: 10_000,
  callTimeoutMs: 10_000,
};

async function runOnce() {
  const t0 = performance.now();
  const res = await investigate({
    workspace: opts.workspace,
    manifest,
    routing: 'cloudflare',
    agent: 'none',
    decisionProvider: mockProvider,
    mcpSessionOptions,
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
    verificationExitCode: res.verification?.exitCode,
    provenance: res.provenance.map((p) => ({ id: p.id, sha256: p.sha256, bytes: p.bytes })),
  };
  process.stdout.write(JSON.stringify(out) + '\n');
} else {
  // Persistent lifecycle: warm up, then measure N iterations
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
    verificationExitCode: lastRes?.verification?.exitCode,
    provenance: lastRes?.provenance.map((p) => ({ id: p.id, sha256: p.sha256, bytes: p.bytes })),
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}
