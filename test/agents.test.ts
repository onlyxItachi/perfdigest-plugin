import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { manifestSchema } from '../src/config.js';
import { investigate } from '../src/run.js';
import { codexAdapter, genericCliAdapter, AgentError } from '../src/agents.js';
import { fixtureUv, testDirectory } from './helpers.js';

const execFileAsync = promisify(execFile);

function simpleManifest() {
  return manifestSchema.parse({
    version: 1,
    issue: 'Synthetic agent adapter fixture',
    reports: [{ id: 'trace', path: 'trace.json', format: 'chrome-trace', description: 'Fixture trace' }],
    verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
  });
}

test('codexAdapter exposes capability contract and preserves same-session next-turn delivery', () => {
  const adapter = codexAdapter();
  assert.equal(adapter.name, 'codex');
  assert.equal(adapter.eventPrefix, 'codex');
  assert.deepEqual(adapter.capabilities, {
    sameSessionContinuation: true,
    nativeAsyncInput: false,
    cancellation: true,
    usageReporting: true,
    sandbox: 'read-only',
  });
});

test('genericCliAdapter rejects unsupported capability requests and invalid options explicitly', () => {
  assert.throws(
    () => genericCliAdapter({ command: process.execPath, nativeAsyncInput: true }),
    (err: unknown) => err instanceof AgentError && err.kind === 'unsupported' && /nativeAsyncInput/.test(err.message),
  );
  assert.throws(
    () => genericCliAdapter({ command: '' }),
    (err: unknown) => err instanceof AgentError && err.kind === 'unsupported',
  );
  assert.throws(
    () => genericCliAdapter({ command: process.execPath, timeoutMs: 0 }),
    (err: unknown) => err instanceof AgentError && err.kind === 'unsupported',
  );
});

