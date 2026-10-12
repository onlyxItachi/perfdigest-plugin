// Fixed-capture experiment. Defaults to no model access; C always uses a network-free fixture.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, release } from 'node:os';
import { demoManifest } from '../dist/demo.js';
import { benchmarkArm, cpuOracle, trialOrder } from '../dist/benchmark.js';
import { runCommand, commandPassed } from '../dist/commands.js';
import { reportFile, writeJson } from '../dist/files.js';
import { childEnvironment } from '../dist/environment.js';

const { values } = parseArgs({ options: {
  trials: { type: 'string', default: '3' }, agent: { type: 'string', default: 'none' },
  model: { type: 'string', default: 'gpt-6-astra' }, effort: { type: 'string', default: 'max' },
} });
const trials = Number(values.trials);
assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 5, '--trials must be between 1 and 5');
assert.ok(['none', 'codex'].includes(values.agent), '--agent must be none or codex');
assert.ok(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(values.effort), 'Invalid reasoning effort');
const parent = resolve('work/benchmark');
await mkdir(parent, { recursive: true });
const workspace = await mkdtemp(join(parent, 'evidence-'));
const manifest = await demoManifest(workspace);
const capture = [];
for (const spec of manifest.captures) {
  const receipt = await runCommand(spec, workspace);
  capture.push(receipt);
  assert.ok(commandPassed(receipt), 'Real CPU capture failed');
}
manifest.captures = []; // Every arm reuses exactly the same measured bytes.
const files = await Promise.all(manifest.reports.map(r => reportFile(workspace, r.path)));
const expectedHashes = Object.fromEntries(files.map((f, i) => [manifest.reports[i].id, f.sha256]));
const expected = cpuOracle(JSON.parse(await readFile(files[0].path, 'utf8')));
let commit = null, dirty = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { env: childEnvironment(), encoding: 'utf8' }).trim();
  dirty = execFileSync('git', ['status', '--porcelain'], { env: childEnvironment(), encoding: 'utf8' }).trim().length > 0;
} catch {}
const sourceFiles = ['package-lock.json', 'scripts/benchmark.mjs', 'examples/cpu-workload.mjs',
  ...(await readdir('src')).filter(f => f.endsWith('.ts')).map(f => `src/${f}`)].sort();
const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const report = { version: 1, kind: 'controlled_evidence_delivery', createdAt: new Date().toISOString(),
  source: { commit, dirty, sourceSha256 },
  runtime: { node: process.version, platform: process.platform, arch: process.arch, kernel: release(), cpu: cpus()[0]?.model ?? null },
  workspace, agent: values.agent, trials, capture, expectedHashes, expected, manifest,
  limits: [
    'Controlled CPU arithmetic/traversal example, not a real PyTorch issue or autonomous debugging benchmark.',
    'A is scripted raw-report delivery, not unrestricted ordinary tool use. B and C use the real Python MCP.',
    'C routes with the official OpenAI SDK against an in-process fixture; zero live Decisions requests.',
    'One report makes routing trivial. No Decisions quality, live latency or service cost claim is possible.',
    'Model correctness grade covers timing extraction, verifier interpretation and causal restraint only.',
    'Evidence bytes are UTF-8 bytes, not model tokens. Tokens exist only for real Codex SDK responses.',
    'Cost remains unknown. Trials reuse one capture and are not independent workload measurements.',
    'Arm order rotates; small samples, shared host load and service/cache state preclude speedup conclusions.',
  ], results: [] };
for (let trial = 0; trial < trials; trial++) {
  for (const [position, arm] of trialOrder(trial).entries()) {
    console.log(`Trial ${trial + 1}/${trials}: ${arm}; agent=${values.agent}; Decisions=fixture-or-unused`);
    const result = await benchmarkArm({ workspace, manifest, arm, agent: values.agent,
      expected, expectedHashes, model: values.model, effort: values.effort });
    report.results.push({ trial: trial + 1, position: position + 1, ...result });
    await writeJson(join(workspace, 'benchmark.json'), report); // Checkpoint every completed arm, including failures.
  }
}
const format = value => value === null ? 'not measured' : typeof value === 'number' ? value.toFixed(2) : String(value);
const rows = report.results.map(r => `| ${r.trial} | ${r.arm} | ${r.status} | ${format(r.telemetry.wallMs)} | ${r.evidenceBytes ?? 'n/a'} | ${format(r.telemetry.actualModelOverlapMs)} | ${r.telemetry.modelUsage?.inputTokens ?? 'n/a'} / ${r.telemetry.modelUsage?.outputTokens ?? 'n/a'} | ${r.modelReadingGrade === null ? 'not run' : r.modelReadingGrade.passed ? 'pass' : 'fail'} |`);
await writeFile(join(workspace, 'benchmark.md'), [
  '# Controlled evidence-delivery experiment', '',
  `Agent: ${values.agent}${values.agent === 'codex' ? ` (${values.model}, ${values.effort})` : ''}. Trials: ${trials}.`, '',
  'The CPU trace is real and fixed across every arm. C uses fixture routing; no live Decisions call occurred. Cost is unknown.', '',
  '| Trial | Arm | Status | Wall ms | Evidence bytes | Actual model overlap ms | Codex input / output tokens | Reading grade |',
  '| --- | --- | --- | ---: | ---: | ---: | ---: | --- |', ...rows, '',
  '## Interpretation limits', '', ...report.limits.map(s => `- ${s}`), '',
  'The complete receipt, including failed arms, commands, hashes, model usage, responses and event times, is in benchmark.json.', '',
].join('\n'));
console.log(JSON.stringify({ status: report.results.every(r => r.status === 'complete') ? 'passed' : 'failed',
  workspace, trials, arms: report.results.length, liveDecisionsRequests: 0,
  modelCalls: report.results.reduce((n, r) => n + Number(r.analysis !== null) + Number(r.review !== null), 0) }, null, 2));
process.exitCode = report.results.every(r => r.status === 'complete') ? 0 : 1;
