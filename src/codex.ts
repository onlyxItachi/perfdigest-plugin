import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Codex, type Thread, type Usage } from '@openai/codex-sdk';
import { childEnvironment, executable, redact } from './environment.js';
import type { Emit } from './config.js';

export interface CodexTurn { text: string; usage: Usage | null; threadId: string | null }

export async function codexThread(workspace: string, model?: string): Promise<Thread> {
  const binary = executable(process.env.PERFDIGEST_CODEX_PATH ?? 'codex');
  const env = childEnvironment();
  const exec = promisify(execFile);
  const login = await exec(binary, ['login', 'status'], { env, timeout: 15_000 });
  if (!/logged in using chatgpt/i.test(login.stdout + login.stderr)) {
    throw new Error('This MVP requires an existing ChatGPT Codex login. Run codex login first.');
  }
  // Discover configuration names only. Do not start inherited MCP servers, copy auth,
  // print their config (which can contain secrets), or change global settings.
  const listing = await exec(binary, ['mcp', 'list', '--json'], { cwd: workspace, env, timeout: 15_000 });
  const servers = JSON.parse(listing.stdout) as Array<{ name: string }>;
  const configOverrides = disabledMcpOverrides(servers.map(s => s.name));
  const sdk = new Codex({ codexPathOverride: binary, env, configOverrides,
    config: { features: { multi_agent: false, shell_tool: false, shell_snapshot: false,
      hooks: false, memories: false, plugins: false } } });
  return sdk.startThread({ workingDirectory: workspace, skipGitRepoCheck: true,
    sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false,
    webSearchMode: 'disabled', modelReasoningEffort: 'low', ...(model ? { model } : {}) });
}

export function disabledMcpOverrides(names: string[]): string[] {
  // CLI dotted paths do not parse quoted keys. Plugin-provided servers also need
  // a complete disabled transport table; an enabled-only table fails to load.
  return names.map(name => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Unsupported inherited MCP name; cannot isolate this Codex run');
    return `mcp_servers.${name}={command="false",enabled=false}`;
  });
}

export async function codexTurn(thread: Thread, prompt: string, phase: string, signal: AbortSignal, emit: Emit): Promise<CodexTurn> {
  emit(`codex.${phase}.started`);
  const { events } = await thread.runStreamed(prompt, { signal });
  let text = '';
  let usage: Usage | null = null;
  let completed = false;
  for await (const event of events) {
    if (event.type === 'turn.started') emit(`codex.${phase}.turn_started`);
    if (event.type === 'turn.failed') throw new Error(redact(event.error.message));
    if (event.type === 'error') throw new Error(redact(event.message));
    if (event.type === 'item.completed' && event.item.type === 'agent_message') text = redact(event.item.text);
    if (event.type === 'turn.completed') { usage = event.usage; completed = true; }
  }
  if (!completed || !text) throw new Error('Codex ended without a completed response');
  emit(`codex.${phase}.completed`);
  return { text, usage, threadId: thread.id };
}
