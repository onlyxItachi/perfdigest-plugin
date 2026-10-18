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
import { initConfiguration, loadConfiguration, applyConfigurationEnvironment } from './setup.js';
import { genericCliAdapter } from './agents.js';

const help = `PerfDigest Evidence — Codex-first MVP

  perfdigest-plugin init [--provider cloudflare|local|openai|offline --yes] [--env-file PATH] [--endpoint URL] [--decision-model clef-flash|clef|clef-omni] [--check-connection]
  perfdigest-plugin demo [--agent none|codex|generic] [--agent-command PATH] [--agent-sessions] [--routing offline|decisions] [--decision-model NAME] [--perf]
  perfdigest-plugin run manifest.json [--workspace PATH] [--routing decisions|offline] [--agent codex|none|generic] [--agent-command PATH] [--agent-sessions] [--decision-model NAME]
  perfdigest-plugin mcp [--workspace PATH]

Unconfigured demo defaults: real local CPU measurements + verification, offline routing, no model calls.
Unconfigured run defaults: existing Codex ChatGPT login + live Decisions (PERFDIGEST_DECISIONS_API_KEY).
Use --agent codex to demonstrate overlap with a real Codex session, or --agent generic --agent-command PATH for a JSONL CLI agent.
--perf adds Linux hardware counters; otherwise the demo uses genuine elapsed-time traces.
Raw reports, command receipts and timeline are saved under .perfdigest/runs/.
--provider cloudflare|local|openai|offline explicitly selects inference; --routing keeps legacy aliases.
--decision-model selects the Cloudflare Clef model (default clef-flash); it is refused for other providers.
init --check-connection opts in to one read-only Cloudflare check; inference and quota are not checked.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, workspace: { type: 'string' },
    agent: { type: 'string' }, 'agent-command': { type: 'string' }, 'agent-sessions': { type: 'boolean' },
    routing: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, perf: { type: 'boolean' },
    endpoint: { type: 'string' }, 'env-file': { type: 'string' }, 'decision-model': { type: 'string' }, yes: { type: 'boolean' }, 'check-connection': { type: 'boolean' },
  } });
  if (values.help || !positionals[0]) { console.log(help); return; }
  const workspace = await realpath(values.workspace ?? process.cwd());
  const command = positionals[0];
  if (command === 'init') {
    const result = await initConfiguration({ workspace, yes: values.yes ?? false, checkConnection: values['check-connection'] ?? false,
      ...(values.provider !== undefined ? { provider: values.provider } : {}),
      ...(values.endpoint !== undefined ? { endpoint: values.endpoint } : {}),
      ...(values['env-file'] !== undefined ? { envFile: values['env-file'] } : {}),
      ...(values['decision-model'] !== undefined ? { decisionModel: values['decision-model'] } : {}) });
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (values.yes !== undefined || values.endpoint !== undefined || values['env-file'] !== undefined || values['check-connection'] !== undefined) {
    throw new Error('--yes, --endpoint, --env-file and --check-connection belong to init; configure the workspace first');
  }
  if (!['demo', 'run', 'mcp'].includes(command)) throw new Error('Unknown command; use --help');
  const configured = await loadConfiguration(workspace);
  const accepted = ['offline', 'cloudflare', 'local', 'openai', 'decisions', 'clef-local', 'clef-cloudflare', 'openai-luna'];
  const selected = values.provider ?? values.routing ?? configured?.provider ?? (command === 'run' ? 'decisions' : 'offline');
  if (!accepted.includes(selected)) throw new Error('Unknown provider; use cloudflare, local, openai or offline');
  const routing = selected as RoutingMode;
  if (values.provider && values.routing && (!accepted.includes(values.routing)
      || providerName(values.routing as RoutingMode) !== providerName(routing))) throw new Error('--provider and --routing conflict');
  if (configured && providerName(routing) !== 'offline') await applyConfigurationEnvironment(configured, workspace);
  // Explicit flag first, then the saved Cloudflare model; neither is applied to another provider.
  const savedModel = configured?.provider === 'cloudflare' && providerName(routing) === 'cloudflare' ? configured.decisionModel : undefined;
  const cloudflareModel = values['decision-model'] ?? savedModel;
  const modelOption = cloudflareModel !== undefined ? { cloudflareModel } : {};
  if (command === 'mcp') {
    const { serve } = await import('./server.js');
    await serve(workspace, routing, modelOption); return;
  }
  const agent = values.agent ?? (command === 'demo' ? 'none' : 'codex');
  if (agent !== 'none' && agent !== 'codex' && agent !== 'generic') throw new Error('--agent must be none, codex or generic');
  if (agent !== 'generic' && (values['agent-command'] !== undefined || values['agent-sessions'] !== undefined)) {
    throw new Error('--agent-command and --agent-sessions require --agent generic');
  }
  if (agent === 'generic' && !values['agent-command']) {
    throw new Error('--agent generic requires --agent-command PATH');
  }
  const agentAdapter = agent === 'generic'
    ? genericCliAdapter({ command: values['agent-command']!, sessions: values['agent-sessions'] ?? false })
    : undefined;
  createDecisionProvider(routing, modelOption); // Preflight credentials and model before creating/capturing a demo.
  if (command === 'run' && !positionals[1]) throw new Error('run requires a manifest path');
  const manifest = command === 'demo' ? await demoManifest(workspace, values.perf)
    : manifestSchema.parse(JSON.parse(await readFile(resolve(positionals[1]!), 'utf8')));
  const abort = new AbortController();
  const onSignal = () => abort.abort(new Error('Interrupted'));
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const result = await investigate({ workspace, manifest, routing, agent, signal: abort.signal, ...modelOption,
      ...(agentAdapter ? { agentAdapter } : {}),
      ...(values.model ? { model: values.model } : {}),
      onEvent: (event, detail) => process.stderr.write(`${event}${detail ? `: ${redact(detail)}` : ''}\n`),
    });
    console.log(JSON.stringify({ status: result.status, decisionOutcome: result.decisionOutcome, agent, routing,
      provider: providerName(routing), directory: result.directory, verification: result.verification?.exitCode ?? null,
      decisionsError: result.decisionsError, agentError: result.agentError, telemetry: result.telemetry }, null, 2));
    if (result.status !== 'complete') process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}

main().catch(error => {
  console.error(error instanceof DecisionsError ? JSON.stringify(error.toJSON()) : redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
