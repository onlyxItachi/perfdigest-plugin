import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { offlineSelection, selectReport, decisionsClient } from '../src/decisions.js';
import type { ReportSpec } from '../src/config.js';

const reports: ReportSpec[] = [
  { id: 'trace', path: 'trace.json', format: 'chrome-trace', description: 'CPU elapsed spans' },
  { id: 'counters', path: 'cpu.json', format: 'perf-stat-json', description: 'CPU counters' },
];
function fakeClient(answer: object, status = 200) {
  let request: { url: string; body: Record<string, unknown>; authorization: string | null } | undefined;
  const client = new OpenAI({ apiKey: 'fixture-decisions-key', baseURL: 'https://api.openai.com/v1', maxRetries: 0,
    fetch: async (input, init) => {
      request = { url: String(input), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') };
      return new Response(JSON.stringify(status === 200 ? {
        answers: [answer], model: 'gpt-6-luna', usage: { input_tokens: 123, output_tokens: 4, total_tokens: 127 },
      } : { error: { message: 'fixture rejection', type: 'invalid_request_error' } }), {
        status, headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, request: () => request };
}

test('OpenAI TS SDK calls the actual Decisions endpoint with the dedicated client key', async () => {
  const fixture = fakeClient({ name: 'next_evidence', type: 'choice', choice: 'counters', confidence: 0.9, probabilities: [] });
  const route = await selectReport(fixture.client, 'Explain CPU latency', reports);
  assert.equal(fixture.request()?.url, 'https://api.openai.com/v1/decisions');
  assert.equal(fixture.request()?.authorization, 'Bearer fixture-decisions-key');
  assert.equal(fixture.request()?.body.model, 'gpt-6-luna');
  assert.equal(route.selectedId, 'counters');
  assert.equal(route.inputTokens, 123);
  assert.equal(route.costUsd, null);
});

test('low confidence and refusal stop collection rather than imply correctness', async () => {
  const low = await selectReport(fakeClient({ name: 'next_evidence', type: 'choice', choice: 'trace', confidence: 0.4, probabilities: [] }).client, 'issue', reports);
  assert.equal(low.reason, 'low_confidence'); assert.equal(low.selectedId, null);
  const refusal = await selectReport(fakeClient({ name: 'next_evidence', type: 'refusal' }).client, 'issue', reports);
  assert.equal(refusal.reason, 'refused'); assert.equal(refusal.confidence, null);
});

test('invalid routes, invalid confidence and HTTP failures never silently fall back', async () => {
  for (const answer of [
    { name: 'next_evidence', type: 'choice', choice: 'unlisted', confidence: 0.9 },
    { name: 'next_evidence', type: 'choice', choice: 'trace', confidence: 2 },
  ]) await assert.rejects(selectReport(fakeClient(answer).client, 'issue', reports));
  for (const status of [401, 429, 500]) {
    await assert.rejects(selectReport(fakeClient({}, status).client, 'issue', reports), new RegExp(`HTTP ${status}`));
  }
});

test('documented response fixture and request contract are verified without network access', async () => {
  const fixture = JSON.parse(readFileSync(resolve('test/fixtures/decisions-choice.json'), 'utf8'));
  let calls = 0;
  const client = new OpenAI({ apiKey: 'synthetic-test-key', maxRetries: 0, fetch: async (_url, init) => {
    calls++;
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.questions.length, 1);
    assert.equal(body.questions[0].type, 'choice');
    assert.equal(body.questions[0].name, 'next_evidence');
    assert.deepEqual(body.questions[0].choices.map((c: {value: string}) => c.value), ['trace', 'counters', '__human_review__']);
    assert.equal(JSON.parse(body.input).reports[0].path, undefined, 'local paths are not sent for routing');
    return new Response(JSON.stringify(fixture), { headers: { 'content-type': 'application/json' } });
  } });
  const route = await selectReport(client, 'fixture issue', reports);
  assert.equal(calls, 1); assert.equal(route.selectedId, 'counters');
  assert.equal(route.outputTokens, 4);
});

test('cancellation and malformed usage are failures, not offline success', async () => {
  const controller = new AbortController(); controller.abort(new Error('fixture cancelled'));
  await assert.rejects(selectReport(fakeClient({}).client, 'issue', reports, controller.signal), /fixture cancelled/);
  const client = new OpenAI({ apiKey: 'synthetic-test-key', maxRetries: 0,
    fetch: async () => new Response(JSON.stringify({ answers: [], usage: { input_tokens: -1, output_tokens: 1 } }),
      { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(selectReport(client, 'fixture', reports), /Invalid Decisions response/);
});

test('offline results carry no invented confidence or token usage', () => {
  const route = offlineSelection(reports);
  assert.equal(route.source, 'offline_order'); assert.equal(route.confidence, null);
  assert.equal(route.requests, 0); assert.equal(route.inputTokens, null);
});

test('live client refuses missing dedicated key even when generic OPENAI_API_KEY exists', () => {
  const prior = process.env.PERFDIGEST_DECISIONS_API_KEY;
  const generic = process.env.OPENAI_API_KEY;
  delete process.env.PERFDIGEST_DECISIONS_API_KEY;
  process.env.OPENAI_API_KEY = 'must-not-use-this-key';
  try { assert.throws(decisionsClient, /PERFDIGEST_DECISIONS_API_KEY/); }
  finally {
    if (prior !== undefined) process.env.PERFDIGEST_DECISIONS_API_KEY = prior;
    if (generic === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = generic;
  }
});
