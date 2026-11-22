import { openSync, closeSync, readFileSync } from 'node:fs';
import { chmod, open, readFile, realpath, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatAgentEvidence, type EvidenceDelivery } from './agents.js';
import { manifestSchema, type DecisionOutcome, type Manifest, type RoutingMode } from './config.js';
import { childEnvironment, redact } from './environment.js';
import {
  assertContainedRegularFile,
  createExclusiveDirectory,
  writePrivateFile,
} from './files.js';
import type { PerfDigestSessionOptions } from './perfdigest.js';
import { createDecisionProvider, providerName, type DecisionProvider } from './providers.js';
import { investigate, type RunResult } from './run.js';
import { applyConfigurationEnvironment, loadConfiguration, validateLocalEndpoint } from './setup.js';

export const SKILL_BACKGROUND_DELIVERY_MODE = 'skill_background_worker' as const satisfies EvidenceDelivery;
export const MAX_EVIDENCE_WAIT_TIMEOUT_MS = 300_000;
export const DEFAULT_EVIDENCE_WAIT_TIMEOUT_MS = 30_000;

const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const BSD_OR_DARWIN_PLATFORMS = new Set(['darwin', 'freebsd', 'openbsd', 'netbsd', 'dragonfly']);

export type EvidenceWorkerTerminalStatus = 'complete' | 'needs_review' | 'failed';
export type EvidenceWorkerJobStatus =
  | 'running'
  | EvidenceWorkerTerminalStatus
  | 'cancelled'
  | 'crashed';

export interface EvidenceReadyReceipt {
  version: 1;
  deliveryMode: 'skill_background_worker';
  jobId: string;
  status: EvidenceWorkerTerminalStatus;
  decisionOutcome: DecisionOutcome;
  completedAt: string;
  runDir: string;
  runJsonPath: string;
  evidencePath: string;
  readyPath: string;
  evidenceSha256: string;
  verificationExitCode: number | null;
  provenanceCount: number;
  error: string | null;
}

export interface EvidenceJobState {
  version: 1;
  deliveryMode: 'skill_background_worker';
  jobId: string;
  pid: number | null;
  processStartId: string | null;
  workerMarker: string;
  status: EvidenceWorkerJobStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  workspace: string;
  runDir: string;
  runJsonPath: string;
  evidencePath: string;
  readyPath: string;
  statusPath: string;
  logPath: string;
  routing: RoutingMode;
  decisionOutcome: DecisionOutcome | null;
  verificationExitCode: number | null;
  provenanceCount: number;
  error: string | null;
}

export interface EvidenceRunOutput {
  version: 1;
  deliveryMode: 'skill_background_worker';
  jobId: string;
  status: EvidenceWorkerTerminalStatus;
  decisionOutcome: DecisionOutcome;
  runDir: string;
  runJsonPath: string;
  evidencePath: string;
  readyPath: string;
  evidenceSha256: string;
  verificationExitCode: number | null;
  provenanceCount: number;
  error: string | null;
  packet: Record<string, unknown>;
}

export interface EvidenceStartOutput {
  version: 1;
  deliveryMode: 'skill_background_worker';
  jobId: string;
  pid: number;
  status: 'running';
  statusPath: string;
  readyPath: string;
  runDir: string;
}

export interface EvidenceStatusOutput {
  version: 1;
  deliveryMode: 'skill_background_worker';
  jobId: string;
  pid: number | null;
  status: EvidenceWorkerJobStatus;
  ready: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  elapsedMs: number;
  runDir: string;
  runJsonPath: string;
  evidencePath: string;
  readyPath: string;
  statusPath: string;
  decisionOutcome: DecisionOutcome | null;
  verificationExitCode: number | null;
  provenanceCount: number;
  evidenceSha256: string | null;
  error: string | null;
}

export interface EvidenceWaitOutput {
  version: 1;
  deliveryMode: 'skill_background_worker';
  jobId: string;
  status: EvidenceWorkerJobStatus;
  timedOut: boolean;
  waitedMs: number;
  decisionOutcome: DecisionOutcome | null;
  runDir: string;
  runJsonPath: string;
  evidencePath: string;
  readyPath: string;
  evidenceSha256: string | null;
  verificationExitCode: number | null;
  provenanceCount: number;
  error: string | null;
  packet: Record<string, unknown> | null;
}

export interface EvidenceCollectOutput {
  version: 1;
  deliveryMode: 'skill_background_worker';
  jobId: string;
  status: EvidenceWorkerTerminalStatus;
  decisionOutcome: DecisionOutcome;
  runDir: string;
  runJsonPath: string;
  evidencePath: string;
  readyPath: string;
  evidenceSha256: string;
  verifiedSha256: true;
  verificationExitCode: number | null;
  provenanceCount: number;
  error: string | null;
  packet: Record<string, unknown>;
  run?: RunResult;
}

export interface EvidenceCancelOutput {
  version: 1;
  deliveryMode: 'skill_background_worker';
  jobId: string;
  status: EvidenceWorkerJobStatus;
  alreadyTerminal: boolean;
  signalSent: 'SIGTERM' | 'SIGKILL' | null;
  note?: string;
}

export interface ProcessInspectionProbes {
  killZero?: (pid: number) => 'ok' | 'eperm' | 'esrch';
  linuxStat?: (pid: number) => { state: string; startId: string } | null;
  linuxCmdline?: (pid: number) => string | null;
  psQuery?: (pid: number) => { state: string; startId: string; command: string } | null;
  winQuery?: (pid: number) => { exists: boolean; startId: string; command: string } | null;
}

interface WorkerRequestFile {
  version: 1;
  jobId: string;
  routing: RoutingMode;
  cloudflareModel?: string;
  compactEvidence: boolean;
  includeCorroborating: boolean;
  decisionsMockURL?: string;
  localEndpoint?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
  reuseMcpSession?: boolean;
}

