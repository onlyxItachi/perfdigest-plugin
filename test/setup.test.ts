import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { childEnvironment } from '../src/environment.js';
import { applyConfigurationEnvironment, initConfiguration, loadConfiguration, normalizeSetupProvider,
  providerForRuntime, validateLocalEndpoint, type InitOptions } from '../src/setup.js';
import { testDirectory } from './helpers.js';

async function project() {
  const root = await testDirectory('setup');
  const workspace = join(root, 'project');
  const bin = join(root, 'bin');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(bin);
  // Setup must discover these files, never execute them or start an MCP/login process.
  for (const name of ['uvx', 'codex']) {
    const path = join(bin, name);
    await writeFile(path, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  }
  return { root, workspace, environment: { PATH: bin } as NodeJS.ProcessEnv };
}

function outputCapture(onWrite?: (text: string) => void) {
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) {
    const part = String(chunk); text += part; onWrite?.(part); done();
  } }) as Writable & { isTTY?: boolean };
  return { output, text: () => text };
}

async function privateEnv(root: string, source: string) {
  const path = join(root, 'private.env');
  await writeFile(path, source, { mode: 0o600 });
  return path;
}

test('explicit offline setup persists private reference-only config and reports optional tools honestly', async () => {
  const fixture = await project();
  const capture = outputCapture();
  const result = await initConfiguration({ ...fixture, provider: 'offline', yes: true, output: capture.output });
  assert.equal(result.ready, true);
  assert.deepEqual(result.configuration, { version: 1, provider: 'offline' });
  assert.deepEqual(await loadConfiguration(fixture.workspace), result.configuration);
  assert.match(capture.text(), /Active provider: offline/);
  assert.match(capture.text(), /login was not checked/);
  assert.match(capture.text(), /no endpoint or model is contacted/);
  if (process.platform !== 'win32') {
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(fixture.workspace, '.perfdigest'))).mode & 0o777, 0o700);
  }
  const missing = await initConfiguration({ workspace: fixture.workspace, provider: 'offline', yes: true,
    environment: { PATH: join(fixture.root, 'absent') }, output: outputCapture().output });
  assert.equal(missing.ready, false);
  assert.equal(missing.diagnostics.find(check => check.check === 'uvx')?.status, 'error');
  assert.equal(missing.diagnostics.find(check => check.check === 'codex')?.status, 'warning');
});

test('missing, malformed and unknown-field configurations never silently choose a provider', async () => {
  const { workspace } = await project();
  assert.equal(await loadConfiguration(workspace), null);
  await mkdir(join(workspace, '.perfdigest'));
  const path = join(workspace, '.perfdigest', 'config.json');
  await writeFile(path, '{ "secret": "do-not-repeat-this"');
  await assert.rejects(loadConfiguration(workspace), error => {
    assert.equal((error as Error).message, 'Configuration is not valid JSON.'); return true;
  });
  await writeFile(path, JSON.stringify({ version: 1, provider: 'offline', apiKey: 'do-not-repeat-this' }));
  await assert.rejects(loadConfiguration(workspace), /only version, provider, endpoint and envFile/);
  for (const alias of ['clef-cloudflare', 'clef-local', 'openai-luna', 'decisions']) {
    await writeFile(path, JSON.stringify({ version: 1, provider: alias }));
    assert.equal((await loadConfiguration(workspace))?.provider, normalizeSetupProvider(alias));
  }
  assert.equal(providerForRuntime('cloudflare'), 'cloudflare');
  assert.throws(() => normalizeSetupProvider('__proto__'), /Provider must be/);
});

test('non-TTY init refuses implicit defaults and --yes requires an explicit selection', async () => {
  const fixture = await project();
  const input = new PassThrough();
  const output = outputCapture().output;
  await assert.rejects(initConfiguration({ ...fixture, input, output }), /requires a terminal/);
  await assert.rejects(initConfiguration({ ...fixture, input, output, provider: 'offline' }), /requires a terminal/);
  await assert.rejects(initConfiguration({ ...fixture, input, output, yes: true }), /requires --provider/);
  assert.equal(await loadConfiguration(fixture.workspace), null);
});

