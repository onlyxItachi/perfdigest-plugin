// Real CPU + Python MCP + loopback HTTP Decisions. Codex CLI is synthetic unless --codex is explicit.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { demoManifest } from '../dist/demo.js';
import { investigate } from '../dist/run.js';
import { writeJson } from '../dist/files.js';
import { redact } from '../dist/environment.js';

const actualCodex = process.argv.includes('--codex');
if (process.argv.slice(2).some(arg => arg !== '--codex')) throw new Error('Only --codex is supported');
const parent = resolve('work/decisions'); await mkdir(parent, { recursive: true });
const workspace = await mkdtemp(join(parent, 'http-'));
const previousBinary = process.env.PERFDIGEST_CODEX_PATH;
const calls = join(workspace, 'codex-fixture-calls.jsonl');
if (!actualCodex) {
  const binary = join(workspace, 'codex-fixture');
  await writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
if(args[0]==='mcp'){console.log('[]');process.exit(0);}
const prompt=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,prompt,hasDecisionsKey:!!process.env.PERFDIGEST_DECISIONS_API_KEY,hasGenericKey:!!process.env.OPENAI_API_KEY})+'\\n');
for(const e of [{type:'thread.started',thread_id:'http-fixture-thread'},{type:'turn.started'},
 {type:'item.completed',item:{id:'message',type:'agent_message',text:'Synthetic Codex CLI fixture; no model inference.'}},
 {type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0,reasoning_output_tokens:0}}]) console.log(JSON.stringify(e));
`, { mode: 0o700 });
  await chmod(binary, 0o700); process.env.PERFDIGEST_CODEX_PATH = binary;
}
let requests = 0, requestBody, serverFailure;
const server = createServer(async (req, res) => {
  try {
    requests++; assert.equal(requests, 1); assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/decisions');
    let body = ''; for await (const chunk of req) body += chunk;
    requestBody = JSON.parse(body); const input = JSON.parse(requestBody.input);
    assert.equal(requestBody.model, 'gpt-6-luna'); assert.equal(input.reports.length, 1);
    const report = input.reports[0]; assert.equal(report.evidence.provenance, 'perfdigest_mcp');
    assert.equal(report.evidence.summary.total_units, 2);
    assert.ok(report.evidence.summary.units.every(unit => unit.duration_us > 0));
    assert.ok(!requestBody.input.includes(workspace)); assert.equal(report.path, undefined);
    assert.equal(report.evidence.summary.raw_ref, undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'gpt-6-luna', answers: [{ name: 'next_evidence', type: 'choice',
      choice: report.id, confidence: 0.9, probabilities: [{ value: report.id, probability: 0.9 },
        { value: '__human_review__', probability: 0.1 }] }],
      usage: { input_tokens: 30, output_tokens: 2, total_tokens: 32,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }));
  } catch (error) { serverFailure = error; res.writeHead(500); res.end('Mock contract assertion failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const decisionsMockURL = `http://127.0.0.1:${server.address().port}/v1`;
  const result = await investigate({ workspace, manifest: await demoManifest(workspace), routing: 'decisions',
    agent: 'codex', decisionsMockURL, model: 'gpt-6-astra', effort: 'max' });
  if (serverFailure) throw serverFailure;
  assert.equal(result.status, 'complete'); assert.equal(result.verification.exitCode, 0);
  assert.equal(result.evidence.decision.transport, 'local_mock'); assert.equal(requests, 1);
  const input = JSON.parse(requestBody.input); const saved = result.evidence.evidence[0];
  assert.equal(saved.sha256, input.reports[0].evidence.artifact_sha256);
  assert.equal(result.evidence.decision.inputSha256, createHash('sha256').update(requestBody.input).digest('hex'));
  assert.equal(result.analysis.threadId, result.review.threadId);
  assert.ok(result.events.findIndex(e => e.event === 'evidence.prefetch.started') < result.events.findIndex(e => e.event === 'codex.analysis.started'));
  if (!actualCodex) {
    const turns = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(turns.length, 2);
    assert.ok(turns.every(t => !t.hasDecisionsKey && !t.hasGenericKey));
    assert.ok(turns[1].args.includes('resume'));
    assert.ok(turns[1].prompt.includes(saved.sha256));
    assert.ok(turns[1].prompt.includes('"pipelineStatus":"complete"'));
  }
  const receipt = { status: 'passed', scope: 'real CPU + Python MCP + real loopback HTTP + official SDK + Codex orchestration',
    decisions: { transport: 'local_mock', requests, liveRequests: 0, liveInferenceValidated: false,
      inputSha256: result.evidence.decision.inputSha256, artifactSha256: saved.sha256,
      observedLiveTokenUsage: null, fixtureUsage: { inputTokens: 30, outputTokens: 2 } },
    codex: { execution: actualCodex ? 'existing_chatgpt_login' : 'synthetic_cli_fixture', model: 'gpt-6-astra', effort: 'max',
      sameThread: true, turns: 2, observedUsage: actualCodex ? { analysis: result.analysis.usage, review: result.review.usage } : null },
    verificationExitCode: result.verification.exitCode, directory: result.directory, decisionsError: result.decisionsError };
  await writeJson(join(workspace, 'http-receipt.json'), receipt);
  await writeJson(join(workspace, 'mapped-input.json'), input);
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : 'HTTP integration failed')); process.exitCode = 1;
} finally {
  if (previousBinary === undefined) delete process.env.PERFDIGEST_CODEX_PATH; else process.env.PERFDIGEST_CODEX_PATH = previousBinary;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
