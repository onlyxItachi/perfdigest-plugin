#!/usr/bin/env node
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir, cpus, hostname, arch, release } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { stats } from './lib/stats.mjs';
import { gatherEvidence } from '../dist/evidence.js';
import { digestReport, withPerfDigestSession } from '../dist/perfdigest.js';
import { executable } from '../dist/environment.js';

const summarize = (values, unit = 'ms') => stats(values, unit);

const execFileAsync = promisify(execFile);

function makeTrace(seed) {
  return JSON.stringify({
    traceEvents: [
      { ph: 'X', name: 'row_major', cat: 'cpu', ts: 0, dur: 120 + seed, pid: 1, tid: 1 },
      { ph: 'X', name: 'column_major', cat: 'cpu', ts: 200, dur: 450 + seed, pid: 1, tid: 1 },
    ],
  });
}

async function runTimedSubprocess(cmd, args, cwd, timeFile, runs = 8, warmup = 2) {
  const walls = [];
  const users = [];
  const syss = [];
  const rssKbs = [];
  for (let i = 0; i < warmup + runs; i++) {
    const t0 = performance.now();
    await execFileAsync('/usr/bin/time', ['-o', timeFile, '-v', cmd, ...args], { cwd, timeout: 60_000 });
    const wallMs = performance.now() - t0;
    if (i < warmup) continue;
    walls.push(wallMs);
    const timeOut = await readFile(timeFile, 'utf8');
    const uMatch = timeOut.match(/User time \(seconds\):\s*([0-9.]+)/);
    const sMatch = timeOut.match(/System time \(seconds\):\s*([0-9.]+)/);
    const rMatch = timeOut.match(/Maximum resident set size \(kbytes\):\s*([0-9]+)/);
    if (uMatch) users.push(Number(uMatch[1]) * 1000);
    if (sMatch) syss.push(Number(sMatch[1]) * 1000);
    if (rMatch) rssKbs.push(Number(rMatch[1]));
  }
  return {
    runs,
    warmup,
    wallMs: summarize(walls, 'ms'),
    userCpuMs: summarize(users, 'ms'),
    sysCpuMs: summarize(syss, 'ms'),
    peakRssKb: summarize(rssKbs, 'KB'),
  };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'perfdigest-mcp-reuse-bench-'));
  try {
    const reports8 = [];
    for (let i = 1; i <= 8; i++) {
      const file = `report-${i}.json`;
      await writeFile(join(root, file), makeTrace(i));
      reports8.push({ id: `r${i}`, path: file, format: 'chrome-trace', description: `Report ${i}` });
    }

    // 1. Cold vs warm single-call latency (v1.2.0 and v1.3.0)
    const coldSamples120 = [];
    const warmSamples120 = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      await digestReport(root, reports8[0], join(root, reports8[0].path));
      if (i >= 2) coldSamples120.push(performance.now() - t0);
    }
    await withPerfDigestSession(root, undefined, async session => {
      // Initial call connects the session
      await session.digest(reports8[0], join(root, reports8[0].path));
      for (let i = 0; i < 12; i++) {
        const r = reports8[i % 8];
        const t0 = performance.now();
        await session.digest(r, join(root, r.path));
        if (i >= 2) warmSamples120.push(performance.now() - t0);
      }
    }, { maxCalls: 16 });

    const uvxBin = executable('uvx');
    const coldSamples130 = [];
    const warmSamples130 = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      await withPerfDigestSession(root, undefined, s => s.digest(reports8[0], join(root, reports8[0].path)), {
        maxCalls: 1,
        command: uvxBin,
        args: ['--offline', '--from', 'perfdigest-mcp==1.3.0', 'perfdigest-mcp'],
      });
      if (i >= 2) coldSamples130.push(performance.now() - t0);
    }
    await withPerfDigestSession(root, undefined, async session => {
      await session.digest(reports8[0], join(root, reports8[0].path));
      for (let i = 0; i < 12; i++) {
        const r = reports8[i % 8];
        const t0 = performance.now();
        await session.digest(r, join(root, r.path));
        if (i >= 2) warmSamples130.push(performance.now() - t0);
      }
    }, {
      maxCalls: 16,
      command: uvxBin,
      args: ['--offline', '--from', 'perfdigest-mcp==1.3.0', 'perfdigest-mcp'],
    });

    // 2. Subprocess-level before/after measurements (1, 4, and 8 reports) for wall time, CPU, and process-tree peak RSS
    const repoRoot = resolve('.');
    await mkdir(join(repoRoot, 'work'), { recursive: true });
    const driverPath = join(repoRoot, 'work', 'mcp-reuse-driver.mjs');
    await writeFile(driverPath, `
import { gatherEvidence } from ${JSON.stringify(resolve('dist/evidence.js'))};
import { digestReport } from ${JSON.stringify(resolve('dist/perfdigest.js'))};
import { reportFile } from ${JSON.stringify(resolve('dist/files.js'))};

const [mode, countStr, workspace] = process.argv.slice(2);
const count = Number(countStr);
const reports = Array.from({ length: count }, (_, i) => ({
  id: 'r' + (i + 1),
  path: 'report-' + (i + 1) + '.json',
  format: 'chrome-trace',
  description: 'Report ' + (i + 1),
}));

const provider = {
  name: 'cloudflare',
  async select(_issue, _reports, _signal, measured) {
    return {
      selectedId: reports[count - 1].id,
      confidence: 0.9,
      reason: 'selected',
      source: 'clef_cloudflare',
      provider: 'cloudflare',
      model: '@cf/cloudflare/clef-flash',
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

if (mode === 'reuse') {
  const pkt = await gatherEvidence({ workspace, issue: 'bench', reports, routing: 'cloudflare', provider });
  if (pkt.status !== 'complete') process.exit(2);
} else if (mode === 'no-reuse') {
  // Pre-Stage-5 baseline: one fresh uvx perfdigest-mcp session per candidate report
  const measured = [];
  for (const r of reports) {
    const before = await reportFile(workspace, r.path);
    const digest = await digestReport(workspace, r, before.path);
    const after = await reportFile(workspace, r.path);
    if (before.sha256 !== after.sha256) process.exit(3);
    measured.push({ report: r, sha256: before.sha256, bytes: before.bytes, modifiedAt: before.modifiedAt, provenance: 'perfdigest_mcp', digest });
  }
  await provider.select('bench', reports, undefined, measured);
}
`);

    const timeFile = join(root, 'gnu-time.txt');
    const workflows = {};
    for (const count of [1, 4, 8]) {
      const before = await runTimedSubprocess(process.execPath, [driverPath, 'no-reuse', String(count), root], repoRoot, timeFile, 8, 2);
      const after = await runTimedSubprocess(process.execPath, [driverPath, 'reuse', String(count), root], repoRoot, timeFile, 8, 2);
      const speedupRatio = Number((before.wallMs.median / after.wallMs.median).toFixed(2));
      const savedMs = Number((before.wallMs.median - after.wallMs.median).toFixed(2));
      workflows[`reports_${count}_node22`] = {
        reportCount: count,
        runtime: 'node22',
        beforePerReportSpawn: before,
        afterSessionReuse: after,
        delta: { savedWallMs: savedMs, speedupRatio },
      };
    }

    // 3. Bun 1.4.3 and Deno 2.9.7 4-report session-reuse comparison (where available)
    const bunBin = '/home/hamza-usta/agy-dev/tools/bun-linux-x64/bun';
    const denoBin = '/home/hamza-usta/agy-dev/tools/deno-bin/deno';
    workflows.reports_4_bun = {
      reportCount: 4,
      runtime: 'bun-1.4.3',
      afterSessionReuse: await runTimedSubprocess(bunBin, [driverPath, 'reuse', '4', root], repoRoot, timeFile, 8, 2),
    };
    workflows.reports_4_deno_post_fix = {
      reportCount: 4,
      runtime: 'deno-2.9.7',
      note: 'Post-fix measurement after withScopedSignal + clearTimeout(deadlineTimer) resolved the 240s AbortSignal.timeout exit hang; not counted as a performance win over Node 22 reference.',
      afterSessionReuse: await runTimedSubprocess(denoBin, ['run', '-A', driverPath, 'reuse', '4', root], repoRoot, timeFile, 8, 2),
    };
    await rm(driverPath, { force: true });

    const output = {
      schemaVersion: 'perfdigest-stage5-mcp-reuse.v1',
      recordedAt: new Date().toISOString(),
      host: {
        hostId: 'amd-ryzen-ai-9-hx-370-x64',
        cpu: cpus()[0]?.model ?? 'unknown',
        cores: cpus().length,
        arch: arch(),
        kernel: release(),
        node: process.version,
      },
      singleCallLatencyMs: {
        perfdigestMcp120: {
          coldSpawn: summarize(coldSamples120),
          warmSessionReuse: summarize(warmSamples120),
          savedPerReusedCallMs: Number((summarize(coldSamples120).median - summarize(warmSamples120).median).toFixed(2)),
        },
        perfdigestMcp130: {
          coldSpawn: summarize(coldSamples130),
          warmSessionReuse: summarize(warmSamples130),
          savedPerReusedCallMs: Number((summarize(coldSamples130).median - summarize(warmSamples130).median).toFixed(2)),
        },
      },
      multiReportWorkflows: workflows,
    };

    await mkdir(resolve('bench/results'), { recursive: true });
    const outPath = resolve('bench/results/2026-10-18-mcp-session-reuse.json');
    await writeFile(outPath, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
