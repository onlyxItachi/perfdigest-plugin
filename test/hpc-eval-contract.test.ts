import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditBenchmarkResultsDirectory, parseCsvRecords } from '../src/benchmark-integrity.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(
  THIS_DIR,
  THIS_DIR.includes(`${join('.test-build', 'test')}`) ? join('..', '..') : '..',
);
const CONTRACT_PATH = join(REPO_ROOT, 'bench', 'hpc-eval-contract.json');
const SCHEMA_PATH = join(REPO_ROOT, 'bench', 'schema', 'hpc-eval-contract.v1.schema.json');
const DOC_PATH = join(REPO_ROOT, 'docs', 'HPC_EVALUATION_CONTRACT.md');
const HARNESS_URL = pathToFileURL(join(REPO_ROOT, 'scripts', 'evaluate-hpc-workloads.mjs')).href;

interface HarnessModule {
  PRIMARY_ARMS: readonly string[];
  DELIVERY_STRATEGIES: readonly string[];
  EVIDENCE_DELIVERY_VOCABULARY: Record<string, string>;
  validateHpcContractDocument: (doc: unknown) => { valid: boolean; problems: string[] };
  loadAndValidateHpcContract: (
    contractPath?: string,
  ) => Promise<{ contract: Record<string, unknown>; contractSha256: string }>;
  computeDirectoryTreeSha256: (dirPath: string) => Promise<string>;
  evaluateSingleCriterion: (
    criterion: Record<string, unknown>,
    submission: Record<string, unknown>,
    verifierReceipts?: Record<string, { exitCode: number }>,
    options?: Record<string, unknown>,
  ) => {
    id: string;
    category: string;
    gradingMode: string;
    status: string;
    passed: boolean | null;
    reason: string;
  };
  evaluateCriteriaSubmission: (
    task: Record<string, unknown>,
    submission: Record<string, unknown>,
    verifierReceipts?: Record<string, { exitCode: number }>,
    options?: Record<string, unknown>,
  ) => {
    studyId: string;
    evaluationMode: string;
    contractTotalCriteria: number;
    applicableCriteriaCount: number;
    gradedCriteriaCount: number;
    pendingBlindJudgeCount: number;
    notApplicableCount: number;
    gradingComplete: boolean;
    totalChecks: number;
    checksPassed: number;
    accuracyPct: number | null;
    automatedChecksTotal: number;
    automatedChecksPassed: number;
    blindJudgeChecksTotal: number;
    blindJudgeChecksPassed: number;
    failedCriteriaIds: string[];
    pendingJudgeCriteriaIds: string[];
  };
  validateLivePreflight: (
    contract: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    violations: string[];
    confirmedStudyIds: string[];
    skippedUnselectedStudyIds: string[];
  }>;
  runHpcEvaluation: (options?: Record<string, unknown>) => Promise<{
    mode: string;
    runId: string;
    confirmedStudyIds: string[];
    skippedUnselectedStudyIds: string[];
    receiptRelPath: string;
    cellsCsvRef: string;
    summaryCsvRef: string;
    sourceTraceRef: string;
    totalCells: number;
    summaryRows: Array<Record<string, unknown>>;
    deliveryStrategyBreakdown: Array<Record<string, unknown>>;
    liveBaselineParityVerified: boolean;
    audit: { valid: boolean; violations: Array<{ code: string; message: string }> };
  }>;
}

let cachedHarness: HarnessModule | null = null;
async function loadHarness(): Promise<HarnessModule> {
  if (!cachedHarness) {
    cachedHarness = (await import(HARNESS_URL)) as HarnessModule;
  }
  return cachedHarness;
}

const LOCAL_PATH_PATTERNS = [
  /\/home\/[a-zA-Z0-9._-]+/,
  /\/Users\/[a-zA-Z0-9._-]+/,
  /\/root\/[a-zA-Z0-9._-]+/,
  /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[a-zA-Z0-9._-]+/,
  /\/tmp\/[a-zA-Z0-9._-]+/,
];

