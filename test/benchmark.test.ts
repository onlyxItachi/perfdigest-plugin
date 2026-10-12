import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { benchmarkArm, cpuOracle, gradeCpuAnswer, measuredOverlap, observedUsage, trialOrder } from '../src/benchmark.js';
import { manifestSchema } from '../src/config.js';
import { reportFile } from '../src/files.js';
import { fixtureUv, testDirectory } from './helpers.js';
import type { TimelineEvent } from '../src/config.js';

test('controlled CPU grading uses raw measured durations and rejects absent metrics and unjustified causal claims', () => {
  assert.equal(cpuOracle({ traceEvents: [{ ph: 'X', name: 'row_major', dur: 5 },
    { ph: 'X', name: 'row_major', dur: 5 }, { ph: 'X', name: 'column_major', dur: 9 }] }), 'row_major');
  assert.throws(() => cpuOracle({ traceEvents: [{ ph: 'X', name: 'column_major', dur: 0 }] }), /Missing duration/);
  assert.throws(() => cpuOracle({ traceEvents: [{ ph: 'X', name: 'row_major', dur: null }] }));
  assert.equal(gradeCpuAnswer(JSON.stringify({ slowerRegion: 'row_major', verificationPassed: true, cacheCauseProven: false }), 'row_major', true).passed, true);
  assert.equal(gradeCpuAnswer(JSON.stringify({ slowerRegion: 'row_major', verificationPassed: true, cacheCauseProven: true }), 'row_major', true).passed, false);
  assert.equal(gradeCpuAnswer(JSON.stringify({ slowerRegion: 'row_major', verificationPassed: true, cacheCauseProven: false }), 'row_major', false).passed, false);
  assert.equal(gradeCpuAnswer('not JSON', 'row_major', true).passed, false);
});

test('benchmark never invents zero token usage or overlap, and rotates all arm positions', () => {
  assert.equal(observedUsage([null, null]), null);
  const timeline = (name: string, elapsedMs: number): TimelineEvent => ({ event: name, elapsedMs, at: 'fixture' });
  const model = [timeline('codex.analysis.turn_started', 10), timeline('codex.analysis.completed', 20)];
  assert.equal(measuredOverlap([timeline('collection.started', 1), timeline('collection.completed', 9), ...model]), 0);
  assert.equal(measuredOverlap([timeline('collection.started', 1), timeline('collection.completed', 15), ...model]), 5);
  assert.equal(measuredOverlap([timeline('collection.started', 1), timeline('collection.completed', 15)]), null);
  for (let position = 0; position < 3; position++) assert.equal(new Set([0, 1, 2].map(t => trialOrder(t)[position])).size, 3);
  assert.throws(() => trialOrder(-1));
});

test('comparison records failed verification and rejects changed shared evidence without inventing model observations', async () => {
  const root = await testDirectory('benchmark');
  const prior = process.env.PATH;
  try {
    process.env.PATH = `${await fixtureUv(root)}${delimiter}${prior}`;
    await writeFile(join(root, 'trace.json'), '{}');
    const hash = (await reportFile(root, 'trace.json')).sha256;
    const manifest = manifestSchema.parse({ version: 1, issue: 'Controlled test',
      reports: [{ id: 'trace', path: 'trace.json', format: 'chrome-trace', description: 'Synthetic MCP fixture' }],
      verification: { command: process.execPath, args: ['-e', 'process.exit(7)'] } });
    const result = await benchmarkArm({ workspace: root, manifest, arm: 'C_fixture_prefetch',
      agent: 'none', expected: 'row_major', expectedHashes: { trace: hash } });
    assert.equal(result.status, 'failed'); assert.equal(result.verification?.exitCode, 7);
    assert.equal(result.decisions.execution, 'fixture_no_network');
    assert.equal(result.decisions.fixtureRequests, 1); assert.equal(result.decisions.liveRequests, 0);
    assert.equal(result.decisions.observedTokenUsage, null); assert.equal(result.telemetry.modelUsage, null);
    assert.equal(result.modelReadingGrade, null); assert.equal(result.telemetry.actualModelOverlapMs, null);
    await writeFile(join(root, 'trace.json'), '{"changed":true}');
    const changed = await benchmarkArm({ workspace: root, manifest, arm: 'A_raw',
      agent: 'none', expected: 'row_major', expectedHashes: { trace: hash } });
    assert.equal(changed.status, 'failed'); assert.match(changed.error!, /Shared capture changed/);
    assert.equal(changed.verification, null);
  } finally {
    if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior;
    await rm(root, { recursive: true, force: true });
  }
});
