#!/usr/bin/env node
/**
 * CI gate for Issue #18: Benchmark integrity and repository engineering policies.
 * Verifies:
 *   1. Root AGENTS.md and CLAUDE.md exist, contain all required policy sections, and are
 *      byte-for-byte identical after the title line.
 *   2. Every artifact in bench/results/ is in FROZEN_HISTORICAL_BENCHMARK_ARTIFACTS with its
 *      exact pinned SHA-256 digest (0 unreceipted or modified files).
 *   3. The representative 3-cell bundle in bench/fixtures/integrity-samples/ passes full CSV,
 *      summary, measurement-receipt, and machine-readable source_trace_ref verification.
 *   4. Producer-boundary generation (writeValidatedBenchmarkBundle) and directory audit
 *      (auditBenchmarkResultsDirectory) succeed in a scratch directory under work/bench-integrity-ci/.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditBenchmarkResultsDirectory,
  validateBenchmarkIntegrityBundle,
  writeValidatedBenchmarkBundle,
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

const agentsBody = agentsMd.split('\n').slice(1).join('\n');
const claudeBody = claudeMd.split('\n').slice(1).join('\n');
if (agentsBody !== claudeBody) {
  fail('AGENTS.md and CLAUDE.md diverge after the title line');
}

if (failures === 0) {
  pass('AGENTS.md and CLAUDE.md present and byte-for-byte synchronized across all 8 required policy sections');
}

// 2. Audit bench/results/ directory (frozen historical files + SHA-256 pinning + zero new committed results)
const dirAudit = await auditBenchmarkResultsDirectory(
  rootDir,
  'bench/results',
  undefined,
  undefined,
  { allowReceiptedBundles: false },
);
if (!dirAudit.valid) {
  for (const v of dirAudit.violations) {
    fail(`bench/results audit (${v.code}): ${v.message}`);
  }
} else {
  pass(
    `bench/results directory audit passed: ${dirAudit.historicalFilesVerified.length} frozen historical artifacts SHA-256 verified, 0 unreceipted artifacts`,
  );
}

// 3. Validate representative fixture bundle in bench/fixtures/integrity-samples/ with full trace + receipt verification
const sampleDir = join(rootDir, 'bench', 'fixtures', 'integrity-samples');
const mixedCellsCsv = await readFile(join(sampleDir, 'failed-and-abstained-cells.csv'), 'utf8');
const mixedSummaryCsv = await readFile(join(sampleDir, 'failed-and-abstained-summary.csv'), 'utf8');
const mixedTraceText = await readFile(join(sampleDir, 'failed-and-abstained-trace.json'), 'utf8');
const mixedReceipt = JSON.parse(
  await readFile(join(sampleDir, 'failed-and-abstained-measurement-receipt.json'), 'utf8'),
);

const mixedRes = validateBenchmarkIntegrityBundle({
  cellsCsv: mixedCellsCsv,
  summaryCsv: mixedSummaryCsv,
  sourceTraceText: mixedTraceText,
  receipt: mixedReceipt,
  requireSourceTraceVerification: true,
});
if (!mixedRes.valid) {
  for (const v of mixedRes.violations) {
    fail(`failed-and-abstained fixture (${v.code}): ${v.message}`);
  }
} else {
  pass(
    `failed-and-abstained fixture: ${mixedRes.checkedCellsCount} cells (complete + abstained + failed) reconciled with source trace and measurement receipt`,
  );
}

// 4. Verify producer-boundary generation and directory audit in a scratch directory under work/bench-integrity-ci/
const ciScratchRoot = join(rootDir, 'work', 'bench-integrity-ci');
await rm(ciScratchRoot, { recursive: true, force: true });
try {
  await mkdir(ciScratchRoot, { recursive: true });
  await writeValidatedBenchmarkBundle({
    rootDir: ciScratchRoot,
    receiptRelPath: 'bench/fixtures/integrity-samples/failed-and-abstained-measurement-receipt.json',
    cellsCsv: mixedCellsCsv,
    summaryCsv: mixedSummaryCsv,
    sourceTraceContent: mixedTraceText,
    receipt: mixedReceipt,
  });
  const scratchAudit = await auditBenchmarkResultsDirectory(
    ciScratchRoot,
    'bench/fixtures/integrity-samples',
    [],
    {},
  );
  if (!scratchAudit.valid || scratchAudit.receiptsValidated.length !== 1) {
    for (const v of scratchAudit.violations) {
      fail(`producer-boundary scratch audit (${v.code}): ${v.message}`);
    }
    if (scratchAudit.receiptsValidated.length !== 1) {
      fail(`expected 1 validated receipt in scratch audit, got ${scratchAudit.receiptsValidated.length}`);
    }
  } else {
    pass('writeValidatedBenchmarkBundle + auditBenchmarkResultsDirectory verified in work/bench-integrity-ci/');
  }
} finally {
  await rm(ciScratchRoot, { recursive: true, force: true });
}

if (failures > 0) {
  process.exitCode = 1;
}