test('HPC evaluation contract enforces 100 criteria (75 grounded + 25 reserved), 5x5 taxonomy, arms, canonical delivery vocabulary, and symmetric modes', async () => {
  const harness = await loadHarness();
  const { contract } = await harness.loadAndValidateHpcContract(CONTRACT_PATH);

  assert.deepEqual(contract.primaryArms, ['raw', 'mcp_digest', 'evidence']);
  assert.deepEqual(contract.deliveryStrategies, [
    'in_execution',
    'in_execution_tool_delivery',
    'single_turn',
    'two_turn',
    'skill_background_worker',
  ]);
  assert.deepEqual(contract.evidenceDeliveryVocabulary, harness.EVIDENCE_DELIVERY_VOCABULARY);

  const tasks = contract.tasks as Array<Record<string, unknown>>;
  assert.equal(tasks.length, 4);

  const confirmed = tasks.filter((t) => t.status === 'confirmed');
  const unselected = tasks.filter((t) => t.status === 'unselected');
  assert.equal(confirmed.length, 3);
  assert.equal(unselected.length, 1);
  assert.deepEqual(
    confirmed.map((t) => t.studyId),
    ['gafime_rc3_ingestion', 'triton_xdna_106_abi', 'gafime_v041_mutual_info'],
  );

  const task4 = unselected[0]!;
  assert.equal(task4.studyId, 'task_4_unselected');
  assert.equal(task4.slot, 4);
  assert.equal(task4.selectedByUser, false);
  assert.equal(task4.runnable, false);

  const allIds = new Set<string>();
  let groundedCount = 0;
  let reservedCount = 0;
  let automatedTotal = 0;
  let blindJudgeTotal = 0;

  for (const task of tasks) {
    const criteria = task.criteria as Array<{ id: string; category: string; automated?: boolean; gradingMode?: string }>;
    assert.equal(criteria.length, 25);
    const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    for (const c of criteria) {
      assert.ok(!allIds.has(c.id), `duplicate criterion id ${c.id}`);
      allIds.add(c.id);
      counts[c.category] = (counts[c.category] ?? 0) + 1;
      if (task.status === 'confirmed') {
        if (c.automated === true) {
          assert.equal(c.gradingMode, 'deterministic_automated');
          automatedTotal += 1;
        } else {
          assert.equal(c.automated, false);
          assert.equal(c.gradingMode, 'blind_rubric_judge');
          blindJudgeTotal += 1;
        }
      }
    }
    assert.deepEqual(counts, { A: 5, B: 5, C: 5, D: 5, E: 5 });
    if (task.status === 'confirmed') groundedCount += criteria.length;
    else reservedCount += criteria.length;
  }

  assert.equal(groundedCount, 75);
  assert.equal(reservedCount, 25);
  assert.equal(allIds.size, 100);
  assert.ok(automatedTotal >= 25, 'expected substantial objective deterministic automated criteria');
  assert.ok(blindJudgeTotal >= 40, 'expected nuanced judgment criteria honestly marked blind_rubric_judge');

  // Verify T3-11 does not hint reference-fix design constants in neutralMetricKeys and T2-23..25 discriminate by agent report.
  const task2 = confirmed.find((t) => t.studyId === 'triton_xdna_106_abi')!;
  const task3 = confirmed.find((t) => t.studyId === 'gafime_v041_mutual_info')!;
  const t3Prompt = task3.agentPrompt as { neutralMetricKeys: string[] };
  assert.equal(t3Prompt.neutralMetricKeys.includes('proposed_max_hist_smem_bytes'), false);
  const t3Crit11 = (task3.criteria as Array<{ id: string; automated: boolean; gradingMode: string }>).find((c) => c.id === 'T3-11')!;
  assert.equal(t3Crit11.automated, false);
  assert.equal(t3Crit11.gradingMode, 'blind_rubric_judge');
  for (const cid of ['T2-23', 'T2-24', 'T2-25']) {
    const c = (task2.criteria as Array<{ id: string; automated: boolean; gradingMode: string }>).find((x) => x.id === cid)!;
    assert.equal(c.automated, false, `${cid} must grade agent-reported evidence rather than identical pristine-snapshot exits`);
    assert.equal(c.gradingMode, 'blind_rubric_judge');
  }
});