export interface EvidenceWorkerRunOptions {
  workspace: string;
  manifest: Manifest;
  routing: RoutingMode;
  jobId?: string;
  cloudflareModel?: string;
  compactEvidence?: boolean;
  includeCorroborating?: boolean;
  decisionsMockURL?: string;
  decisionProvider?: DecisionProvider;
  mcpSessionOptions?: PerfDigestSessionOptions;
  reuseMcpSession?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: string, detail?: string) => void;
  /** Internal flag used by detached worker so pre-reserved dirs and cancellation markers are respected. */
  preserveCancelledState?: boolean;
}

export interface EvidenceWorkerStartOptions {
  workspace: string;
  manifest: Manifest;
  routing: RoutingMode;
  jobId?: string;
  cloudflareModel?: string;
  compactEvidence?: boolean;
  includeCorroborating?: boolean;
  decisionsMockURL?: string;
  mcpSessionOptions?: PerfDigestSessionOptions;
  reuseMcpSession?: boolean;
  /** Optional worker executable/args override (primarily for custom launchers/tests). */
  workerCommand?: string;
  workerArgsPrefix?: string[];
}

export function redactWorkerText(text: string): string {
  return redact(text)
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]');
}

export function validateEvidenceJobId(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error('Invalid jobId: must be 8 to 80 characters matching ^[a-zA-Z0-9_-]+$');
  }
  return jobId;
}

export function generateEvidenceJobId(): string {
  const iso = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `ev-${iso}-${randomBytes(4).toString('hex')}`;
}

function sha256HexBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      rejectSleep(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      rejectSleep(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function defaultKillZero(pid: number): 'ok' | 'eperm' | 'esrch' {
  try {
    process.kill(pid, 0);
    return 'ok';
  } catch (error) {
    return isErrorCode(error, 'EPERM') ? 'eperm' : 'esrch';
  }
}

function parseLinuxProcStat(pid: number): { state: string; startId: string } | null {
  if (process.platform !== 'linux' || pid <= 0) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen === -1) return null;
    const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
    const state = fields[0];
    const startTicks = fields[19];
    if (!state || !startTicks) return null;
    return { state, startId: startTicks };
  } catch {
    return null;
  }
}

function readLinuxProcCmdline(pid: number): string | null {
  if (process.platform !== 'linux' || pid <= 0) return null;
  try {
    const buf = readFileSync(`/proc/${pid}/cmdline`);
    if (buf.byteLength === 0) return null;
    return buf.toString('utf8').replaceAll('\0', ' ');
  } catch {
    return null;
  }
}

/**
 * Parses `LC_ALL=C ps -o stat=,lstart=,command= -p <pid>` output:
 * `<STAT> <Day> <Mon> <DD> <HH:MM:SS> <YYYY> <COMMAND...>`
 */
export function parsePsProcessLine(raw: string): { state: string; startId: string; command: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  const fields = firstLine.split(/\s+/);
  if (fields.length < 7) return null;
  const state = fields[0]!;
  const startId = fields.slice(1, 6).join(' ');
  const command = fields.slice(6).join(' ');
  if (!state || !startId || !command) return null;
  return { state, startId, command };
}

