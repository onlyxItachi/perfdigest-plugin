import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { manifestSchema } from '../src/config.js';
import { investigate } from '../src/run.js';
import { gatherEvidence } from '../src/evidence.js';
import { validateDigest } from '../src/perfdigest.js';
import { disabledMcpOverrides } from '../src/codex.js';
import { fixtureUv, testDirectory } from './helpers.js';

test('deterministic evidence uses the MCP wire protocol, preserves nulls and hashes; verification failure wins', async () => {
  const root = await testDirectory('pipeline');
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${await fixtureUv(root)}${delimiter}${oldPath}`;
    await writeFile(join(root, 'trace.json'), '{}');
    const manifest = manifestSchema.parse({ version: 1, issue: 'fixture question',
      reports: [{ id: 'trace', path: 'trace.json', format: 'chrome-trace', description: 'Synthetic test input' }],
      verification: { command: process.execPath, args: ['-e', 'process.exit(3)'] } });
    const first = await investigate({ workspace: root, manifest, routing: 'offline', agent: 'none' });
    assert.equal(first.status, 'failed');
    assert.equal(first.verification?.exitCode, 3);
    assert.equal(first.evidence?.status, 'complete');
    assert.equal(first.evidence?.decision.requests, 0);
    const second = await gatherEvidence({ workspace: root, issue: manifest.issue, reports: manifest.reports, routing: 'offline' });
    assert.deepEqual(second, first.evidence);
    assert.equal(((second.evidence[0]?.digest.units as Array<{metrics: {cache_misses: unknown}}>)[0]!).metrics.cache_misses, null);
    const receipt = JSON.parse(await readFile(join(first.directory, 'run.json'), 'utf8'));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.telemetry.costUsd, null);
    assert.equal(receipt.telemetry.patchApplied, false);
  } finally { process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }); }
});

test('failed captures and unchanged artifacts are never reused as fresh evidence', async () => {
  const root = await testDirectory('capture');
  try {
    await writeFile(join(root, 'trace.json'), '{}');
    for (const exitCode of [9, 0]) {
      const manifest = manifestSchema.parse({ version: 1, issue: 'fixture',
        captures: [{ command: process.execPath, args: ['-e', `process.exit(${exitCode})`] }],
        reports: [{ id: 'trace', path: 'trace.json', format: 'chrome-trace', description: 'Old artifact' }],
        verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] } });
      const result = await investigate({ workspace: root, manifest, routing: 'offline', agent: 'none' });
      assert.equal(result.status, 'failed'); assert.equal(result.evidence, null); assert.equal(result.verification, null);
      assert.match(result.error!, exitCode ? /Capture failed/ : /did not refresh/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP errors, empty digests, concurrent mutation and cancellation cannot become evidence', async () => {
  const root = await testDirectory('digest');
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${await fixtureUv(root)}${delimiter}${oldPath}`;
    const reports = [{ id: 'trace', path: 'trace.json', format: 'chrome-trace', description: 'Fixture' }];
    for (const [mode, message] of [['error', /tool error/], ['empty', /nonempty digest/], ['change', /changed while digesting/]] as const) {
      await writeFile(join(root, 'trace.json'), JSON.stringify({ mode }));
      await assert.rejects(gatherEvidence({ workspace: root, issue: 'fixture', reports, routing: 'offline' }), message);
    }
    await writeFile(join(root, 'trace.json'), JSON.stringify({ mode: 'slow' }));
    await assert.rejects(gatherEvidence({ workspace: root, issue: 'fixture', reports, routing: 'offline', signal: AbortSignal.timeout(100) }));
  } finally { process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }); }
});

test('invalid digest bindings and inherited MCP names fail closed', () => {
  const digest = { format: 'chrome-trace', raw_ref: '/trace', total_units: 1, returned: 1, units: [{ duration_us: null }] };
  assert.throws(() => validateDigest(digest, 'perf-stat-json', '/trace'));
  assert.throws(() => validateDigest(digest, 'chrome-trace', '/different'));
  assert.deepEqual(disabledMcpOverrides(['tool-name']), ['mcp_servers.tool-name={command="false",enabled=false}']);
  assert.throws(() => disabledMcpOverrides(['bad.name']));
});