test('HPC contract rejects local paths, prompt/schema oracle leakage, hidden automated fields, no-op verifiers, and malformed operator expectations', async () => {
  const harness = await loadHarness();
  const [contractText, schemaText, docText] = await Promise.all([
    readFile(CONTRACT_PATH, 'utf8'),
    readFile(SCHEMA_PATH, 'utf8'),
    readFile(DOC_PATH, 'utf8'),
  ]);

  for (const [label, text] of [
    ['bench/hpc-eval-contract.json', contractText],
    ['bench/schema/hpc-eval-contract.v1.schema.json', schemaText],
    ['docs/HPC_EVALUATION_CONTRACT.md', docText],
  ] as const) {
    for (const pattern of LOCAL_PATH_PATTERNS) {
      assert.equal(pattern.test(text), false, `${label} matched forbidden local path ${pattern.toString()}`);
    }
  }

  const baseDoc = JSON.parse(contractText) as { tasks: Array<Record<string, unknown>> };

  // 1. Leakage in agentPrompt.outputSchema key/metric names must fail closed.
  const schemaLeakDoc = structuredClone(baseDoc);
  (schemaLeakDoc.tasks[0]! as { agentPrompt: { neutralMetricKeys: string[] } }).agentPrompt.neutralMetricKeys.push(
    'iter_rows_count',
  );
  const schemaLeakRes = harness.validateHpcContractDocument(schemaLeakDoc);
  assert.equal(schemaLeakRes.valid, false);
  assert.ok(schemaLeakRes.problems.some((p) => p.includes('oracle leakage')));

  // 2. Hidden unexposed automated oracleCheck field must fail closed.
  const hiddenFieldDoc = structuredClone(baseDoc);
  const t1Crits = (hiddenFieldDoc.tasks[0]! as { criteria: Array<Record<string, unknown>> }).criteria;
  (t1Crits[0]!.oracleCheck as { field: string }).field = 'measured_metrics.secret_unexposed_key';
  const hiddenFieldRes = harness.validateHpcContractDocument(hiddenFieldDoc);
  assert.equal(hiddenFieldRes.valid, false);
  assert.ok(hiddenFieldRes.problems.some((p) => p.includes('hidden metric key')));

  // 3. Per-operator superRefine must reject malformed in_range and exit_code_equals expectations.
  const badRangeDoc = structuredClone(baseDoc);
  const t1Range = (badRangeDoc.tasks[0]! as { criteria: Array<Record<string, unknown>> }).criteria[0]! as {
    oracleCheck: { expected: unknown };
  };
  t1Range.oracleCheck.expected = [100, 10]; // min > max
  const badRangeRes = harness.validateHpcContractDocument(badRangeDoc);
  assert.equal(badRangeRes.valid, false);
  assert.ok(badRangeRes.problems.some((p) => p.includes('in_range requires expected')));

  const badTolDoc = structuredClone(baseDoc);
  const t2Tol = (badTolDoc.tasks[1]! as { criteria: Array<Record<string, unknown>> }).criteria[0]! as {
    oracleCheck: { tolerancePct?: number };
  };
  delete t2Tol.oracleCheck.tolerancePct;
  const badTolRes = harness.validateHpcContractDocument(badTolDoc);
  assert.equal(badTolRes.valid, false);
  assert.ok(badTolRes.problems.some((p) => p.includes('within_tolerance_pct requires numeric tolerancePct')));

  // 4. Forbidden /bin/true no-op verifier must fail closed.
  const noopDoc = structuredClone(baseDoc);
  (noopDoc.tasks[0]! as { verifiers: Array<{ command: string }> }).verifiers[0]!.command = '/bin/true';
  const noopRes = harness.validateHpcContractDocument(noopDoc);
  assert.equal(noopRes.valid, false);
  assert.ok(noopRes.problems.some((p) => p.includes('no-op')));

  // 5. Missing `.git` in excludedLeakPaths must fail closed.
  const gitLeakDoc = structuredClone(baseDoc);
  (gitLeakDoc.tasks[1]! as { snapshotStrategy: { excludedLeakPaths: string[] } }).snapshotStrategy.excludedLeakPaths =
    ['UPSTREAM_ISSUE.md'];
  const gitLeakRes = harness.validateHpcContractDocument(gitLeakDoc);
  assert.equal(gitLeakRes.valid, false);
  assert.ok(gitLeakRes.problems.some((p) => p.includes('.git')));
});

