import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

function matrix(n) {
  const values = new Float64Array(n * n);
  for (let i = 0; i < values.length; i++) values[i] = i + 1;
  return values;
}
function sumRows(values, n) {
  let sum = 0;
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) sum += values[row * n + col];
  return sum;
}
function sumColumns(values, n) {
  let sum = 0;
  for (let col = 0; col < n; col++) for (let row = 0; row < n; row++) sum += values[row * n + col];
  return sum;
}
function verify() {
  // Independent arithmetic oracle, several non-square-power sizes, and zero-size edge case.
  for (const n of [0, 1, 2, 7, 31, 129]) {
    const values = matrix(n);
    const count = n * n;
    const expected = count * (count + 1) / 2;
    assert.equal(sumRows(values, n), expected);
    assert.equal(sumColumns(values, n), expected);
  }
}
if (process.argv[2] === '--verify') {
  verify();
  console.log('PASS: both traversal orders match an independent sum formula for six sizes.');
} else {
  const tracePath = process.argv[2];
  if (!tracePath) throw new Error('Provide a trace output path or --verify');
  const n = 768;
  const values = matrix(n);
  const expected = (n * n) * (n * n + 1) / 2;
  const traceEvents = [];
  // Warm up separately; these spans are honest elapsed CPU workload samples, not hardware counters.
  for (const fn of [sumRows, sumColumns]) for (let i = 0; i < 3; i++) assert.equal(fn(values, n), expected);
  for (const [name, fn] of [['row_major', sumRows], ['column_major', sumColumns]]) {
    const start = performance.now();
    for (let i = 0; i < 8; i++) assert.equal(fn(values, n), expected);
    const end = performance.now();
    traceEvents.push({ name, ph: 'X', cat: 'measured_cpu_workload', pid: process.pid, tid: 1,
      ts: start * 1000, dur: (end - start) * 1000, args: { n, repetitions: 8, checksum: expected } });
  }
  writeFileSync(tracePath, JSON.stringify({ traceEvents, displayTimeUnit: 'ms' }));
  console.log(JSON.stringify({ provenance: 'local_execution', checksum: expected, tracePath }));
}
