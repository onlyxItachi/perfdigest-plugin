#!/usr/bin/env node
// Validate benchmark result / manifest / MCP-reuse documents against the v1 formats.
//   node bench/validate.mjs [FILE...]   (default: bench/manifests/*.json + bench/results/*.json)
// Beyond the zod schema it enforces the reporting rules from bench/README.md:
//   - not-run / failed cells carry a reason;
//   - measured cells carry wall-time stats;
//   - every (group, scenario) has at most one baseline;
//   - cell `layer` assignments are consistent with group/id and `layerSummary` matches `cells`.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestSchema, mcpReuseResultSchema, realWorkloadEvalResultSchema, resultSchema, lifecycleBenchmarkResultSchema, regressionCorpusSchema, multiModelEvalResultSchema, measurementReceiptSchema } from './schema/formats.mjs';

const benchDir = dirname(fileURLToPath(import.meta.url));
const listJson = async (dir) => (await readdir(join(benchDir, dir)).catch(() => [])).filter((f) => f.endsWith('.json')).map((f) => join(benchDir, dir, f));
const files = process.argv.slice(2).length ? process.argv.slice(2) : [...await listJson('manifests'), ...await listJson('results')];

function expectedLayer(c) {
  if (c.id === 'runtime.uvx.perfdigest-mcp' || c.id.startsWith('engine.')) return 'engine';
  if (c.group === 'agent') return 'agent_e2e';
  return 'orchestration';
}

function selectSchema(doc) {
  switch (doc.schema) {
    case 'perfdigest.benchmark-manifest.v1':
      return { kind: 'manifest', schema: manifestSchema };
    case 'perfdigest.benchmark-result.v1':
      return { kind: 'result', schema: resultSchema };
    case 'perfdigest.mcp-reuse-result.v1':
      return { kind: 'mcp-reuse', schema: mcpReuseResultSchema };
    case 'perfdigest.real-workload-eval.v1':
      return { kind: 'real-workload-eval', schema: realWorkloadEvalResultSchema };
    case 'perfdigest.lifecycle-benchmark.v1':
      return { kind: 'lifecycle-benchmark', schema: lifecycleBenchmarkResultSchema };
    case 'perfdigest.regression-corpus.v1':
      return { kind: 'regression-corpus', schema: regressionCorpusSchema };
    case 'perfdigest.multi-model-eval.v1':
      return { kind: 'multi-model-eval', schema: multiModelEvalResultSchema };
    case 'perfdigest.benchmark.measurement-receipt.v1':
      return { kind: 'measurement-receipt', schema: measurementReceiptSchema };
    default:
      return { kind: 'unknown', schema: resultSchema };
  }
}

let failures = 0;
for (const file of files) {
  const doc = JSON.parse(await readFile(file, 'utf8'));
  const { kind, schema } = selectSchema(doc);
  const parsed = schema.safeParse(doc);
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  if (parsed.success && (kind === 'manifest' || kind === 'result')) {
    for (const c of doc.cells) {
      const exp = expectedLayer(c);
      if (c.layer !== exp) problems.push(`${c.id}: layer is ${c.layer}, expected ${exp}`);
    }
  }
  if (parsed.success && kind === 'result') {
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
  if (parsed.success && kind === 'mcp-reuse') {
    for (const [id, wf] of Object.entries(doc.multiReportWorkflows)) {
      if (wf.status === 'measured') {
        if (!wf.beforePerReportSpawn || !wf.afterSessionReuse || !wf.delta) {
          problems.push(`${id}: measured workflow must include beforePerReportSpawn, afterSessionReuse, and delta`);
        }
        if (wf.evidenceParity.status !== 'pass') {
          problems.push(`${id}: measured workflow must have evidenceParity.status === "pass"`);
        }
      } else if (!wf.reason) {
        problems.push(`${id}: not-run workflow must include reason`);
      }
    }
  }
  if (parsed.success && kind === 'real-workload-eval') {
    for (const st of doc.studies) {
      if (!st.abstentionGuardCheck.provenanceHashesMatch) {
        problems.push(`${st.id}: abstentionGuardCheck.provenanceHashesMatch must be true`);
      }
      if (st.validatedFix.attempted && !st.validatedFix.correctnessPassed) {
        problems.push(`${st.id}: validatedFix.correctnessPassed must be true`);
      }
    }
  }
  if (parsed.success && kind === 'lifecycle-benchmark') {
    for (const cell of doc.tableA_workerReceipt ?? []) {
      if (cell.parity?.status !== 'pass') {
        problems.push(`tableA_workerReceipt.${cell.id}: parity.status must be "pass"`);
      }
    }
    for (const cell of doc.tableB_investigateOrchestration ?? []) {
      if (cell.parity?.status !== 'pass') {
        problems.push(`tableB_investigateOrchestration.${cell.id}: parity.status must be "pass"`);
      }
    }
    for (const cell of doc.tableB2_liveMcpEndToEnd ?? []) {
      if (cell.parity?.status !== 'pass') {
        problems.push(`tableB2_liveMcpEndToEnd.${cell.id}: parity.status must be "pass"`);
      }
    }
    for (const cell of doc.tableD_mcpServerLifecycle ?? []) {
      if (cell.parity?.status !== 'pass') {
        problems.push(`tableD_mcpServerLifecycle.${cell.id}: parity.status must be "pass"`);
      }
    }
  }
  if (problems.length) {
    failures++;
    console.error(`FAIL ${file}\n  ${problems.join('\n  ')}`);
  } else {
    const summary = kind === 'manifest'
      ? 'manifest'
      : kind === 'mcp-reuse'
        ? `mcp-reuse, ${Object.keys(doc.multiReportWorkflows).length} workflows`
        : kind === 'real-workload-eval'
          ? `real-workload-eval, ${doc.studies.length} studies`
          : kind === 'lifecycle-benchmark'
            ? `lifecycle-benchmark, Table A: ${doc.tableA_workerReceipt.length} cells, Table B: ${doc.tableB_investigateOrchestration.length} cells, Table B2: ${(doc.tableB2_liveMcpEndToEnd ?? []).length} cells, Table C: ${doc.tableC_costSeparation.length} entries, Table D: ${(doc.tableD_mcpServerLifecycle ?? []).length} cells`
            : kind === 'regression-corpus'
              ? `regression-corpus, ${doc.studies.length} studies`
              : kind === 'multi-model-eval'
                ? `multi-model-eval, ${doc.summary.totalModels} models × ${doc.summary.totalStudies} studies (${doc.summary.totalEvaluations} evals)`
                : kind === 'measurement-receipt'
                  ? `measurement-receipt, ${doc.experimentId} (${doc.sampleSize.totalCells} cells)`
                  : `result, ${doc.cells.length} cells`;
    console.log(`ok   ${file} (${summary})`);
  }
}
if (!files.length) { console.error('no files to validate'); failures++; }
process.exitCode = failures ? 1 : 0;
