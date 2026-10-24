#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { investigate, manifestSchema } from '../dist/index.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const goBin = join(root, 'dist', 'perfdigest-plugin');

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function locateBenchRepo() {
  const argIdx = process.argv.indexOf('--bench-dir');
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    const p = resolve(process.argv[argIdx + 1]);
    if (existsSync(join(p, 'schemas', 'examples', 'real-workloads-corpus.v1.json'))) return { path: p, temp: false };
  }
  const candidates = [
    process.env.PERFDIGEST_BENCH_DIR,
    join(root, 'work', 'PerfDigest-MCP-Bench'),
    resolve(root, '..', 'PerfDigest-MCP-Bench'),
    resolve(root, '..', 'bench'),
    '/home/hamza-usta/agy-dev/bench',
    '/home/hamza-usta/PerfDigest-MCP-Bench',
  ].filter(Boolean);

  for (const cand of candidates) {
    const p = resolve(cand);
    if (existsSync(join(p, 'schemas', 'examples', 'real-workloads-corpus.v1.json'))) {
      return { path: p, temp: false };
    }
  }
  return null;
}

const located = locateBenchRepo();
let benchDir;
let cleanupDir = null;

if (located) {
  benchDir = located.path;
} else {
  cleanupDir = await mkdtemp(join(tmpdir(), 'perfdigest-bench-regression-'));
  benchDir = join(cleanupDir, 'PerfDigest-MCP-Bench');
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/onlyxItachi/PerfDigest-MCP-Bench.git', benchDir], {
    stdio: 'inherit',
  });
}

const hadPerfdigestDir = existsSync(join(benchDir, '.perfdigest'));
let targetChoice = 'template-heavy';

const server = createServer((req, res) => {
  if (req.url !== '/v1/systemone') {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const criteria = parsed?.questions?.next_evidence?.criteria ?? {};
    const keys = Object.keys(criteria);
    const confidence = 0.88;
    const otherKeys = keys.filter((k) => k !== targetChoice);
    const probs = {};
    let allocated = confidence;
    probs[targetChoice] = confidence;
    otherKeys.forEach((k, idx) => {
      if (idx === otherKeys.length - 1) {
        probs[k] = Number((1 - allocated).toFixed(4));
      } else {
        const share = Number(((1 - confidence) / otherKeys.length).toFixed(4));
        probs[k] = share;
        allocated += share;
      }
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: '@cf/cloudflare/clef-flash',
      usage: { input_tokens: 96, output_tokens: 12 },
      answers: {
        next_evidence: {
          type: 'choice',
          choice: targetChoice,
          confidence,
          probabilities: probs,
        },
      },
    }));
  });
});

const port = await new Promise((resolvePort, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
});

