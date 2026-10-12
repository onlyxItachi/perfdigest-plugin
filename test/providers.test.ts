import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDecisionProvider, normalizeSystemOne, providerName, toSystemOne, ProviderError, type DecisionQuestion } from '../src/providers.js';
import { childEnvironment } from '../src/environment.js';
import type { EvidencePacket, ReportSpec } from '../src/config.js';

const reports: ReportSpec[] = [{ id: 'cpu', path: '/private/trace.json', format: 'chrome-trace', description: 'Measured CPU duration' }];
const questions: DecisionQuestion[] = [
  { type: 'predicate', name: 'measured', instructions: 'Is the duration actually measured?' },
  { type: 'choice', name: 'next_evidence', instructions: 'Select report', choices: [{ value: 'cpu' }, { value: '__human_review__' }] },
  { type: 'score', name: 'severity', instructions: 'Severity', levels: [{ label: 'low' }, { label: 'high', description: 'severe' }] },
];
const native = { model: 'clef-flash', answers: {
  measured: { type: 'noul', noul: 0.91 },
  next_evidence: { type: 'choice', choice: 'cpu', confidence: 0.8, probabilities: { cpu: 0.9, __human_review__: 0.1 } },
  severity: { type: 'score', score: 0.75, confidence: 0.5, probabilities: { 0: 0.25, 1: 0.75 }, legend: { 0: 'low', 1: 'high: severe' } },
}, usage: { input_tokens: 333, output_tokens: 0 } };
const routingResponse = { ...native, answers: { next_evidence: native.answers.next_evidence } };
const measured: EvidencePacket['evidence'] = [{ report: reports[0]!, sha256: 'a'.repeat(64), bytes: 123, modifiedAt: '2026-10-12T00:00:00Z',
  provenance: 'perfdigest_mcp', digest: { format: 'chrome-trace', total_units: 1, returned: 1,
    units: [{ index: 0, duration_us: 50, metrics: { absent: null, zero: 0, unsupported: 'not_available_in_this_export' } }], raw_ref: '/private/trace.json' } }];

test('predicate/noul, typed choice/criteria and score levels preserve provider probabilities and confidence', () => {
  const request = toSystemOne('measured input', questions);
  assert.equal(request.model, 'clef-flash');
  assert.deepEqual(request.questions.measured, { type: 'noul', instructions: questions[0]!.instructions });
  assert.deepEqual(request.questions.next_evidence, { type: 'choice', instructions: 'Select report', criteria: { cpu: 'cpu', __human_review__: '__human_review__' } });
  assert.deepEqual(request.questions.severity, { type: 'score', instructions: 'Severity', criteria: ['low', 'high: severe'] });
  const result = normalizeSystemOne(native, questions);
  assert.deepEqual(result.answers[0], { name: 'measured', type: 'predicate', probability: 0.91 });
  assert.deepEqual(result.answers[1], { name: 'next_evidence', type: 'choice', choice: 'cpu', confidence: 0.8,
    probabilities: [{ value: 'cpu', probability: 0.9 }, { value: '__human_review__', probability: 0.1 }] });
  assert.deepEqual(result.answers[2], { name: 'severity', type: 'score', score: 0.75, confidence: 0.5,
    probabilities: [{ value: 0, label: 'low', probability: 0.25 }, { value: 1, label: 'high', probability: 0.75 }] });
  assert.equal(result.usage.output_tokens, 0, 'Native reported zero is preserved, not invented');
  const typed: DecisionQuestion[] = [{ type: 'choice', name: 'typed', instructions: 'Choose', choices: [{ value: true }, { value: 'true' }] }];
  assert.deepEqual(toSystemOne('x', typed).questions.typed, { type: 'choice', instructions: 'Choose', criteria: { option_0: 'true', option_1: 'true' } });
  const response = { ...native, answers: { typed: { type: 'choice', choice: 'option_0', confidence: 1, probabilities: { option_0: 1, option_1: 0 } } } };
  assert.equal((normalizeSystemOne(response, typed).answers[0] as { choice: unknown }).choice, true);
});

test('missing and invalid native fields fail closed rather than fabricating a compatible answer', () => {
  for (const mutate of [
    (r: any) => { delete r.usage; }, (r: any) => { delete r.usage.output_tokens; },
    (r: any) => { delete r.answers.next_evidence.confidence; },
    (r: any) => { r.answers.measured.noul = 1.5; },
    (r: any) => { r.answers.next_evidence.choice = 'unknown'; },
    (r: any) => { r.answers.next_evidence.probabilities.cpu = 0.2; },
    (r: any) => { r.answers.extra = r.answers.measured; },
    (r: any) => { r.answers.severity.score = 3; },
  ]) { const response = structuredClone(native); mutate(response); assert.throws(() => normalizeSystemOne(response, questions)); }
  assert.throws(() => toSystemOne('x', [questions[0]!, questions[0]!]));
});

