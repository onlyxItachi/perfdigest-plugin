#!/usr/bin/env node
// PROTOTYPE counterpart of go-worker/main.go — same manifest, same receipt shape,
// same semantics (argv spawn without a shell, allowlisted env, streaming SHA-256 for >64KB).
// Supports one-shot CLI execution and persistent stdio loop via --serve.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import readline from 'node:readline';

const ms = (t) => Math.round((performance.now() - t) * 1000) / 1000;

function runOne(command, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

async function hashFile(p) {
  const meta = await stat(p);
  const size = meta.size;
  if (size <= 64 * 1024) {
    const buf = await readFile(p);
    return { path: p, sha256: createHash('sha256').update(buf).digest('hex'), bytes: size };
  }
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    createReadStream(p, { highWaterMark: 64 * 1024 })
      .on('data', (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
      })
      .once('error', reject)
      .once('end', () => resolve({ path: p, sha256: hash.digest('hex'), bytes }));
  });
}

const workerBackend = process.versions.bun ? 'bun' : (process.versions.deno || globalThis.Deno) ? 'deno' : 'node';

async function executeJob(req) {
  const start = performance.now();
  const manifest = JSON.parse(await readFile(req.manifest, 'utf8'));
  if (manifest.version !== 1) throw new Error(`unsupported manifest version ${manifest.version}`);
  const env = Object.fromEntries(
    (manifest.envAllowlist ?? []).filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])
  );
  const receipt = {
    schema: 'perfdigest.worker-receipt.v0-prototype',
    worker: workerBackend,
    commands: [],
    reports: [],
    totalMs: 0,
  };
  for (const { command, args = [] } of manifest.commands ?? []) {
    const t = performance.now();
    const exitCode = await runOne(command, args, env, req.workspace || undefined);
    receipt.commands.push({ argv: [command, ...args], exitCode, elapsedMs: ms(t) });
  }
  for (const p of manifest.reports ?? []) {
    const rawPath = typeof p === 'string' ? p : p?.path ?? '';
    const reportPath = req.workspace && !isAbsolute(rawPath) ? join(req.workspace, rawPath) : rawPath;
    receipt.reports.push(await hashFile(reportPath));
  }
  const elapsedUs = Math.round((performance.now() - start) * 1000);
  receipt.totalMs = ms(start);
  if (req.out) {
    await writeFile(req.out, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  }
  return { receipt, elapsedUs };
}

async function main() {
  const isServe = process.argv.includes('--serve');
  if (isServe) {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const req = JSON.parse(trimmed);
      const { receipt, elapsedUs } = await executeJob(req);
      const resp = { ok: true, elapsedUs, reports: receipt.reports.length, out: req.out ?? '' };
      process.stdout.write(JSON.stringify(resp) + '\n');
    }
    return;
  }

  let manifestPath = '';
  let workspace = '';
  let outPath = '';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--manifest' && i + 1 < args.length) {
      manifestPath = args[++i];
    } else if (arg === '--workspace' && i + 1 < args.length) {
      workspace = args[++i];
    } else if (arg === '--out' && i + 1 < args.length) {
      outPath = args[++i];
    } else if (!arg.startsWith('-') && !manifestPath) {
      manifestPath = arg;
    }
  }

  if (!manifestPath) {
    console.error('usage: node-worker.mjs [--serve] [--manifest <path>] [--workspace <dir>] [--out <file>] [MANIFEST.json]');
    process.exit(1);
  }

  const { receipt } = await executeJob({ manifest: manifestPath, workspace, out: outPath });
  process.stdout.write(JSON.stringify(receipt) + '\n');
}

await main();