function queryPsProcess(pid: number): { state: string; startId: string; command: string } | null {
  if (pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'stat=,lstart=,command=', '-p', String(pid)], {
      env: { ...childEnvironment(), LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parsePsProcessLine(out);
  } catch {
    return null;
  }
}

export function parseWindowsCimJson(raw: string): { exists: boolean; startId: string; command: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return { exists: false, startId: '', command: '' };
  try {
    const parsed = JSON.parse(trimmed) as { CreationDate?: unknown; CommandLine?: unknown };
    const startId = typeof parsed.CreationDate === 'string' ? parsed.CreationDate.trim() : '';
    const command = typeof parsed.CommandLine === 'string' ? parsed.CommandLine : '';
    if (!startId || !command.trim()) return null;
    return { exists: true, startId, command };
  } catch {
    return null;
  }
}

function queryWindowsProcess(pid: number): { exists: boolean; startId: string; command: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const psCmd =
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
      `if ($null -ne $p) { $p | Select-Object CreationDate,CommandLine | ConvertTo-Json -Compress }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseWindowsCimJson(out);
  } catch {
    return null;
  }
}

export function readProcessStartId(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    return parseLinuxProcStat(pid)?.startId ?? null;
  }
  if (BSD_OR_DARWIN_PLATFORMS.has(process.platform)) {
    return queryPsProcess(pid)?.startId ?? null;
  }
  if (process.platform === 'win32') {
    const res = queryWindowsProcess(pid);
    return res && res.exists ? res.startId : null;
  }
  return null;
}

/**
 * Evaluates worker process liveness and ownership fail-closed across all platforms.
 * Never returns `owned: true` unless BOTH start time and workerMarker cmdline ownership are verified.
 */
export function evaluateWorkerProcessStatus(
  platform: string,
  pid: number | null,
  expectedStartId: string | null,
  expectedMarker: string | null,
  probes: ProcessInspectionProbes = {},
): { alive: boolean; owned: boolean } {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) {
    return { alive: false, owned: false };
  }

  if (platform === 'win32') {
    const winFn = probes.winQuery ?? queryWindowsProcess;
    const info = winFn(pid);
    if (!info) {
      // Query failed: fail closed so callers never taskkill an unverified PID.
      return { alive: true, owned: false };
    }
    if (!info.exists) {
      return { alive: false, owned: false };
    }
    if (!expectedStartId || !expectedMarker) {
      return { alive: true, owned: false };
    }
    if (info.startId !== expectedStartId || !info.command.includes(expectedMarker)) {
      return { alive: true, owned: false };
    }
    return { alive: true, owned: true };
  }

  const killFn = probes.killZero ?? defaultKillZero;
  const k = killFn(pid);
  if (k === 'esrch') return { alive: false, owned: false };
  if (k === 'eperm') return { alive: true, owned: false };

  if (platform === 'linux') {
    const statFn = probes.linuxStat ?? parseLinuxProcStat;
    const cmdFn = probes.linuxCmdline ?? readLinuxProcCmdline;
    const stat = statFn(pid);
    if (!stat) return { alive: false, owned: false };
    if (stat.state === 'Z' || stat.state === 'X') {
      return { alive: false, owned: true };
    }
    if (!expectedStartId || !expectedMarker || stat.startId !== expectedStartId) {
      return { alive: true, owned: false };
    }
    const cmdline = cmdFn(pid);
    if (cmdline === null || !cmdline.includes(expectedMarker)) {
      return { alive: true, owned: false };
    }
    return { alive: true, owned: true };
  }

  if (BSD_OR_DARWIN_PLATFORMS.has(platform)) {
    const psFn = probes.psQuery ?? queryPsProcess;
    const info = psFn(pid);
    if (!info) {
      // Distinguish process exit between kill(0) and ps vs unreadable ps output.
      if (killFn(pid) === 'esrch') return { alive: false, owned: false };
      return { alive: true, owned: false };
    }
    if (info.state.startsWith('Z') || info.state.startsWith('X')) {
      return { alive: false, owned: true };
    }
    if (!expectedStartId || !expectedMarker || info.startId !== expectedStartId) {
      return { alive: true, owned: false };
    }
    if (!info.command.includes(expectedMarker)) {
      return { alive: true, owned: false };
    }
    return { alive: true, owned: true };
  }

  // Unknown OS: fail closed — never assume ownership.
  return { alive: true, owned: false };
}

export function checkWorkerProcessStatus(
  pid: number | null,
  expectedStartId: string | null,
  expectedMarker: string | null,
): { alive: boolean; owned: boolean } {
  return evaluateWorkerProcessStatus(process.platform, pid, expectedStartId, expectedMarker);
}

function signalProcessGroup(pid: number, force: boolean): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', force ? ['/F', '/T', '/PID', String(pid)] : ['/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000,
      });
      return true;
    } catch {
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        return true;
      } catch {
        return false;
      }
    }
  }
  const sig: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, sig);
    return true;
  } catch (error) {
    if (!isErrorCode(error, 'ESRCH')) {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  }
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

async function resolveJobPaths(
  workspace: string,
  jobId: string,
  mode: 'existing' | 'create_exclusive',
) {
  const validId = validateEvidenceJobId(jobId);
  const root = await realpath(workspace);
  let jobDir: string;
  let runDir: string;

  if (mode === 'create_exclusive') {
    try {
      jobDir = await createExclusiveDirectory(root, ['.perfdigest', 'jobs'], validId);
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) {
        throw new Error(`Evidence job already exists: ${validId}`);
      }
      throw error;
    }
    try {
      runDir = await createExclusiveDirectory(root, ['.perfdigest', 'runs'], validId);
    } catch (error) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});
      if (isErrorCode(error, 'EEXIST')) {
        throw new Error(`Evidence job already exists: ${validId}`);
      }
      throw error;
    }
  } else {
    jobDir = join(root, '.perfdigest', 'jobs', validId);
    runDir = join(root, '.perfdigest', 'runs', validId);
  }

  return {
    workspace: root,
    jobId: validId,
    jobDir,
    runDir,
    statusPath: join(jobDir, 'state.json'),
    requestPath: join(jobDir, 'request.json'),
    manifestCopyPath: join(jobDir, 'manifest.json'),
    cancelledMarkerPath: join(jobDir, 'cancelled.marker'),
    logPath: join(jobDir, 'worker.log'),
    runJsonPath: join(runDir, 'run.json'),
    evidencePath: join(runDir, 'evidence.v1.json'),
    readyPath: join(runDir, 'ready.json'),
  };
}

async function readContainedJson<T>(workspace: string, filePath: string): Promise<T | null> {
  try {
    const safePath = await assertContainedRegularFile(workspace, filePath);
    const raw = await readFile(safePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

async function hasCancelledMarker(workspace: string, markerPath: string): Promise<boolean> {
  try {
    await assertContainedRegularFile(workspace, markerPath);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function createCancelledMarker(markerPath: string, jobId: string): Promise<void> {
  try {
    const handle = await open(markerPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ jobId, cancelledAt: new Date().toISOString() })}\n`);
      await handle.sync().catch(() => {});
    } finally {
      await handle.close();
    }
    await chmod(markerPath, 0o600).catch(() => {});
  } catch (error) {
    if (!isErrorCode(error, 'EEXIST')) throw error;
  }
}

async function writeRedactedJson(path: string, value: unknown): Promise<void> {
  await writePrivateFile(path, `${redactWorkerText(JSON.stringify(value, null, 2))}\n`);
}

function buildFallbackFailedPacket(errorText: string): Record<string, unknown> {
  return {
    schema: 'perfdigest.agent-evidence.v1',
    status: 'failed',
    decision: null,
    selected: [],
    verification: null,
    error: redactWorkerText(errorText),
  };
}

