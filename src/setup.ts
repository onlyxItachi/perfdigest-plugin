import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { executable } from './environment.js';

export const setupProviders = ['cloudflare', 'local', 'openai', 'offline'] as const;
export type SetupProvider = typeof setupProviders[number];
export type RuntimeProvider = SetupProvider;
export const defaultLocalEndpoint = 'http://127.0.0.1:8137/v1/systemone';

/** This file contains references only. Credential values belong in a private external env file. */
export interface PluginConfiguration {
  version: 1;
  provider: SetupProvider;
  endpoint?: string;
  envFile?: string;
}

export interface SetupDiagnostic {
  check: 'configuration' | 'uvx' | 'codex' | 'env_file' | 'credentials' | 'endpoint';
  status: 'ok' | 'warning' | 'error' | 'skipped';
  message: string;
}

export interface InitOptions {
  workspace?: string;
  provider?: string;
  endpoint?: string;
  envFile?: string;
  yes?: boolean;
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { isTTY?: boolean };
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface InitResult {
  configuration: PluginConfiguration;
  path: string;
  diagnostics: SetupDiagnostic[];
  /** Prerequisite checks only; does not claim authenticated inference or Codex login. */
  ready: boolean;
}

const providerAliases: Record<string, SetupProvider> = {
  cloudflare: 'cloudflare', 'clef-cloudflare': 'cloudflare',
  local: 'local', 'clef-local': 'local',
  openai: 'openai', 'openai-luna': 'openai', decisions: 'openai', offline: 'offline',
};
const permittedEnvironment = new Set([
  'PERFDIGEST_CLOUDFLARE_ACCOUNT_ID', 'PERFDIGEST_CLOUDFLARE_API_TOKEN',
  'PERFDIGEST_DECISIONS_API_KEY', 'PERFDIGEST_CLEF_URL',
]);

export function normalizeSetupProvider(value: string): SetupProvider {
  const provider = Object.hasOwn(providerAliases, value) ? providerAliases[value] : undefined;
  if (!provider) throw new Error('Provider must be cloudflare, local, openai or offline.');
  return provider;
}

export function providerForRuntime(provider: SetupProvider): RuntimeProvider {
  return normalizeSetupProvider(provider);
}

export function validateLocalEndpoint(value: string): string {
  // Shared by setup and the runtime. Check the explicit port before URL parsing
  // can erase a default :80 port; both stages must accept the same saved address.
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/v1\/systemone$/.exec(value);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error('Local endpoint must be http://127.0.0.1:PORT/v1/systemone with no credentials, query or fragment.');
  }
  return value;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isWithin(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

async function workspaceDirectory(workspace: string): Promise<string> {
  try {
    const path = await realpath(workspace);
    if (!(await stat(path)).isDirectory()) throw new Error();
    return path;
  } catch { throw new Error('Workspace must be an existing directory.'); }
}

async function repositoryDirectory(workspace: string): Promise<string> {
  for (let path = workspace; ; path = dirname(path)) {
    try { await lstat(join(path, '.git')); return path; } catch (error) {
      if (!isCode(error, 'ENOENT')) throw new Error('Cannot inspect workspace repository boundary.');
    }
    if (path === dirname(path)) return workspace;
  }
}

/** Resolve missing leaf names too, so a symlinked parent cannot bypass the repository boundary. */
async function canonicalReference(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if (!isCode(error, 'ENOENT')) throw new Error('Cannot access the external env-file path.');
    const parent = dirname(path);
    if (parent === path) throw new Error('Cannot resolve the external env-file path.');
    return join(await canonicalReference(parent), relative(parent, path));
  }
}

async function validateEnvReference(path: string, workspace: string): Promise<string> {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error('Env file must be an absolute external file path, never a token or KEY=VALUE.');
  }
  const repository = await repositoryDirectory(workspace);
  const reference = await canonicalReference(path);
  if (isWithin(workspace, reference) || isWithin(repository, reference)) {
    throw new Error('Keep the env file outside the investigated workspace and repository.');
  }
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Env file must be a regular file, not a symbolic link.');
    if (info.size > 65_536) throw new Error('Env file exceeds the 64 KiB setup limit.');
    if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) {
      throw new Error('Env file must be owned by the current user and private; set its permissions to 600.');
    }
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
  }
  return reference;
}

