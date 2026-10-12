import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportFile } from '../src/files.js';
import { commandPassed, runCommand } from '../src/commands.js';
import { manifestSchema } from '../src/config.js';

test('artifact paths cannot escape by traversal or symlink and bytes have a stable hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perfdigest-files-'));
  try {
    const workspace = join(root, 'project'); await mkdir(workspace);
    await writeFile(join(workspace, 'report.json'), '{"metric":null}');
    await writeFile(join(root, 'outside.json'), '{}');
    await symlink(join(root, 'outside.json'), join(workspace, 'link.json'));
    const first = await reportFile(workspace, 'report.json');
    assert.equal(first.sha256.length, 64); assert.equal(first.bytes, 15);
    await assert.rejects(reportFile(workspace, '../outside.json'), /inside the workspace/);
    await assert.rejects(reportFile(workspace, 'link.json'), /inside the workspace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nonzero exit, timeout and cancellation cannot pass verification', async () => {
  const failure = await runCommand({ command: process.execPath, args: ['-e', 'process.exit(7)'], timeoutMs: 2000 }, process.cwd());
  assert.equal(failure.exitCode, 7); assert.equal(commandPassed(failure), false);
  const timeout = await runCommand({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 }, process.cwd());
  assert.equal(timeout.timedOut, true); assert.equal(commandPassed(timeout), false);
  const controller = new AbortController();
  const pending = runCommand({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 2000 }, process.cwd(), controller.signal);
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.aborted, true); assert.equal(commandPassed(cancelled), false);
});

test('manifest requires an independent verification command and unique report IDs', () => {
  const report = { id: 'cpu', path: 'cpu.json', format: 'perf-stat-json', description: 'CPU' };
  assert.equal(manifestSchema.safeParse({ version: 1, issue: 'issue', reports: [report] }).success, false);
  assert.equal(manifestSchema.safeParse({ version: 1, issue: 'issue', reports: [report, report],
    verification: { command: 'node', args: [] } }).success, false);
});
