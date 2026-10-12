import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import OpenAI from 'openai';
import { localDecisionsClient, selectReport, DecisionsError, decisionsInput, authenticationBoundarySmoke } from '../src/decisions.js';
import type { EvidencePacket, ReportSpec } from '../src/config.js';
import { manifestSchema } from '../src/config.js';
import { investigate } from '../src/run.js';
import { gatherEvidence } from '../src/evidence.js';
import { fixtureUv, testDirectory } from './helpers.js';

const reports: ReportSpec[] = [{ id: 'cpu', path: '/private/local/trace.json', format: 'chrome-trace', description: 'Elapsed CPU spans' }];
const valid = { model: 'gpt-6-luna', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  answers: [{ type: 'choice', name: 'next_evidence', choice: 'cpu', confidence: 0.9,
    probabilities: [{ value: 'cpu', probability: 0.9 }, { value: '__human_review__', probability: 0.1 }] }] };
async function httpFixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}

const evidence: EvidencePacket['evidence'] = [{ report: reports[0]!, sha256: 'a'.repeat(64), bytes: 321,
  modifiedAt: '2026-10-12T00:00:00Z', provenance: 'perfdigest_mcp', digest: { format: 'chrome-trace', raw_ref: '/private/local/trace.json',
    total_units: 1, returned: 1, total_duration_us: 10, coverage_pct_of_total_duration: 100,
    secretExtra: 'must-not-send', units: [{ name: '/private/source.cc', index: 0, duration_us: 10,
      metrics: { count: 0, cache_misses: null, instructions: 'not_available_in_this_export' } }] } }];

test('real loopback HTTP + official SDK maps measured evidence without paths, zero-filling or retries', async () => {
  let requests = 0; let received: any;
  const fixture = await httpFixture(async (req, res) => {
    requests++; assert.equal(req.url, '/v1/decisions'); assert.equal(req.method, 'POST');
    let text = ''; for await (const chunk of req) text += chunk;
    received = JSON.parse(text);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(valid));
  });
  try {
    const result = await selectReport(localDecisionsClient(fixture.url), 'CPU question', reports, undefined, evidence);
    assert.equal(requests, 1); assert.equal(result.selectedId, 'cpu'); assert.equal(result.transport, 'local_mock');
    assert.equal(result.evidenceCount, 1); assert.match(result.inputSha256!, /^[a-f0-9]{64}$/);
    const input = JSON.parse(received.input);
    assert.equal(input.reports[0].evidence.artifact_sha256, evidence[0]!.sha256);
    assert.deepEqual(input.reports[0].evidence.summary.units[0].metrics,
      { count: 0, cache_misses: null, instructions: 'not_available_in_this_export' });
    assert.ok(!received.input.includes('/private')); assert.ok(!received.input.includes('must-not-send'));
  } finally { await fixture.close(); }
});

test('HTTP failures and malformed successful responses are categorized, sanitized and never retried', async () => {
  for (const [status, code, kind] of [
    [401, 'invalid_api_key', 'authentication'], [402, 'payment_required', 'billing'],
    [429, 'insufficient_quota', 'billing'], [429, 'rate_limit_exceeded', 'rate_limit'],
    [400, 'invalid_request_error', 'schema'], [422, 'invalid_request_error', 'schema'],
    [403, 'access_denied', 'permission'], [503, 'unavailable', 'service'], [200, '', 'schema'],
  ] as const) {
    let requests = 0;
    const fixture = await httpFixture((req, res) => {
      req.resume(); requests++;
      res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'secret-header-must-not-leak' });
      res.end(status === 200 ? '{malformed JSON' : JSON.stringify({ error: { code, type: code,
        message: 'Authorization: Bearer synthetic-secret-must-not-leak' } }));
    });
    try {
      // Caller retry/debug settings cannot override the adapter's boundary.
      let logs = 0;
      const client = new OpenAI({ apiKey: 'fixture-only', baseURL: fixture.url, maxRetries: 4, logLevel: 'debug',
        logger: { debug() { logs++; }, info() { logs++; }, warn() { logs++; }, error() { logs++; } } });
      await assert.rejects(selectReport(client, 'test', reports), (error: unknown) => {
        assert.ok(error instanceof DecisionsError); assert.equal(error.kind, kind);
        assert.ok(!JSON.stringify(error).includes('must-not-leak'));
        assert.ok(!error.stack?.includes('Bearer')); assert.equal((error as Error).cause, undefined); return true;
      });
      assert.equal(requests, 1, `${status} must not retry`); assert.equal(logs, 0);
    } finally { await fixture.close(); }
  }
});

test('connection failure and redirects fail closed without forwarding credentials or retrying', async () => {
  let redirected = 0; let initial = 0;
  const target = await httpFixture((req, res) => { req.resume(); redirected++; res.end('{}'); });
  const origin = await httpFixture((req, res) => {
    req.resume(); initial++; res.writeHead(307, { location: `${target.url}/decisions` }); res.end();
  });
  try {
    await assert.rejects(selectReport(localDecisionsClient(origin.url), 'test', reports), { kind: 'network' });
    assert.equal(initial, 1); assert.equal(redirected, 0);
  } finally { await origin.close(); await target.close(); }
  let calls = 0;
  const client = new OpenAI({ apiKey: 'fixture', fetch: async () => { calls++; throw new Error('secret transport details'); } });
  await assert.rejects(selectReport(client, 'test', reports), (e: unknown) => e instanceof DecisionsError && e.kind === 'network' && !e.message.includes('secret'));
  assert.equal(calls, 1);
});