async function validateConfiguration(value: unknown, workspace: string): Promise<PluginConfiguration> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid PerfDigest configuration.');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['version', 'provider', 'endpoint', 'envFile'].includes(key))) {
    throw new Error('Configuration may contain only version, provider, endpoint and envFile references.');
  }
  if (raw.version !== 1 || typeof raw.provider !== 'string') throw new Error('Invalid PerfDigest configuration version or provider.');
  const provider = normalizeSetupProvider(raw.provider);
  if (raw.endpoint !== undefined && (provider !== 'local' || typeof raw.endpoint !== 'string')) {
    throw new Error('Only the local provider accepts a configurable endpoint.');
  }
  if (raw.envFile !== undefined && typeof raw.envFile !== 'string') throw new Error('Env file must be an absolute external file path.');
  const configuration: PluginConfiguration = { version: 1, provider };
  if (provider === 'local') configuration.endpoint = validateLocalEndpoint((raw.endpoint as string | undefined) ?? defaultLocalEndpoint);
  if (typeof raw.envFile === 'string') configuration.envFile = await validateEnvReference(raw.envFile, workspace);
  return configuration;
}

async function checkConfigurationDirectory(workspace: string): Promise<string> {
  const directory = join(workspace, '.perfdigest');
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The .perfdigest configuration directory must not be a symlink.');
  } catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
  return directory;
}

/** Missing configuration is explicit (null). Malformed or unsafe configuration never becomes offline. */
export async function loadConfiguration(workspace = process.cwd()): Promise<PluginConfiguration | null> {
  const root = await workspaceDirectory(workspace);
  const directory = await checkConfigurationDirectory(root);
  const path = join(directory, 'config.json');
  let source: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new Error('Configuration must be a regular file smaller than 16 KiB.');
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('Configuration is not valid JSON.'); }
  return validateConfiguration(value, root);
}

function parseDedicatedEnvironment(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!assignment || !permittedEnvironment.has(assignment[1]!)) {
      throw new Error(`Env file line ${index + 1} must assign a dedicated PerfDigest variable; general API keys and shell syntax are refused.`);
    }
    const key = assignment[1]!;
    if (Object.hasOwn(values, key)) throw new Error(`Env file has a duplicate assignment on line ${index + 1}.`);
    let value = assignment[2]!.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error(`Env file has an invalid quoted value on line ${index + 1}.`);
      value = value.slice(1, -1);
    }
    if (/[\s\x00-\x1f\x7f]/.test(value)) throw new Error(`Env file values must be single-line literals without whitespace (line ${index + 1}).`);
    if (key === 'PERFDIGEST_CLEF_URL' && value) validateLocalEndpoint(value);
    values[key] = value;
  }
  return values;
}

/** Load only dedicated variables into this process. No shell evaluation, child environment or secret return value. */
export async function applyConfigurationEnvironment(
  configuration: PluginConfiguration, workspace = process.cwd(), environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const root = await workspaceDirectory(workspace);
  const checked = await validateConfiguration(configuration, root);
  let values: Record<string, string> = {};
  if (checked.envFile) {
    let source: string;
    try { source = await readFile(checked.envFile, 'utf8'); }
    catch { throw new Error('The configured external env file is missing or unreadable.'); }
    values = parseDedicatedEnvironment(source);
  }
  // Parse/validate everything before assigning anything. Existing process variables take priority.
  for (const [key, value] of Object.entries(values)) if (environment[key] === undefined) environment[key] = value;
  // The visible saved local endpoint is authoritative, independent of an env-file default.
  if (checked.provider === 'local') environment.PERFDIGEST_CLEF_URL = checked.endpoint!;
}

