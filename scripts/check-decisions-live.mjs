// Intentionally not part of test, check, CI or the offline demo.
import assert from 'node:assert/strict';
import { decisionsClient, selectReport } from '../dist/decisions.js';
if (process.env.PERFDIGEST_RUN_LIVE_DECISIONS !== '1') {
  console.log('SKIPPED: live Decisions integration is disabled. No request sent.');
  process.exit(0);
}
const result = await selectReport(decisionsClient(), 'Which saved report contains CPU instruction counts?', [
  { id: 'cpu-counters', path: 'not-sent.json', format: 'perf-stat-json', description: 'CPU cycles and instruction counts' },
  { id: 'build', path: 'not-sent.log', format: 'ninja-log', description: 'Build durations without CPU counters' },
]);
assert.equal(result.source, 'openai_decisions');
assert.equal(result.selectedId, 'cpu-counters');
console.log(JSON.stringify({ scope: 'live Decisions API routing, no Codex invocation', ...result }, null, 2));
