// Intentionally outside check/normal CI: future one-request test with real evidence and a real key.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decisionsClient, decisionsFailure } from '../dist/decisions.js';
import { demoManifest } from '../dist/demo.js';
import { investigate } from '../dist/run.js';
if (process.env.PERFDIGEST_RUN_LIVE_DECISIONS !== '1') {
  console.log('SKIPPED: live Decisions integration is disabled. No request sent.');
  process.exit(0);
}
try {
  decisionsClient(); // Fail before capture if the dedicated key is absent. No request here.
  const parent = resolve('work/decisions'); await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, 'live-'));
  const result = await investigate({ workspace, manifest: await demoManifest(workspace), routing: 'decisions', agent: 'none' });
  if (result.decisionsError) {
    console.error(JSON.stringify({ status: 'failed', error: result.decisionsError, directory: result.directory }));
    process.exitCode = 1;
  } else {
    assert.ok(result.evidence, 'Live run did not produce a Decisions result');
    const decision = result.evidence.decision;
    assert.equal(decision.transport, 'openai_https'); assert.equal(decision.requests, 1); assert.equal(decision.evidenceCount, 1);
    console.log(JSON.stringify({ scope: 'one live Decisions call with measured CPU evidence; no Codex model call',
      status: result.status, decision, verificationExitCode: result.verification?.exitCode ?? null,
      directory: result.directory, diagnosisValidated: false }, null, 2));
    if (result.status !== 'complete') process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: decisionsFailure(error).toJSON() })); process.exitCode = 1;
}