test('readline selection retries an invalid answer and saves the explicitly chosen provider', async () => {
  const fixture = await project();
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  let providerPrompts = 0;
  const capture = outputCapture(text => {
    if (text.includes('Provider [cloudflare]:')) {
      const answer = ++providerPrompts === 1 ? 'invalid' : '4';
      setImmediate(() => input.write(`${answer}\n`));
    }
    if (text.includes('Save workspace configuration?')) setImmediate(() => input.write('y\n'));
  });
  capture.output.isTTY = true;
  const result = await initConfiguration({ ...fixture, input, output: capture.output });
  assert.equal(result.configuration.provider, 'offline');
  assert.equal(providerPrompts, 2);
  assert.match(capture.text(), /Cloudflare \(recommended demo\)/);
  assert.match(capture.text(), /Choose 1–4/);
  assert.doesNotMatch(capture.text(), /env-file absolute path/);
});

test('closing an interactive prompt or declining replacement leaves configuration untouched', async () => {
  const fixture = await project();
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const closed = outputCapture(text => {
    if (text.includes('Provider [')) setImmediate(() => input.end());
  });
  closed.output.isTTY = true;
  await assert.rejects(initConfiguration({ ...fixture, input, output: closed.output }), /cancelled before saving/);
  assert.equal(await loadConfiguration(fixture.workspace), null);
  await initConfiguration({ ...fixture, provider: 'offline', yes: true, output: outputCapture().output });
  const declineInput = new PassThrough() as PassThrough & { isTTY?: boolean };
  declineInput.isTTY = true;
  const decline = outputCapture(text => {
    if (text.includes('Replace workspace configuration?')) setImmediate(() => declineInput.write('n\n'));
  });
  decline.output.isTTY = true;
  await assert.rejects(initConfiguration({ ...fixture, provider: 'openai', envFile: '',
    input: declineInput, output: decline.output }), /cancelled before saving/);
  assert.equal((await loadConfiguration(fixture.workspace))?.provider, 'offline');
});

test('hosted setup defaults to no requests and never persists, prints or inherits secret values', async () => {
  const fixture = await project();
  const cloudflareSecret = 'synthetic-cloudflare-private-token';
  const decisionsSecret = 'synthetic-decisions-private-token';
  const envFile = await privateEnv(fixture.root,
    `# Private runner variables only\nPERFDIGEST_CLOUDFLARE_ACCOUNT_ID=${'a'.repeat(32)}\nPERFDIGEST_CLOUDFLARE_API_TOKEN='${cloudflareSecret}'\nPERFDIGEST_DECISIONS_API_KEY="${decisionsSecret}"\n`);
  const capture = outputCapture();
  const fetchBefore = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Hosted setup must not make requests'); };
  try {
    for (const provider of ['cloudflare', 'openai']) {
      const result = await initConfiguration({ ...fixture, provider, envFile, yes: true, output: capture.output });
      assert.equal(result.ready, true);
      assert.equal(result.diagnostics.find(check => check.check === 'endpoint')?.status, 'skipped');
      const saved = await readFile(result.path, 'utf8');
      for (const secret of [cloudflareSecret, decisionsSecret]) {
        assert.equal(saved.includes(secret), false); assert.equal(capture.text().includes(secret), false);
      }
      assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['envFile', 'provider', 'version']);
      assert.equal(fixture.environment.PERFDIGEST_CLOUDFLARE_API_TOKEN, undefined);
    }
    assert.equal(requests, 0);
    const parentEnvironment: NodeJS.ProcessEnv = { PERFDIGEST_DECISIONS_API_KEY: 'explicit-process-value' };
    await applyConfigurationEnvironment({ version: 1, provider: 'cloudflare', envFile }, fixture.workspace, parentEnvironment);
    assert.equal(parentEnvironment.PERFDIGEST_CLOUDFLARE_API_TOKEN, cloudflareSecret);
    assert.equal(parentEnvironment.PERFDIGEST_DECISIONS_API_KEY, 'explicit-process-value');
    for (const key of ['PERFDIGEST_CLOUDFLARE_API_TOKEN', 'PERFDIGEST_CLOUDFLARE_ACCOUNT_ID', 'PERFDIGEST_DECISIONS_API_KEY']) {
      assert.equal(childEnvironment(parentEnvironment)[key], undefined);
    }
  } finally { globalThis.fetch = fetchBefore; }
});