test('native choices must maximize the reported distribution, while genuine ties keep the returned choice', () => {
  const lowerProbabilityChoice = structuredClone(native);
  lowerProbabilityChoice.answers.next_evidence.probabilities = { cpu: 0.1, __human_review__: 0.9 };
  lowerProbabilityChoice.answers.next_evidence.confidence = 0.99;
  assert.throws(() => normalizeSystemOne(lowerProbabilityChoice, questions), { kind: 'schema' });
  for (const choice of ['cpu', '__human_review__']) {
    const tied = structuredClone(native);
    tied.answers.next_evidence = { type: 'choice', choice, confidence: 0.1234, probabilities: { cpu: 0.5, __human_review__: 0.5 } };
    const answer = normalizeSystemOne(tied, questions).answers[1]!;
    assert.equal(answer.type, 'choice');
    if (answer.type !== 'choice') throw new Error('Expected choice');
    assert.equal(answer.choice, choice);
    assert.equal(answer.confidence, 0.1234, 'Provider confidence is preserved, not recomputed');
  }
});

test('native score must match weighted probabilities and the requested legend', () => {
  for (const mutate of [
    (r: any) => { r.answers.severity.score = 0.25; },
    (r: any) => { r.answers.severity.legend = { 0: 'low' }; },
    (r: any) => { r.answers.severity.legend = { 0: 'low', 2: 'high: severe' }; },
    (r: any) => { r.answers.severity.legend[1] = 'different rubric'; },
    (r: any) => { r.answers.severity.legend.extra = 'extra'; },
  ]) {
    const response = structuredClone(native); mutate(response);
    assert.throws(() => normalizeSystemOne(response, questions), { kind: 'schema' });
  }
  const scoreQuestions: DecisionQuestion[] = [{ type: 'score', name: 'level', instructions: 'Level',
    levels: [{ label: 'low' }, { label: 'middle' }, { label: 'high' }] }];
  const rounded = { model: 'clef-flash', answers: { level: { type: 'score', score: 1, confidence: 0.2468,
    probabilities: { 0: 0.3333, 1: 0.3333, 2: 0.3333 }, legend: { 0: 'low', 1: 'middle', 2: 'high' } } },
  usage: { input_tokens: 12, output_tokens: 0 } };
  const answer = normalizeSystemOne(rounded, scoreQuestions).answers[0]!;
  assert.equal(answer.type, 'score');
  if (answer.type !== 'score') throw new Error('Expected score');
  assert.equal(answer.score, 1, 'Preserve the reported rounded score rather than replacing it with 0.9999');
  assert.equal(answer.confidence, 0.2468);
  assert.deepEqual(answer.probabilities.map(p => p.probability), [0.3333, 0.3333, 0.3333]);
  rounded.answers.level.score = 1.001;
  assert.throws(() => normalizeSystemOne(rounded, scoreQuestions), { kind: 'schema' });
});

test('four-decimal rounding tolerance scales with the number of native probabilities without renormalizing them', () => {
  const many: DecisionQuestion[] = [{ type: 'choice', name: 'many', instructions: 'Pick',
    choices: Array.from({ length: 255 }, (_, i) => ({ value: `c${i}` })) }];
  const probabilities = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`c${i}`, 0.0039]));
  const rounded = { model: 'clef-flash', answers: { many: { type: 'choice', choice: 'c254', confidence: 0, probabilities } },
    usage: { input_tokens: 12, output_tokens: 0 } };
  const answer = normalizeSystemOne(rounded, many).answers[0]!;
  assert.equal(answer.type, 'choice');
  if (answer.type !== 'choice') throw new Error('Expected choice');
  assert.equal(answer.choice, 'c254');
  assert.equal(answer.confidence, 0);
  assert.equal(answer.probabilities.length, 255);
  assert.ok(answer.probabilities.every(p => p.probability === 0.0039));
  for (const key of Object.keys(probabilities)) probabilities[key] = 0.0038;
  assert.throws(() => normalizeSystemOne(rounded, many), { kind: 'schema' });
});

