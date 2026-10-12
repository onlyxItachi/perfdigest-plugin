import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { childEnvironment, redact } from './environment.js';
import type { CommandReceipt, CommandSpec } from './config.js';

export async function runCommand(spec: CommandSpec, cwd: string, signal?: AbortSignal): Promise<CommandReceipt> {
  signal?.throwIfAborted();
  const started = performance.now();
  const receipt: CommandReceipt = { command: spec.command, args: spec.args,
    startedAt: new Date().toISOString(), elapsedMs: 0, exitCode: null, signal: null,
    timedOut: false, aborted: false, stdout: '', stderr: '' };
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd, env: childEnvironment(), shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let escalation: NodeJS.Timeout | undefined;
    const kill = (kind: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.platform === 'win32' ? child.kill(kind) : process.kill(-child.pid, kind); } catch { /* Already exited. */ }
    };
    const stop = () => { kill('SIGTERM'); escalation ??= setTimeout(() => kill('SIGKILL'), 500); };
    const abort = () => { receipt.aborted = true; stop(); };
    const timer = setTimeout(() => { receipt.timedOut = true; stop(); }, spec.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // Keep bounded text; raw profiler artifacts are separate files, never stdout prompts.
    const append = (key: 'stdout' | 'stderr', data: Buffer) => {
      if (receipt[key].length < 64_000) receipt[key] += data.toString('utf8').slice(0, 64_000 - receipt[key].length);
    };
    child.stdout.on('data', (data: Buffer) => append('stdout', data));
    child.stderr.on('data', (data: Buffer) => append('stderr', data));
    const cleanup = () => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
    };
    child.once('error', error => { cleanup(); reject(new Error(redact(error.message))); });
    child.once('close', (code, exitSignal) => {
      cleanup(); receipt.exitCode = code; receipt.signal = exitSignal;
      receipt.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
      receipt.stdout = redact(receipt.stdout); receipt.stderr = redact(receipt.stderr);
      resolve(receipt);
    });
  });
}

export function commandPassed(receipt: CommandReceipt): boolean {
  return receipt.exitCode === 0 && !receipt.timedOut && !receipt.aborted && receipt.signal === null;
}
