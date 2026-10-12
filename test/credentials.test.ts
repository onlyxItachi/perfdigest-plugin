import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { childEnvironment, redact } from '../src/environment.js';
import { runCommand } from '../src/commands.js';

test('the actual Codex SDK spawn receives login paths but no Decisions or API credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perfdigest-env-'));
  try {
    const receipt = join(root, 'environment.json');
    const binary = join(root, 'codex-fixture');
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.env));
for (const event of [
 {type:'thread.started',thread_id:'fixture-thread'},
 {type:'turn.started'},
 {type:'item.completed',item:{id:'1',type:'agent_message',text:'fixture response'}},
 {type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0,reasoning_output_tokens:0}}
]) console.log(JSON.stringify(event));
`);
    await chmod(binary, 0o755);
    const env = childEnvironment({ ...process.env, PERFDIGEST_DECISIONS_API_KEY: 'test-decisions-secret',
      OPENAI_API_KEY: 'test-openai-secret', CODEX_API_KEY: 'test-codex-secret',
      OPENAI_BASE_URL: 'https://must-not-propagate.invalid', OTHER_PROVIDER_TOKEN: 'test-other-secret',
      CODEX_HOME: '/test/existing-codex-home' });
    const codex = new Codex({ codexPathOverride: binary, env });
    const result = await codex.startThread({ skipGitRepoCheck: true }).run('Offline SDK subprocess fixture');
    assert.equal(result.finalResponse, 'fixture response');
    const child = JSON.parse(await readFile(receipt, 'utf8'));
    assert.equal(child.CODEX_HOME, '/test/existing-codex-home');
    assert.equal(child.HOME, process.env.HOME);
    for (const key of ['PERFDIGEST_DECISIONS_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OTHER_PROVIDER_TOKEN']) {
      assert.equal(child[key], undefined, key);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capture and verification children also do not receive the Decisions secret', async () => {
  const prior = process.env.PERFDIGEST_DECISIONS_API_KEY;
  process.env.PERFDIGEST_DECISIONS_API_KEY = 'test-parent-secret';
  try {
    const result = await runCommand({ command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({present:!!process.env.PERFDIGEST_DECISIONS_API_KEY}))'], timeoutMs: 2000 }, process.cwd());
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { present: false });
    assert.equal(process.env.PERFDIGEST_DECISIONS_API_KEY, 'test-parent-secret');
  } finally {
    if (prior === undefined) delete process.env.PERFDIGEST_DECISIONS_API_KEY;
    else process.env.PERFDIGEST_DECISIONS_API_KEY = prior;
  }
});

test('recorded errors redact known credential values', () => {
  assert.equal(redact('failure: pretend-secret', { PERFDIGEST_DECISIONS_API_KEY: 'pretend-secret' }), 'failure: [REDACTED]');
});
