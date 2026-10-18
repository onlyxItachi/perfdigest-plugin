import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { manifestSchema } from '../src/config.js';
import { investigate } from '../src/run.js';
import { fixtureUv, testDirectory } from './helpers.js';

// Network-free contract tests: Cloudflare responses are synthetic and fetch is replaced in-process.
const account = 'a'.repeat(32);
const token = 'synthetic-provenance-token';

function cloudflare(answer: Record<string, unknown>, model = 'clef-flash') {
  return new Response(JSON.stringify({ success: true, errors: [],
    result: { model, answers: { next_evidence: { type: 'choice', ...answer } }, usage: { input_tokens: 5, output_tokens: 0 } } }));
}
const choice = (choice: string, confidence: number, p: number) =>
  ({ choice, confidence, probabilities: choice === 'trace' ? { trace: p, __human_review__: 1 - p } : { trace: 1 - p, __human_review__: p } });

async function withRun(t: test.TestContext, label: string, respond: () => Response | Promise<Response>,
  manifestOverrides: Record<string, unknown> = {}) {
  const root = await testDirectory(label);
  const saved = { path: process.env.PATH, account: process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID, token: process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN };
  const fetch = globalThis.fetch;
  let requests = 0;
  t.after(async () => {
    globalThis.fetch = fetch; process.env.PATH = saved.path;
    if (saved.account === undefined) delete process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID; else process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID = saved.account;
    if (saved.token === undefined) delete process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN; else process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN = saved.token;
    await rm(root, { recursive: true, force: true });
  });
  process.env.PATH = `${await fixtureUv(root)}${delimiter}${saved.path}`;
  process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID = account;
  process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN = token;
  globalThis.fetch = async () => { requests++; return respond(); };
  const bytes = '{"traceEvents":[]}';
  await writeFile(join(root, 'trace.json'), bytes);
  const manifest = manifestSchema.parse({ version: 1, issue: 'provenance fixture',
    reports: [{ id: 'trace', path: 'trace.json', format: 'chrome-trace', description: 'Synthetic test input' }],
    verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] }, ...manifestOverrides });
  const result = await investigate({ workspace: root, manifest, routing: 'cloudflare', agent: 'none' });
  const receipt = JSON.parse(await readFile(join(result.directory, 'run.json'), 'utf8'));
  return { result, receipt, requests: () => requests, sha256: createHash('sha256').update(bytes).digest('hex'), root };
}

function assertProvenance(receipt: { provenance: Array<Record<string, unknown>> }, sha256: string, delivered: boolean) {
  assert.equal(receipt.provenance.length, 1);
  assert.deepEqual({ ...receipt.provenance[0], modifiedAt: undefined },
    { id: 'trace', reference: 'trace.json', format: 'chrome-trace', sha256, bytes: 18, provenance: 'perfdigest_mcp', delivered, modifiedAt: undefined });
  assert.equal(JSON.stringify(receipt).includes(token), false, 'credential never reaches the receipt');
}

test('accepted route at exactly the unchanged 0.65 policy delivers evidence with provenance', async t => {
  const { result, receipt, requests, sha256 } = await withRun(t, 'prov-accepted', () => cloudflare(choice('trace', 0.65, 0.825)));
  assert.equal(result.status, 'complete'); assert.equal(result.decisionOutcome, 'accepted'); assert.equal(requests(), 1);
  assert.equal(result.evidence?.evidence.length, 1); assert.equal(result.evidence?.evidence[0]?.sha256, sha256);
  assertProvenance(receipt, sha256, true);
  assert.deepEqual(result.evidence?.considered, result.provenance);
});

test('low-confidence abstention keeps hash-checked provenance without delivering evidence', async t => {
  const { result, receipt, requests, sha256 } = await withRun(t, 'prov-low', () => cloudflare(choice('trace', 0.6499, 0.82)));
  assert.equal(result.status, 'needs_review'); assert.equal(result.decisionOutcome, 'abstained'); assert.equal(requests(), 1);
  assert.equal(result.evidence?.decision.reason, 'low_confidence');
  assert.equal(result.evidence?.decision.selectedId, null, '0.6499 stays below the unchanged policy');
  assert.deepEqual(result.evidence?.evidence, []);
  assert.equal(result.verification?.exitCode, 0);
  assertProvenance(receipt, sha256, false);
  assert.deepEqual(receipt.evidence.considered, receipt.provenance);
});

test('human-review abstention keeps provenance', async t => {
  const { result, receipt, sha256 } = await withRun(t, 'prov-human', () => cloudflare(choice('__human_review__', 0.9, 0.95)));
  assert.equal(result.decisionOutcome, 'abstained'); assert.equal(result.evidence?.decision.reason, 'human_review');
  assertProvenance(receipt, sha256, false);
});

test('rejected provider responses fail without fallback and keep provenance', async t => {
  for (const [label, respond] of [
    ['identity', () => cloudflare(choice('trace', 0.9, 0.95), 'unrecognized-model')],
    ['unknown-choice', () => cloudflare({ choice: 'invented', confidence: 0.9, probabilities: { invented: 0.95, __human_review__: 0.05 } })],
    ['http-400', () => new Response('{"success":false,"errors":[{"code":5004}]}', { status: 400 })],
  ] as const) {
    const { result, receipt, requests, sha256 } = await withRun(t, `prov-rejected-${label}`, respond);
    assert.equal(result.status, 'failed', label); assert.equal(result.decisionOutcome, 'rejected', label);
    assert.equal(result.decisionsError?.kind, 'schema'); assert.equal(requests(), 1, 'no retry');
    assert.equal(result.evidence, null); assert.equal(result.verification, null);
    assertProvenance(receipt, sha256, false);
  }
});

test('failed provider requests keep provenance and never retry or fall back', async t => {
  for (const [label, kind, respond] of [
    ['network', 'network', () => { throw new Error(`echo ${token}`); }],
    ['auth', 'authentication', () => new Response(`{"success":false,"errors":[{"code":10000,"message":"${token}"}]}`, { status: 401 })],
    ['quota', 'billing', () => new Response('{"success":false,"errors":[{"code":3036}]}', { status: 429 })],
  ] as const) {
    const { result, receipt, requests, sha256 } = await withRun(t, `prov-failed-${label}`, respond);
    assert.equal(result.status, 'failed', label); assert.equal(result.decisionOutcome, 'failed', label);
    assert.equal(result.decisionsError?.kind, kind); assert.equal(requests(), 1);
    assertProvenance(receipt, sha256, false);
  }
});

test('a capture failure before routing reports not_reached with no provenance', async t => {
  const { result, receipt, requests } = await withRun(t, 'prov-not-reached', () => cloudflare(choice('trace', 0.9, 0.95)),
    { captures: [{ command: process.execPath, args: ['-e', 'process.exit(4)'] }] });
  assert.equal(result.decisionOutcome, 'not_reached'); assert.equal(requests(), 0);
  assert.deepEqual(receipt.provenance, []);
});

test('report.md is written with private permissions', { skip: process.platform === 'win32' }, async t => {
  const { result } = await withRun(t, 'prov-mode', () => cloudflare(choice('trace', 0.6, 0.8)));
  assert.equal((await stat(join(result.directory, 'report.md'))).mode & 0o777, 0o600);
});
