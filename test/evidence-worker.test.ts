import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  cancelEvidenceWorker,
  collectEvidenceWorker,
  evaluateWorkerProcessStatus,
  getEvidenceWorkerStatus,
  parsePsProcessLine,
  parseWindowsCimJson,
  runDetachedEvidenceWorker,
  runEvidenceWorker,
  startEvidenceWorker,
  validateEvidenceJobId,
  waitEvidenceWorker,
  type EvidenceJobState,
  type Manifest,
} from '../src/index.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsCli = resolve(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');
const goBinary = join(repoRoot, 'dist/perfdigest-plugin');
const zeroCostMcp = join(repoRoot, 'bench/probes/zero-cost-mcp.mjs');

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePort((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolveClose => server.close(() => resolveClose()));
}

async function createTraceWorkspace(label: string, verification: Manifest['verification']): Promise<{
  workspace: string;
  manifestPath: string;
  manifest: Manifest;
}> {
  const workspace = await mkdtemp(join(tmpdir(), `pd-bg-${label}-`));
  const tracePath = join(workspace, 'trace.json');
  await writeFile(
    tracePath,
    JSON.stringify({
      traceEvents: [
        { name: 'hot_kernel', ph: 'X', ts: 0, dur: 1250 },
        { name: 'cold_helper', ph: 'X', ts: 1300, dur: 80 },
      ],
    }),
    'utf8',
  );
  const manifest: Manifest = {
    version: 1,
    issue: 'Investigate hot kernel latency in fixture trace.',
    captures: [],
    reports: [
      {
        id: 'primary-trace',
        path: 'trace.json',
        format: 'chrome-trace',
        description: 'Fixture chrome trace',
      },
    ],
    verification,
  };
  const manifestPath = join(workspace, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { workspace, manifestPath, manifest };
}

test('evidence run writes 0600 atomic artifacts, verified SHA-256 ready.json, and works via TS & Go CLIs', async () => {
  const { workspace, manifestPath, manifest } = await createTraceWorkspace('run', {
    command: process.execPath,
    args: ['-e', 'console.log("verifier-ok")'],
    timeoutMs: 15_000,
  });

  try {
    // 1. Direct TS API
    const out = await runEvidenceWorker({
      workspace,
      manifest,
      routing: 'offline',
      mcpSessionOptions: { command: process.execPath, args: [zeroCostMcp] },
    });
    assert.equal(out.version, 1);
    assert.equal(out.deliveryMode, 'skill_background_worker');
    assert.equal(out.status, 'complete');
    assert.equal(out.decisionOutcome, 'accepted');
    assert.equal(out.verificationExitCode, 0);
    assert.equal(out.provenanceCount, 1);
    assert.match(out.evidenceSha256, /^[a-f0-9]{64}$/);
    assert.equal(out.packet.schema, 'perfdigest.agent-evidence.v1');
    assert.equal(out.packet.status, 'complete');

    for (const p of [out.runJsonPath, out.evidencePath, out.readyPath]) {
      const st = await stat(p);
      assert.equal(st.mode & 0o777, 0o600, `expected 0600 mode on ${p}`);
    }
    const runDoc = JSON.parse(await readFile(out.runJsonPath, 'utf8'));
    assert.equal(runDoc.telemetry.evidenceDelivery, 'skill_background_worker');

    // 2. TS CLI `evidence run`
    const tsExec = await execFileAsync(process.execPath, [
      tsCli,
      'evidence',
      'run',
      manifestPath,
      '--workspace',
      workspace,
      '--provider',
      'offline',
      '--mcp-command',
      process.execPath,
      '--mcp-arg',
      zeroCostMcp,
      '--json',
    ]);
    const tsParsed = JSON.parse(tsExec.stdout);
    assert.equal(tsParsed.deliveryMode, 'skill_background_worker');
    assert.equal(tsParsed.status, 'complete');
    assert.equal(tsParsed.packet.schema, 'perfdigest.agent-evidence.v1');

    // 3. Go CLI `evidence run`
    const goExec = await execFileAsync(goBinary, [
      'evidence',
      'run',
      manifestPath,
      '--workspace',
      workspace,
      '--provider',
      'offline',
      '--mcp-command',
      process.execPath,
      '--mcp-arg',
      zeroCostMcp,
      '--json',
    ]);
    const goParsed = JSON.parse(goExec.stdout);
    assert.equal(goParsed.deliveryMode, 'skill_background_worker');
    assert.equal(goParsed.status, 'complete');
    assert.equal(goParsed.decisionOutcome, 'accepted');
    assert.equal(goParsed.packet.schema, 'perfdigest.agent-evidence.v1');
    assert.equal(goParsed.verificationExitCode, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('detached start -> status -> wait -> idempotent collect (--full) parity across TS and Go CLIs', async () => {
  const { workspace, manifestPath } = await createTraceWorkspace('lifecycle', {
    command: process.execPath,
    args: ['-e', 'setTimeout(() => console.log("slow-verify-ok"), 250)'],
    timeoutMs: 15_000,
  });

  try {
    for (const runner of [
      { label: 'ts', cmd: process.execPath, prefix: [tsCli] },
      { label: 'go', cmd: goBinary, prefix: [] },
    ]) {
      const startRes = await execFileAsync(runner.cmd, [
        ...runner.prefix,
        'evidence',
        'start',
        manifestPath,
        '--workspace',
        workspace,
        '--provider',
        'offline',
        '--mcp-command',
        process.execPath,
        '--mcp-arg',
        zeroCostMcp,
      ]);
      const started = JSON.parse(startRes.stdout);
      assert.equal(started.deliveryMode, 'skill_background_worker', runner.label);
      assert.equal(started.status, 'running', runner.label);
      assert.ok(Number.isInteger(started.pid) && started.pid > 0, runner.label);

      const statusRes = await execFileAsync(runner.cmd, [
        ...runner.prefix,
        'evidence',
        'status',
        started.jobId,
        '--workspace',
        workspace,
      ]);
      const stObj = JSON.parse(statusRes.stdout);
      assert.ok(['running', 'complete'].includes(stObj.status), `${runner.label}: ${stObj.status}`);

      const waitRes = await execFileAsync(runner.cmd, [
        ...runner.prefix,
        'evidence',
        'wait',
        started.jobId,
        '--workspace',
        workspace,
        '--timeout-ms',
        '15000',
      ]);
      const waited = JSON.parse(waitRes.stdout);
      assert.equal(waited.status, 'complete', runner.label);
      assert.equal(waited.timedOut, false, runner.label);
      assert.equal(waited.packet.schema, 'perfdigest.agent-evidence.v1', runner.label);
      assert.equal(waited.verificationExitCode, 0, runner.label);

      // Idempotent collect (twice) + --full
      const col1 = JSON.parse(
        (await execFileAsync(runner.cmd, [...runner.prefix, 'evidence', 'collect', started.jobId, '--workspace', workspace])).stdout,
      );
      const col2 = JSON.parse(
        (
          await execFileAsync(runner.cmd, [
            ...runner.prefix,
            'evidence',
            'collect',
            started.jobId,
            '--workspace',
            workspace,
            '--full',
          ])
        ).stdout,
      );
      assert.equal(col1.verifiedSha256, true, runner.label);
      assert.equal(col1.evidenceSha256, col2.evidenceSha256, runner.label);
      assert.equal(col1.run, undefined, runner.label);
      assert.equal(col2.run.status, 'complete', runner.label);
      assert.equal(col2.run.telemetry.evidenceDelivery, 'skill_background_worker', runner.label);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('evidence cancel terminates slow detached worker, blocks collect, and refuses PID-ownership mismatch', async () => {
  const { workspace, manifest } = await createTraceWorkspace('cancel', {
    command: process.execPath,
    args: ['-e', 'setTimeout(() => console.log("never"), 20000)'],
    timeoutMs: 30_000,
  });

  const unrelatedChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    const started = await startEvidenceWorker({
      workspace,
      manifest,
      routing: 'offline',
      mcpSessionOptions: { command: process.execPath, args: [zeroCostMcp] },
    });

    const stBefore = await getEvidenceWorkerStatus({ workspace, jobId: started.jobId });
    assert.equal(stBefore.status, 'running');

    const cancelled = await cancelEvidenceWorker({ workspace, jobId: started.jobId });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.alreadyTerminal, false);
    assert.ok(cancelled.signalSent === 'SIGTERM' || cancelled.signalSent === 'SIGKILL');

    const stAfter = await getEvidenceWorkerStatus({ workspace, jobId: started.jobId });
    assert.equal(stAfter.status, 'cancelled');
    await assert.rejects(collectEvidenceWorker({ workspace, jobId: started.jobId }), /was cancelled/);

    // PID-ownership mismatch guard: a state file pointing to an unrelated live PID with wrong marker must NOT signal it.
    const mismatchJobId = 'ev-mismatch-guard-01';
    const mismatchJobDir = join(workspace, '.perfdigest', 'jobs', mismatchJobId);
    const mismatchRunDir = join(workspace, '.perfdigest', 'runs', mismatchJobId);
    await writeFile(
      join(workspace, '.perfdigest', 'jobs', started.jobId, 'state.json'),
      await readFile(join(workspace, '.perfdigest', 'jobs', started.jobId, 'state.json')),
    );
    await execFileAsync('mkdir', ['-p', mismatchJobDir, mismatchRunDir]);
    const mismatchState: EvidenceJobState = {
      version: 1,
      deliveryMode: 'skill_background_worker',
      jobId: mismatchJobId,
      pid: unrelatedChild.pid!,
      processStartId: '9999999999999',
      workerMarker: mismatchJobId,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      workspace,
      runDir: mismatchRunDir,
      runJsonPath: join(mismatchRunDir, 'run.json'),
      evidencePath: join(mismatchRunDir, 'evidence.v1.json'),
      readyPath: join(mismatchRunDir, 'ready.json'),
      statusPath: join(mismatchJobDir, 'state.json'),
      logPath: join(mismatchJobDir, 'worker.log'),
      routing: 'offline',
      decisionOutcome: null,
      verificationExitCode: null,
      provenanceCount: 0,
      error: null,
    };
    await writeFile(join(mismatchJobDir, 'state.json'), JSON.stringify(mismatchState, null, 2), { mode: 0o600 });

    const guardCancel = await cancelEvidenceWorker({ workspace, jobId: mismatchJobId });
    assert.equal(guardCancel.status, 'cancelled');
    assert.equal(guardCancel.signalSent, null);
    assert.equal(guardCancel.note, 'pid_ownership_mismatch_skipped_signal');
    // Unrelated process must still be alive.
    assert.doesNotThrow(() => process.kill(unrelatedChild.pid!, 0));
  } finally {
    unrelatedChild.kill('SIGKILL');
    await rm(workspace, { recursive: true, force: true });
  }
});

test('collect fails closed on evidence.v1.json SHA-256 tamper (TS & Go) and rejects invalid jobIds / symlinks', async () => {
  assert.throws(() => validateEvidenceJobId('../escape'), /Invalid jobId/);
  assert.throws(() => validateEvidenceJobId('short'), /Invalid jobId/);

  const { workspace, manifest } = await createTraceWorkspace('tamper', {
    command: process.execPath,
    args: ['-e', 'console.log("ok")'],
    timeoutMs: 15_000,
  });

  try {
    const out = await runEvidenceWorker({
      workspace,
      manifest,
      routing: 'offline',
      mcpSessionOptions: { command: process.execPath, args: [zeroCostMcp] },
    });

    // Tamper with 1 byte of evidence.v1.json after ready.json was sealed
    const original = await readFile(out.evidencePath, 'utf8');
    await writeFile(out.evidencePath, original.replace('"complete"', '"tampered"'), { mode: 0o600 });

    await assert.rejects(
      collectEvidenceWorker({ workspace, jobId: out.jobId }),
      /SHA-256 mismatch/,
    );
    await assert.rejects(
      execFileAsync(goBinary, ['evidence', 'collect', out.jobId, '--workspace', workspace]),
      /SHA-256 mismatch/,
    );

    // Symlink replacement on evidence.v1.json must also fail closed
    const outsideFile = join(workspace, 'outside.json');
    await writeFile(outsideFile, original, { mode: 0o600 });
    await rm(out.evidencePath);
    await symlink(outsideFile, out.evidencePath);
    await assert.rejects(
      collectEvidenceWorker({ workspace, jobId: out.jobId }),
      /non-symlink/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('abstention (needs_review) and failed verifier stay non-complete and fail closed on exit code', async () => {
  // 1. Abstention via loopback local SystemOne mock returning low confidence (0.40 < 0.65)
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/systemone') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'clef-flash',
          answers: {
            next_evidence: {
              type: 'choice',
              choice: 'primary-trace',
              confidence: 0.4,
              probabilities: {
                'primary-trace': 0.55,
                __human_review__: 0.45,
              },
            },
          },
          usage: { input_tokens: 12, output_tokens: 1 },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  const prevClefUrl = process.env.PERFDIGEST_CLEF_URL;
  process.env.PERFDIGEST_CLEF_URL = `http://127.0.0.1:${port}/v1/systemone`;

  const abstWs = await createTraceWorkspace('abstain', {
    command: process.execPath,
    args: ['-e', 'console.log("verify-pass")'],
    timeoutMs: 15_000,
  });
  const failWs = await createTraceWorkspace('failver', {
    command: process.execPath,
    args: ['-e', 'console.error("regression detected"); process.exit(1)'],
    timeoutMs: 15_000,
  });

  try {
    // Abstention check (TS CLI must exit nonzero, print needs_review, and allow verified collect)
    let abstStdout = '';
    try {
      await execFileAsync(process.execPath, [
        tsCli,
        'evidence',
        'run',
        abstWs.manifestPath,
        '--workspace',
        abstWs.workspace,
        '--provider',
        'local',
        '--mcp-command',
        process.execPath,
        '--mcp-arg',
        zeroCostMcp,
      ]);
      assert.fail('expected nonzero exit for abstained needs_review run');
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string };
      assert.equal(e.code, 1);
      abstStdout = e.stdout ?? '';
    }
    const abstOut = JSON.parse(abstStdout);
    assert.equal(abstOut.status, 'needs_review');
    assert.equal(abstOut.decisionOutcome, 'abstained');
    assert.equal(abstOut.provenanceCount, 1);
    assert.deepEqual(abstOut.packet.selected, []);

    const abstCollected = await collectEvidenceWorker({ workspace: abstWs.workspace, jobId: abstOut.jobId });
    assert.equal(abstCollected.status, 'needs_review');
    assert.equal(abstCollected.verifiedSha256, true);

    // Failed verifier must remain failed (both TS & Go)
    let failStdout = '';
    try {
      await execFileAsync(goBinary, [
        'evidence',
        'run',
        failWs.manifestPath,
        '--workspace',
        failWs.workspace,
        '--provider',
        'offline',
        '--mcp-command',
        process.execPath,
        '--mcp-arg',
        zeroCostMcp,
      ]);
      assert.fail('expected nonzero exit when verifier fails');
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string };
      assert.equal(e.code, 1);
      failStdout = e.stdout ?? '';
    }
    const failOut = JSON.parse(failStdout);
    assert.equal(failOut.status, 'failed');
    assert.equal(failOut.verificationExitCode, 1);
    assert.equal(failOut.packet.status, 'failed');
    assert.equal(failOut.packet.verification.passed, false);
  } finally {
    if (prevClefUrl === undefined) delete process.env.PERFDIGEST_CLEF_URL;
    else process.env.PERFDIGEST_CLEF_URL = prevClefUrl;
    await closeServer(server);
    await rm(abstWs.workspace, { recursive: true, force: true });
    await rm(failWs.workspace, { recursive: true, force: true });
  }
});

test('stale/crashed PID without ready.json is reported as crashed and wait returns promptly', async () => {
  const { workspace } = await createTraceWorkspace('crashed', {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 10_000,
  });

  try {
    // Spawn a short-lived process and wait for it to exit so we get a guaranteed dead PID.
    const deadChild = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = deadChild.pid!;
    await new Promise<void>(resolveExit => deadChild.once('close', () => resolveExit()));

    const jobId = 'ev-crashed-pid-test1';
    const jobDir = join(workspace, '.perfdigest', 'jobs', jobId);
    const runDir = join(workspace, '.perfdigest', 'runs', jobId);
    await execFileAsync('mkdir', ['-p', jobDir, runDir]);
    const state: EvidenceJobState = {
      version: 1,
      deliveryMode: 'skill_background_worker',
      jobId,
      pid: deadPid,
      processStartId: '1',
      workerMarker: jobId,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      workspace,
      runDir,
      runJsonPath: join(runDir, 'run.json'),
      evidencePath: join(runDir, 'evidence.v1.json'),
      readyPath: join(runDir, 'ready.json'),
      statusPath: join(jobDir, 'state.json'),
      logPath: join(jobDir, 'worker.log'),
      routing: 'offline',
      decisionOutcome: null,
      verificationExitCode: null,
      provenanceCount: 0,
      error: null,
    };
    await writeFile(join(jobDir, 'state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
    await chmod(join(jobDir, 'state.json'), 0o600);

    const st = await getEvidenceWorkerStatus({ workspace, jobId });
    assert.equal(st.status, 'crashed');
    assert.equal(st.ready, false);

    const waited = await waitEvidenceWorker({ workspace, jobId, timeoutMs: 5000 });
    assert.equal(waited.status, 'crashed');
    assert.equal(waited.timedOut, false);
    assert.equal(waited.packet, null);
    assert.ok(waited.waitedMs < 2000);

    // Go CLI parity on the exact same crashed state file
    const goSt = JSON.parse((await execFileAsync(goBinary, ['evidence', 'status', jobId, '--workspace', workspace])).stdout);
    assert.equal(goSt.status, 'crashed');
    assert.equal(goSt.ready, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('secret redaction strips tokens from evidence.v1.json, ready.json, state.json, run.json, and CLI stdout', async () => {
  const secretVal = 'super_secret_worker_token_998877';
  const skToken = 'sk-test1234567890abcdef1234';
  const bearerToken = 'Bearer mybearertoken987654321';
  const { workspace, manifestPath } = await createTraceWorkspace('redact', {
    command: process.execPath,
    args: ['-e', `console.log("leaked=${secretVal} ${skToken} ${bearerToken}")`],
    timeoutMs: 15_000,
  });

  try {
    for (const runner of [
      { label: 'ts', cmd: process.execPath, prefix: [tsCli] },
      { label: 'go', cmd: goBinary, prefix: [] },
    ]) {
      const res = await execFileAsync(
        runner.cmd,
        [
          ...runner.prefix,
          'evidence',
          'run',
          manifestPath,
          '--workspace',
          workspace,
          '--provider',
          'offline',
          '--mcp-command',
          process.execPath,
          '--mcp-arg',
          zeroCostMcp,
        ],
        {
          env: {
            ...process.env,
            PERFDIGEST_TEST_SECRET_TOKEN: secretVal,
          },
        },
      );
      const parsed = JSON.parse(res.stdout);
      for (const blob of [
        res.stdout,
        await readFile(parsed.evidencePath, 'utf8'),
        await readFile(parsed.readyPath, 'utf8'),
        await readFile(parsed.runJsonPath, 'utf8'),
      ]) {
        assert.ok(!blob.includes(secretVal), `${runner.label}: leaked env secret`);
        assert.ok(!blob.includes(skToken), `${runner.label}: leaked sk token`);
        assert.ok(!blob.includes('mybearertoken987654321'), `${runner.label}: leaked bearer token`);
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('non-Linux PID ownership checks fail closed across darwin, win32, and unknown OSes', async () => {
  // Parse helpers
  const psParsed = parsePsProcessLine('Ss   Sun Nov 22 23:15:00 2026 /usr/bin/perfdigest-plugin evidence _worker --job-id ev-20261122-abcd1234\n');
  assert.deepEqual(psParsed, {
    state: 'Ss',
    startId: 'Sun Nov 22 23:15:00 2026',
    command: '/usr/bin/perfdigest-plugin evidence _worker --job-id ev-20261122-abcd1234',
  });
  assert.equal(parsePsProcessLine(''), null);

  const winParsed = parseWindowsCimJson('{"CreationDate":"20261122231500.000000+000","CommandLine":"perfdigest-plugin.exe evidence _worker --job-id ev-win-0001"}');
  assert.deepEqual(winParsed, {
    exists: true,
    startId: '20261122231500.000000+000',
    command: 'perfdigest-plugin.exe evidence _worker --job-id ev-win-0001',
  });
  assert.deepEqual(parseWindowsCimJson('   '), { exists: false, startId: '', command: '' });

  // darwin: positive verification requires BOTH lstart and marker match
  assert.deepEqual(
    evaluateWorkerProcessStatus('darwin', 4242, 'Sun Nov 22 23:15:00 2026', 'ev-darwin-01', {
      killZero: () => 'ok',
      psQuery: () => ({
        state: 'S',
        startId: 'Sun Nov 22 23:15:00 2026',
        command: 'perfdigest-plugin evidence _worker --job-id ev-darwin-01',
      }),
    }),
    { alive: true, owned: true },
  );
  // darwin: mismatched lstart / missing marker / ps failure / missing expectedStartId all fail closed (owned: false)
  assert.deepEqual(
    evaluateWorkerProcessStatus('darwin', 4242, 'Sun Nov 22 23:15:00 2026', 'ev-darwin-01', {
      killZero: () => 'ok',
      psQuery: () => ({
        state: 'S',
        startId: 'Mon Nov 23 00:00:01 2026',
        command: 'perfdigest-plugin evidence _worker --job-id ev-darwin-01',
      }),
    }),
    { alive: true, owned: false },
  );
  assert.deepEqual(
    evaluateWorkerProcessStatus('darwin', 4242, 'Sun Nov 22 23:15:00 2026', 'ev-darwin-01', {
      killZero: () => 'ok',
      psQuery: () => null,
    }),
    { alive: true, owned: false },
  );
  assert.deepEqual(
    evaluateWorkerProcessStatus('darwin', 4242, null, 'ev-darwin-01', {
      killZero: () => 'ok',
      psQuery: () => ({
        state: 'S',
        startId: 'Sun Nov 22 23:15:00 2026',
        command: 'perfdigest-plugin evidence _worker --job-id ev-darwin-01',
      }),
    }),
    { alive: true, owned: false },
  );

  // win32: positive verification requires BOTH CreationDate and marker match; failing query fails closed
  assert.deepEqual(
    evaluateWorkerProcessStatus('win32', 4242, '20261122231500.000000+000', 'ev-win-0001', {
      winQuery: () => ({
        exists: true,
        startId: '20261122231500.000000+000',
        command: 'perfdigest-plugin.exe evidence _worker --job-id ev-win-0001',
      }),
    }),
    { alive: true, owned: true },
  );
  assert.deepEqual(
    evaluateWorkerProcessStatus('win32', 4242, '20261122231500.000000+000', 'ev-win-0001', {
      winQuery: () => null,
    }),
    { alive: true, owned: false },
  );
  assert.deepEqual(
    evaluateWorkerProcessStatus('win32', 4242, '20261122231500.000000+000', 'ev-win-0001', {
      winQuery: () => ({ exists: false, startId: '', command: '' }),
    }),
    { alive: false, owned: false },
  );

  // Unknown OS always fails closed (never owned: true)
  assert.deepEqual(
    evaluateWorkerProcessStatus('sunos', 4242, '123', 'ev-sunos-01', { killZero: () => 'ok' }),
    { alive: true, owned: false },
  );
});

test('duplicate jobId is rejected atomically and pre-PID cancelled.marker prevents detached worker execution', async () => {
  const { workspace, manifest } = await createTraceWorkspace('dup-cancel', {
    command: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync("verifier-ran.flag", "ran")'],
    timeoutMs: 15_000,
  });

  try {
    // 1. Duplicate jobId rejection in both runEvidenceWorker and startEvidenceWorker
    const fixedId = 'ev-duplicate-check-01';
    const first = await runEvidenceWorker({
      workspace,
      manifest,
      routing: 'offline',
      jobId: fixedId,
      mcpSessionOptions: { command: process.execPath, args: [zeroCostMcp] },
    });
    assert.equal(first.status, 'complete');

    await assert.rejects(
      runEvidenceWorker({
        workspace,
        manifest,
        routing: 'offline',
        jobId: fixedId,
        mcpSessionOptions: { command: process.execPath, args: [zeroCostMcp] },
      }),
      /already exists/,
    );
    await assert.rejects(
      startEvidenceWorker({
        workspace,
        manifest,
        routing: 'offline',
        jobId: fixedId,
        mcpSessionOptions: { command: process.execPath, args: [zeroCostMcp] },
      }),
      /already exists/,
    );

    // 2. Cancelling a completed job must preserve ready.json without creating a conflicting cancelled.marker
    const cancelCompleted = await cancelEvidenceWorker({ workspace, jobId: fixedId });
    assert.equal(cancelCompleted.alreadyTerminal, true);
    assert.equal(cancelCompleted.status, 'complete');
    const colAfterCancel = await collectEvidenceWorker({ workspace, jobId: fixedId });
    assert.equal(colAfterCancel.status, 'complete');

    // 3. Pre-PID cancel writes cancelled.marker and prevents _worker from running investigate/verification
    await rm(join(workspace, 'verifier-ran.flag'), { force: true });
    const preCancelId = 'ev-precancel-guard-01';
    const jobDir = join(workspace, '.perfdigest', 'jobs', preCancelId);
    const runDir = join(workspace, '.perfdigest', 'runs', preCancelId);
    await execFileAsync('mkdir', ['-p', jobDir, runDir]);
    await writeFile(join(jobDir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    await writeFile(
      join(jobDir, 'request.json'),
      JSON.stringify({
        version: 1,
        jobId: preCancelId,
        routing: 'offline',
        compactEvidence: true,
        includeCorroborating: false,
        mcpCommand: process.execPath,
        mcpArgs: [zeroCostMcp],
      }),
      { mode: 0o600 },
    );
    const preState: EvidenceJobState = {
      version: 1,
      deliveryMode: 'skill_background_worker',
      jobId: preCancelId,
      pid: null,
      processStartId: null,
      workerMarker: preCancelId,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      workspace,
      runDir,
      runJsonPath: join(runDir, 'run.json'),
      evidencePath: join(runDir, 'evidence.v1.json'),
      readyPath: join(runDir, 'ready.json'),
      statusPath: join(jobDir, 'state.json'),
      logPath: join(jobDir, 'worker.log'),
      routing: 'offline',
      decisionOutcome: null,
      verificationExitCode: null,
      provenanceCount: 0,
      error: null,
    };
    await writeFile(join(jobDir, 'state.json'), JSON.stringify(preState, null, 2), { mode: 0o600 });

    const cancelPre = await cancelEvidenceWorker({ workspace, jobId: preCancelId });
    assert.equal(cancelPre.status, 'cancelled');
    assert.equal(cancelPre.alreadyTerminal, false);

    // Invoking _worker after pre-PID cancel must return immediately without running verifier or writing ready.json
    await runDetachedEvidenceWorker({ workspace, jobId: preCancelId });
    await assert.rejects(stat(join(workspace, 'verifier-ran.flag')), /ENOENT/);
    await assert.rejects(stat(join(runDir, 'ready.json')), /ENOENT/);
    const preStatus = await getEvidenceWorkerStatus({ workspace, jobId: preCancelId });
    assert.equal(preStatus.status, 'cancelled');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
