// Runtime-agnostic probe (Node / Bun / Deno via node: compat): spawn a trivial
// child N times sequentially and report per-spawn latency. Usage:
//   <runtime> bench/probes/spawn-loop.mjs ITERATIONS [CHILD=/bin/true]
import { spawn } from 'node:child_process';

const iterations = Number(process.argv[2] ?? 100);
const child = process.argv[3] ?? '/bin/true';
const samples = [];
for (let i = 0; i < iterations; i++) {
  const t = performance.now();
  const code = await new Promise((resolve, reject) => {
    const p = spawn(child, [], { stdio: 'ignore', shell: false, env: { PATH: process.env.PATH ?? '' } });
    p.once('error', reject); p.once('close', resolve);
  });
  samples.push(performance.now() - t);
  if (code !== 0) throw new Error(`child exited ${code}`);
}
process.stdout.write(`${JSON.stringify({ iterations, child, samplesMs: samples })}\n`);