test('blind_rubric_judge criteria never fake automated passes, read_only_diagnosis excludes patch verifiers, and task_4_unselected fails closed', async () => {
  const harness = await loadHarness();
  const { contract } = await harness.loadAndValidateHpcContract(CONTRACT_PATH);
  const tasks = contract.tasks as Array<Record<string, unknown>>;
  const task1 = tasks.find((t) => t.studyId === 'gafime_rc3_ingestion')!;
  const task4 = tasks.find((t) => t.studyId === 'task_4_unselected')!;

  assert.throws(() => harness.evaluateCriteriaSubmission(task4, {}, {}), /Refusing to grade unselected task/);

  // Without external blind-judge verdicts, automated:false criteria MUST remain pending_blind_judge
  // (passed: null) and MUST be excluded from totalChecks / accuracyPct (never counted as failures!).
  const readOnlyNoJudge = harness.evaluateCriteriaSubmission(
    task1,
    {
      measured_metrics: {
        cpu_hotspot_pct: 80,
        wall_slowdown_ratio: 22.8,
        peak_rss_excess_mib: 410,
        perf_report_duration_us: null,
      },
      localized_files: ['python/gafime/v1_adapter.py', 'crates/gafime-py'],
      localized_symbols: ['iter_rows', '_coerce_row_major_f32_for_cache', '_append_numeric', '_finite_for_precision', 'normalize_precision'],
    },
    {},
    { evaluationMode: 'read_only_diagnosis' },
  );
  assert.equal(readOnlyNoJudge.contractTotalCriteria, 25);
  assert.equal(readOnlyNoJudge.notApplicableCount, 3, '3 patch-only verifier criteria excluded in read_only_diagnosis');
  assert.equal(readOnlyNoJudge.applicableCriteriaCount, 22);
  assert.equal(readOnlyNoJudge.pendingBlindJudgeCount, 15);
  assert.equal(readOnlyNoJudge.gradedCriteriaCount, 7);
  assert.equal(readOnlyNoJudge.gradingComplete, false);
  assert.equal(readOnlyNoJudge.totalChecks, 7, 'pending judge criteria must NOT inflate denominator');
  assert.equal(readOnlyNoJudge.automatedChecksTotal, 7);
  assert.equal(readOnlyNoJudge.automatedChecksPassed, 7);
  assert.equal(readOnlyNoJudge.blindJudgeChecksTotal, 15);
  assert.equal(readOnlyNoJudge.blindJudgeChecksPassed, 0, 'never fabricate automated pass on blind-judge criteria');
  assert.equal(readOnlyNoJudge.checksPassed, 7);
  assert.equal(readOnlyNoJudge.accuracyPct, 100);

  // Supplying a real blind-judge verdict scores only that criterion accurately.
  const withOneJudge = harness.evaluateCriteriaSubmission(
    task1,
    {
      measured_metrics: {
        cpu_hotspot_pct: 80,
        wall_slowdown_ratio: 22.8,
        peak_rss_excess_mib: 410,
        perf_report_duration_us: 0, // zero-filled! must FAIL T1-04 null_not_zero
      },
      localized_files: ['python/gafime/v1_adapter.py', 'crates/gafime-py'],
      localized_symbols: ['iter_rows', '_coerce_row_major_f32_for_cache', '_append_numeric', '_finite_for_precision', 'normalize_precision'],
    },
    {},
    {
      evaluationMode: 'read_only_diagnosis',
      judgeVerdicts: {
        'T1-05': { passed: true, judgeId: 'blind-judge-1', rationale: 'Separated parser floor from native delta.' },
      },
    },
  );
  assert.equal(withOneJudge.automatedChecksPassed, 6, 'zero-filled perf_report_duration_us must fail T1-04');
  assert.ok(withOneJudge.failedCriteriaIds.includes('T1-04'));
  assert.equal(withOneJudge.blindJudgeChecksPassed, 1);
  assert.equal(withOneJudge.pendingBlindJudgeCount, 14);
  assert.equal(withOneJudge.gradedCriteriaCount, 8);
  assert.equal(withOneJudge.totalChecks, 8);
  assert.equal(withOneJudge.checksPassed, 7);
  assert.equal(withOneJudge.accuracyPct, 87.5);
});

