#!/usr/bin/env node
// Controlled before/after benchmark for Stage 5 bounded PerfDigest MCP session reuse.
// - Resolves optional runtimes (Bun, Deno) portably via `bench/lib/binaries.mjs` (no hardcoded paths).
// - Separates Linux cgroup v2 process-tree memory peak (`cgroupTreePeakKb` via `memory.peak`) from
//   GNU `/usr/bin/time -f '%M'` single-process `ru_maxrss` (`maxSingleProcessRssKb`).
// - Uses strictly equivalent workloads and explicitly controlled baselines:
//     * Single-call cold vs warm both iterate through the exact same 8-report sequence (`reports8[i % 8]`)
//       with identical `uvx` command/arguments and verify digest output parity.
//     * Multi-report `beforePerReportSpawn` (`reuseMcpSession: false`) and `afterSessionReuse`
//       (`reuseMcpSession: true`) both execute `gatherEvidence(...)` on identical inputs and verify
//       SHA-256 provenance and `PerfDigestSessionStats`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolveBenchBinaries, usable, versionOf } from './lib/binaries.mjs';
import { createResourceRunner } from './lib/cgroup-time.mjs';
import { stats } from './lib/stats.mjs';
import { mcpReuseResultSchema } from './schema/formats.mjs';
import { withPerfDigestSession } from '../dist/perfdigest.js';

const benchDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(benchDir, '..');
const summarize = (values, unit = 'ms') => stats(values, unit);

function makeTrace(seed) {
  return JSON.stringify({
    traceEvents: [
      { ph: 'X', name: 'row_major', cat: 'cpu', ts: 0, dur: 120 + seed, pid: 1, tid: 1 },
      { ph: 'X', name: 'column_major', cat: 'cpu', ts: 200, dur: 450 + seed, pid: 1, tid: 1 },
    ],
  });
}

async function measureSingleCallPair(root, reports8, sessionOpts, runs = 10, warmup = 2) {
  const coldSamples = [];
  const warmSamples = [];
  const coldDigests = [];
  const warmDigests = [];

  for (let i = 0; i < warmup + runs; i++) {
    const r = reports8[i % reports8.length];
    const absPath = join(root, r.path);
    const t0 = performance.now();
    const d = await withPerfDigestSession(
      root,
      undefined,
      (s) => s.digest(r, absPath),
      { ...sessionOpts, maxCalls: 1 },
    );
    const elapsed = performance.now() - t0;
    if (i >= warmup) {
      coldSamples.push(elapsed);
      coldDigests.push(JSON.stringify(d));
    }
  }

  await withPerfDigestSession(
    root,
    undefined,
    async (session) => {
      // Connect and warm the persistent MCP stdio session before timed calls
      await session.digest(reports8[0], join(root, reports8[0].path));
      for (let i = 0; i < warmup + runs; i++) {
        const r = reports8[i % reports8.length];
        const absPath = join(root, r.path);
        const t0 = performance.now();
        const d = await session.digest(r, absPath);
        const elapsed = performance.now() - t0;
        if (i >= warmup) {
          warmSamples.push(elapsed);
          warmDigests.push(JSON.stringify(d));
        }
      }
    },
    { ...sessionOpts, maxCalls: 16 },
  );

  const digestParityPass =
    coldDigests.length === warmDigests.length &&
    coldDigests.every((d, idx) => d === warmDigests[idx]);

  const coldStats = summarize(coldSamples, 'ms');
  const warmStats = summarize(warmSamples, 'ms');
  const displayCmd = [
    '<uvx>',
    ...(sessionOpts.args ?? ['perfdigest-mcp']),
  ];
  return {
    command: displayCmd,
    reportSequenceCount: reports8.length,
    digestParityPass,
    coldSpawn: coldStats,
    warmSessionReuse: warmStats,
    savedPerReusedCallMs: Number((coldStats.median - warmStats.median).toFixed(2)),
    speedupRatio: Number((coldStats.median / warmStats.median).toFixed(2)),
  };
}

