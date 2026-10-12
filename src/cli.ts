#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { manifestSchema, type RoutingMode } from './config.js';
import { investigate } from './run.js';
import { demoManifest } from './demo.js';
import { redact } from './environment.js';
import { DecisionsError } from './decisions.js';
import { createDecisionProvider, providerName } from './providers.js';

const help = `PerfDigest Evidence — Codex-first MVP

  perfdigest-plugin demo [--agent none|codex] [--routing offline|decisions] [--perf]
  perfdigest-plugin run manifest.json [--workspace PATH] [--routing decisions|offline] [--agent codex|none]
  perfdigest-plugin mcp [--workspace PATH]

Demo defaults: real local CPU measurements + verification, offline routing, no model calls.
Run defaults: existing Codex ChatGPT login + live Decisions (PERFDIGEST_DECISIONS_API_KEY).
Use --agent codex to demonstrate overlap with a real Codex session.
--perf adds Linux hardware counters; otherwise the demo uses genuine elapsed-time traces.
Raw reports, command receipts and timeline are saved under .perfdigest/runs/.
--provider cloudflare|local|openai|offline explicitly selects inference; --routing keeps legacy aliases.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, workspace: { type: 'string' },
    agent: { type: 'string' }, routing: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, perf: { type: 'boolean' },
  } });
  if (values.help || !positionals[0]) { console.log(help); return; }
  const workspace = await realpath(values.workspace ?? process.cwd());
  const command = positionals[0];
  if (command === 'mcp') {
    const { serve } = await import('./server.js');
    await serve(workspace); return;
  }
  if (command !== 'demo' && command !== 'run') throw new Error('Unknown command; use --help');
  const accepted = ['offline', 'cloudflare', 'local', 'openai', 'decisions', 'clef-local', 'clef-cloudflare', 'openai-luna'];
  const selected = values.provider ?? values.routing ?? (command === 'demo' ? 'offline' : 'decisions');
  if (!accepted.includes(selected)) throw new Error('Unknown provider; use cloudflare, local, openai or offline');
  const routing = selected as RoutingMode;
  if (values.provider && values.routing && (!accepted.includes(values.routing)
      || providerName(values.routing as RoutingMode) !== providerName(routing))) throw new Error('--provider and --routing conflict');
  const agent = values.agent ?? (command === 'demo' ? 'none' : 'codex');
  if (agent !== 'none' && agent !== 'codex') throw new Error('--agent must be none or codex');
  createDecisionProvider(routing); // Preflight credentials before creating/capturing a demo.
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
    console.log(JSON.stringify({ status: result.status, agent, routing, provider: providerName(routing), directory: result.directory,
      verification: result.verification?.exitCode ?? null, decisionsError: result.decisionsError, telemetry: result.telemetry }, null, 2));
    if (result.status !== 'complete') process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}

main().catch(error => {
  console.error(error instanceof DecisionsError ? JSON.stringify(error.toJSON()) : redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
