#!/usr/bin/env node
// Validate benchmark result / manifest documents against the v1 formats.
//   node bench/validate.mjs [FILE...]   (default: bench/manifests/*.json + bench/results/*.json)
// Beyond the zod schema it enforces the reporting rules from bench/README.md:
//   - not-run / failed cells carry a reason;
//   - measured cells carry wall-time stats;
//   - every (group, scenario) has at most one baseline;
//   - cell `layer` assignments are consistent with group/id and `layerSummary` matches `cells`.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestSchema, resultSchema } from './schema/formats.mjs';

const benchDir = dirname(fileURLToPath(import.meta.url));
const listJson = async (dir) => (await readdir(join(benchDir, dir)).catch(() => [])).filter((f) => f.endsWith('.json')).map((f) => join(benchDir, dir, f));
const files = process.argv.slice(2).length ? process.argv.slice(2) : [...await listJson('manifests'), ...await listJson('results')];

function expectedLayer(c) {
  if (c.id === 'runtime.uvx.perfdigest-mcp') return 'engine';
  if (c.group === 'agent') return 'agent_e2e';
  return 'orchestration';
}

let failures = 0;
for (const file of files) {
  const doc = JSON.parse(await readFile(file, 'utf8'));
  const isManifest = doc.schema === 'perfdigest.benchmark-manifest.v1';
  const parsed = (isManifest ? manifestSchema : resultSchema).safeParse(doc);
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  if (parsed.success) {
    for (const c of doc.cells) {
      const exp = expectedLayer(c);
      if (c.layer !== exp) problems.push(`${c.id}: layer is ${c.layer}, expected ${exp}`);
    }
  }
  if (parsed.success && !isManifest) {
    for (const c of doc.cells) {
      if (c.status !== 'measured' && !c.reason) problems.push(`${c.id}: ${c.status} cell without reason`);
      if (c.status === 'measured' && !c.wall) problems.push(`${c.id}: measured cell without wall stats`);
    }
    const seen = new Set();
    for (const c of doc.cells.filter((x) => x.baseline)) {
      const k = `${c.group}/${c.scenario}`;
      if (seen.has(k)) problems.push(`multiple baselines for ${k}`);
      seen.add(k);
    }
    for (const layer of ['engine', 'orchestration', 'agent_e2e']) {
      const subset = doc.cells.filter((c) => c.layer === layer);
      const actual = {
        total: subset.length,
        measured: subset.filter((c) => c.status === 'measured').length,
        notRun: subset.filter((c) => c.status === 'not-run').length,
        failed: subset.filter((c) => c.status === 'failed').length,
        parityPass: subset.filter((c) => c.parity.status === 'pass').length,
        parityFail: subset.filter((c) => c.parity.status === 'fail').length,
        parityNotApplicable: subset.filter((c) => c.parity.status === 'not-applicable').length,
      };
      const recorded = doc.layerSummary?.[layer];
      if (JSON.stringify(actual) !== JSON.stringify(recorded)) {
        problems.push(`layerSummary.${layer} mismatch: recorded ${JSON.stringify(recorded)} vs actual ${JSON.stringify(actual)}`);
      }
    }
  }
  if (problems.length) { failures++; console.error(`FAIL ${file}\n  ${problems.join('\n  ')}`); }
  else console.log(`ok   ${file} (${isManifest ? 'manifest' : `result, ${doc.cells.length} cells`})`);
}
if (!files.length) { console.error('no files to validate'); failures++; }
process.exitCode = failures ? 1 : 0;
