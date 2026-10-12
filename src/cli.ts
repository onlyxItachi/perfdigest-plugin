#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { manifestSchema } from './config.js';
import { investigate } from './run.js';
import { demoManifest } from './demo.js';
import { redact } from './environment.js';

const help = `PerfDigest Evidence — Codex-first MVP

  perfdigest-plugin demo [--agent none|codex] [--routing offline|decisions] [--perf]
  perfdigest-plugin run manifest.json [--workspace PATH] [--routing decisions|offline] [--agent codex|none]
  perfdigest-plugin mcp [--workspace PATH]

Demo defaults: real local CPU measurements + verification, offline routing, no model calls.
Run defaults: existing Codex ChatGPT login + live Decisions (PERFDIGEST_DECISIONS_API_KEY).
Use --agent codex to demonstrate overlap with a real Codex session.
--perf adds Linux hardware counters; otherwise the demo uses genuine elapsed-time traces.
Raw reports, command receipts and timeline are saved under .perfdigest/runs/.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, workspace: { type: 'string' },
    agent: { type: 'string' }, routing: { type: 'string' }, model: { type: 'string' }, perf: { type: 'boolean' },
  } });
  if (values.help || !positionals[0]) { console.log(help); return; }
  const workspace = await realpath(values.workspace ?? process.cwd());
  const command = positionals[0];
  if (command === 'mcp') {
    const { serve } = await import('./server.js');
    await serve(workspace); return;
  }
  if (command !== 'demo' && command !== 'run') throw new Error('Unknown command; use --help');
  const routing = values.routing ?? (command === 'demo' ? 'offline' : 'decisions');
  const agent = values.agent ?? (command === 'demo' ? 'none' : 'codex');
  if (routing !== 'offline' && routing !== 'decisions') throw new Error('--routing must be offline or decisions');
  if (agent !== 'none' && agent !== 'codex') throw new Error('--agent must be none or codex');
  if (routing === 'decisions' && !process.env.PERFDIGEST_DECISIONS_API_KEY) throw new Error('Missing PERFDIGEST_DECISIONS_API_KEY; no live call started.');
  if (command === 'run' && !positionals[1]) throw new Error('run requires a manifest path');
  const manifest = command === 'demo' ? await demoManifest(workspace, values.perf)
    : manifestSchema.parse(JSON.parse(await readFile(resolve(positionals[1]!), 'utf8')));
  const abort = new AbortController();
  const onSignal = () => abort.abort(new Error('Interrupted'));
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const result = await investigate({ workspace, manifest, routing, agent, signal: abort.signal,
      ...(values.model ? { model: values.model } : {}),
      onEvent: (event, detail) => process.stderr.write(`${event}${detail ? `: ${redact(detail)}` : ''}\n`),
    });
    console.log(JSON.stringify({ status: result.status, agent, routing, directory: result.directory,
      verification: result.verification?.exitCode ?? null, telemetry: result.telemetry }, null, 2));
    if (result.status !== 'complete') process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}

main().catch(error => { console.error(redact(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