test('Clef factories refuse a different advertised model and preserve one-request failure behavior', async () => {
  const saved = { ...process.env }; const fetch = globalThis.fetch;
  try {
    process.env.PERFDIGEST_CLEF_URL = 'http://127.0.0.1:8137/v1/systemone';
    process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
    process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN = 'synthetic-cloudflare-token';
    for (const provider of ['local', 'cloudflare'] as const) {
      for (const model of ['openjev', 'clef', 'unrecognized', 'clef-flash', '@cf/cloudflare/clef-flash']) {
        let requests = 0;
        globalThis.fetch = async () => {
          requests++;
          const result = { ...routingResponse, model };
          return new Response(JSON.stringify(provider === 'local' ? result : { success: true, result, errors: [] }));
        };
        const result = createDecisionProvider(provider).select('Synthetic identity fixture', reports);
        if (model === 'clef-flash' || model === '@cf/cloudflare/clef-flash') assert.equal((await result).model, model);
        else await assert.rejects(result, { kind: 'schema' });
        assert.equal(requests, 1);
      }
    }
  } finally { globalThis.fetch = fetch; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('real loopback SystemOne HTTP uses measured inputs without credentials or raw paths', async () => {
  const previous = process.env.PERFDIGEST_CLEF_URL;
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++; assert.equal(req.url, '/v1/systemone'); assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, undefined);
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); const state = JSON.parse(request.state);
    assert.equal(request.questions.next_evidence.type, 'choice');
    assert.equal(state.reports[0].evidence.artifact_sha256, 'a'.repeat(64));
    assert.equal(state.reports[0].evidence.summary.units[0].metrics.absent, null);
    assert.ok(!body.includes('/private'));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(routingResponse));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  process.env.PERFDIGEST_CLEF_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`;
  try {
    const result = await createDecisionProvider('clef-local').select('Actual input mapping', reports, undefined, measured);
    assert.equal(result.provider, 'local'); assert.equal(result.selectedId, 'cpu'); assert.equal(requests, 1);
    assert.equal(result.confidence, 0.8); assert.equal(result.confidenceSemantics, 'systemone_uniform_zero');
    assert.equal(result.outputTokens, 0); assert.equal(result.evidenceCount, 1);
    assert.equal(result.probabilities?.[0]?.probability, 0.9);
  } finally {
    if (previous === undefined) delete process.env.PERFDIGEST_CLEF_URL; else process.env.PERFDIGEST_CLEF_URL = previous;
    await new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); });
  }
});

test('Cloudflare envelope, endpoint and categorized errors use one request with no hosted CI dependency', async () => {
  const saved = { ...process.env }; const fetch = globalThis.fetch;
  try {
    delete process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN;
    assert.throws(() => createDecisionProvider('cloudflare'), { kind: 'missing_credential' });
    process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
    process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN = 'synthetic-cloudflare-token';
    let requests = 0;
    globalThis.fetch = async (url, init) => {
      requests++; assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run/@cf/cloudflare/clef-flash`);
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization') === 'Bearer synthetic-cloudflare-token', true);
      return new Response(JSON.stringify({ success: true, result: routingResponse, errors: [] }));
    };
    const result = await createDecisionProvider('cloudflare').select('Fixture only', reports, undefined, measured);
    assert.equal(result.provider, 'cloudflare'); assert.equal(result.transport, 'cloudflare_https'); assert.equal(requests, 1);
    for (const [status, code, kind] of [[401, 10000, 'authentication'], [402, 0, 'billing'], [403, 5035, 'billing'],
      [429, 3036, 'billing'], [429, 3040, 'rate_limit'], [400, 5004, 'schema'], [403, 3041, 'permission'], [500, 0, 'service']] as const) {
      requests = 0;
      globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ success: false, errors: [{ code, message: 'Authorization: Bearer do-not-log' }] }), { status }); };
      await assert.rejects(createDecisionProvider('cloudflare').select('Fixture only', reports), (error: unknown) => {
        assert.ok(error instanceof ProviderError); assert.equal(error.kind, kind); assert.ok(!error.message.includes('do-not-log')); return true;
      });
      assert.equal(requests, 1);
    }
    requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error('secret network details'); };
    await assert.rejects(createDecisionProvider('cloudflare').select('Fixture only', reports), { kind: 'network' });
    assert.equal(requests, 1);
    assert.equal(childEnvironment().PERFDIGEST_CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(childEnvironment().PERFDIGEST_CLOUDFLARE_ACCOUNT_ID, undefined);
  } finally { globalThis.fetch = fetch; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('provider aliases stay explicit, offline sends no request, invalid local URLs cannot contact a remote host', async () => {
  assert.equal(providerName('decisions'), 'openai'); assert.equal(providerName('openai-luna'), 'openai');
  assert.equal(providerName('clef-cloudflare'), 'cloudflare'); assert.equal(providerName('clef-local'), 'local');
  const fetch = globalThis.fetch; const previous = process.env.PERFDIGEST_CLEF_URL;
  try {
    globalThis.fetch = async () => { throw new Error('Offline must not fetch'); };
    assert.equal((await createDecisionProvider('offline').select('test', reports)).requests, 0);
    process.env.PERFDIGEST_CLEF_URL = 'http://127.0.0.1:80/v1/systemone';
    assert.equal(createDecisionProvider('local').name, 'local', 'An explicit default port accepted by init is accepted by runtime');
    for (const url of ['https://api.example.test/v1/systemone', 'http://user:secret@127.0.0.1:8000/v1/systemone',
      'http://127.0.0.1:8000/v1/systemone?token=x', 'http://127.0.0.1/v1/systemone',
      'http://127.0.0.1:8000/v1/systemone#fragment', 'http://127.0.0.1:65536/v1/systemone']) {
      process.env.PERFDIGEST_CLEF_URL = url; assert.throws(() => createDecisionProvider('local'), { kind: 'schema' });
    }
    assert.throws(() => createDecisionProvider('local', { decisionsMockURL: 'http://127.0.0.1:8123/v1' }), { kind: 'schema' });
  } finally { globalThis.fetch = fetch; if (previous === undefined) delete process.env.PERFDIGEST_CLEF_URL; else process.env.PERFDIGEST_CLEF_URL = previous; }
});