test('missing hosted credentials remain missing with no generic key or offline fallback', async () => {
  const fixture = await project();
  const result = await initConfiguration({ ...fixture, provider: 'openai', yes: true,
    environment: { ...fixture.environment, OPENAI_API_KEY: 'general-key-must-not-be-used' }, output: outputCapture().output });
  assert.equal(result.ready, false);
  assert.equal(result.configuration.provider, 'openai');
  assert.equal(result.diagnostics.find(check => check.check === 'credentials')?.status, 'error');
  const missing = await initConfiguration({ ...fixture, provider: 'cloudflare', yes: true,
    envFile: join(fixture.root, 'not-created', 'credentials.env'), output: outputCapture().output });
  assert.equal(missing.ready, false);
  assert.equal(missing.configuration.provider, 'cloudflare');
  assert.equal(missing.diagnostics.find(check => check.check === 'env_file')?.status, 'error');
});

test('env files reject repository paths, parent symlink escapes and unsafe permissions', async () => {
  const fixture = await project();
  const run = (envFile: string) => initConfiguration({ ...fixture, provider: 'openai', envFile, yes: true, output: outputCapture().output });
  await assert.rejects(run('PERFDIGEST_DECISIONS_API_KEY=synthetic-secret'), /absolute external file path/);
  await assert.rejects(run(join(fixture.workspace, 'key.env')), /outside the investigated/);
  const nested = join(fixture.workspace, 'nested');
  await mkdir(nested);
  await assert.rejects(initConfiguration({ workspace: nested, provider: 'openai', envFile: join(fixture.workspace, 'key.env'),
    yes: true, output: outputCapture().output }), /outside the investigated/);
  if (process.platform !== 'win32') {
    const link = join(fixture.root, 'link-to-project');
    await symlink(fixture.workspace, link, 'dir');
    await assert.rejects(run(join(link, 'missing.env')), /outside the investigated/);
    const envFile = await privateEnv(fixture.root, 'PERFDIGEST_DECISIONS_API_KEY=synthetic-secret');
    await chmod(envFile, 0o644);
    await assert.rejects(run(envFile), /permissions to 600/);
    await chmod(envFile, 0o600);
    const fileLink = join(fixture.root, 'linked.env');
    await symlink(envFile, fileLink);
    await assert.rejects(run(fileLink), /not a symbolic link/);
  }
});

test('env parsing refuses general keys, duplicates and shell commands without partial assignment', async () => {
  const fixture = await project();
  const envFile = await privateEnv(fixture.root, '');
  for (const source of [
    'PERFDIGEST_CLOUDFLARE_API_TOKEN=synthetic-secret\nOPENAI_API_KEY=never-accepted',
    'PERFDIGEST_CLOUDFLARE_API_TOKEN=synthetic-secret\nPERFDIGEST_CLOUDFLARE_API_TOKEN=duplicate',
    'PERFDIGEST_CLOUDFLARE_API_TOKEN=synthetic-secret\nsource credentials.env',
  ]) {
    await writeFile(envFile, source);
    const environment: NodeJS.ProcessEnv = {};
    await assert.rejects(applyConfigurationEnvironment({ version: 1, provider: 'cloudflare', envFile }, fixture.workspace, environment));
    assert.deepEqual(environment, {});
  }
  await writeFile(envFile, 'PERFDIGEST_DECISIONS_API_KEY=$(never_execute_me)');
  const environment: NodeJS.ProcessEnv = {};
  await applyConfigurationEnvironment({ version: 1, provider: 'openai', envFile }, fixture.workspace, environment);
  assert.equal(environment.PERFDIGEST_DECISIONS_API_KEY, '$(never_execute_me)');
});