export async function runEvidenceWorker(options: EvidenceWorkerRunOptions): Promise<EvidenceRunOutput> {
  const manifest = manifestSchema.parse(options.manifest);
  const jobId = options.jobId ? validateEvidenceJobId(options.jobId) : generateEvidenceJobId();
  const paths = await resolveJobPaths(
    options.workspace,
    jobId,
    options.preserveCancelledState ? 'existing' : 'create_exclusive',
  );
  const compact = options.compactEvidence ?? true;
  const startedAt = new Date().toISOString();

  // Check cancellation BEFORE starting investigate() so pre-PID cancel stops captures & verification immediately.
  if (options.preserveCancelledState) {
    if (
      options.signal?.aborted ||
      (await hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)) ||
      (await readContainedJson<EvidenceJobState>(paths.workspace, paths.statusPath))?.status === 'cancelled'
    ) {
      throw new Error('Background evidence worker was cancelled');
    }
  }

  const result = await investigate({
    workspace: paths.workspace,
    manifest,
    routing: options.routing,
    agent: 'none',
    runDirectory: paths.runDir,
    evidenceDeliveryOverride: SKILL_BACKGROUND_DELIVERY_MODE,
    compactEvidence: compact,
    ...(options.cloudflareModel !== undefined ? { cloudflareModel: options.cloudflareModel } : {}),
    ...(options.includeCorroborating !== undefined ? { includeCorroborating: options.includeCorroborating } : {}),
    ...(options.decisionsMockURL !== undefined ? { decisionsMockURL: options.decisionsMockURL } : {}),
    ...(options.decisionProvider !== undefined ? { decisionProvider: options.decisionProvider } : {}),
    ...(options.mcpSessionOptions !== undefined ? { mcpSessionOptions: options.mcpSessionOptions } : {}),
    ...(options.reuseMcpSession !== undefined ? { reuseMcpSession: options.reuseMcpSession } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
  });

  const formattedRaw = formatAgentEvidence(result.evidence, result.verification, result.status, compact);
  const redactedText = `${redactWorkerText(formattedRaw)}\n`;
  const redactedBuf = Buffer.from(redactedText, 'utf8');
  const evidenceSha256 = sha256HexBuffer(redactedBuf);
  const packet = JSON.parse(redactedText) as Record<string, unknown>;

  // Write evidence.v1.json first (0600 atomic).
  await writePrivateFile(paths.evidencePath, redactedBuf);

  // Re-check cancellation marker RIGHT BEFORE sealing ready.json so cancel and completion never conflict.
  if (options.preserveCancelledState) {
    if (
      options.signal?.aborted ||
      (await hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)) ||
      (await readContainedJson<EvidenceJobState>(paths.workspace, paths.statusPath))?.status === 'cancelled'
    ) {
      await rm(paths.evidencePath, { force: true }).catch(() => {});
      throw new Error('Background evidence worker was cancelled');
    }
  }

  const completedAt = new Date().toISOString();
  const verificationExitCode = result.verification?.exitCode ?? null;
  const provenanceCount = result.provenance.length;
  const redactedError = result.error ? redactWorkerText(result.error) : null;

  const readyReceipt: EvidenceReadyReceipt = {
    version: 1,
    deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
    jobId,
    status: result.status,
    decisionOutcome: result.decisionOutcome,
    completedAt,
    runDir: paths.runDir,
    runJsonPath: paths.runJsonPath,
    evidencePath: paths.evidencePath,
    readyPath: paths.readyPath,
    evidenceSha256,
    verificationExitCode,
    provenanceCount,
    error: redactedError,
  };
  await writeRedactedJson(paths.readyPath, readyReceipt);

  const existingState = await readContainedJson<EvidenceJobState>(paths.workspace, paths.statusPath);
  const cancelledNow =
    options.preserveCancelledState &&
    (existingState?.status === 'cancelled' || (await hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)));

  if (!cancelledNow) {
    const finalState: EvidenceJobState = {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId,
      pid: existingState?.pid ?? process.pid,
      processStartId: existingState?.processStartId ?? readProcessStartId(process.pid),
      workerMarker: existingState?.workerMarker ?? jobId,
      status: result.status,
      startedAt: existingState?.startedAt ?? startedAt,
      updatedAt: completedAt,
      completedAt,
      workspace: paths.workspace,
      runDir: paths.runDir,
      runJsonPath: paths.runJsonPath,
      evidencePath: paths.evidencePath,
      readyPath: paths.readyPath,
      statusPath: paths.statusPath,
      logPath: paths.logPath,
      routing: options.routing,
      decisionOutcome: result.decisionOutcome,
      verificationExitCode,
      provenanceCount,
      error: redactedError,
    };
    await writeRedactedJson(paths.statusPath, finalState);
  }

  return {
    version: 1,
    deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
    jobId,
    status: result.status,
    decisionOutcome: result.decisionOutcome,
    runDir: paths.runDir,
    runJsonPath: paths.runJsonPath,
    evidencePath: paths.evidencePath,
    readyPath: paths.readyPath,
    evidenceSha256,
    verificationExitCode,
    provenanceCount,
    error: redactedError,
    packet,
  };
}

