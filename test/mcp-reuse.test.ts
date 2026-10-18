import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod, mkdir, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gatherEvidence } from '../src/evidence.js';
import { openPerfDigestSession, withPerfDigestSession, type PerfDigestSessionStats } from '../src/perfdigest.js';
import type { DecisionProvider } from '../src/providers.js';
import type { EvidenceProvenance, ReportSpec } from '../src/config.js';
import { childEnvironment, executable } from '../src/environment.js';
import { fixtureUv, testDirectory } from './helpers.js';

const execFileAsync = promisify(execFile);

async function countingFixtureUv(root: string, spawnsFile: string, callsFile: string): Promise<string> {
  const bin = join(root, 'bin-counting');
  await mkdir(bin, { recursive: true });
  const script = join(bin, 'uvx');
  const serverUrl = new URL('./fixtures/mcp-server.js', import.meta.url).href;
  await writeFile(script, `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(spawnsFile)}, JSON.stringify({
  pid: process.pid,
  hasCf: !!process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN,
  hasDecisions: !!process.env.PERFDIGEST_DECISIONS_API_KEY,
  hasOpenai: !!process.env.OPENAI_API_KEY,
}) + '\\n');
process.on('exit', () => {
  fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ exitedPid: process.pid }) + '\\n');
});
await import(${JSON.stringify(serverUrl)});
`);
  await chmod(script, 0o755);
  return bin;
}