test('local setup requests only GET /health without credentials or a body', async () => {
  const fixture = await project();
  const requests: Array<{ method?: string; path?: string; authorization?: string; bytes: number }> = [];
  let status = 200;
  const server = createServer((request, response) => {
    let bytes = 0;
    request.on('data', chunk => { bytes += chunk.length; });
    request.on('end', () => {
      requests.push({ ...(request.method ? { method: request.method } : {}), ...(request.url ? { path: request.url } : {}),
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), bytes });
      response.writeHead(status, { 'Content-Type': 'application/json' }); response.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/v1/systemone`;
  try {
    const options: InitOptions = { ...fixture, provider: 'local', endpoint, yes: true, checkConnection: true, output: outputCapture().output,
      environment: { ...fixture.environment, PERFDIGEST_CLOUDFLARE_API_TOKEN: 'must-not-be-sent' } };
    const result = await initConfiguration(options);
    assert.equal(result.ready, true);
    assert.equal(result.configuration.endpoint, endpoint);
    assert.deepEqual(requests, [{ method: 'GET', path: '/health', bytes: 0 }]);
    status = 503;
    const unavailable = await initConfiguration(options);
    assert.equal(unavailable.ready, false);
    assert.match(unavailable.diagnostics.find(check => check.check === 'endpoint')!.message, /HTTP 503/);
    const environment = { PERFDIGEST_CLEF_URL: 'http://127.0.0.1:9999/v1/systemone' };
    await applyConfigurationEnvironment(result.configuration, fixture.workspace, environment);
    assert.equal(environment.PERFDIGEST_CLEF_URL, endpoint);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('local endpoint validation refuses remote hosts, credentials and inference parameters', () => {
  assert.equal(validateLocalEndpoint('http://127.0.0.1:80/v1/systemone'), 'http://127.0.0.1:80/v1/systemone');
  for (const endpoint of [
    'https://127.0.0.1:8137/v1/systemone', 'http://localhost:8137/v1/systemone',
    'http://127.0.0.1/v1/systemone', 'http://127.0.0.1:0/v1/systemone',
    'http://127.0.0.1:65536/v1/systemone', 'http://127.0.0.1:8137/v1/systemone?token=never-log-this',
    'http://127.0.0.1:8137/v1/systemone#fragment', 'http://token@127.0.0.1:8137/v1/systemone',
    'http://example.com:8137/v1/systemone',
  ]) assert.throws(() => validateLocalEndpoint(endpoint), error => {
    assert.equal((error as Error).message.includes('never-log-this'), false); return true;
  });
});

test('configuration directory symlinks are refused before any write', { skip: process.platform === 'win32' }, async () => {
  const fixture = await project();
  const outside = join(fixture.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(fixture.workspace, '.perfdigest'), 'dir');
  await assert.rejects(initConfiguration({ ...fixture, provider: 'offline', yes: true, output: outputCapture().output }), /must not be a symlink/);
  await assert.rejects(stat(join(outside, 'config.json')), { code: 'ENOENT' });
});

const discoveryAccount = 'a'.repeat(32);
const discoveryToken = 'synthetic-discovery-secret-never-log';
const discoveryBody = JSON.stringify({ success: true, errors: [], messages: [], result: [] });

test('opt-in Cloudflare discovery sends one authenticated GET and reports only read acceptance', async t => {
  const fixture = await project();
  const envFile = await privateEnv(fixture.root,
    `PERFDIGEST_CLOUDFLARE_ACCOUNT_ID=${discoveryAccount}\nPERFDIGEST_CLOUDFLARE_API_TOKEN=${discoveryToken}\n`);
  const capture = outputCapture();
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${discoveryAccount}/ai/models/search?search=clef-flash&per_page=1&page=1`);
    assert.equal(options?.method, 'GET');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.body, undefined);
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${discoveryToken}`);
    assert.equal(new Headers(options?.headers).get('accept'), 'application/json');
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ success: true, errors: [], messages: [discoveryToken], result: [] }));
  });
  const result = await initConfiguration({ ...fixture, provider: 'cloudflare', envFile, yes: true,
    checkConnection: true, output: capture.output });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.ready, true);
  assert.equal(result.configuration.provider, 'cloudflare');
  assert.equal(fixture.environment.PERFDIGEST_CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(result.diagnostics.find(check => check.check === 'endpoint')?.status, 'ok');
  assert.match(capture.text(), /authenticated model-discovery read accepted/);
  assert.match(capture.text(), /model availability, inference and remaining quota were not checked/);
  const saved = await readFile(result.path, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['envFile', 'provider', 'version']);
  for (const value of [saved, capture.text(), JSON.stringify(result)]) assert.equal(value.includes(discoveryToken), false);
});

test('opt-in Cloudflare failures neither retry nor print upstream bodies, headers or errors', async t => {
  const fixture = await project();
  const environment = { ...fixture.environment,
    PERFDIGEST_CLOUDFLARE_ACCOUNT_ID: discoveryAccount, PERFDIGEST_CLOUDFLARE_API_TOKEN: discoveryToken };
  let response: () => Response = () => new Response();
  const fetch = t.mock.method(globalThis, 'fetch', async () => response());
  const cases = [
    ...[301, 401, 403, 429, 500].map(status => () => new Response(discoveryToken, {
      status, headers: { Location: 'https://never-follow.invalid', 'X-Private-Upstream': discoveryToken },
    })),
    () => new Response(JSON.stringify({ success: false, errors: [discoveryToken], result: [] })),
    () => new Response(JSON.stringify({ success: true, errors: [discoveryToken], result: [] })),
    () => new Response(JSON.stringify({ success: true, errors: [], result: {} })),
    () => new Response(discoveryToken),
    () => { throw new Error(`upstream headers and body: ${discoveryToken}`); },
  ];
  for (const [index, createResponse] of cases.entries()) {
    response = createResponse;
    const capture = outputCapture();
    const result = await initConfiguration({ ...fixture, environment, provider: 'cloudflare', yes: true,
      checkConnection: true, output: capture.output });
    assert.equal(fetch.mock.callCount(), index + 1);
    assert.equal(result.ready, false);
    assert.equal(result.configuration.provider, 'cloudflare');
    assert.equal(result.diagnostics.find(check => check.check === 'endpoint')?.status, 'error');
    if (index === 2) assert.match(capture.text(), /Workers AI Read or Write permission/);
    if (index === 3) assert.match(capture.text(), /rate-limited; this does not establish remaining inference quota/);
    assert.equal(capture.text().includes(discoveryToken), false);
    assert.equal(JSON.stringify(result).includes(discoveryToken), false);
    assert.doesNotMatch(capture.text(), /read accepted|Prerequisite checks passed/);
  }
});

test('opt-in discovery bounds response size while streaming and cancels the body', async t => {
  const fixture = await project();
  let cancelled = 0;
  let chunks = 0;
  let contentLength = false;
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(32_768)); },
    cancel() { cancelled++; },
  }), { headers: contentLength ? { 'Content-Length': '65537' } : {} }));
  for (const oversizedHeader of [false, true]) {
    contentLength = oversizedHeader;
    chunks = 0;
    const result = await initConfiguration({ ...fixture, provider: 'cloudflare', yes: true, checkConnection: true,
      environment: { ...fixture.environment, PERFDIGEST_CLOUDFLARE_ACCOUNT_ID: discoveryAccount,
        PERFDIGEST_CLOUDFLARE_API_TOKEN: discoveryToken }, output: outputCapture().output });
    assert.equal(result.ready, false);
    assert.match(result.diagnostics.find(check => check.check === 'endpoint')!.message, /64-KiB limit/);
    assert.ok(chunks <= (oversizedHeader ? 1 : 4), 'must stop reading oversized responses');
  }
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(cancelled, 2);
});

test('opt-in discovery is cancellable and has a five-second deadline without retries', async t => {
  const fixture = await project();
  const capture = outputCapture();
  const abort = new AbortController();
  const timeouts: number[] = [];
  const timeoutBefore = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    timeouts.push(milliseconds);
    return timeoutBefore(20); // Exercise the configured deadline without delaying the suite five seconds.
  });
  let useCallerAbort = true;
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, options?: RequestInit) => {
    const signal = options?.signal;
    assert.ok(signal);
    if (useCallerAbort) setImmediate(() => abort.abort(new Error(discoveryToken)));
    return new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('check failed to enforce deadline')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    });
  });
  for (const caller of [true, false]) {
    useCallerAbort = caller;
    const result = await initConfiguration({ ...fixture, provider: 'cloudflare', yes: true, checkConnection: true,
      ...(caller ? { signal: abort.signal } : {}),
      environment: { ...fixture.environment, PERFDIGEST_CLOUDFLARE_ACCOUNT_ID: discoveryAccount,
        PERFDIGEST_CLOUDFLARE_API_TOKEN: discoveryToken }, output: capture.output });
    assert.equal(result.ready, false);
    assert.equal(result.diagnostics.find(check => check.check === 'endpoint')?.status, 'error');
  }
  assert.deepEqual(timeouts, [5000, 5000]);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(capture.text().includes(discoveryToken), false);
});

test('opt-in checks skip missing or invalid Cloudflare credentials/config, OpenAI and offline', async t => {
  const fixture = await project();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must never request'); });
  for (const credentials of [{}, { PERFDIGEST_CLOUDFLARE_ACCOUNT_ID: 'bad', PERFDIGEST_CLOUDFLARE_API_TOKEN: discoveryToken },
    { PERFDIGEST_CLOUDFLARE_ACCOUNT_ID: discoveryAccount, PERFDIGEST_CLOUDFLARE_API_TOKEN: 'invalid\r\nheader' }]) {
    const result = await initConfiguration({ ...fixture, provider: 'cloudflare', yes: true, checkConnection: true,
      environment: { ...fixture.environment, ...credentials }, output: outputCapture().output });
    assert.equal(result.ready, false);
    assert.equal(result.diagnostics.find(check => check.check === 'endpoint')?.status, 'skipped');
  }
  const envFile = await privateEnv(fixture.root, 'OPENAI_API_KEY=general-key-is-refused');
  for (const file of [envFile, join(fixture.root, 'missing.env')]) {
    const result = await initConfiguration({ ...fixture, provider: 'cloudflare', envFile: file, yes: true, checkConnection: true,
      environment: { ...fixture.environment, PERFDIGEST_CLOUDFLARE_ACCOUNT_ID: discoveryAccount,
        PERFDIGEST_CLOUDFLARE_API_TOKEN: discoveryToken }, output: outputCapture().output });
    assert.equal(result.ready, false);
    assert.equal(result.diagnostics.find(check => check.check === 'env_file')?.status, 'error');
    assert.equal(result.diagnostics.find(check => check.check === 'endpoint')?.status, 'skipped');
  }
  for (const provider of ['openai', 'offline']) {
    const result = await initConfiguration({ ...fixture, provider, yes: true, checkConnection: true,
      output: outputCapture().output });
    assert.equal(result.ready, provider === 'offline');
    assert.equal(result.diagnostics.find(check => check.check === 'endpoint')?.status, 'skipped');
  }
  const withOpenAIKey = await initConfiguration({ ...fixture, provider: 'openai', yes: true, checkConnection: true,
    environment: { ...fixture.environment, PERFDIGEST_DECISIONS_API_KEY: discoveryToken }, output: outputCapture().output });
  assert.equal(withOpenAIKey.ready, true);
  assert.equal(withOpenAIKey.diagnostics.find(check => check.check === 'endpoint')?.status, 'skipped');
  assert.equal(fetch.mock.callCount(), 0);
});

test('interactive connection opt-in runs only after the save confirmation', async t => {
  const fixture = await project();
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(discoveryBody));
  for (const confirm of [false, true]) {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    const capture = outputCapture(text => {
      if (text.includes('Save workspace configuration?')) {
        assert.equal(fetch.mock.callCount(), 0);
        setImmediate(() => input.write(confirm ? 'y\n' : 'n\n'));
      }
    });
    capture.output.isTTY = true;
    const pending = initConfiguration({ ...fixture, provider: 'cloudflare', envFile: '', checkConnection: true,
      input, output: capture.output, environment: { ...fixture.environment,
        PERFDIGEST_CLOUDFLARE_ACCOUNT_ID: discoveryAccount, PERFDIGEST_CLOUDFLARE_API_TOKEN: discoveryToken } });
    if (confirm) assert.equal((await pending).ready, true);
    else {
      await assert.rejects(pending, /cancelled before saving/);
      assert.equal(await loadConfiguration(fixture.workspace), null);
    }
  }
  assert.equal(fetch.mock.callCount(), 1);
});

test('CLI wires --check-connection to init and refuses it on other commands', async () => {
  const fixture = await project();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const preload = join(fixture.root, 'mock-discovery.mjs');
  const log = join(fixture.root, 'discovery-requests.jsonl');
  await writeFile(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, options) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url), method: options.method, redirect: options.redirect }) + '\\n');
  return new Response(${JSON.stringify(discoveryBody)});
};\n`);
  const run = promisify(execFile);
  const environment = { ...fixture.environment, PERFDIGEST_CLOUDFLARE_ACCOUNT_ID: discoveryAccount,
    PERFDIGEST_CLOUDFLARE_API_TOKEN: discoveryToken };
  const init = await run(process.execPath, ['--import', preload, cli, 'init', '--workspace', fixture.workspace,
    '--provider', 'cloudflare', '--yes', '--check-connection'], { env: environment });
  assert.match(init.stderr, /authenticated model-discovery read accepted/);
  const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].redirect, 'error');
  assert.match(requests[0].url, /\/ai\/models\/search\?/);
  await assert.rejects(run(process.execPath, ['--import', preload, cli, 'demo', '--workspace', fixture.workspace,
    '--check-connection'], { env: environment }), error => {
    assert.match((error as Error & { stderr: string }).stderr, /--check-connection belong to init/); return true;
  });
  await assert.rejects(run(process.execPath, ['--import', preload, cli, 'init', '--workspace', fixture.workspace,
    '--provider', 'cloudflare', '--yes', '--check-connection'], { env: fixture.environment }), error => {
    assert.match((error as Error & { stderr: string }).stderr, /Cloudflare was not contacted/); return true;
  });
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
});
