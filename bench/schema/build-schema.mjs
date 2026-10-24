// Generate (default) or verify (--check) the committed JSON Schema files from formats.mjs.
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { manifestSchema, mcpReuseResultSchema, realWorkloadEvalResultSchema, resultSchema, lifecycleBenchmarkResultSchema, regressionCorpusSchema, multiModelEvalResultSchema } from './formats.mjs';

const targets = [
  ['benchmark-result.v1.schema.json', resultSchema, 'PerfDigest benchmark result v1'],
  ['benchmark-manifest.v1.schema.json', manifestSchema, 'PerfDigest benchmark manifest v1'],
  ['mcp-reuse-result.v1.schema.json', mcpReuseResultSchema, 'PerfDigest MCP session reuse benchmark result v1'],
  ['real-workload-eval.v1.schema.json', realWorkloadEvalResultSchema, 'PerfDigest real workload A/B/C evaluation result v1'],
  ['lifecycle-benchmark.v1.schema.json', lifecycleBenchmarkResultSchema, 'PerfDigest lifecycle and orchestration benchmark result v1'],
  ['regression-corpus.v1.schema.json', regressionCorpusSchema, 'PerfDigest Cross-Repo Real-Workload Regression Corpus v1'],
  ['multi-model-eval.v1.schema.json', multiModelEvalResultSchema, 'PerfDigest Multi-Model Real-Workload Evaluation Result v1'],
];
const check = process.argv.includes('--check');
let stale = 0;
for (const [file, schema, title] of targets) {
  const url = new URL(`./${file}`, import.meta.url);
  const json = { ...z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }), $id: `https://github.com/onlyxItachi/perfdigest-plugin/bench/schema/${file}`, title };
  const text = `${JSON.stringify(json, null, 2)}\n`;
  if (check) {
    const current = await readFile(url, 'utf8').catch(() => '');
    if (current !== text) { console.error(`${file} is stale; run node bench/schema/build-schema.mjs`); stale++; }
  } else {
    await writeFile(url, text);
    console.log(`wrote ${file}`);
  }
}
if (stale) process.exitCode = 1;
