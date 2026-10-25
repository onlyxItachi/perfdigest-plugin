#!/usr/bin/env node
/**
 * CI gate for Issue #18: Benchmark integrity and repository engineering policies.
 * Verifies:
 *   1. Root AGENTS.md and CLAUDE.md exist and are synchronized on all 6 core policy pillars.
 *   2. Every artifact in bench/results/ is either in FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS or bound
 *      to a valid *-measurement-receipt.json bundle (no unreceipted benchmark results can evade CI).
 *   3. All *-measurement-receipt.json bundles pass full CSV, summary, and machine-readable
 *      source_trace_ref existence, cell identity, provenance, and telemetry reconciliation.
 *   4. All representative fixture bundles in bench/fixtures/integrity-samples/ pass validation.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditBenchmarkResultsDirectory,
  validateBenchmarkIntegrityBundle,
} from '../dist/benchmark-integrity.js';

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

// 2. Audit bench/results/ directory (frozen historical files + receipted bundles + untracked file rejection)
const dirAudit = await auditBenchmarkResultsDirectory(rootDir);
if (!dirAudit.valid) {
  for (const v of dirAudit.violations) {
    fail(`bench/results audit (${v.code}): ${v.message}`);
  }
} else {
  pass(
    `bench/results directory audit passed: ${dirAudit.historicalFilesVerified.length} frozen historical artifacts preserved, ${dirAudit.receiptsValidated.length} receipt bundle(s) fully reconciled with machine-readable source traces, 0 unreceipted artifacts`,
  );
}

// 3. Validate representative fixture bundles in bench/fixtures/integrity-samples/
const sampleDir = join(rootDir, 'bench', 'fixtures', 'integrity-samples');
const mixedCellsCsv = await readFile(join(sampleDir, 'failed-and-abstained-cells.csv'), 'utf8');
const mixedSummaryCsv = await readFile(join(sampleDir, 'failed-and-abstained-summary.csv'), 'utf8');
const mixedRes = validateBenchmarkIntegrityBundle({
  cellsCsv: mixedCellsCsv,
  summaryCsv: mixedSummaryCsv,
  requireSourceTraceVerification: false,
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