async function saveConfiguration(configuration: PluginConfiguration, workspace: string): Promise<string> {
  const directory = await checkConfigurationDirectory(workspace);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const path = join(directory, 'config.json');
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Configuration must not be a symlink or special file.');
  } catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(configuration, null, 2)}\n`); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return path;
}

async function diagnosticsFor(configuration: PluginConfiguration, workspace: string, environment: NodeJS.ProcessEnv): Promise<SetupDiagnostic[]> {
  const diagnostics: SetupDiagnostic[] = [
    { check: 'configuration', status: 'ok', message: 'Workspace configuration saved; it contains references only.' },
  ];
  for (const [name, binary] of [['uvx', 'uvx'], ['codex', environment.PERFDIGEST_CODEX_PATH ?? 'codex']] as const) {
    try {
      const path = executable(binary, environment);
      if (!(await stat(path)).isFile()) throw new Error();
      await access(path, constants.X_OK);
      diagnostics.push({ check: name, status: 'ok', message: name === 'uvx'
        ? 'uvx executable found; Python MCP installation was not started.'
        : 'Codex executable found; existing login was not checked.' });
    } catch {
      diagnostics.push({ check: name, status: name === 'uvx' ? 'error' : 'warning', message: name === 'uvx'
        ? 'uvx is missing or not executable; install uv before collecting evidence.'
        : 'Codex is missing or not executable; install/login before using --agent codex.' });
    }
  }
  const effective = { ...environment };
  try {
    await applyConfigurationEnvironment(configuration, workspace, effective);
    diagnostics.push({ check: 'env_file', status: configuration.envFile ? 'ok' : 'skipped', message: configuration.envFile
      ? 'Private external env file read; values are not displayed or saved in configuration.'
      : 'No external env file configured; dedicated variables are read from the runner environment.' });
  } catch {
    diagnostics.push({ check: 'env_file', status: 'error', message: 'External env file is missing, unreadable or invalid; no values were applied.' });
  }
  if (configuration.provider === 'cloudflare') {
    const account = effective.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID?.trim();
    const token = effective.PERFDIGEST_CLOUDFLARE_API_TOKEN?.trim();
    diagnostics.push({ check: 'credentials', status: account && /^[a-f0-9]{32}$/i.test(account) && token ? 'ok' : 'error',
      message: account && /^[a-f0-9]{32}$/i.test(account) && token
        ? 'Cloudflare account ID and token present; authentication and quota remain unverified.'
        : 'Set PERFDIGEST_CLOUDFLARE_ACCOUNT_ID (32 hex characters) and PERFDIGEST_CLOUDFLARE_API_TOKEN in the private runner environment.' });
  } else if (configuration.provider === 'openai') {
    const present = Boolean(effective.PERFDIGEST_DECISIONS_API_KEY?.trim());
    diagnostics.push({ check: 'credentials', status: present ? 'ok' : 'error', message: present
      ? 'Dedicated Decisions key present; authentication, model access and budget remain unverified.'
      : 'Set PERFDIGEST_DECISIONS_API_KEY in the private runner environment; OPENAI_API_KEY is not used.' });
  } else {
    diagnostics.push({ check: 'credentials', status: 'skipped', message: 'This provider does not require hosted API credentials.' });
  }
  if (configuration.provider === 'local') {
    const health = new URL('/health', configuration.endpoint!);
    try {
      const response = await fetch(health, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      diagnostics.push({ check: 'endpoint', status: response.ok ? 'ok' : 'error', message: response.ok
        ? `Local /health returned HTTP ${response.status}; inference and model identity remain unverified.`
        : `Local server returned HTTP ${response.status} for /health; readiness was not confirmed.` });
    } catch {
      diagnostics.push({ check: 'endpoint', status: 'error', message: 'Local /health was unreachable, redirected or timed out; start llama.cpp at the configured address.' });
    }
  } else {
    diagnostics.push({ check: 'endpoint', status: 'skipped', message: configuration.provider === 'offline'
      ? 'Offline selected explicitly; no endpoint or model is contacted.'
      : 'Hosted endpoint was not contacted; setup sends no inference or credential-verification requests.' });
  }
  return diagnostics;
}

/** Small readline setup. --yes always requires an explicit provider; non-TTY use never silently chooses one. */
export async function initConfiguration(options: InitOptions = {}): Promise<InitResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  if (options.yes && options.provider === undefined) throw new Error('Noninteractive init requires --provider cloudflare|local|openai|offline together with --yes.');
  if (!options.yes && (!input.isTTY || !output.isTTY)) {
    throw new Error('Interactive init requires a terminal. For automation specify --provider cloudflare|local|openai|offline and --yes.');
  }
  const workspace = await workspaceDirectory(options.workspace ?? process.cwd());
  const previous = await loadConfiguration(workspace);
  const environment = options.environment ?? process.env;
  const terminal = options.yes ? undefined : createInterface({ input, output, terminal: true });
  let closed = false;
  let rejectClose: ((error: Error) => void) | undefined;
  const close = new Promise<string>((_resolve, reject) => { rejectClose = reject; });
  void close.catch(() => {});
  terminal?.on('close', () => { closed = true; rejectClose?.(new Error('Setup cancelled before saving configuration.')); });
  terminal?.on('SIGINT', () => terminal.close());
  const ask = async (question: string): Promise<string> => {
    if (!terminal || closed) throw new Error('Setup cancelled before saving configuration.');
    return Promise.race([terminal.question(question, options.signal ? { signal: options.signal } : {}), close]);
  };
  try {
    output.write('PerfDigest provider setup — no model calls\n');
    let provider = options.provider === undefined ? undefined : normalizeSetupProvider(options.provider);
    if (!provider) {
      output.write('  1. Cloudflare (recommended demo)\n  2. Local llama.cpp\n  3. OpenAI Decisions\n  4. Offline (deterministic, no model)\n');
      const preferred = previous?.provider ?? 'cloudflare';
      while (!provider) {
        const choice = (await ask(`Provider [${preferred}]: `)).trim() || preferred;
        try { provider = normalizeSetupProvider(setupProviders[Number(choice) - 1] ?? choice); }
        catch { output.write('Choose 1–4 or cloudflare, local, openai, offline.\n'); }
      }
    }
    let envFile = options.envFile !== undefined ? options.envFile.trim() || undefined
      : previous?.provider === provider ? previous.envFile : undefined;
    if (terminal && options.envFile === undefined && (provider === 'cloudflare' || provider === 'openai')) {
      const answer = (await ask(envFile
        ? 'External env-file absolute path [Enter keeps configured path; - uses current environment]: '
        : 'Private external env-file absolute path [Enter uses current environment]: ')).trim();
      if (answer === '-') envFile = undefined;
      else if (answer) envFile = answer;
    }
    let endpoint = options.endpoint;
    if (provider === 'local' && endpoint === undefined) {
      endpoint = previous?.provider === 'local' ? previous.endpoint : undefined;
      endpoint ??= environment.PERFDIGEST_CLEF_URL ?? defaultLocalEndpoint;
      validateLocalEndpoint(endpoint);
      if (terminal) endpoint = (await ask(`Local endpoint [${endpoint}]: `)).trim() || endpoint;
    }
    const configuration = await validateConfiguration({ version: 1, provider,
      ...(endpoint !== undefined ? { endpoint } : {}), ...(envFile ? { envFile } : {}),
    }, workspace);
    if (terminal) {
      output.write(`Selected provider: ${provider}\n`);
      const answer = (await ask(`${previous ? 'Replace' : 'Save'} workspace configuration? [Y/n]: `)).trim().toLowerCase();
      if (answer && answer !== 'y' && answer !== 'yes') throw new Error('Setup cancelled before saving configuration.');
    }
    options.signal?.throwIfAborted();
    const path = await saveConfiguration(configuration, workspace);
    output.write(`Active provider: ${provider}\n`);
    if (configuration.endpoint) output.write(`Local endpoint: ${configuration.endpoint}\n`);
    const diagnostics = await diagnosticsFor(configuration, workspace, environment);
    for (const diagnostic of diagnostics) output.write(`[${diagnostic.status}] ${diagnostic.message}\n`);
    const ready = !diagnostics.some(diagnostic => diagnostic.status === 'error');
    output.write(`Configuration saved to .perfdigest/config.json. ${ready ? 'Prerequisite checks passed.' : 'Some prerequisites need attention.'}\n`);
    return { configuration, path, diagnostics, ready };
  } finally { terminal?.close(); }
}