export async function startEvidenceWorker(options: EvidenceWorkerStartOptions): Promise<EvidenceStartOutput> {
  const manifest = manifestSchema.parse(options.manifest);
  const workspace = await realpath(options.workspace);

  // Preflight credentials & provider selection synchronously before spawning a detached worker.
  createDecisionProvider(options.routing, {
    ...(options.cloudflareModel !== undefined ? { cloudflareModel: options.cloudflareModel } : {}),
    ...(options.decisionsMockURL !== undefined ? { decisionsMockURL: options.decisionsMockURL } : {}),
  });

  const jobId = options.jobId ? validateEvidenceJobId(options.jobId) : generateEvidenceJobId();
  const paths = await resolveJobPaths(workspace, jobId, 'create_exclusive');

  let localEndpoint: string | undefined;
  if (providerName(options.routing) === 'local' && process.env.PERFDIGEST_CLEF_URL) {
    localEndpoint = validateLocalEndpoint(process.env.PERFDIGEST_CLEF_URL);
  }

  const requestPayload: WorkerRequestFile = {
    version: 1,
    jobId,
    routing: options.routing,
    compactEvidence: options.compactEvidence ?? true,
    includeCorroborating: options.includeCorroborating ?? false,
    ...(options.cloudflareModel !== undefined ? { cloudflareModel: options.cloudflareModel } : {}),
    ...(options.decisionsMockURL !== undefined ? { decisionsMockURL: options.decisionsMockURL } : {}),
    ...(localEndpoint !== undefined ? { localEndpoint } : {}),
    ...(options.mcpSessionOptions?.command !== undefined ? { mcpCommand: options.mcpSessionOptions.command } : {}),
    ...(options.mcpSessionOptions?.args !== undefined ? { mcpArgs: options.mcpSessionOptions.args } : {}),
    ...(options.reuseMcpSession !== undefined ? { reuseMcpSession: options.reuseMcpSession } : {}),
  };

  await writeRedactedJson(paths.manifestCopyPath, manifest);
  await writeRedactedJson(paths.requestPath, requestPayload);

  const startedAt = new Date().toISOString();
  const initialState: EvidenceJobState = {
    version: 1,
    deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
    jobId,
    pid: null,
    processStartId: null,
    workerMarker: jobId,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    workspace: paths.workspace,
    runDir: paths.runDir,
    runJsonPath: paths.runJsonPath,
    evidencePath: paths.evidencePath,
    readyPath: paths.readyPath,
    statusPath: paths.statusPath,
    logPath: paths.logPath,
    routing: options.routing,
    decisionOutcome: null,
    verificationExitCode: null,
    provenanceCount: 0,
    error: null,
  };
  await writeRedactedJson(paths.statusPath, initialState);

  const workerCmd = options.workerCommand ?? process.execPath;
  const cliScriptPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const workerArgs = [
    ...(options.workerArgsPrefix ?? (options.workerCommand ? [] : [cliScriptPath])),
    'evidence',
    '_worker',
    '--workspace',
    paths.workspace,
    '--job-id',
    jobId,
  ];

  // Open worker.log with 0600 permissions; spawn detached with allowlisted childEnvironment() (zero secrets in env or argv).
  const logFd = openSync(paths.logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(workerCmd, workerArgs, {
      cwd: paths.workspace,
      env: childEnvironment(),
      detached: true,
      shell: false,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }

  const pid = child.pid;
  if (!pid || pid <= 0) {
    throw new Error('Failed to spawn detached evidence worker process');
  }
  child.unref();

  const processStartId = readProcessStartId(pid);
  const now = new Date().toISOString();

  // If cancel raced during spawn before PID was recorded, terminate the just-spawned child immediately.
  if (await hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)) {
    const own = checkWorkerProcessStatus(pid, processStartId, jobId);
    if (own.alive && own.owned) {
      signalProcessGroup(pid, false);
    }
    await writeRedactedJson(paths.statusPath, {
      ...initialState,
      pid,
      processStartId,
      status: 'cancelled',
      updatedAt: now,
      completedAt: now,
      error: 'Cancelled during startup',
    });
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId,
      pid,
      status: 'running',
      statusPath: paths.statusPath,
      readyPath: paths.readyPath,
      runDir: paths.runDir,
    };
  }

  const readyAlready = await readContainedJson<EvidenceReadyReceipt>(paths.workspace, paths.readyPath);
  const updatedState: EvidenceJobState = readyAlready
    ? {
        ...initialState,
        pid,
        processStartId,
        status: readyAlready.status,
        updatedAt: now,
        completedAt: readyAlready.completedAt,
        decisionOutcome: readyAlready.decisionOutcome,
        verificationExitCode: readyAlready.verificationExitCode,
        provenanceCount: readyAlready.provenanceCount,
        error: readyAlready.error,
      }
    : {
        ...initialState,
        pid,
        processStartId,
        updatedAt: now,
      };
  await writeRedactedJson(paths.statusPath, updatedState);

  return {
    version: 1,
    deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
    jobId,
    pid,
    status: 'running',
    statusPath: paths.statusPath,
    readyPath: paths.readyPath,
    runDir: paths.runDir,
  };
}