try {
  // 1. Cross-repo schema lockstep verification
  for (const schemaFile of ['benchmark-result.v1.schema.json', 'benchmark-manifest.v1.schema.json', 'regression-corpus.v1.schema.json']) {
    const pluginSchemaRaw = await readFile(join(root, 'bench', 'schema', schemaFile), 'utf8');
    const benchSchemaRaw = await readFile(join(benchDir, 'schemas', schemaFile), 'utf8');
    const normalizeId = (s) => JSON.parse(s.replace(
      'https://github.com/onlyxItachi/PerfDigest-MCP-Bench/schemas/',
      'https://github.com/onlyxItachi/perfdigest-plugin/bench/schema/',
    ));
    if (schemaFile !== 'regression-corpus.v1.schema.json') {
      assert.deepEqual(
        normalizeId(benchSchemaRaw),
        normalizeId(pluginSchemaRaw),
        `Cross-repo schema drift detected in ${schemaFile}`,
      );
    }
  }

  // 2. Validate PerfDigest-MCP-Bench v1 documents with perfdigest-plugin's validator
  const interpreterMatrixExample = join(benchDir, 'schemas', 'examples', 'interpreter-matrix-2026-07-18.benchmark-result.v1.json');
  const corpusExample = join(benchDir, 'schemas', 'examples', 'real-workloads-corpus.v1.json');
  execFileSync(process.execPath, [join(root, 'bench', 'validate.mjs'), interpreterMatrixExample, corpusExample], {
    cwd: root,
    stdio: 'pipe',
  });

  // 3. Run PerfDigest-MCP-Bench's own deterministic Python exporters in --check mode
  execFileSync('python3', ['ci/export_benchmark_v1.py', '--check'], { cwd: benchDir, stdio: 'pipe' });
  execFileSync('python3', ['ci/export_regression_corpus.py', '--check'], { cwd: benchDir, stdio: 'pipe' });

  // 4. Execute end-to-end real-workload regression across Go default binary and Node/TS library
  const corpus = JSON.parse(await readFile(corpusExample, 'utf8'));
  const tmpManifestDir = await mkdtemp(join(tmpdir(), 'perfdigest-bench-manifests-'));
  const studySummaries = [];
  const prevClefUrl = process.env.PERFDIGEST_CLEF_URL;
  process.env.PERFDIGEST_CLEF_URL = `http://127.0.0.1:${port}/v1/systemone`;

  try {
    for (const study of corpus.studies) {
      targetChoice = study.expectedSelectedReportId;

      for (const r of study.reports) {
        const absReport = join(benchDir, r.path);
        const bytes = await readFile(absReport);
        assert.equal(bytes.byteLength, r.bytes, `${study.id}/${r.id}: raw byte size mismatch`);
        assert.equal(sha256Buffer(bytes), r.sha256, `${study.id}/${r.id}: raw sha256 mismatch`);
      }

      const manifestPath = join(tmpManifestDir, `${study.id}.manifest.json`);
      const manifestRaw = {
        version: 1,
        issue: study.question,
        captures: [],
        reports: study.reports.map((r) => ({
          id: r.id,
          path: r.path,
          format: r.format,
          description: `${study.id} ${r.id} (${r.format})`,
        })),
        verification: {
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          timeoutMs: 10000,
        },
      };
      const manifest = manifestSchema.parse(manifestRaw);
      await writeFile(manifestPath, JSON.stringify(manifestRaw, null, 2), 'utf8');

      // Run Go default binary (async so our loopback HTTP server responds immediately)
      const tGo0 = performance.now();
      const { stdout: goStdout } = await execFileAsync(
        goBin,
        ['run', manifestPath, '--workspace', benchDir, '--agent', 'none', '--routing', 'local'],
        {
          cwd: root,
          env: { ...process.env, PERFDIGEST_CLEF_URL: `http://127.0.0.1:${port}/v1/systemone` },
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const goWallMs = Number((performance.now() - tGo0).toFixed(2));
      const goSummary = JSON.parse(goStdout);
      const goResult = JSON.parse(await readFile(join(goSummary.directory, 'run.json'), 'utf8'));

      // Run Node/TS library
      const tNode0 = performance.now();
      const nodeResult = await investigate({
        workspace: benchDir,
        manifest,
        routing: 'local',
        agent: 'none',
        reuseMcpSession: true,
        includeCorroborating: true,
      });
      const nodeWallMs = Number((performance.now() - tNode0).toFixed(2));

      for (const [label, res] of [['go', goResult], ['node', nodeResult]]) {
        assert.equal(res.status, 'complete', `${study.id} (${label}): expected status='complete'`);
        assert.equal(res.decisionOutcome, 'accepted', `${study.id} (${label}): expected decisionOutcome='accepted'`);
        assert.equal(res.provenance.length, study.reports.length, `${study.id} (${label}): provenance length mismatch`);
        assert.ok(res.evidence, `${study.id} (${label}): expected non-null evidence packet`);
        assert.equal(res.evidence.decision.selectedId, study.expectedSelectedReportId, `${study.id} (${label}): evidence.decision.selectedId mismatch`);

        const expectedReport = study.reports.find((r) => r.id === study.expectedSelectedReportId);
        assert.ok(expectedReport, `${study.id}: missing expectedSelectedReportId in study.reports`);
        assert.equal(res.evidence.evidence.length, 1, `${study.id} (${label}): expected 1 delivered evidence entry`);
        const digest = res.evidence.evidence[0].digest;
        assert.equal(
          digest.total_units,
          expectedReport.expectedDigest.totalUnits,
          `${study.id} (${label}): total_units mismatch`,
        );
        const topUnit = digest.units[0];
        assert.equal(
          topUnit.name,
          expectedReport.expectedDigest.topUnitName,
          `${study.id} (${label}): topUnit.name mismatch`,
        );
        assert.equal(
          topUnit.index,
          expectedReport.expectedDigest.topUnitIndex,
          `${study.id} (${label}): topUnit.index mismatch`,
        );
        assert.equal(
          topUnit.domain,
          expectedReport.expectedDigest.topUnitDomain,
          `${study.id} (${label}): topUnit.domain mismatch`,
        );
        for (const [metricKey, expectedVal] of Object.entries(expectedReport.expectedDigest.topUnitMetrics)) {
          const actualVal = topUnit.metrics[metricKey];
          if (expectedVal === null) {
            assert.equal(actualVal, null, `${study.id} (${label}): metric ${metricKey} must remain null`);
          } else {
            assert.ok(
              typeof actualVal === 'number' && Math.abs(actualVal - expectedVal) < 1e-6,
              `${study.id} (${label}): metric ${metricKey} expected ${expectedVal}, got ${actualVal}`,
            );
          }
        }
      }

      // Assert Go vs Node/TS parity on provenance, decisionOutcome, and selected digest
      assert.deepEqual(goResult.provenance, nodeResult.provenance, `${study.id}: Go vs Node provenance mismatch`);
      assert.equal(goResult.decisionOutcome, nodeResult.decisionOutcome, `${study.id}: Go vs Node decisionOutcome mismatch`);
      assert.equal(goResult.evidence.decision.selectedId, nodeResult.evidence.decision.selectedId, `${study.id}: Go vs Node selectedId mismatch`);
      assert.deepEqual(goResult.evidence.evidence[0].digest, nodeResult.evidence.evidence[0].digest, `${study.id}: Go vs Node selected digest mismatch`);

      studySummaries.push({
        studyId: study.id,
        reportsCount: study.reports.length,
        totalRawBytes: study.reports.reduce((acc, r) => acc + r.bytes, 0),
        selectedReportId: goResult.evidence.decision.selectedId,
        topUnitName: goResult.evidence.evidence[0].digest.units[0].name,
        goWallMs,
        nodeWallMs,
      });
    }
  } finally {
    if (prevClefUrl === undefined) delete process.env.PERFDIGEST_CLEF_URL;
    else process.env.PERFDIGEST_CLEF_URL = prevClefUrl;
    await rm(tmpManifestDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    benchRepo: benchDir,
    schemasValidated: [
      'benchmark-result.v1.schema.json',
      'benchmark-manifest.v1.schema.json',
      'regression-corpus.v1.schema.json',
    ],
    interpreterMatrixCellsValidated: 72,
    studiesValidated: studySummaries,
  }, null, 2));
} finally {
  await new Promise((resolveClose) => server.close(() => resolveClose()));
  if (!hadPerfdigestDir) {
    await rm(join(benchDir, '.perfdigest'), { recursive: true, force: true });
  }
  if (cleanupDir) {
    await rm(cleanupDir, { recursive: true, force: true });
  }
}