test('mock endpoints and malformed evidence fail before sending a request', () => {
  for (const url of ['https://api.openai.com/v1', 'http://localhost:8888/v1', 'http://user:pass@127.0.0.1:8888/v1']) {
    assert.throws(() => localDecisionsClient(url), { kind: 'schema' });
  }
  assert.throws(() => decisionsInput('issue', reports, [{ ...evidence[0]!, sha256: 'wrong' }]), { kind: 'schema' });
  assert.throws(() => decisionsInput('issue', reports, [evidence[0]!, evidence[0]!]), { kind: 'schema' });
});

test('runner records typed Decisions failure and never runs verification or substitutes mock/offline success', async () => {
  const workspace = await testDirectory('http-failure');
  const path = process.env.PATH;
  let requests = 0;
  const fixture = await httpFixture((req, res) => {
    req.resume(); requests++; res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Authorization: Bearer do-not-record', code: 'invalid_api_key' } }));
  });
  try {
    process.env.PATH = `${await fixtureUv(workspace)}${delimiter}${path}`;
    await writeFile(join(workspace, 'trace.json'), '{}');
    const manifest = manifestSchema.parse({ version: 1, issue: 'Fixture pipeline error',
      reports: [{ ...reports[0], path: 'trace.json' }],
      verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] } });
    const result = await investigate({ workspace, manifest, agent: 'none', routing: 'decisions', decisionsMockURL: fixture.url });
    assert.equal(requests, 1); assert.equal(result.status, 'failed'); assert.equal(result.evidence, null);
    assert.equal(result.verification, null); assert.equal(result.decisionsError?.kind, 'authentication');
    assert.equal(result.decisionsError?.httpStatus, 401);
    const saved = await readFile(join(result.directory, 'run.json'), 'utf8');
    assert.ok(!saved.includes('do-not-record')); assert.ok(!saved.includes('Bearer'));
  } finally { process.env.PATH = path; await fixture.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('a report modified during the Decisions request invalidates the measured route', async () => {
  const workspace = await testDirectory('routing-mutation'); const path = process.env.PATH;
  const fixture = await httpFixture(async (req, res) => {
    req.resume(); await writeFile(join(workspace, 'trace.json'), '{"changed":true}');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(valid));
  });
  try {
    process.env.PATH = `${await fixtureUv(workspace)}${delimiter}${path}`;
    await writeFile(join(workspace, 'trace.json'), '{}');
    await assert.rejects(gatherEvidence({ workspace, issue: 'Fixture mutation', reports: [{ ...reports[0]!, path: 'trace.json' }],
      routing: 'decisions', client: localDecisionsClient(fixture.url) }), /changed while routing/);
  } finally { process.env.PATH = path; await fixture.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('auth-boundary diagnostic is opt-in, single-request and immune to real credential/default overrides', async () => {
  const prior = { ...process.env }; const fetch = globalThis.fetch;
  let requests = 0;
  try {
    delete process.env.PERFDIGEST_RUN_AUTH_BOUNDARY;
    globalThis.fetch = async () => { throw new Error('Disabled diagnostic must not fetch'); };
    assert.deepEqual(await authenticationBoundarySmoke(), { status: 'skipped', requests: 0, liveInferenceValidated: false });
    Object.assign(process.env, { PERFDIGEST_RUN_AUTH_BOUNDARY: '1', PERFDIGEST_DECISIONS_API_KEY: 'never-use-real-key',
      OPENAI_API_KEY: 'never-use-generic-key', OPENAI_ADMIN_KEY: 'never-use-admin-key', OPENAI_LOG: 'debug',
      OPENAI_BASE_URL: 'https://must-not-contact.invalid', OPENAI_ORG_ID: 'must-not-send', OPENAI_PROJECT_ID: 'must-not-send' });
    globalThis.fetch = async (url, init) => {
      requests++; assert.equal(String(url), 'https://api.openai.com/v1/decisions'); assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization') === 'Bearer intentionally-invalid-perfdigest-auth-boundary', true);
      assert.equal(headers.get('openai-organization'), null); assert.equal(headers.get('openai-project'), null);
      assert.ok(!String(init?.body).includes('artifact_sha256'));
      return new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'private reflection' } }), { status: 401 });
    };
    const result = await authenticationBoundarySmoke();
    assert.equal(result.status, 'passed'); assert.equal(requests, 1); assert.equal(result.liveInferenceValidated, false);
    requests = 0;
    globalThis.fetch = async () => { requests++; return new Response(JSON.stringify(valid), { headers: { 'content-type': 'application/json' } }); };
    await assert.rejects(authenticationBoundarySmoke()); assert.equal(requests, 1, 'unexpected response cannot trigger another request');
  } finally {
    globalThis.fetch = fetch;
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  }
});