export async function runDetachedEvidenceWorker(options: {
  workspace: string;
  jobId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const paths = await resolveJobPaths(options.workspace, options.jobId, 'existing');
  if (
    options.signal?.aborted ||
    (await hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)) ||
    (await readContainedJson<EvidenceJobState>(paths.workspace, paths.statusPath))?.status === 'cancelled'
  ) {
    return;
  }

  const req = await readContainedJson<WorkerRequestFile>(paths.workspace, paths.requestPath);
  if (!req || req.jobId !== paths.jobId) {
    throw new Error(`Missing or invalid worker request for job ${paths.jobId}`);
  }
  const rawManifest = await readContainedJson<unknown>(paths.workspace, paths.manifestCopyPath);
  if (!rawManifest) {
    throw new Error(`Missing worker manifest for job ${paths.jobId}`);
  }
  const manifest = manifestSchema.parse(rawManifest);

  // Load private envFile credentials strictly inside the worker process (never passed on argv or in request.json).
  const configured = await loadConfiguration(paths.workspace);
  if (configured && providerName(req.routing) !== 'offline') {
    await applyConfigurationEnvironment(configured, paths.workspace);
  }
  if (req.localEndpoint && providerName(req.routing) === 'local' && !process.env.PERFDIGEST_CLEF_URL) {
    process.env.PERFDIGEST_CLEF_URL = validateLocalEndpoint(req.localEndpoint);
  }

  const mcpSessionOptions: PerfDigestSessionOptions | undefined =
    req.mcpCommand || req.mcpArgs?.length
      ? {
          ...(req.mcpCommand ? { command: req.mcpCommand } : {}),
          ...(req.mcpArgs ? { args: req.mcpArgs } : {}),
        }
      : undefined;

  try {
    await runEvidenceWorker({
      workspace: paths.workspace,
      manifest,
      routing: req.routing,
      jobId: paths.jobId,
      compactEvidence: req.compactEvidence,
      includeCorroborating: req.includeCorroborating,
      preserveCancelledState: true,
      ...(req.cloudflareModel !== undefined ? { cloudflareModel: req.cloudflareModel } : {}),
      ...(req.decisionsMockURL !== undefined ? { decisionsMockURL: req.decisionsMockURL } : {}),
      ...(mcpSessionOptions !== undefined ? { mcpSessionOptions } : {}),
      ...(req.reuseMcpSession !== undefined ? { reuseMcpSession: req.reuseMcpSession } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (error) {
    const existingState = await readContainedJson<EvidenceJobState>(paths.workspace, paths.statusPath);
    if (
      options.signal?.aborted ||
      existingState?.status === 'cancelled' ||
      (await hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath))
    ) {
      return;
    }
    const errText = redactWorkerText(error instanceof Error ? error.message : String(error));
    const failedPacket = buildFallbackFailedPacket(errText);
    const failedBuf = Buffer.from(`${redactWorkerText(JSON.stringify(failedPacket))}\n`, 'utf8');
    const evidenceSha256 = sha256HexBuffer(failedBuf);
    const completedAt = new Date().toISOString();
    await writePrivateFile(paths.evidencePath, failedBuf);
    if (await hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath)) {
      await rm(paths.evidencePath, { force: true }).catch(() => {});
      return;
    }
    const readyReceipt: EvidenceReadyReceipt = {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      status: 'failed',
      decisionOutcome: 'not_reached',
      completedAt,
      runDir: paths.runDir,
      runJsonPath: paths.runJsonPath,
      evidencePath: paths.evidencePath,
      readyPath: paths.readyPath,
      evidenceSha256,
      verificationExitCode: null,
      provenanceCount: 0,
      error: errText,
    };
    await writeRedactedJson(paths.readyPath, readyReceipt);
    const failedState: EvidenceJobState = {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      pid: existingState?.pid ?? process.pid,
      processStartId: existingState?.processStartId ?? readProcessStartId(process.pid),
      workerMarker: existingState?.workerMarker ?? paths.jobId,
      status: 'failed',
      startedAt: existingState?.startedAt ?? completedAt,
      updatedAt: completedAt,
      completedAt,
      workspace: paths.workspace,
      runDir: paths.runDir,
      runJsonPath: paths.runJsonPath,
      evidencePath: paths.evidencePath,
      readyPath: paths.readyPath,
      statusPath: paths.statusPath,
      logPath: paths.logPath,
      routing: req.routing,
      decisionOutcome: 'not_reached',
      verificationExitCode: null,
      provenanceCount: 0,
      error: errText,
    };
    await writeRedactedJson(paths.statusPath, failedState);
    throw error;
  }
}

export async function getEvidenceWorkerStatus(options: {
  workspace: string;
  jobId: string;
}): Promise<EvidenceStatusOutput> {
  const paths = await resolveJobPaths(options.workspace, options.jobId, 'existing');
  const state = await readContainedJson<EvidenceJobState>(paths.workspace, paths.statusPath);
  if (!state || state.jobId !== paths.jobId) {
    throw new Error(`Evidence job not found: ${paths.jobId}`);
  }

  const startedMs = Date.parse(state.startedAt);
  const nowIso = new Date().toISOString();
  const computeElapsed = (endIso: string | null) => {
    const endMs = endIso ? Date.parse(endIso) : Date.now();
    return Number.isFinite(startedMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startedMs) : 0;
  };

  const ready = await readContainedJson<EvidenceReadyReceipt>(paths.workspace, paths.readyPath);
  if (ready) {
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      pid: state.pid,
      status: ready.status,
      ready: true,
      startedAt: state.startedAt,
      updatedAt: ready.completedAt,
      completedAt: ready.completedAt,
      elapsedMs: computeElapsed(ready.completedAt),
      runDir: paths.runDir,
      runJsonPath: paths.runJsonPath,
      evidencePath: paths.evidencePath,
      readyPath: paths.readyPath,
      statusPath: paths.statusPath,
      decisionOutcome: ready.decisionOutcome,
      verificationExitCode: ready.verificationExitCode,
      provenanceCount: ready.provenanceCount,
      evidenceSha256: ready.evidenceSha256,
      error: ready.error,
    };
  }

  if (state.status === 'cancelled' || (await hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath))) {
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      pid: state.pid,
      status: 'cancelled',
      ready: false,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      completedAt: state.completedAt,
      elapsedMs: computeElapsed(state.completedAt),
      runDir: paths.runDir,
      runJsonPath: paths.runJsonPath,
      evidencePath: paths.evidencePath,
      readyPath: paths.readyPath,
      statusPath: paths.statusPath,
      decisionOutcome: state.decisionOutcome,
      verificationExitCode: state.verificationExitCode,
      provenanceCount: state.provenanceCount,
      evidenceSha256: null,
      error: state.error,
    };
  }

  if (state.status !== 'running') {
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      pid: state.pid,
      status: state.status,
      ready: false,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      completedAt: state.completedAt,
      elapsedMs: computeElapsed(state.completedAt),
      runDir: paths.runDir,
      runJsonPath: paths.runJsonPath,
      evidencePath: paths.evidencePath,
      readyPath: paths.readyPath,
      statusPath: paths.statusPath,
      decisionOutcome: state.decisionOutcome,
      verificationExitCode: state.verificationExitCode,
      provenanceCount: state.provenanceCount,
      evidenceSha256: null,
      error: state.error,
    };
  }

  const proc = checkWorkerProcessStatus(state.pid, state.processStartId, state.workerMarker || paths.jobId);
  if (proc.alive && proc.owned) {
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      pid: state.pid,
      status: 'running',
      ready: false,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      completedAt: null,
      elapsedMs: computeElapsed(null),
      runDir: paths.runDir,
      runJsonPath: paths.runJsonPath,
      evidencePath: paths.evidencePath,
      readyPath: paths.readyPath,
      statusPath: paths.statusPath,
      decisionOutcome: null,
      verificationExitCode: null,
      provenanceCount: 0,
      evidenceSha256: null,
      error: null,
    };
  }

  // Re-check ready.json & cancellation once to guard against normal exit right before our liveness check.
  const readyRetry = await readContainedJson<EvidenceReadyReceipt>(paths.workspace, paths.readyPath);
  if (readyRetry) {
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      pid: state.pid,
      status: readyRetry.status,
      ready: true,
      startedAt: state.startedAt,
      updatedAt: readyRetry.completedAt,
      completedAt: readyRetry.completedAt,
      elapsedMs: computeElapsed(readyRetry.completedAt),
      runDir: paths.runDir,
      runJsonPath: paths.runJsonPath,
      evidencePath: paths.evidencePath,
      readyPath: paths.readyPath,
      statusPath: paths.statusPath,
      decisionOutcome: readyRetry.decisionOutcome,
      verificationExitCode: readyRetry.verificationExitCode,
      provenanceCount: readyRetry.provenanceCount,
      evidenceSha256: readyRetry.evidenceSha256,
      error: readyRetry.error,
    };
  }
  const stateRetry = await readContainedJson<EvidenceJobState>(paths.workspace, paths.statusPath);
  if (stateRetry?.status === 'cancelled' || (await hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath))) {
    const src = stateRetry ?? state;
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      pid: src.pid,
      status: 'cancelled',
      ready: false,
      startedAt: src.startedAt,
      updatedAt: src.updatedAt,
      completedAt: src.completedAt,
      elapsedMs: computeElapsed(src.completedAt),
      runDir: paths.runDir,
      runJsonPath: paths.runJsonPath,
      evidencePath: paths.evidencePath,
      readyPath: paths.readyPath,
      statusPath: paths.statusPath,
      decisionOutcome: src.decisionOutcome,
      verificationExitCode: src.verificationExitCode,
      provenanceCount: src.provenanceCount,
      evidenceSha256: null,
      error: src.error,
    };
  }

  const crashMsg = 'Background evidence worker process is no longer running and no ready.json receipt was produced';
  return {
    version: 1,
    deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
    jobId: paths.jobId,
    pid: state.pid,
    status: 'crashed',
    ready: false,
    startedAt: state.startedAt,
    updatedAt: nowIso,
    completedAt: null,
    elapsedMs: computeElapsed(null),
    runDir: paths.runDir,
    runJsonPath: paths.runJsonPath,
    evidencePath: paths.evidencePath,
    readyPath: paths.readyPath,
    statusPath: paths.statusPath,
    decisionOutcome: null,
    verificationExitCode: null,
    provenanceCount: 0,
    evidenceSha256: null,
    error: crashMsg,
  };
}

