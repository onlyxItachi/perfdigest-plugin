import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { manifestSchema } from '../src/config.js';
import { investigate } from '../src/run.js';
import { fixtureUv, testDirectory } from './helpers.js';

test('full production runner uses mocked Decisions, isolated Codex SDK turns and an independent failing verifier', async () => {
  const root = await testDirectory('codex-flow');
  const prior = { path: process.env.PATH, binary: process.env.PERFDIGEST_CODEX_PATH,
    key: process.env.PERFDIGEST_DECISIONS_API_KEY, fetch: globalThis.fetch };
  try {
    process.env.PATH = `${await fixtureUv(root)}${delimiter}${prior.path}`;
    const binary = join(root, 'codex-fixture');
    process.env.PERFDIGEST_CODEX_PATH = binary;
    process.env.PERFDIGEST_DECISIONS_API_KEY = 'synthetic-decisions-test-secret';
    const calls = join(root, 'calls.jsonl');
    await writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
if(args[0]==='login') { console.log('Logged in using ChatGPT'); process.exit(0); }
if(args[0]==='mcp') { console.log(JSON.stringify([{name:'fixture-tool'}])); process.exit(0); }
const prompt = fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,prompt,hasDecisionsKey:!!process.env.PERFDIGEST_DECISIONS_API_KEY,hasGenericKey:!!process.env.OPENAI_API_KEY})+'\\n');
const emit=e=>console.log(JSON.stringify(e));
emit({type:'thread.started',thread_id:'fixture-thread'});
emit({type:'turn.started'});
await new Promise(r=>setTimeout(r,400));
emit({type:'item.completed',item:{id:'message',type:'agent_message',text:'Synthetic model output says everything passed; the actual verifier must override this.'}});
emit({type:'turn.completed',usage:{input_tokens:2,output_tokens:3,cached_input_tokens:0,reasoning_output_tokens:0}});
`);
    await chmod(binary, 0o755);
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      requests++;
      assert.equal(String(input), 'https://api.openai.com/v1/decisions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-decisions-test-secret');
      return new Response(JSON.stringify({ model: 'gpt-6-luna', usage: { input_tokens: 1, output_tokens: 1 },
        answers: [{ type: 'choice', name: 'next_evidence', choice: 'trace', confidence: 1 }] }),
        { headers: { 'content-type': 'application/json' } });
    };
    await writeFile(join(root, 'trace.json'), '{}');
    const manifest = manifestSchema.parse({ version: 1, issue: 'Synthetic pipeline fixture',
      reports: [{ id: 'trace', path: 'trace.json', format: 'chrome-trace', description: 'Fixture' }],
      verification: { command: process.execPath, args: ['-e', 'process.exit(4)'] } });
    const result = await investigate({ workspace: root, manifest, routing: 'decisions', agent: 'codex' });
    assert.equal(result.status, 'failed'); assert.equal(result.verification?.exitCode, 4);
    assert.equal(result.evidence?.decision.confidence, 1);
    assert.equal(requests, 1);
    assert.equal(result.analysis?.threadId, result.review?.threadId);
    assert.equal(result.review?.usage?.output_tokens, 3);
    const records = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.hasDecisionsKey, false); assert.equal(record.hasGenericKey, false);
      assert.ok(record.args.includes('mcp_servers.fixture-tool={command="false",enabled=false}'));
      assert.ok(record.args.includes('features.shell_tool=false'));
    }
    assert.ok(records[1].args.includes('resume'));
    assert.ok(records[1].args.includes('fixture-thread'));
    assert.match(records[1].prompt, /"pipelineStatus":"failed"/);
    assert.ok(result.events.findIndex(e => e.event === 'evidence.prefetch.started') < result.events.findIndex(e => e.event === 'codex.analysis.started'));
    assert.ok(result.telemetry.evidenceModelOverlapMs! > 0, 'synthetic scheduling overlap, not a live performance measurement');
    assert.ok(!(await readFile(join(result.directory, 'run.json'), 'utf8')).includes('synthetic-decisions-test-secret'));
  } finally {
    globalThis.fetch = prior.fetch;
    for (const [key, value] of Object.entries({ PATH: prior.path, PERFDIGEST_CODEX_PATH: prior.binary, PERFDIGEST_DECISIONS_API_KEY: prior.key })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