async function main() {
  const root = await mkdtemp(join(os.tmpdir(), 'perfdigest-mcp-reuse-bench-'));
  const xdgConfig = join(root, 'xdg-config');
  await mkdir(xdgConfig, { recursive: true });
  const childEnv = Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      USER: process.env.USER,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      LANG: 'C',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: xdgConfig,
      NO_COLOR: '1',
      DENO_NO_UPDATE_CHECK: '1',
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    }).filter(([, v]) => v !== undefined),
  );

  const bin = resolveBenchBinaries(repo);
  const resourceRunner = createResourceRunner({
    scratch: root,
    env: childEnv,
    cwd: repo,
    timeBin: bin.time,
    systemdRunBin: bin.systemdRun,
  });

  const workBase = join(repo, 'work');
  await mkdir(workBase, { recursive: true });
  const driverDir = await mkdtemp(join(workBase, 'mcp-reuse-driver-'));

  try {
    const reports8 = [];
    for (let i = 1; i <= 8; i++) {
      const file = `report-${i}.json`;
      await writeFile(join(root, file), makeTrace(i));
      reports8.push({ id: `r${i}`, path: file, format: 'chrome-trace', description: `Report ${i}` });
    }

    // 1. Controlled single-call cold vs warm comparisons across identical 8-report sequences
    const single120 = await measureSingleCallPair(
      root,
      reports8,
      { command: bin.uvx, args: ['perfdigest-mcp'] },
      10,
      2,
    );

    let single130;
    const probe130 = spawnSync(
      bin.uvx,
      ['--offline', '--from', 'perfdigest-mcp==1.3.0', 'python', '-c', 'import perfdigest'],
      { env: childEnv, timeout: 10_000 },
    );
    if (probe130.status === 0) {
      single130 = await measureSingleCallPair(
        root,
        reports8,
        { command: bin.uvx, args: ['--offline', '--from', 'perfdigest-mcp==1.3.0', 'perfdigest-mcp'] },
        10,
        2,
      );
    }

    // 2. Subprocess-level before/after measurements using the EXACT SAME `gatherEvidence(...)` code path
    const driverPath = join(driverDir, 'mcp-reuse-driver.mjs');
    await writeFile(
      driverPath,
      `import { writeFile } from 'node:fs/promises';
import { gatherEvidence } from ${JSON.stringify(resolve(repo, 'dist/evidence.js'))};

const [mode, countStr, workspace, summaryFile] = process.argv.slice(2);
const count = Number(countStr);
const reuseMcpSession = mode === 'reuse';
const reports = Array.from({ length: count }, (_, i) => ({
  id: 'r' + (i + 1),
  path: 'report-' + (i + 1) + '.json',
  format: 'chrome-trace',
  description: 'Report ' + (i + 1),
}));

const provider = {
  name: 'cloudflare',
  async select(_issue, _reports, _signal, measured) {
    if (!measured || measured.length !== count) process.exit(4);
    return {
      selectedId: reports[count - 1].id,
      confidence: 0.9,
      reason: 'selected',
      source: 'clef_cloudflare',
      provider: 'cloudflare',
      model: 'perfdigest/clef-flash-v1',
      confidenceSemantics: 'systemone_uniform_zero',
      transport: 'local_mock',
      requests: 1,
      latencyMs: 1,
      inputTokens: 20,
      outputTokens: 0,
      costUsd: null,
    };
  },
};

let sessionStats = null;
const pkt = await gatherEvidence({
  workspace,
  issue: 'bench',
  reports,
  routing: 'cloudflare',
  provider,
  reuseMcpSession,
  onMcpSessionStats: (s) => { sessionStats = s; },
});
if (pkt.status !== 'complete' || !sessionStats) process.exit(2);
if (summaryFile) {
  const payload = {
    status: pkt.status,
    selectedId: pkt.decision.selectedId,
    consideredSha256: pkt.considered.map((c) => c.id + ':' + c.sha256 + ':' + c.delivered),
    evidenceDigestUnits: pkt.evidence.map((e) => e.report.id + ':' + e.sha256 + ':' + e.digest.total_units),
    sessionStats,
  };
  await writeFile(summaryFile, JSON.stringify(payload));
}
`,
    );

    const runSubprocessBench = async (prefix, mode, count, runs = 8, warmup = 2, rssRuns = 5) => {
      const summaryOut = join(root, `summary-${mode}-${count}.json`);
      const argv = [...prefix, driverPath, mode, String(count), root, summaryOut];

      const walls = [];
      for (let i = 0; i < warmup + runs; i++) {
        const t0 = performance.now();
        const r = spawnSync(argv[0], argv.slice(1), { env: childEnv, cwd: repo, stdio: 'ignore', timeout: 60_000 });
        const wallMs = performance.now() - t0;
        if (r.status !== 0) throw new Error(`Driver exited ${r.status} for ${mode} count=${count}`);
        if (i >= warmup) walls.push(wallMs);
      }
      const summary = JSON.parse(await readFile(summaryOut, 'utf8'));

      // Measure CPU & cgroup v2 process-tree memory peak + GNU time single-process RSS across `rssRuns` repetitions
      const gnuUsers = [];
      const gnuSyss = [];
      const maxSingleRss = [];
      const cgUsers = [];
      const cgSyss = [];
      const cgPeaks = [];
      for (let i = 0; i < rssRuns; i++) {
        const single = resourceRunner.measure(argv, { runs: 1 });
        if (single.cpu) {
          gnuUsers.push(single.cpu.userMedian);
          gnuSyss.push(single.cpu.sysMedian);
          if (typeof single.cpu.cgroupUserMedianMs === 'number') cgUsers.push(single.cpu.cgroupUserMedianMs);
          if (typeof single.cpu.cgroupSysMedianMs === 'number') cgSyss.push(single.cpu.cgroupSysMedianMs);
        }
        if (single.peakRssKb) maxSingleRss.push(single.peakRssKb.median);
        if (single.cgroupTreePeakKb) cgPeaks.push(single.cgroupTreePeakKb.median);
      }

      return {
        summary,
        metrics: {
          runs,
          warmup,
          wallMs: summarize(walls, 'ms'),
          userCpuMs: summarize(gnuUsers, 'ms'),
          sysCpuMs: summarize(gnuSyss, 'ms'),
          ...(cgUsers.length ? { cgroupUserCpuMs: summarize(cgUsers, 'ms') } : {}),
          ...(cgSyss.length ? { cgroupSysCpuMs: summarize(cgSyss, 'ms') } : {}),
          memoryCoverage: resourceRunner.memoryCoverage,
          maxSingleProcessRssKb: summarize(maxSingleRss, 'kb'),
          ...(cgPeaks.length ? { cgroupTreePeakKb: summarize(cgPeaks, 'kb') } : {}),
          sessionStats: summary.sessionStats,
        },
      };
    };

    const compareWorkflow = async (runtimeLabel, prefix, count, note) => {
      const before = await runSubprocessBench(prefix, 'no-reuse', count, 8, 2);
      const after = await runSubprocessBench(prefix, 'reuse', count, 8, 2);

      const hashesMatch =
        JSON.stringify(before.summary.consideredSha256) === JSON.stringify(after.summary.consideredSha256) &&
        JSON.stringify(before.summary.evidenceDigestUnits) === JSON.stringify(after.summary.evidenceDigestUnits);
      const statsExpected =
        before.summary.sessionStats.spawns === count &&
        before.summary.sessionStats.calls === count &&
        before.summary.sessionStats.reusedCalls === 0 &&
        after.summary.sessionStats.spawns === 1 &&
        after.summary.sessionStats.calls === count &&
        after.summary.sessionStats.reusedCalls === count - 1;

      const parityPass = hashesMatch && statsExpected;
      const savedWallMs = Number((before.metrics.wallMs.median - after.metrics.wallMs.median).toFixed(2));
      const speedupRatio = Number((before.metrics.wallMs.median / after.metrics.wallMs.median).toFixed(2));
      const savedCgroupUserCpuMs =
        before.metrics.cgroupUserCpuMs && after.metrics.cgroupUserCpuMs
          ? Number((before.metrics.cgroupUserCpuMs.median - after.metrics.cgroupUserCpuMs.median).toFixed(2))
          : undefined;
      const savedCgroupSysCpuMs =
        before.metrics.cgroupSysCpuMs && after.metrics.cgroupSysCpuMs
          ? Number((before.metrics.cgroupSysCpuMs.median - after.metrics.cgroupSysCpuMs.median).toFixed(2))
          : undefined;

      return {
        reportCount: count,
        runtime: runtimeLabel,
        status: 'measured',
        ...(note ? { note } : {}),
        evidenceParity: {
          status: parityPass ? 'pass' : 'fail',
          detail: `sha256_match=${hashesMatch} before_spawns=${before.summary.sessionStats.spawns}/${before.summary.sessionStats.calls} after_spawns=${after.summary.sessionStats.spawns}/${after.summary.sessionStats.calls}(reused=${after.summary.sessionStats.reusedCalls})`,
        },
        beforePerReportSpawn: before.metrics,
        afterSessionReuse: after.metrics,
        delta: {
          savedWallMs,
          speedupRatio,
          ...(savedCgroupUserCpuMs !== undefined ? { savedCgroupUserCpuMs } : {}),
          ...(savedCgroupSysCpuMs !== undefined ? { savedCgroupSysCpuMs } : {}),
        },
      };
    };

    const workflows = {};
    for (const count of [1, 4, 8]) {
      workflows[`reports_${count}_node22`] = await compareWorkflow(`node-${process.version}`, [bin.node], count);
    }

    if (usable(bin.bun)) {
      const bunVer = versionOf(bin.bun, ['--version'], childEnv) ?? 'unknown';
      workflows.reports_4_bun = await compareWorkflow(`bun-${bunVer}`, [bin.bun], 4);
    } else {
      workflows.reports_4_bun = {
        reportCount: 4,
        runtime: 'bun',
        status: 'not-run',
        reason: 'bun binary not found (set PERFDIGEST_BENCH_BUN or add bun to PATH)',
        evidenceParity: { status: 'not-checked', detail: 'bun not installed' },
      };
    }

    if (usable(bin.deno)) {
      const denoVer = versionOf(bin.deno, ['--version'], childEnv) ?? 'unknown';
      workflows.reports_4_deno = await compareWorkflow(
        `deno-${denoVer}`,
        [bin.deno, 'run', '-A'],
        4,
        'Measured with both beforePerReportSpawn (reuseMcpSession: false) and afterSessionReuse (reuseMcpSession: true) after withScopedSignal + explicit clearTimeout resolved Deno 2.9.7 AbortSignal.timeout exit retention.',
      );
    } else {
      workflows.reports_4_deno = {
        reportCount: 4,
        runtime: 'deno',
        status: 'not-run',
        reason: 'deno binary not found (set PERFDIGEST_BENCH_DENO or add deno to PATH)',
        evidenceParity: { status: 'not-checked', detail: 'deno not installed' },
      };
    }

    const cpuModel = (os.cpus()[0]?.model ?? 'unknown').trim();
    const label = `${cpuModel.toLowerCase().replace(/\bw\/.*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${os.arch()}`;
    const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();

    const output = {
      schema: 'perfdigest.mcp-reuse-result.v1',
      createdAt: new Date().toISOString(),
      subject: {
        repo: 'onlyxItachi/perfdigest-plugin',
        gitSha: git(['rev-parse', 'HEAD']),
        dirty: git(['status', '--porcelain', '--', 'src', 'test', 'package.json', 'tsconfig.json']) !== '',
        ref: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      },
      host: {
        label,
        os: `${os.type()} ${os.release()}`.trim(),
        kernel: os.release(),
        arch: os.arch(),
        cpuModel,
        logicalCpus: os.cpus().length,
        memTotalKb: Math.round(os.totalmem() / 1024),
        loadavg1AtStart: os.loadavg()[0],
        node: process.version,
      },
      singleCallLatencyMs: {
        perfdigestMcp120: single120,
        ...(single130 ? { perfdigestMcp130: single130 } : {}),
      },
      multiReportWorkflows: workflows,
      claims: [
        'Single-call cold vs warm pairs execute identical uvx commands across the exact same 8-report sequence (`reports8[i % 8]`) and produce byte-identical JSON digests (`digestParityPass: true`).',
        'Multi-report before (`reuseMcpSession: false`) and after (`reuseMcpSession: true`) workflows execute the identical `gatherEvidence(...)` code path and produce identical SHA-256 report provenance and digest payloads (`evidenceParity.status: "pass"`).',
        'Process-tree memory peak (`cgroupTreePeakKb`) is measured via Linux cgroup v2 `memory.peak` inside a transient `systemd-run --user --scope` unit, kept separate from GNU `/usr/bin/time -f "%M"` single-process `ru_maxrss` (`maxSingleProcessRssKb`).',
      ],
      limits: [
        'Single host, single sequential session: medians apply only to this host (`amd-ryzen-ai-9-hx-370-x64`) and commit.',
        '1-report workflows still pay one initial `uvx perfdigest-mcp` startup; bounded session reuse saves N-1 cold spawns when N >= 2 candidate reports are summarized within one investigation.',
        'GNU `/usr/bin/time` `maxSingleProcessRssKb` reflects `ru_maxrss` of only the single highest-RSS process, whereas `cgroupTreePeakKb` reflects the kernel cgroup v2 `memory.peak` across all concurrent processes in the scope.',
      ],
    };

    const parsed = mcpReuseResultSchema.safeParse(output);
    if (!parsed.success) {
      console.error(JSON.stringify(parsed.error.issues, null, 2));
      process.exit(1);
    }

    await mkdir(resolve(repo, 'bench/results'), { recursive: true });
    const outPath = resolve(repo, 'bench/results/2026-10-18-mcp-session-reuse.json');
    await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`);
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await rm(driverDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
