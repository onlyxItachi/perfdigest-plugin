#!/usr/bin/env node
// PROTOTYPE counterpart of go-worker/main.go — same manifest, same receipt shape,
// same semantics (argv spawn without a shell, allowlisted env, sequential SHA-256).
// Used only to compare subprocess + hashing overhead; not part of the plugin.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

const ms = (t) => Math.round((performance.now() - t) * 1000) / 1000;

function runOne(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256'); let bytes = 0;
    createReadStream(path).on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); })
      .once('error', reject).once('end', () => resolve({ path, sha256: hash.digest('hex'), bytes }));
  });
}

const start = performance.now();
if (process.argv.length !== 3) { console.error('usage: node-worker.mjs MANIFEST.json'); process.exit(1); }
const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (manifest.version !== 1) throw new Error(`unsupported manifest version ${manifest.version}`);
const env = Object.fromEntries((manifest.envAllowlist ?? []).filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const receipt = { schema: 'perfdigest.worker-receipt.v0-prototype', worker: 'node', commands: [], reports: [], totalMs: 0 };
for (const { command, args = [] } of manifest.commands) {
  const t = performance.now();
  const exitCode = await runOne(command, args, env);
  receipt.commands.push({ argv: [command, ...args], exitCode, elapsedMs: ms(t) });
}
for (const path of manifest.reports) receipt.reports.push(await hashFile(path));
receipt.totalMs = ms(start);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