test('gatherEvidence reuses one bounded MCP session across multiple candidate reports and closes it before provider routing', async () => {
  const root = await testDirectory('mcp-reuse-multi');
  const prior = {
    path: process.env.PATH,
    cf: process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN,
    decisions: process.env.PERFDIGEST_DECISIONS_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  try {
    const spawnsFile = join(root, 'spawns.jsonl');
    const exitsFile = join(root, 'exits.jsonl');
    process.env.PATH = `${await countingFixtureUv(root, spawnsFile, exitsFile)}${delimiter}${prior.path}`;
    process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN = 'cf-secret-do-not-leak';
    process.env.PERFDIGEST_DECISIONS_API_KEY = 'decisions-secret-do-not-leak';
    process.env.OPENAI_API_KEY = 'openai-secret-do-not-leak';

    const reports: ReportSpec[] = [];
    for (let i = 1; i <= 4; i++) {
      const name = `trace-${i}.json`;
      await writeFile(join(root, name), JSON.stringify({ reportIndex: i }));
      reports.push({ id: `r${i}`, path: name, format: 'chrome-trace', description: `Report ${i}` });
    }

    let spawnsAtProviderSelect = 0;
    const provider: DecisionProvider = {
      name: 'cloudflare',
      async select(_issue, _reports, _signal, measured) {
        assert.equal(measured?.length, 4);
        const spawnsLines = (await readFile(spawnsFile, 'utf8')).trim().split('\n').filter(Boolean);
        spawnsAtProviderSelect = spawnsLines.length;
        return {
          selectedId: 'r3',
          confidence: 0.88,
          reason: 'selected',
          source: 'clef_cloudflare',
          provider: 'cloudflare',
          model: '@cf/cloudflare/clef-flash',
          confidenceSemantics: 'systemone_uniform_zero',
          transport: 'local_mock',
          requests: 1,
          latencyMs: 5,
          inputTokens: 20,
          outputTokens: 0,
          costUsd: null,
        };
      },
    };

    let observedStats: PerfDigestSessionStats | null = null;
    const provenance: EvidenceProvenance[] = [];
    const packet = await gatherEvidence({
      workspace: root,
      issue: 'Multi-report session reuse test',
      reports,
      routing: 'cloudflare',
      provider,
      provenance,
      onMcpSessionStats: s => { observedStats = s; },
    });

    assert.equal(packet.status, 'complete');
    assert.equal(packet.evidence.length, 1);
    assert.equal(packet.evidence[0]!.report.id, 'r3');
    assert.equal(packet.considered.length, 4);
    assert.equal(packet.considered.filter(c => c.delivered).length, 1);
    assert.equal(packet.considered.find(c => c.id === 'r3')?.delivered, true);

    assert.deepEqual(observedStats, {
      spawns: 1,
      calls: 4,
      reusedCalls: 3,
      closed: true,
      tainted: false,
    });

    // Verify only 1 uvx process was spawned across all 4 reports and credentials were stripped
    const spawns = (await readFile(spawnsFile, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(spawns.length, 1, 'Expected exactly 1 uvx process spawn for 4 reports');
    assert.equal(spawns[0].hasCf, false);
    assert.equal(spawns[0].hasDecisions, false);
    assert.equal(spawns[0].hasOpenai, false);
    assert.equal(spawnsAtProviderSelect, 1);
  } finally {
    for (const [k, v] of Object.entries({
      PATH: prior.path,
      PERFDIGEST_CLOUDFLARE_API_TOKEN: prior.cf,
      PERFDIGEST_DECISIONS_API_KEY: prior.decisions,
      OPENAI_API_KEY: prior.openai,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('PerfDigestSession enforces maxCalls, concurrency guards, failure isolation, and per-call timeouts', async () => {
  const root = await testDirectory('mcp-reuse-isolation');
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${await fixtureUv(root)}${delimiter}${priorPath}`;
    await writeFile(join(root, 'ok1.json'), '{}');
    await writeFile(join(root, 'ok2.json'), '{}');
    await writeFile(join(root, 'bad.json'), JSON.stringify({ mode: 'error' }));
    await writeFile(join(root, 'slow.json'), JSON.stringify({ mode: 'slow' }));

    const r1: ReportSpec = { id: 'ok1', path: 'ok1.json', format: 'chrome-trace', description: 'OK 1' };
    const r2: ReportSpec = { id: 'ok2', path: 'ok2.json', format: 'chrome-trace', description: 'OK 2' };
    const rBad: ReportSpec = { id: 'bad', path: 'bad.json', format: 'chrome-trace', description: 'Bad' };
    const rSlow: ReportSpec = { id: 'slow', path: 'slow.json', format: 'chrome-trace', description: 'Slow' };

    // 1. Invalid bounds rejected
    assert.throws(() => openPerfDigestSession(root, undefined, { maxCalls: 0 }), /between 1 and 16/);
    assert.throws(() => openPerfDigestSession(root, undefined, { maxCalls: 17 }), /between 1 and 16/);
    assert.throws(() => openPerfDigestSession(root, undefined, { callTimeoutMs: 0 }), /must be positive/);

    // 2. maxCalls enforcement
    await withPerfDigestSession(root, undefined, async session => {
      await session.digest(r1, join(root, 'ok1.json'));
      await session.digest(r2, join(root, 'ok2.json'));
      assert.deepEqual(session.stats(), { spawns: 1, calls: 2, reusedCalls: 1, closed: false, tainted: false });
      await assert.rejects(session.digest(r1, join(root, 'ok1.json')), /call limit \(2\) exceeded/);
      assert.equal(session.stats().tainted, true);
      assert.equal(session.stats().closed, true);
    }, { maxCalls: 2 });

    // 3. Failure isolation: error on call #2 taints and closes session; call #3 is refused without spawning or reusing
    const session = openPerfDigestSession(root, undefined, { maxCalls: 4 });
    try {
      await session.digest(r1, join(root, 'ok1.json'));
      await assert.rejects(session.digest(rBad, join(root, 'bad.json')), /MCP tool error/);
      assert.deepEqual(session.stats(), { spawns: 1, calls: 2, reusedCalls: 1, closed: true, tainted: true });
      await assert.rejects(session.digest(r2, join(root, 'ok2.json')), /tainted by a prior error/);
    } finally {
      await session.close();
    }

    // 4. Per-call timeout taints and closes session
    await withPerfDigestSession(root, undefined, async slowSession => {
      await slowSession.digest(r1, join(root, 'ok1.json'));
      await assert.rejects(slowSession.digest(rSlow, join(root, 'slow.json')), /timed out/);
      assert.equal(slowSession.stats().tainted, true);
      assert.equal(slowSession.stats().closed, true);
    }, { callTimeoutMs: 80 });

    // 5. Concurrent calls on the same session are rejected
    await withPerfDigestSession(root, undefined, async concSession => {
      await assert.rejects(
        Promise.all([
          concSession.digest(rSlow, join(root, 'slow.json')),
          concSession.digest(r1, join(root, 'ok1.json')),
        ]),
        /does not allow concurrent calls/,
      );
      assert.equal(concSession.stats().tainted, true);
      assert.equal(concSession.stats().closed, true);
    }, { callTimeoutMs: 1000 });
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('real PerfDigest MCP session reuse works across multiple reports on baseline v1.2.0 and v1.3.0 (when cached)', async () => {
  const root = await testDirectory('mcp-reuse-real-versions');
  try {
    const tracePayload = JSON.stringify({
      traceEvents: [
        { ph: 'X', name: 'row_major', cat: 'cpu', ts: 0, dur: 120, pid: 1, tid: 1 },
        { ph: 'X', name: 'column_major', cat: 'cpu', ts: 200, dur: 450, pid: 1, tid: 1 },
      ],
    });
    const reports: ReportSpec[] = [];
    for (let i = 1; i <= 3; i++) {
      const p = join(root, `real-${i}.json`);
      await writeFile(p, tracePayload);
      reports.push({ id: `real-${i}`, path: `real-${i}.json`, format: 'chrome-trace', description: `Real trace ${i}` });
    }

    // 1. Installed baseline (perfdigest-mcp v1.2.0)
    await withPerfDigestSession(root, undefined, async session => {
      for (const r of reports) {
        const d = await session.digest(r, join(root, r.path));
        assert.equal(d.format, 'chrome-trace');
        assert.equal(d.total_units, 2);
      }
      assert.deepEqual(session.stats(), { spawns: 1, calls: 3, reusedCalls: 2, closed: false, tainted: false });
    });

    // 2. PerfDigest MCP v1.3.0 (MCP SDK 2.3) when cached locally in uv
    const uvxBin = executable('uvx');
    let has130 = false;
    try {
      await execFileAsync(uvxBin, ['--offline', '--from', 'perfdigest-mcp==1.3.0', 'python', '-c', 'import perfdigest'], {
        env: childEnvironment(),
        timeout: 5000,
      });
      has130 = true;
    } catch {
      has130 = false;
    }
    if (has130) {
      await withPerfDigestSession(root, undefined, async session => {
        for (const r of reports) {
          const d = await session.digest(r, join(root, r.path));
          assert.equal(d.format, 'chrome-trace');
          assert.equal(d.total_units, 2);
        }
        assert.deepEqual(session.stats(), { spawns: 1, calls: 3, reusedCalls: 2, closed: false, tainted: false });
      }, { command: uvxBin, args: ['--offline', '--from', 'perfdigest-mcp==1.3.0', 'perfdigest-mcp'] });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gatherEvidence reuseMcpSession=false vs reuseMcpSession=true executes identical evidence pipeline with controlled spawn counts', async () => {
  const root = await testDirectory('mcp-reuse-baseline-equivalence');
  const priorPath = process.env.PATH;
  try {
    const spawnsFile = join(root, 'spawns.jsonl');
    const exitsFile = join(root, 'exits.jsonl');
    process.env.PATH = `${await countingFixtureUv(root, spawnsFile, exitsFile)}${delimiter}${priorPath}`;

    const reports: ReportSpec[] = [];
    for (let i = 1; i <= 4; i++) {
      const name = `trace-${i}.json`;
      await writeFile(join(root, name), JSON.stringify({ reportIndex: i }));
      reports.push({ id: `r${i}`, path: name, format: 'chrome-trace', description: `Report ${i}` });
    }

    const provider: DecisionProvider = {
      name: 'cloudflare',
      async select(_issue, _reports, _signal, measured) {
        assert.equal(measured?.length, 4);
        return {
          selectedId: 'r2',
          confidence: 0.91,
          reason: 'selected',
          source: 'clef_cloudflare',
          provider: 'cloudflare',
          model: 'perfdigest/clef-flash-v1',
          confidenceSemantics: 'systemone_uniform_zero',
          transport: 'local_mock',
          requests: 1,
          latencyMs: 2,
          inputTokens: 20,
          outputTokens: 0,
          costUsd: null,
        };
      },
    };

    let baselineStats: PerfDigestSessionStats | null = null;
    const baselineProvenance: EvidenceProvenance[] = [];
    const baselinePacket = await gatherEvidence({
      workspace: root,
      issue: 'Baseline equivalence test',
      reports,
      routing: 'cloudflare',
      provider,
      reuseMcpSession: false,
      provenance: baselineProvenance,
      onMcpSessionStats: s => { baselineStats = s; },
    });

    let reuseStats: PerfDigestSessionStats | null = null;
    const reuseProvenance: EvidenceProvenance[] = [];
    const reusePacket = await gatherEvidence({
      workspace: root,
      issue: 'Baseline equivalence test',
      reports,
      routing: 'cloudflare',
      provider,
      reuseMcpSession: true,
      provenance: reuseProvenance,
      onMcpSessionStats: s => { reuseStats = s; },
    });

    assert.deepEqual(baselineStats, { spawns: 4, calls: 4, reusedCalls: 0, closed: true, tainted: false });
    assert.deepEqual(reuseStats, { spawns: 1, calls: 4, reusedCalls: 3, closed: true, tainted: false });
    assert.deepEqual(baselinePacket, reusePacket);
    assert.deepEqual(baselineProvenance, reuseProvenance);
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('Deno and Bun runtime verification: normal completion, caller abort, and deadline timeout exit promptly without leaked timer/listener hangs', async () => {
  const root = await testDirectory('mcp-runtime-deno-bun-lifecycle');
  try {
    const repoRoot = join(import.meta.dirname, '..', '..');
    const distRun = join(repoRoot, 'dist', 'run.js');
    const distEvidence = join(repoRoot, 'dist', 'evidence.js');
    const binModUrl = new URL('../../bench/lib/binaries.mjs', import.meta.url).href;
    const { resolveBenchBinaries } = await import(binModUrl) as {
      resolveBenchBinaries: (r: string) => { node: string; bun: string | null; deno: string | null };
    };
    const bins = resolveBenchBinaries(repoRoot);
    const binDir = await fixtureUv(root);

    await writeFile(join(root, 'trace-1.json'), '{}');
    await writeFile(join(root, 'trace-2.json'), '{}');
    await writeFile(join(root, 'slow.json'), JSON.stringify({ mode: 'slow' }));

    const driverPath = join(root, 'lifecycle-driver.mjs');
    await writeFile(driverPath, `import { investigate } from ${JSON.stringify(distRun)};
import { gatherEvidence } from ${JSON.stringify(distEvidence)};

const [scenario, workspace] = process.argv.slice(2);

if (scenario === 'normal-reuse') {
  const reports = [
    { id: 'r1', path: 'trace-1.json', format: 'chrome-trace', description: 'R1' },
    { id: 'r2', path: 'trace-2.json', format: 'chrome-trace', description: 'R2' },
  ];
  const provider = {
    name: 'cloudflare',
    async select() {
      return {
        selectedId: 'r2',
        confidence: 0.9,
        reason: 'selected',
        source: 'clef_cloudflare',
        provider: 'cloudflare',
        model: 'perfdigest/clef-flash-v1',
        confidenceSemantics: 'systemone_uniform_zero',
        transport: 'local_mock',
        requests: 1,
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 0,
        costUsd: null,
      };
    },
  };
  let stats = null;
  const pkt = await gatherEvidence({
    workspace,
    issue: 'Deno/Bun reuse',
    reports,
    routing: 'cloudflare',
    provider,
    reuseMcpSession: true,
    onMcpSessionStats: (s) => { stats = s; },
  });
  if (pkt.status !== 'complete' || stats?.spawns !== 1 || stats?.reusedCalls !== 1) process.exit(2);
} else if (scenario === 'caller-abort') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('caller-cancelled')), 40);
  timer.unref();
  try {
    await gatherEvidence({
      workspace,
      issue: 'Caller abort test',
      reports: [{ id: 'slow', path: 'slow.json', format: 'chrome-trace', description: 'Slow' }],
      routing: 'offline',
      signal: controller.signal,
    });
    process.exit(3);
  } catch {
    // Expected abort; process must exit promptly without hanging on leaked listeners
  }
} else if (scenario === 'deadline-timeout') {
  try {
    await gatherEvidence({
      workspace,
      issue: 'Per-call timeout test',
      reports: [{ id: 'slow', path: 'slow.json', format: 'chrome-trace', description: 'Slow' }],
      routing: 'offline',
      mcpSessionOptions: { callTimeoutMs: 60 },
    });
    process.exit(4);
  } catch {
    // Expected per-call timeout; verify full investigate() also exits cleanly afterwards
  }
  const manifest = {
    version: 1,
    issue: 'Investigate normal completion after timeout',
    reports: [{ id: 'r1', path: 'trace-1.json', format: 'chrome-trace', description: 'R1' }],
    verification: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
  };
  const record = await investigate({
    workspace,
    manifest,
    routing: 'offline',
    agent: 'none',
  });
  if (record.status !== 'complete') process.exit(5);
}
`);

    const runtimes: Array<{ name: string; prefix: string[] }> = [
      { name: 'node22', prefix: [bins.node] },
      ...(bins.bun ? [{ name: 'bun', prefix: [bins.bun] }] : []),
      ...(bins.deno ? [{ name: 'deno', prefix: [bins.deno, 'run', '-A'] }] : []),
    ];

    const env = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      DENO_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    };

    for (const rt of runtimes) {
      for (const scenario of ['normal-reuse', 'caller-abort', 'deadline-timeout']) {
        const argv = [...rt.prefix, driverPath, scenario, root];
        const t0 = Date.now();
        await execFileAsync(argv[0]!, argv.slice(1), { env, timeout: 8000 });
        const elapsedMs = Date.now() - t0;
        assert.ok(elapsedMs < 5000, `${rt.name} (${scenario}) should exit promptly (<5000ms), took ${elapsedMs}ms`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configurable topN (1..10) preserves full digest units locally while bounding external router input to top-3, and includeCorroborating retains non-selected digests only on accepted routes', async () => {
  const root = await testDirectory('mcp-topn-corroborating');
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${await fixtureUv(root)}${delimiter}${priorPath}`;
    await writeFile(join(root, 'kineto-eager.json'), JSON.stringify({ totalUnits: 8 }));
    await writeFile(join(root, 'kineto-compiled.json'), JSON.stringify({ totalUnits: 6 }));

    assert.throws(() => openPerfDigestSession(root, undefined, { topN: 0 }), /between 1 and 10/);
    assert.throws(() => openPerfDigestSession(root, undefined, { topN: 11 }), /between 1 and 10/);

    const reports: ReportSpec[] = [
      { id: 'eager', path: 'kineto-eager.json', format: 'kineto-trace', description: 'Eager Kineto trace' },
      { id: 'compiled', path: 'kineto-compiled.json', format: 'kineto-trace', description: 'Compiled Kineto trace' },
    ];

    const { decisionsInput } = await import('../src/decisions.js');

    let routerSummaryUnits: number[] = [];
    const acceptProvider: DecisionProvider = {
      name: 'cloudflare',
      async select(issue, reps, _signal, measured) {
        const payload = JSON.parse(decisionsInput(issue, reps, measured));
        routerSummaryUnits = payload.reports.map((r: { evidence: { summary: { units: unknown[] } } }) => r.evidence.summary.units.length);
        return {
          selectedId: 'compiled',
          confidence: 0.89,
          reason: 'selected',
          source: 'clef_cloudflare',
          provider: 'cloudflare',
          model: 'clef-flash',
          confidenceSemantics: 'systemone_uniform_zero',
          transport: 'local_mock',
          requests: 1,
          latencyMs: 2,
          inputTokens: 30,
          outputTokens: 0,
          costUsd: null,
        };
      },
    };

    const accepted = await gatherEvidence({
      workspace: root,
      issue: 'Compare eager vs compiled Kineto traces',
      reports,
      routing: 'cloudflare',
      provider: acceptProvider,
      mcpSessionOptions: { topN: 6 },
      includeCorroborating: true,
    });

    assert.deepEqual(routerSummaryUnits, [3, 3], 'External decision router summary remains bounded to 3 units');
    assert.equal(accepted.status, 'complete');
    assert.equal(accepted.evidence.length, 1);
    assert.equal(accepted.evidence[0]!.report.id, 'compiled');
    assert.equal((accepted.evidence[0]!.digest.units as unknown[]).length, 6);
    assert.equal(accepted.corroborating?.length, 1);
    assert.equal(accepted.corroborating?.[0]?.report.id, 'eager');
    assert.equal((accepted.corroborating?.[0]?.digest.units as unknown[]).length, 6);

    const abstainProvider: DecisionProvider = {
      name: 'cloudflare',
      async select() {
        return {
          selectedId: null,
          confidence: 0.55,
          reason: 'low_confidence',
          source: 'clef_cloudflare',
          provider: 'cloudflare',
          model: 'clef-flash',
          confidenceSemantics: 'systemone_uniform_zero',
          transport: 'local_mock',
          requests: 1,
          latencyMs: 2,
          inputTokens: 30,
          outputTokens: 0,
          costUsd: null,
        };
      },
    };

    const abstained = await gatherEvidence({
      workspace: root,
      issue: 'Compare eager vs compiled Kineto traces',
      reports,
      routing: 'cloudflare',
      provider: abstainProvider,
      mcpSessionOptions: { topN: 6 },
      includeCorroborating: true,
    });
    assert.equal(abstained.status, 'needs_review');
    assert.deepEqual(abstained.evidence, []);
    assert.equal(abstained.corroborating, undefined, 'Abstention must never deliver corroborating digests');
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});
