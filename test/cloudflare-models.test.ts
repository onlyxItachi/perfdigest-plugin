import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { cloudflareModel, cloudflareModels, createDecisionProvider, toSystemOne, ProviderError } from '../src/providers.js';
import { initConfiguration, loadConfiguration } from '../src/setup.js';
import type { ReportSpec } from '../src/config.js';
import { testDirectory } from './helpers.js';

// Network-free: fetch is replaced in-process and every response is synthetic.
const account = 'b'.repeat(32);
const token = 'synthetic-model-token';
const reports: ReportSpec[] = [{ id: 'cpu', path: 'trace.json', format: 'chrome-trace', description: 'Synthetic' }];
const answer = (model: string, confidence = 0.8) => ({ success: true, errors: [], result: { model,
  answers: { next_evidence: { type: 'choice', choice: 'cpu', confidence, probabilities: { cpu: 0.9, __human_review__: 0.1 } } },
  usage: { input_tokens: 3, output_tokens: 0 } } });

async function withCredentials(t: test.TestContext) {
  const saved = { a: process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID, k: process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN };
  const fetch = globalThis.fetch;
  process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID = account; process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN = token;
  t.after(() => {
    globalThis.fetch = fetch;
    if (saved.a === undefined) delete process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID; else process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID = saved.a;
    if (saved.k === undefined) delete process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN; else process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN = saved.k;
  });
}

test('registry lists exactly the documented Clef family with shared SystemOne semantics', () => {
  assert.deepEqual(Object.keys(cloudflareModels).sort(), ['clef', 'clef-flash', 'clef-omni']);
  for (const [name, spec] of Object.entries(cloudflareModels)) {
    assert.equal(spec.id, `@cf/cloudflare/${name}`); assert.equal(spec.requestModel, name);
    assert.equal(spec.confidenceSemantics, 'systemone_uniform_zero');
    assert.deepEqual(spec.pluginInputs, ['text'], 'the plugin sends text state only');
  }
  assert.deepEqual(cloudflareModels['clef-omni'].documentedMediaInputs, ['image', 'audio', 'video']);
  assert.equal(cloudflareModels['clef-flash'].liveQualified, '2026-10-18');
  assert.equal(cloudflareModels.clef.liveQualified, '2026-10-18');
  assert.equal(cloudflareModels['clef-omni'].liveQualified, '2026-10-18');
  assert.equal(cloudflareModel().name, 'clef-flash', 'default is unchanged');
  for (const bad of ['clef-pro', 'CLEF', '__proto__', '@cf/cloudflare/clef', '']) {
    assert.throws(() => cloudflareModel(bad), (e: unknown) => e instanceof ProviderError && e.kind === 'schema');
  }
});

test('each Cloudflare model uses its own endpoint, request model and identity check', async t => {
  await withCredentials(t);
  for (const name of ['clef-flash', 'clef', 'clef-omni'] as const) {
    const calls: Array<{ url: string; model: string }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), model: JSON.parse(String(init?.body)).model });
      return new Response(JSON.stringify(answer(name)));
    };
    const decision = await createDecisionProvider('cloudflare', { cloudflareModel: name }).select('fixture', reports);
    assert.deepEqual(calls, [{ url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${name}`, model: name }]);
    assert.equal(decision.model, name); assert.equal(decision.requestedModel, `@cf/cloudflare/${name}`);
    assert.equal(decision.confidenceSemantics, 'systemone_uniform_zero'); assert.equal(decision.selectedId, 'cpu');
  }
});

test('a response from a different Clef model is rejected, never accepted as the requested one', async t => {
  await withCredentials(t);
  for (const [requested, returned] of [['clef', 'clef-flash'], ['clef-flash', 'clef'], ['clef-omni', '@cf/cloudflare/clef']] as const) {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response(JSON.stringify(answer(returned))); };
    await assert.rejects(createDecisionProvider('cloudflare', { cloudflareModel: requested }).select('fixture', reports), { kind: 'schema' });
    assert.equal(requests, 1, 'no retry with another model');
  }
});

test('unknown models and models for non-Cloudflare providers fail before any request', async t => {
  await withCredentials(t);
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  assert.throws(() => createDecisionProvider('cloudflare', { cloudflareModel: 'clef-ultra' }), { kind: 'schema' });
  for (const mode of ['offline', 'local', 'openai'] as const) {
    assert.throws(() => createDecisionProvider(mode, { cloudflareModel: 'clef' }), { kind: 'schema' }, mode);
  }
  // The shared threshold is unchanged for every model.
  globalThis.fetch = async () => new Response(JSON.stringify(answer('clef-omni', 0.6499)));
  assert.equal((await createDecisionProvider('cloudflare', { cloudflareModel: 'clef-omni' }).select('fixture', reports)).reason, 'low_confidence');
});

test('local and OpenAI adapters keep their existing request shapes', () => {
  assert.equal(toSystemOne('state', [{ type: 'predicate', name: 'q', instructions: 'i' }]).model, 'clef-flash');
  assert.equal(createDecisionProvider('local').name, 'local');
  assert.equal(createDecisionProvider('offline').name, 'offline');
});

test('setup saves an explicit Cloudflare model reference and refuses it elsewhere', async () => {
  const root = await testDirectory('models');
  const workspace = join(root, 'project'); await mkdir(join(workspace, '.git'), { recursive: true });
  const output = new Writable({ write(_c, _e, done) { done(); } });
  const environment: NodeJS.ProcessEnv = { PATH: '' };
  const saved = await initConfiguration({ workspace, provider: 'cloudflare', decisionModel: 'clef-omni', yes: true, output, environment });
  assert.deepEqual(JSON.parse(await readFile(saved.path, 'utf8')), { version: 1, provider: 'cloudflare', decisionModel: 'clef-omni' });
  assert.equal((await loadConfiguration(workspace))?.decisionModel, 'clef-omni');
  // Re-running setup for the same provider keeps the saved model unless replaced explicitly.
  await initConfiguration({ workspace, provider: 'cloudflare', yes: true, output, environment });
  assert.equal((await loadConfiguration(workspace))?.decisionModel, 'clef-omni');
  await assert.rejects(initConfiguration({ workspace, provider: 'cloudflare', decisionModel: 'clef-ultra', yes: true, output, environment }), /decision model/);
  await assert.rejects(initConfiguration({ workspace, provider: 'local', decisionModel: 'clef', yes: true, output, environment }), /decision model/);
  await writeFile(saved.path, JSON.stringify({ version: 1, provider: 'openai', decisionModel: 'clef' }));
  await assert.rejects(loadConfiguration(workspace), /decision model/);
});

test('opt-in discovery searches for the configured model only', async t => {
  const root = await testDirectory('models-discovery');
  const workspace = join(root, 'project'); await mkdir(join(workspace, '.git'), { recursive: true });
  const envFile = join(root, 'private.env');
  await writeFile(envFile, `PERFDIGEST_CLOUDFLARE_ACCOUNT_ID=${account}\nPERFDIGEST_CLOUDFLARE_API_TOKEN=${token}\n`, { mode: 0o600 });
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    urls.push(String(url)); return new Response(JSON.stringify({ success: true, errors: [], result: [] }));
  });
  let text = '';
  const output = new Writable({ write(c, _e, done) { text += String(c); done(); } });
  await initConfiguration({ workspace, provider: 'cloudflare', decisionModel: 'clef', envFile, yes: true, checkConnection: true, output, environment: { PATH: '' } });
  assert.deepEqual(urls, [`https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?search=clef&per_page=1&page=1`]);
  assert.match(text, /Cloudflare decision model: clef/);
  assert.equal(text.includes(token), false);
});
