import { fileURLToPath } from 'node:url';
import { relative, join } from 'node:path';
import { newRunDirectory } from './files.js';
import { manifestSchema } from './config.js';
import { executable } from './environment.js';

export async function demoManifest(workspace: string, usePerf = false) {
  const dataDirectory = await newRunDirectory(workspace);
  const tracePath = relative(workspace, join(dataDirectory, 'cpu.chrome-trace.json'));
  const statPath = relative(workspace, join(dataDirectory, 'cpu.perf-stat.json'));
  const script = fileURLToPath(new URL('../examples/cpu-workload.mjs', import.meta.url));
  const args = [script, tracePath];
  const capture = usePerf
    ? { command: executable('perf'), args: ['stat', '-j', '-e', 'task-clock,cycles,instructions', '-o', statPath, '--', process.execPath, ...args] }
    : { command: process.execPath, args };
  return manifestSchema.parse({ version: 1,
    issue: 'This controlled CPU demo sums the same row-major matrix in row and column traversal order. Which measured region takes longer, what cache-locality hypothesis could explain it, and what additional counters or repetitions would falsify that hypothesis? No PyTorch issue or patch is represented.',
    captures: [capture], reports: [{ id: 'traversal-timing', path: tracePath, format: 'chrome-trace',
      description: 'Genuine local CPU elapsed spans for row-major and column-major traversal, with checksums.' },
      ...(usePerf ? [{ id: 'cpu-counters', path: statPath, format: 'perf-stat-json', description: 'Real process-wide perf task-clock, cycles and instructions for the same workload; no cache counters.' }] : [])],
    verification: { command: process.execPath, args: [script, '--verify'] },
  });
}
