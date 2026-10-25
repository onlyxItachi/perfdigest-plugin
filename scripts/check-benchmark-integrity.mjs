#!/usr/bin/env node
/**
 * CI gate for Issue #18: Benchmark integrity and repository engineering policies.
 * Verifies:
 *   1. Root AGENTS.md and CLAUDE.md exist and are synchronized on all 6 core policy pillars.
 *   2. All *-measurement-receipt.json bundles in bench/results/ pass full CSV/trace/receipt reconciliation.
 *   3. All representative fixture bundles in bench/fixtures/integrity-samples/ pass validation.
 *   4. Historical benchmark result files remain intact.
 */
import { readFile, readdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBenchmarkIntegrityBundle } from '../dist/benchmark-integrity.js';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_POLICY_SECTIONS = [
  '### 1.1 Reproducible Experiments',
  '### 1.2 Fair Baselines & Access Parity',
  '### 1.3 Real Execution vs. Fixtures',
  '### 1.4 Measured Truth Before Optimization',
  '### 1.5 Immutable History & Versioned Reconciliation',
  '### 1.6 Secrets, Sanitization & Provenance',
  '## 2. Mandatory Machine-Readable Outputs for Every Benchmark Run',
  '## 3. Cost Control & CI Verification Gates',
];

const HISTORICAL_RESULT_ARTIFACTS = [
  'bench/results/2026-10-18-amd-ryzen-ai-9-hx-370-x64.json',
  'bench/results/2026-10-18-lifecycle-and-orchestration.json',
  'bench/results/2026-10-18-mcp-session-reuse.json',
  'bench/results/2026-10-18-real-workload-evaluation.json',
  'bench/results/2026-10-24-multi-model-evaluation.json',
];

let failures = 0;

function fail(msg) {
  failures += 1;
  console.error(`FAIL [bench-integrity] ${msg}`);
}

function pass(msg) {
  console.log(`ok   [bench-integrity] ${msg}`);
}

// 1. Check AGENTS.md and CLAUDE.md
const agentsMd = await readFile(join(rootDir, 'AGENTS.md'), 'utf8').catch(() => '');
const claudeMd = await readFile(join(rootDir, 'CLAUDE.md'), 'utf8').catch(() => '');

if (!agentsMd) {
  fail('Missing root AGENTS.md');
}
if (!claudeMd) {
  fail('Missing root CLAUDE.md');
}

for (const section of REQUIRED_POLICY_SECTIONS) {
  if (!agentsMd.includes(section)) {
    fail(`AGENTS.md is missing required section: "${section}"`);
  }
  if (!claudeMd.includes(section)) {
    fail(`CLAUDE.md is missing required section: "${section}"`);
  }
}
if (failures === 0) {
  pass('AGENTS.md and CLAUDE.md present and synchronized across all 8 required policy sections');
}

// 2. Check historical result files exist and were not deleted
for (const relPath of HISTORICAL_RESULT_ARTIFACTS) {
  try {
    await access(join(rootDir, relPath));
  } catch {
    fail(`Historical benchmark artifact missing: ${relPath}`);
  }
}
if (failures === 0) {
  pass(`All ${HISTORICAL_RESULT_ARTIFACTS.length} historical benchmark result artifacts preserved`);
}

// 3. Validate all *-measurement-receipt.json bundles in bench/results/
const resultsDir = join(rootDir, 'bench', 'results');
const resultFiles = await readdir(resultsDir);
const receiptFiles = resultFiles.filter((f) => f.endsWith('-measurement-receipt.json'));

if (receiptFiles.length === 0) {
  fail('No *-measurement-receipt.json files found in bench/results/');
}

for (const receiptFile of receiptFiles) {
  const receiptPath = join(resultsDir, receiptFile);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const cellsCsv = await readFile(join(rootDir, receipt.cellsCsvRef), 'utf8');
  const summaryCsv = await readFile(join(rootDir, receipt.summaryCsvRef), 'utf8');
  const sourceTraceText = await readFile(join(rootDir, receipt.sourceTraceRef), 'utf8');

  const res = validateBenchmarkIntegrityBundle({
    cellsCsv,
    summaryCsv,
    sourceTraceText,
    receipt,
  });

  if (!res.valid) {
    for (const v of res.violations) {
      fail(`${receiptFile} (${v.code}): ${v.message}`);
    }
  } else {
    pass(`${receiptFile}: ${res.checkedCellsCount} cells and ${res.checkedSummaryRowsCount} summary rows reconciled`);
  }
}

// 4. Validate representative fixture bundles in bench/fixtures/integrity-samples/
const sampleDir = join(rootDir, 'bench', 'fixtures', 'integrity-samples');
const mixedCellsCsv = await readFile(join(sampleDir, 'failed-and-abstained-cells.csv'), 'utf8');
const mixedSummaryCsv = await readFile(join(sampleDir, 'failed-and-abstained-summary.csv'), 'utf8');
const mixedRes = validateBenchmarkIntegrityBundle({
  cellsCsv: mixedCellsCsv,
  summaryCsv: mixedSummaryCsv,
});
if (!mixedRes.valid) {
  for (const v of mixedRes.violations) {
    fail(`failed-and-abstained fixture (${v.code}): ${v.message}`);
  }
} else {
  pass(`failed-and-abstained fixture: ${mixedRes.checkedCellsCount} cells (complete + abstained + failed) reconciled`);
}

if (failures > 0) {
  process.exitCode = 1;
}