export async function collectEvidenceWorker(options: {
  workspace: string;
  jobId: string;
  full?: boolean;
}): Promise<EvidenceCollectOutput> {
  const paths = await resolveJobPaths(options.workspace, options.jobId, 'existing');
  const state = await readContainedJson<EvidenceJobState>(paths.workspace, paths.statusPath);
  if (!state || state.jobId !== paths.jobId) {
    throw new Error(`Evidence job not found: ${paths.jobId}`);
  }
  const ready = await readContainedJson<EvidenceReadyReceipt>(paths.workspace, paths.readyPath);
  if (!ready) {
    if (state.status === 'cancelled' || (await hasCancelledMarker(paths.workspace, paths.cancelledMarkerPath))) {
      throw new Error(`Evidence job ${paths.jobId} was cancelled`);
    }
    const statusInfo = await getEvidenceWorkerStatus({ workspace: paths.workspace, jobId: paths.jobId });
    throw new Error(`Evidence job ${paths.jobId} is not ready (status: ${statusInfo.status})`);
  }
  if (ready.jobId !== paths.jobId) {
    throw new Error('Evidence integrity check failed: ready.json jobId mismatch');
  }
  if (typeof ready.evidenceSha256 !== 'string' || !SHA256_HEX_PATTERN.test(ready.evidenceSha256)) {
    throw new Error('Evidence integrity check failed: invalid evidenceSha256 in ready.json');
  }

  const safeEvidencePath = await assertContainedRegularFile(paths.workspace, paths.evidencePath);
  const evidenceBuf = await readFile(safeEvidencePath);
  const actualSha256 = sha256HexBuffer(evidenceBuf);
  if (actualSha256 !== ready.evidenceSha256) {
    throw new Error(
      `Evidence integrity check failed: evidence.v1.json SHA-256 mismatch (expected ${ready.evidenceSha256}, got ${actualSha256})`,
    );
  }
  const packet = JSON.parse(evidenceBuf.toString('utf8')) as Record<string, unknown>;

  let run: RunResult | undefined;
  if (options.full) {
    const safeRunPath = await assertContainedRegularFile(paths.workspace, paths.runJsonPath);
    run = JSON.parse(await readFile(safeRunPath, 'utf8')) as RunResult;
  }

  return {
    version: 1,
    deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
    jobId: paths.jobId,
    status: ready.status,
    decisionOutcome: ready.decisionOutcome,
    runDir: paths.runDir,
    runJsonPath: paths.runJsonPath,
    evidencePath: paths.evidencePath,
    readyPath: paths.readyPath,
    evidenceSha256: actualSha256,
    verifiedSha256: true,
    verificationExitCode: ready.verificationExitCode,
    provenanceCount: ready.provenanceCount,
    error: ready.error,
    packet,
    ...(run !== undefined ? { run } : {}),
  };
}