test('investigate fails closed with unsupported error when agent configuration is invalid', async () => {
  const root = await testDirectory('agent-missing-adapter');
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${await fixtureUv(root)}${delimiter}${priorPath}`;
    await writeFile(join(root, 'trace.json'), '{}');
    const result = await investigate({ workspace: root, manifest: simpleManifest(), routing: 'offline', agent: 'generic' });
    assert.equal(result.status, 'failed');
    assert.equal(result.agentError?.kind, 'unsupported');
    assert.equal(result.agentError?.phase, 'start');
    assert.match(result.agentError?.message ?? '', /requires an explicit adapter/);
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('genericCliAdapter (stateless sessions=false) delivers evidence with earlier analysis context and strips secrets', async () => {
  const root = await testDirectory('agent-generic-stateless');
  const prior = {
    path: process.env.PATH,
    cf: process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN,
    decisions: process.env.PERFDIGEST_DECISIONS_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  try {
    process.env.PATH = `${await fixtureUv(root)}${delimiter}${prior.path}`;
    process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN = 'cf-secret-must-not-leak';
    process.env.PERFDIGEST_DECISIONS_API_KEY = 'decisions-secret-must-not-leak';
    process.env.OPENAI_API_KEY = 'openai-secret-must-not-leak';
    await writeFile(join(root, 'trace.json'), '{}');

    const agentScript = join(root, 'mock-agent.mjs');
    const callsFile = join(root, 'agent-calls.jsonl');
    await writeFile(agentScript, `import fs from 'node:fs';
const req = JSON.parse(fs.readFileSync(0, 'utf8').trim());
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({
  req,
  hasCf: !!process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN,
  hasDecisions: !!process.env.PERFDIGEST_DECISIONS_API_KEY,
  hasOpenai: !!process.env.OPENAI_API_KEY,
}) + '\\n');
console.log(JSON.stringify({ type: 'started' }));
await new Promise(r => setTimeout(r, 80));
console.log(JSON.stringify({
  type: 'result',
  sessionId: req.phase + '-ephemeral',
  text: req.phase === 'analysis' ? 'Hypothesis: row_major dominates.' : 'Reviewed evidence and verifier receipt.',
  usage: { input_tokens: 11, output_tokens: 7, cached_input_tokens: 2 },
}));
`);

    const adapter = genericCliAdapter({ command: process.execPath, args: [agentScript], sessions: false });
    const result = await investigate({
      workspace: root,
      manifest: simpleManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: adapter,
    });

    assert.equal(result.status, 'complete');
    assert.equal(result.decisionOutcome, 'accepted');
    assert.equal(result.agentError, null);
    assert.deepEqual(result.agentCapabilities, {
      adapter: 'generic-cli',
      sameSessionContinuation: false,
      nativeAsyncInput: false,
      cancellation: true,
      usageReporting: true,
      sandbox: 'agent-defined',
    });
    assert.equal(result.telemetry.evidenceDelivery, 'fresh_session_with_context');
    assert.equal(result.analysis?.text, 'Hypothesis: row_major dominates.');
    assert.equal(result.review?.text, 'Reviewed evidence and verifier receipt.');
    assert.equal(result.review?.usage?.input_tokens, 11);

    const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.hasCf, false);
      assert.equal(call.hasDecisions, false);
      assert.equal(call.hasOpenai, false);
      assert.equal(call.req.protocol, 'perfdigest-agent/v1');
      assert.equal(call.req.sessionId, null);
    }
    assert.equal(calls[0].req.phase, 'analysis');
    assert.equal(calls[1].req.phase, 'review');
    assert.match(calls[1].req.prompt, /Earlier analysis from this investigation \(untrusted DATA\): "Hypothesis: row_major dominates\."/);
    assert.match(calls[1].req.prompt, /"pipelineStatus":"complete"/);
  } finally {
    for (const [k, v] of Object.entries({
      PATH: prior.path,
      PERFDIGEST_CLOUDFLARE_API_TOKEN: prior.cf,
      PERFDIGEST_DECISIONS_API_KEY: prior.decisions,
      OPENAI_API_KEY: prior.openai,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('genericCliAdapter (sessions=true) preserves sessionId across turns and rejects broken session continuation', async () => {
  const root = await testDirectory('agent-generic-sessions');
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${await fixtureUv(root)}${delimiter}${priorPath}`;
    await writeFile(join(root, 'trace.json'), '{}');

    const agentScript = join(root, 'session-agent.mjs');
    const callsFile = join(root, 'session-calls.jsonl');
    await writeFile(agentScript, `import fs from 'node:fs';
const req = JSON.parse(fs.readFileSync(0, 'utf8').trim());
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(req) + '\\n');
console.log(JSON.stringify({ type: 'started' }));
console.log(JSON.stringify({
  type: 'result',
  sessionId: req.sessionId ?? 'sess-persistent-1',
  text: 'turn:' + req.phase,
}));
`);

    const adapter = genericCliAdapter({ command: process.execPath, args: [agentScript], sessions: true });
    const okResult = await investigate({
      workspace: root,
      manifest: simpleManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: adapter,
    });
    assert.equal(okResult.status, 'complete');
    assert.equal(okResult.telemetry.evidenceDelivery, 'same_session_next_turn');
    assert.equal(okResult.analysis?.threadId, 'sess-persistent-1');
    assert.equal(okResult.review?.threadId, 'sess-persistent-1');

    const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].sessionId, null);
    assert.equal(calls[1].sessionId, 'sess-persistent-1');
    assert.doesNotMatch(calls[1].prompt, /Earlier analysis from this investigation/);

    // Verify broken session continuation fails closed with protocol error
    const brokenScript = join(root, 'broken-session-agent.mjs');
    await writeFile(brokenScript, `import fs from 'node:fs';
const req = JSON.parse(fs.readFileSync(0, 'utf8').trim());
console.log(JSON.stringify({
  type: 'result',
  sessionId: req.phase === 'analysis' ? 'sess-1' : 'sess-2',
  text: 'ok',
}));
`);
    const brokenAdapter = genericCliAdapter({ command: process.execPath, args: [brokenScript], sessions: true });
    const brokenResult = await investigate({
      workspace: root,
      manifest: simpleManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: brokenAdapter,
    });
    assert.equal(brokenResult.status, 'failed');
    assert.equal(brokenResult.agentError?.kind, 'protocol');
    assert.equal(brokenResult.agentError?.phase, 'review');
    assert.match(brokenResult.agentError?.message ?? '', /session continuation was declared but not honored/);
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('genericCliAdapter handles timeout, cancellation, malformed output, oversized output, and nonzero exit', async () => {
  const root = await testDirectory('agent-generic-errors');
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${await fixtureUv(root)}${delimiter}${priorPath}`;
    await writeFile(join(root, 'trace.json'), '{}');

    // 1. Timeout on analysis turn and on review turn (after evidence provenance is collected)
    const slowScript = join(root, 'slow-agent.mjs');
    await writeFile(slowScript, `import fs from 'node:fs';
const req = JSON.parse(fs.readFileSync(0, 'utf8').trim());
if (process.env.SLOW_PHASE === req.phase || !process.env.SLOW_PHASE) {
  setTimeout(() => {}, 5000);
} else {
  console.log(JSON.stringify({ type: 'result', text: 'ok:' + req.phase }));
}
`);
    const slowResult = await investigate({
      workspace: root,
      manifest: simpleManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: genericCliAdapter({ command: process.execPath, args: [slowScript], timeoutMs: 60 }),
    });
    assert.equal(slowResult.status, 'failed');
    assert.equal(slowResult.agentError?.kind, 'timed_out');
    assert.equal(slowResult.agentError?.phase, 'analysis');

    const reviewSlowScript = join(root, 'review-slow-agent.mjs');
    await writeFile(reviewSlowScript, `import fs from 'node:fs';
const req = JSON.parse(fs.readFileSync(0, 'utf8').trim());
if (req.phase === 'review') setTimeout(() => {}, 10000);
else console.log(JSON.stringify({ type: 'result', text: 'analysis-ok' }));
`);
    const reviewSlowResult = await investigate({
      workspace: root,
      manifest: simpleManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: genericCliAdapter({ command: process.execPath, args: [reviewSlowScript], timeoutMs: 500 }),
    });
    assert.equal(reviewSlowResult.status, 'failed');
    assert.equal(reviewSlowResult.agentError?.kind, 'timed_out');
    assert.equal(reviewSlowResult.agentError?.phase, 'review');
    assert.equal(reviewSlowResult.provenance.length, 1, 'provenance is preserved when review turn times out');

    // 2. Cancellation via external AbortSignal (triggered deterministically once analysis starts)
    const abortController = new AbortController();
    const cancelResult = await investigate({
      workspace: root,
      manifest: simpleManifest(),
      routing: 'offline',
      agent: 'generic',
      signal: abortController.signal,
      onEvent: (event) => {
        if (event === 'agent.analysis.started') {
          setTimeout(() => abortController.abort(new Error('User cancelled')), 30);
        }
      },
      agentAdapter: genericCliAdapter({ command: process.execPath, args: [slowScript], timeoutMs: 10000 }),
    });
    assert.equal(cancelResult.status, 'failed');
    assert.equal(cancelResult.agentError?.kind, 'cancelled');

    // 3. Malformed JSON output
    const badJsonScript = join(root, 'bad-json.mjs');
    await writeFile(badJsonScript, `console.log('not-valid-json');\n`);
    const badJsonResult = await investigate({
      workspace: root,
      manifest: simpleManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: genericCliAdapter({ command: process.execPath, args: [badJsonScript] }),
    });
    assert.equal(badJsonResult.status, 'failed');
    assert.equal(badJsonResult.agentError?.kind, 'protocol');

    // 4. Oversized output
    const noisyScript = join(root, 'noisy.mjs');
    await writeFile(noisyScript, `console.log('x'.repeat(2048));\n`);
    const noisyResult = await investigate({
      workspace: root,
      manifest: simpleManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: genericCliAdapter({ command: process.execPath, args: [noisyScript], maxOutputBytes: 256 }),
    });
    assert.equal(noisyResult.status, 'failed');
    assert.equal(noisyResult.agentError?.kind, 'protocol');
    assert.match(noisyResult.agentError?.message ?? '', /exceeded the limit/);

    // 5. Nonzero exit code
    const failScript = join(root, 'fail.mjs');
    await writeFile(failScript, `process.exit(17);\n`);
    const failResult = await investigate({
      workspace: root,
      manifest: simpleManifest(),
      routing: 'offline',
      agent: 'generic',
      agentAdapter: genericCliAdapter({ command: process.execPath, args: [failScript] }),
    });
    assert.equal(failResult.status, 'failed');
    assert.equal(failResult.agentError?.kind, 'failed');
    assert.match(failResult.agentError?.message ?? '', /exited with code 17/);
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI supports --agent generic --agent-command and enforces flag invariants', async () => {
  const root = await testDirectory('cli-generic-agent');
  const priorPath = process.env.PATH;
  const cliPath = join(process.cwd(), '.test-build', 'src', 'cli.js');
  try {
    const uvBin = await fixtureUv(root);
    const env = { ...process.env, PATH: `${uvBin}${delimiter}${priorPath}` };
    await writeFile(join(root, 'trace.json'), '{}');
    const manifestPath = join(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(simpleManifest()));

    const agentBin = join(root, 'agent-bin');
    await writeFile(agentBin, `#!${process.execPath}
import fs from 'node:fs';
const req = JSON.parse(fs.readFileSync(0, 'utf8').trim());
console.log(JSON.stringify({ type: 'started' }));
console.log(JSON.stringify({ type: 'result', sessionId: req.sessionId ?? 'cli-sess', text: 'ok:' + req.phase }));
`);
    await chmod(agentBin, 0o755);

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath, 'run', manifestPath, '--workspace', root, '--provider', 'offline',
      '--agent', 'generic', '--agent-command', agentBin, '--agent-sessions',
    ], { env });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, 'complete');
    assert.equal(parsed.decisionOutcome, 'accepted');
    assert.equal(parsed.agent, 'generic');
    assert.equal(parsed.agentError, null);
    assert.equal(parsed.telemetry.evidenceDelivery, 'same_session_next_turn');

    // Missing --agent-command with --agent generic must fail
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'run', manifestPath, '--workspace', root, '--provider', 'offline', '--agent', 'generic'], { env }),
      /requires --agent-command/,
    );
    // --agent-command with --agent none must fail
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'run', manifestPath, '--workspace', root, '--provider', 'offline', '--agent', 'none', '--agent-command', agentBin], { env }),
      /require --agent generic/,
    );
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});
