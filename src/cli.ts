#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ModelReasoningEffort } from '@openai/codex-sdk';
import { manifestSchema, type AgentDeliveryMode, type RoutingMode } from './config.js';
import { investigate } from './run.js';
import { demoManifest } from './demo.js';
import { redact } from './environment.js';
import { DecisionsError } from './decisions.js';
import { createDecisionProvider, providerName } from './providers.js';
import { initConfiguration, loadConfiguration, applyConfigurationEnvironment } from './setup.js';
import { genericCliAdapter } from './agents.js';
import {
  cancelEvidenceWorker,
  collectEvidenceWorker,
  getEvidenceWorkerStatus,
  redactWorkerText,
  runDetachedEvidenceWorker,
  runEvidenceWorker,
  startEvidenceWorker,
  waitEvidenceWorker,
} from './evidence-worker.js';

const help = `PerfDigest Evidence — Codex-first MVP

  perfdigest-plugin init [--provider cloudflare|local|openai|offline --yes] [--env-file PATH] [--endpoint URL] [--decision-model clef-flash|clef|clef-omni] [--check-connection]
  perfdigest-plugin demo [--agent none|codex|generic] [--agent-command PATH] [--agent-sessions] [--agent-in-execution-async] [--agent-delivery auto|in_execution|single_turn|two_turn] [--codex-steering-mechanism turn_steer|tool_output] [--strict-delivery-mode] [--routing offline|decisions] [--decision-model NAME] [--model NAME] [--effort minimal|low|medium|high|xhigh|max] [--perf]
  perfdigest-plugin run manifest.json [--workspace PATH] [--routing decisions|offline] [--agent codex|none|generic] [--agent-command PATH] [--agent-sessions] [--agent-in-execution-async] [--agent-delivery auto|in_execution|single_turn|two_turn] [--codex-steering-mechanism turn_steer|tool_output] [--strict-delivery-mode] [--decision-model NAME] [--model NAME] [--effort minimal|low|medium|high|xhigh|max]
  perfdigest-plugin mcp [--workspace PATH]
  perfdigest-plugin evidence run manifest.json [--workspace PATH] [--provider cloudflare|local|openai|offline] [--decision-model NAME] [--compact-evidence] [--include-corroborating] [--json]
  perfdigest-plugin evidence start manifest.json [--workspace PATH] [--provider cloudflare|local|openai|offline] [--decision-model NAME] [--compact-evidence] [--include-corroborating]
  perfdigest-plugin evidence status <jobId> [--workspace PATH]
  perfdigest-plugin evidence wait <jobId> [--workspace PATH] [--timeout-ms 30000]
  perfdigest-plugin evidence collect <jobId> [--workspace PATH] [--full]
  perfdigest-plugin evidence cancel <jobId> [--workspace PATH]

Unconfigured demo defaults: real local CPU measurements + verification, offline routing, no model calls.
Unconfigured run defaults: existing Codex ChatGPT login + live Decisions (PERFDIGEST_DECISIONS_API_KEY).
Use --agent codex to demonstrate overlap with a real Codex session, or --agent generic --agent-command PATH for a JSONL CLI agent.
--agent-delivery selects auto, in_execution, single_turn (evidence-first single turn), or two_turn (default concurrent analysis + review).
--codex-steering-mechanism selects turn_steer (default) or tool_output for mid-turn evidence steering in Codex app-server mode.
--agent-in-execution-async opts a generic CLI agent into the perfdigest-agent/v1 in-execution async evidence streaming protocol.
--strict-delivery-mode fails closed if in_execution delivery is requested on an adapter without inExecutionAsyncInput support.
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
    'agent-in-execution-async': { type: 'boolean' },
    'agent-delivery': { type: 'string' }, 'strict-delivery-mode': { type: 'boolean' }, 'compact-evidence': { type: 'boolean' },
    'codex-steering-mechanism': { type: 'string' },
    routing: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, perf: { type: 'boolean' },
    endpoint: { type: 'string' }, 'env-file': { type: 'string' }, 'decision-model': { type: 'string' }, yes: { type: 'boolean' }, 'check-connection': { type: 'boolean' },
    'include-corroborating': { type: 'boolean' }, json: { type: 'boolean' }, full: { type: 'boolean' },
    'timeout-ms': { type: 'string' }, 'job-id': { type: 'string' },
    'decisions-mock-url': { type: 'string' }, 'mcp-command': { type: 'string' },
    'mcp-arg': { type: 'string', multiple: true }, 'reuse-mcp-session': { type: 'string' },
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
  if (!['demo', 'run', 'mcp', 'evidence'].includes(command)) throw new Error('Unknown command; use --help');
  if (command === 'evidence') {
    const sub = positionals[1];
    if (!sub) throw new Error('evidence requires a subcommand: run, start, status, wait, collect or cancel');
    if (sub === '_worker') {
      const jobId = values['job-id'] ?? positionals[2];
      if (!jobId) throw new Error('evidence _worker requires --job-id <id>');
      const abort = new AbortController();
      const onSignal = () => abort.abort(new Error('Interrupted'));
      process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
      try {
        await runDetachedEvidenceWorker({ workspace, jobId, signal: abort.signal });
      } finally {
        process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
      }
      return;
    }
    if (sub === 'status' || sub === 'wait' || sub === 'collect' || sub === 'cancel') {
      const jobId = positionals[2] ?? values['job-id'];
      if (!jobId) throw new Error(`evidence ${sub} requires a jobId`);
      if (sub === 'status') {
        const out = await getEvidenceWorkerStatus({ workspace, jobId });
        console.log(redactWorkerText(JSON.stringify(out, null, 2)));
        return;
      }
      if (sub === 'wait') {
        let timeoutMs: number | undefined;
        if (values['timeout-ms'] !== undefined) {
          if (!/^\d+$/.test(values['timeout-ms'])) {
            throw new Error('--timeout-ms must be an integer between 0 and 300000');
          }
          timeoutMs = Number(values['timeout-ms']);
        }
        const abort = new AbortController();
        const onSignal = () => abort.abort(new Error('Interrupted'));
        process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
        try {
          const out = await waitEvidenceWorker({
            workspace,
            jobId,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            signal: abort.signal,
          });
          console.log(redactWorkerText(JSON.stringify(out, null, 2)));
          if (out.status !== 'complete') process.exitCode = 1;
        } finally {
          process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
        }
        return;
      }
      if (sub === 'collect') {
        const out = await collectEvidenceWorker({ workspace, jobId, full: values.full ?? false });
        console.log(redactWorkerText(JSON.stringify(out, null, 2)));
        return;
      }
      const out = await cancelEvidenceWorker({ workspace, jobId });
      console.log(redactWorkerText(JSON.stringify(out, null, 2)));
      return;
    }
    if (sub !== 'run' && sub !== 'start') {
      throw new Error(`Unknown evidence subcommand: ${sub}`);
    }
  }
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
  if (command === 'evidence') {
    const sub = positionals[1]!;
    const mcpSessionOptions = values['mcp-command'] || (values['mcp-arg'] && values['mcp-arg'].length > 0)
      ? {
          ...(values['mcp-command'] ? { command: values['mcp-command'] } : {}),
          ...(values['mcp-arg'] ? { args: values['mcp-arg'] } : {}),
        }
      : undefined;
    const reuseMcpSession = values['reuse-mcp-session'] !== undefined
      ? values['reuse-mcp-session'] === 'true' || values['reuse-mcp-session'] === '1'
      : undefined;
    const manifestArg = positionals[2];
    if (!manifestArg) throw new Error(`evidence ${sub} requires a manifest path`);
    const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(manifestArg), 'utf8')));
    if (sub === 'start') {
      const out = await startEvidenceWorker({
        workspace,
        manifest,
        routing,
        ...modelOption,
        compactEvidence: values['compact-evidence'] ?? true,
        includeCorroborating: values['include-corroborating'] ?? false,
        ...(values['decisions-mock-url'] !== undefined ? { decisionsMockURL: values['decisions-mock-url'] } : {}),
        ...(mcpSessionOptions !== undefined ? { mcpSessionOptions } : {}),
        ...(reuseMcpSession !== undefined ? { reuseMcpSession } : {}),
      });
      console.log(redactWorkerText(JSON.stringify(out, null, 2)));
      return;
    }
    const abort = new AbortController();
    const onSignal = () => abort.abort(new Error('Interrupted'));
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    try {
      const out = await runEvidenceWorker({
        workspace,
        manifest,
        routing,
        ...modelOption,
        compactEvidence: values['compact-evidence'] ?? true,
        includeCorroborating: values['include-corroborating'] ?? false,
        ...(values['decisions-mock-url'] !== undefined ? { decisionsMockURL: values['decisions-mock-url'] } : {}),
        ...(mcpSessionOptions !== undefined ? { mcpSessionOptions } : {}),
        ...(reuseMcpSession !== undefined ? { reuseMcpSession } : {}),
        signal: abort.signal,
        onEvent: (event, detail) => process.stderr.write(`${event}${detail ? `: ${redactWorkerText(detail)}` : ''}\n`),
      });
      console.log(redactWorkerText(JSON.stringify(out, null, 2)));
      if (out.status !== 'complete') process.exitCode = 1;
    } finally {
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    }
    return;
  }
  const agent = values.agent ?? (command === 'demo' ? 'none' : 'codex');
  if (agent !== 'none' && agent !== 'codex' && agent !== 'generic') throw new Error('--agent must be none, codex or generic');
  if (agent !== 'generic' && (values['agent-command'] !== undefined || values['agent-sessions'] !== undefined || values['agent-in-execution-async'] !== undefined)) {
    throw new Error('--agent-command, --agent-sessions and --agent-in-execution-async require --agent generic');
  }
  if (agent === 'generic' && !values['agent-command']) {
    throw new Error('--agent generic requires --agent-command PATH');
  }
  const agentDeliveryRaw = values['agent-delivery'];
  if (
    agentDeliveryRaw !== undefined &&
    agentDeliveryRaw !== 'two_turn' &&
    agentDeliveryRaw !== 'single_turn' &&
    agentDeliveryRaw !== 'in_execution' &&
    agentDeliveryRaw !== 'auto'
  ) {
    throw new Error('--agent-delivery must be auto, in_execution, two_turn or single_turn');
  }
  const agentDelivery = agentDeliveryRaw as AgentDeliveryMode | undefined;
  const codexSteeringRaw = values['codex-steering-mechanism'];
  if (codexSteeringRaw !== undefined && agent !== 'codex') {
    throw new Error('--codex-steering-mechanism requires --agent codex');
  }
  if (codexSteeringRaw !== undefined && codexSteeringRaw !== 'turn_steer' && codexSteeringRaw !== 'tool_output') {
    throw new Error('--codex-steering-mechanism must be turn_steer or tool_output');
  }
  const codexSteeringMechanism = codexSteeringRaw as 'turn_steer' | 'tool_output' | undefined;
  const effortRaw = values.effort;
  const validEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
  if (effortRaw !== undefined && !validEfforts.includes(effortRaw as (typeof validEfforts)[number])) {
    throw new Error('--effort must be minimal, low, medium, high, xhigh or max');
  }
  const effort = effortRaw as ModelReasoningEffort | undefined;
  const agentAdapter = agent === 'generic'
    ? genericCliAdapter({
        command: values['agent-command']!,
        sessions: values['agent-sessions'] ?? false,
        inExecutionAsync: values['agent-in-execution-async'] ?? false,
      })
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
      ...(agentDelivery !== undefined ? { agentDelivery } : {}),
      ...(codexSteeringMechanism !== undefined ? { codexSteeringMechanism } : {}),
      ...(values['strict-delivery-mode'] !== undefined ? { strictDeliveryMode: values['strict-delivery-mode'] } : {}),
      ...(values['compact-evidence'] !== undefined ? { compactEvidence: values['compact-evidence'] } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(effort !== undefined ? { effort } : {}),
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