test('live mode preflight enforces recursive nested .git rejection, snapshotTreeSha256 verification, and genuine artifact SHA-256 checks', async () => {
  const harness = await loadHarness();
  const { contract } = await harness.loadAndValidateHpcContract(CONTRACT_PATH);

  const missingAll = await harness.validateLivePreflight(contract, {});
  assert.equal(missingAll.ok, false);
  assert.ok(missingAll.violations.some((v) => v.startsWith('live_confirmation_missing')));
  assert.ok(missingAll.violations.some((v) => v.startsWith('perfdigest_mcp_version_unpinned')));

  const scratch = await mkdtemp(join(tmpdir(), 'perfdigest-hpc-preflight-'));
  try {
    const snapDir = join(scratch, 'triton-snap');
    const artDir = join(scratch, 'triton-arts');
    await mkdir(join(snapDir, 'sources', 'triton'), { recursive: true });
    await writeFile(join(snapDir, 'sources', 'triton', 'README.txt'), 'clean archive snapshot\n');
    await mkdir(artDir, { recursive: true });

    const ninja1 = join(artDir, 'native_registry.ninja_log');
    const ninja2 = join(artDir, 'initializer.ninja_log');
    const cmakeProf = join(artDir, 'native_registry.cmake-profile.json');
    const b1 = Buffer.from('# ninja log v7\n0\t10\t1\tfoo.o\tabc\n');
    const b2 = Buffer.from('# ninja log v7\n0\t20\t1\tbar.o\tdef\n');
    const b3 = Buffer.from('[{"name":"project","ph":"X","ts":0,"dur":100}]\n');
    await Promise.all([writeFile(ninja1, b1), writeFile(ninja2, b2), writeFile(cmakeProf, b3)]);

    const cleanTreeSha = await harness.computeDirectoryTreeSha256(snapDir);
    const snapManifestPath = join(scratch, 'snapshots.json');
    const artManifestPath = join(scratch, 'artifacts.json');
    const writeManifests = async (treeSha: string) => {
      await writeFile(
        snapManifestPath,
        JSON.stringify({
          snapshots: {
            triton_xdna_106_abi: {
              snapshotDir: snapDir,
              preFixSha: 'e0667baa81c9dba66e8163c23e4683a144505cef',
              snapshotTreeSha256: treeSha,
            },
          },
        }),
      );
      await writeFile(
        artManifestPath,
        JSON.stringify({
          artifacts: {
            triton_xdna_106_abi: {
              'native-registry-ninja-log': {
                path: ninja1,
                format: 'ninja-log',
                sha256: createHash('sha256').update(b1).digest('hex'),
              },
              'initializer-ninja-log': {
                path: ninja2,
                format: 'ninja-log',
                sha256: createHash('sha256').update(b2).digest('hex'),
              },
              'native-registry-cmake-profile': {
                path: cmakeProf,
                format: 'cmake-profile',
                sha256: createHash('sha256').update(b3).digest('hex'),
              },
            },
          },
        }),
      );
    };

    await writeManifests(cleanTreeSha);
    const validPreflight = await harness.validateLivePreflight(contract, {
      confirmLive: true,
      perfdigestMcpVersion: '1.2.0',
      snapshotManifestPath: snapManifestPath,
      artifactManifestPath: artManifestPath,
      taskIds: ['triton_xdna_106_abi', 'task_4_unselected'],
    });
    assert.equal(validPreflight.ok, true, `unexpected preflight violations: ${validPreflight.violations.join('; ')}`);

    // Tampered snapshotTreeSha256 must fail closed.
    await writeManifests('0'.repeat(64));
    const badShaRes = await harness.validateLivePreflight(contract, {
      confirmLive: true,
      perfdigestMcpVersion: '1.2.0',
      snapshotManifestPath: snapManifestPath,
      artifactManifestPath: artManifestPath,
      taskIds: ['triton_xdna_106_abi'],
    });
    assert.equal(badShaRes.ok, false);
    assert.ok(badShaRes.violations.some((v) => v.startsWith('snapshot_tree_sha256_mismatch:')));

    // Nested `.git` inside `sources/triton/.git` must be caught recursively even if snapshotTreeSha256 is recomputed!
    await mkdir(join(snapDir, 'sources', 'triton', '.git'), { recursive: true });
    await writeFile(join(snapDir, 'sources', 'triton', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const nestedGitTreeSha = await harness.computeDirectoryTreeSha256(snapDir);
    await writeManifests(nestedGitTreeSha);
    const nestedGitRes = await harness.validateLivePreflight(contract, {
      confirmLive: true,
      perfdigestMcpVersion: '1.2.0',
      snapshotManifestPath: snapManifestPath,
      artifactManifestPath: artManifestPath,
      taskIds: ['triton_xdna_106_abi'],
    });
    assert.equal(nestedGitRes.ok, false);
    assert.ok(nestedGitRes.violations.some((v) => v.includes('snapshot_git_leak_detected:triton_xdna_106_abi:sources/triton/.git')));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('contract_fixture smoke run is strictly arm-neutral, uses canonical EvidenceDelivery names, skips task_4_unselected, and passes auditBenchmarkResultsDirectory', async () => {
  const harness = await loadHarness();
  const outputRelDir = `work/bench-results/hpc-eval-test-${process.pid}-${Date.now()}`;
  const fullOutDir = join(REPO_ROOT, outputRelDir);

  try {
    const res = await harness.runHpcEvaluation({
      rootDir: REPO_ROOT,
      contractPath: CONTRACT_PATH,
      mode: 'contract_fixture',
      outputRelDir,
      runId: 'hpc-eval-smoke-test',
    });

    assert.equal(res.mode, 'contract_fixture');
    assert.equal(res.liveBaselineParityVerified, false);
    assert.deepEqual(res.confirmedStudyIds, [
      'gafime_rc3_ingestion',
      'triton_xdna_106_abi',
      'gafime_v041_mutual_info',
    ]);
    assert.deepEqual(res.skippedUnselectedStudyIds, ['task_4_unselected']);
    assert.equal(res.totalCells, 21);
    assert.equal(res.audit.valid, true);
    assert.equal(res.summaryRows.length, 7);
    assert.equal(res.deliveryStrategyBreakdown.length, 5);

    const [cellsCsv, traceText, receiptText] = await Promise.all([
      readFile(join(REPO_ROOT, res.cellsCsvRef), 'utf8'),
      readFile(join(REPO_ROOT, res.sourceTraceRef), 'utf8'),
      readFile(join(REPO_ROOT, res.receiptRelPath), 'utf8'),
    ]);

    const parsedCells = parseCsvRecords(cellsCsv);
    assert.equal(parsedCells.rows.length, 21);
    assert.equal(parsedCells.rows.some((r) => r.study_id === 'task_4_unselected'), false);

    // Verify canonical EvidenceDelivery vocabulary on every row.
    const validDeliveries = new Set(Object.values(harness.EVIDENCE_DELIVERY_VOCABULARY));
    for (const r of parsedCells.rows) {
      assert.ok(validDeliveries.has(r.evidence_delivery_mode ?? ''), `non-canonical evidence_delivery_mode "${r.evidence_delivery_mode}"`);
    }

    // Verify strict arm-neutrality: raw, mcp_digest, and complete evidence cells have IDENTICAL
    // checks_passed, input/output tokens, tool calls, and e2e_wall_ms (zero hypothesis bias against raw!).
    const completeRows = parsedCells.rows.filter((r) => r.status === 'complete');
    const rawRows = completeRows.filter((r) => r.arm === 'raw');
    const mcpRows = completeRows.filter((r) => r.arm === 'mcp_digest');
    const evRows = completeRows.filter((r) => r.arm === 'evidence');
    assert.equal(rawRows.length, 3);
    assert.equal(mcpRows.length, 3);
    assert.ok(evRows.length > 0);
    for (const r of completeRows) {
      assert.equal(r.checks_passed, '25', `complete fixture cell ${r.cell_id} must not penalize any arm`);
      assert.equal(r.agent_input_tokens, '2000');
      assert.equal(r.agent_output_tokens, '350');
      assert.equal(r.tool_calls_count, '4');
      assert.equal(r.e2e_wall_ms, '100');
    }

    const trace = JSON.parse(traceText) as {
      rootCauseFindings: { liveBaselineParityVerified: boolean; contractFixtureArmNeutralityVerified: boolean };
    };
    assert.equal(trace.rootCauseFindings.liveBaselineParityVerified, false);
    assert.equal(trace.rootCauseFindings.contractFixtureArmNeutralityVerified, true);

    const receipt = JSON.parse(receiptText) as {
      sampleSize: { totalCells: number; abstainedCells: number; failedCells: number };
      limitations: string[];
    };
    assert.equal(receipt.sampleSize.abstainedCells, 1);
    assert.equal(receipt.sampleSize.failedCells, 1);
    assert.ok(receipt.limitations.some((l) => l.includes('LIVE_BASELINE_PARITY_UNVERIFIED')));
    assert.ok(receipt.limitations.some((l) => l.includes('task_4_unselected')));

    const directAudit = await auditBenchmarkResultsDirectory(REPO_ROOT, outputRelDir, [], {});
    assert.equal(directAudit.valid, true, JSON.stringify(directAudit.violations));
  } finally {
    await rm(fullOutDir, { recursive: true, force: true });
  }
});