export async function waitEvidenceWorker(options: {
  workspace: string;
  jobId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<EvidenceWaitOutput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVIDENCE_WAIT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_EVIDENCE_WAIT_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 0 and ${MAX_EVIDENCE_WAIT_TIMEOUT_MS}`);
  }
  const start = Date.now();
  const deadline = start + timeoutMs;

  while (true) {
    const status = await getEvidenceWorkerStatus({ workspace: options.workspace, jobId: options.jobId });
    if (status.status !== 'running') {
      const waitedMs = Math.max(0, Date.now() - start);
      if (status.ready && status.status !== 'cancelled') {
        const collected = await collectEvidenceWorker({ workspace: options.workspace, jobId: options.jobId });
        return {
          version: 1,
          deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
          jobId: collected.jobId,
          status: collected.status,
          timedOut: false,
          waitedMs,
          decisionOutcome: collected.decisionOutcome,
          runDir: collected.runDir,
          runJsonPath: collected.runJsonPath,
          evidencePath: collected.evidencePath,
          readyPath: collected.readyPath,
          evidenceSha256: collected.evidenceSha256,
          verificationExitCode: collected.verificationExitCode,
          provenanceCount: collected.provenanceCount,
          error: collected.error,
          packet: collected.packet,
        };
      }
      return {
        version: 1,
        deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
        jobId: status.jobId,
        status: status.status,
        timedOut: false,
        waitedMs,
        decisionOutcome: status.decisionOutcome,
        runDir: status.runDir,
        runJsonPath: status.runJsonPath,
        evidencePath: status.evidencePath,
        readyPath: status.readyPath,
        evidenceSha256: status.evidenceSha256,
        verificationExitCode: status.verificationExitCode,
        provenanceCount: status.provenanceCount,
        error: status.error,
        packet: null,
      };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        version: 1,
        deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
        jobId: status.jobId,
        status: 'running',
        timedOut: true,
        waitedMs: Math.max(0, Date.now() - start),
        decisionOutcome: null,
        runDir: status.runDir,
        runJsonPath: status.runJsonPath,
        evidencePath: status.evidencePath,
        readyPath: status.readyPath,
        evidenceSha256: null,
        verificationExitCode: null,
        provenanceCount: 0,
        error: null,
        packet: null,
      };
    }
    await sleepMs(Math.min(50, remaining), options.signal);
  }
}

export async function cancelEvidenceWorker(options: {
  workspace: string;
  jobId: string;
}): Promise<EvidenceCancelOutput> {
  const paths = await resolveJobPaths(options.workspace, options.jobId, 'existing');
  const state = await readContainedJson<EvidenceJobState>(paths.workspace, paths.statusPath);
  if (!state || state.jobId !== paths.jobId) {
    throw new Error(`Evidence job not found: ${paths.jobId}`);
  }
  const readyBefore = await readContainedJson<EvidenceReadyReceipt>(paths.workspace, paths.readyPath);
  if (readyBefore) {
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      status: readyBefore.status,
      alreadyTerminal: true,
      signalSent: null,
    };
  }
  if (state.status === 'cancelled') {
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      status: 'cancelled',
      alreadyTerminal: true,
      signalSent: null,
    };
  }
  if (state.status !== 'running') {
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      status: state.status,
      alreadyTerminal: true,
      signalSent: null,
    };
  }

  // Atomically create exclusive cancelled.marker first, then re-check ready.json to close the cancel-vs-completion race.
  await createCancelledMarker(paths.cancelledMarkerPath, paths.jobId);
  const readyAfter = await readContainedJson<EvidenceReadyReceipt>(paths.workspace, paths.readyPath);
  if (readyAfter) {
    await rm(paths.cancelledMarkerPath, { force: true }).catch(() => {});
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      status: readyAfter.status,
      alreadyTerminal: true,
      signalSent: null,
    };
  }

  // Re-read state.json so a PID written by startEvidenceWorker just before cancel is observed.
  const latestState = (await readContainedJson<EvidenceJobState>(paths.workspace, paths.statusPath)) ?? state;
  const proc = checkWorkerProcessStatus(
    latestState.pid,
    latestState.processStartId,
    latestState.workerMarker || paths.jobId,
  );
  const now = new Date().toISOString();
  const markCancelled = async (note?: string) => {
    const cancelledState: EvidenceJobState = {
      ...latestState,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
      completedAt: now,
      error: note ?? 'Cancelled by caller',
    };
    await writeRedactedJson(paths.statusPath, cancelledState);
  };

  if (proc.alive && !proc.owned) {
    await markCancelled('PID ownership mismatch; skipped signal');
    return {
      version: 1,
      deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
      jobId: paths.jobId,
      status: 'cancelled',
      alreadyTerminal: false,
      signalSent: null,
      note: 'pid_ownership_mismatch_skipped_signal',
    };
  }

  await markCancelled();

  let signalSent: 'SIGTERM' | 'SIGKILL' | null = null;
  if (proc.alive && proc.owned && latestState.pid !== null) {
    if (signalProcessGroup(latestState.pid, false)) {
      signalSent = 'SIGTERM';
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const check = checkWorkerProcessStatus(
        latestState.pid,
        latestState.processStartId,
        latestState.workerMarker || paths.jobId,
      );
      if (!check.alive || !check.owned) break;
      await sleepMs(25);
    }
    const afterTerm = checkWorkerProcessStatus(
      latestState.pid,
      latestState.processStartId,
      latestState.workerMarker || paths.jobId,
    );
    if (afterTerm.alive && afterTerm.owned) {
      if (signalProcessGroup(latestState.pid, true)) {
        signalSent = 'SIGKILL';
      }
      const killDeadline = Date.now() + 500;
      while (Date.now() < killDeadline) {
        const check = checkWorkerProcessStatus(
          latestState.pid,
          latestState.processStartId,
          latestState.workerMarker || paths.jobId,
        );
        if (!check.alive || !check.owned) break;
        await sleepMs(25);
      }
    }
  }

  return {
    version: 1,
    deliveryMode: SKILL_BACKGROUND_DELIVERY_MODE,
    jobId: paths.jobId,
    status: 'cancelled',
    alreadyTerminal: false,
    signalSent,
  };
}
