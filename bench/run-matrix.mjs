#!/usr/bin/env node
// PerfDigest Evidence — runtime & build benchmark harness (Stage 3 foundations).
//
//   node bench/run-matrix.mjs [--smoke] [--manifest FILE] [--out FILE] [--host-label LABEL] [--only id,id]
//
// Requirements: a built dist/ (npm run build), hyperfine, GNU /usr/bin/time.
// Optional backends are resolved from env vars or PATH and recorded as `not-run`
// when missing: PERFDIGEST_BENCH_BUN, PERFDIGEST_BENCH_DENO, PERFDIGEST_BENCH_TSGO,
// PERFDIGEST_BENCH_GO, PERFDIGEST_BENCH_UVX.
//
// Credential policy: every child gets a minimal allowlisted environment, a throwaway
// XDG_CONFIG_HOME, and runs offline routing with --agent none. No model/API calls.
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { manifestSchema, resultSchema } from './schema/formats.mjs';
import { stats } from './lib/stats.mjs';

const exec = promisify(execFile);
const benchDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(benchDir, '..');
const { values: opts } = parseArgs({ options: {
  smoke: { type: 'boolean', default: false }, manifest: { type: 'string' }, out: { type: 'string' },
  'host-label': { type: 'string' }, only: { type: 'string' },
} });

// ---------------------------------------------------------------- environment
const scratch = await mkdtemp(join(os.tmpdir(), 'pd-bench-'));
const xdgConfig = join(scratch, 'xdg-config'); await mkdir(xdgConfig);
const childEnv = Object.fromEntries(Object.entries({
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, USER: process.env.USER,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, LANG: 'C', LC_ALL: 'C', XDG_CONFIG_HOME: xdgConfig,
  NO_COLOR: '1', DENO_NO_UPDATE_CHECK: '1',
}).filter(([, v]) => v !== undefined));

function which(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, name);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}
function usable(p) { try { if (p) accessSync(p, constants.X_OK); return Boolean(p); } catch { return false; } }
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const version = (cmd, args, re = /(\d+\.\d+\.\d+[^\s]*)/) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: childEnv });
  const m = `${r.stdout}${r.stderr}`.match(re); return m ? m[1] : null;
};

const localTsgo = join(benchDir, 'node_modules/@typescript/native-preview-linux-x64/lib/tsgo');
const bin = {
  node: process.execPath,
  bun: process.env.PERFDIGEST_BENCH_BUN ?? which('bun'),
  deno: process.env.PERFDIGEST_BENCH_DENO ?? which('deno'),
  tsgo: process.env.PERFDIGEST_BENCH_TSGO ?? (existsSync(localTsgo) ? localTsgo : which('tsgo')),
  go: process.env.PERFDIGEST_BENCH_GO ?? which('go'),
  uvx: process.env.PERFDIGEST_BENCH_UVX ?? which('uvx'),
  hyperfine: which('hyperfine'),
  time: usable('/usr/bin/time') ? '/usr/bin/time' : null,
};
const tsc = join(repo, 'node_modules/typescript/bin/tsc');
const cli = join(repo, 'dist/cli.js');
if (!existsSync(cli)) throw new Error('dist/cli.js missing: run `npm run build` first');
// hyperfine and GNU time are expected for real runs; without them (e.g. the CI smoke)
// the harness falls back to an in-process spawnSync timer and omits CPU/RSS.
if (!opts.smoke && (!bin.hyperfine || !bin.time)) throw new Error('full runs require hyperfine and GNU /usr/bin/time');

const tools = [
  { name: 'node', version: process.version, source: 'system' },
  { name: 'typescript', version: JSON.parse(readFileSync(join(repo, 'node_modules/typescript/package.json'), 'utf8')).version, source: 'repo devDependency' },
  ...(bin.hyperfine ? [{ name: 'hyperfine', version: version(bin.hyperfine, ['--version']), source: 'system' }] : []),
  ...(bin.time ? [{ name: 'gnu-time', version: version(bin.time, ['--version'], /(\d+\.\d+)/), source: '/usr/bin/time' }] : []),
];
const downloaded = (p) => (p && !p.startsWith('/usr/') ? { sha256: sha256File(p) } : {});
if (usable(bin.bun)) tools.push({ name: 'bun', version: version(bin.bun, ['--version']), ...downloaded(bin.bun), source: 'official release binary' });
if (usable(bin.deno)) tools.push({ name: 'deno', version: version(bin.deno, ['--version']), ...downloaded(bin.deno), source: 'official release binary' });
if (usable(bin.tsgo)) tools.push({ name: 'tsgo', version: version(bin.tsgo, ['--version']), sha256: sha256File(bin.tsgo), source: '@typescript/native-preview (bench devDependency only)' });
if (usable(bin.go)) tools.push({ name: 'go', version: version(bin.go, ['version'], /go(\d+\.\d+(?:\.\d+)?)/), source: 'system' });
if (usable(bin.uvx)) {
  tools.push({ name: 'uv', version: version(bin.uvx, ['--version']), source: 'system' });
  const list = spawnSync('uv', ['tool', 'list'], { encoding: 'utf8', env: childEnv }).stdout ?? '';
  const m = list.match(/perfdigest-mcp v(\S+)/); tools.push({ name: 'perfdigest-mcp', version: m ? m[1] : null, source: 'uv tool' });
}

// Replace host-specific paths in recorded argv.
const placeholders = [[cli, '<repo>/dist/cli.js'], [benchDir, '<repo>/bench'], [repo, '<repo>'], [scratch, '<scratch>'],
  ...['bun', 'deno', 'tsgo', 'go', 'uvx'].filter((k) => bin[k]).map((k) => [bin[k], `<${k}>`]), [process.execPath, '<node>']];
const display = (argv) => argv.map((a) => placeholders.reduce((s, [from, to]) => s.split(from).join(to), a));

// ---------------------------------------------------------------- measurement primitives
const shellQuote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`);

/** hyperfine -N (no shell) for wall time; returns seconds->ms samples. */
async function hyperfine(argv, { runs, warmup, prepare }) {
  if (!bin.hyperfine) {
    const samples = [];
    for (let i = 0; i < warmup + runs; i++) {
      if (prepare) spawnSync(prepare[0], prepare.slice(1), { env: childEnv });
      const t = performance.now();
      const r = spawnSync(argv[0], argv.slice(1), { env: childEnv, cwd: repo, stdio: 'ignore' });
      if (r.status !== 0) throw new Error(`${display(argv).join(' ')} exited ${r.status}`);
      if (i >= warmup) samples.push(performance.now() - t);
    }
    return samples;
  }
  const out = join(scratch, `hf-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const args = ['-N', '--style', 'none', '--runs', String(runs), '--warmup', String(warmup), '--export-json', out];
  if (prepare) args.push('--prepare', prepare.map(shellQuote).join(' '));
  args.push(argv.map(shellQuote).join(' '));
  await exec(bin.hyperfine, args, { env: childEnv, cwd: repo, maxBuffer: 1 << 24 });
  const r = JSON.parse(await readFile(out, 'utf8')).results[0];
  return r.times.map((t) => t * 1000);
}

/** GNU time for user/sys CPU and peak RSS of the whole process tree's largest member. */
async function gnuTime(argv, { runs, prepare }) {
  if (!bin.time) return {};
  const user = [], sys = [], rss = [];
  for (let i = 0; i < runs; i++) {
    if (prepare) spawnSync(prepare[0], prepare.slice(1), { env: childEnv });
    const out = join(scratch, `time-${i}.txt`);
    const r = spawnSync(bin.time, ['-f', '%U %S %M', '-o', out, ...argv], { env: childEnv, cwd: repo, stdio: 'ignore' });
    if (r.status !== 0) throw new Error(`${display(argv).join(' ')} exited ${r.status}`);
    const [u, s, m] = (await readFile(out, 'utf8')).trim().split('\n').pop().split(/\s+/).map(Number);
    user.push(u * 1000); sys.push(s * 1000); rss.push(m);
  }
  const med = (xs) => stats(xs, 'ms').median;
  return { cpu: { unit: 'ms', n: runs, userMedian: med(user), sysMedian: med(sys) }, peakRssKb: stats(rss, 'kb') };
}

const runtimePrefix = (backend) => ({ node22: [bin.node], bun: [bin.bun], deno: [bin.deno, 'run', '-A'] }[backend]);
const runtimeAvailable = (backend) => (backend === 'node22' ? true : usable(bin[backend]));

// ---------------------------------------------------------------- parity checks
async function demoParity(prefix, cliPath = cli) {
  const ws = await mkdtemp(join(scratch, 'parity-'));
  const checks = [];
  let run;
  try {
    const r = await exec(prefix[0], [...prefix.slice(1), cliPath, 'demo', '--provider', 'offline', '--agent', 'none', '--workspace', ws],
      { env: childEnv, cwd: repo, timeout: 15_000 });
    checks.push({ name: 'demo-exit-0', pass: true, detail: 'exited 0 within 15000ms' });
    run = JSON.parse(r.stdout);
  } catch (error) {
    const timedOut = Boolean(error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT');
    const detail = timedOut
      ? 'process did not exit within 15000ms after writing stdout/run.json (killed by timeout)'
      : String(error.stderr ?? error.message).slice(-400);
    checks.push({ name: 'demo-exit-0', pass: false, detail });
    try { run = JSON.parse(String(error.stdout ?? '')); } catch { run = null; }
    if (!run?.directory) {
      await rm(ws, { recursive: true, force: true });
      return { status: 'fail', checks };
    }
  }
  checks.push({ name: 'status=complete', pass: run.status === 'complete', detail: String(run.status) });
  checks.push({ name: 'verifier-exit-0', pass: run.verification === 0, detail: String(run.verification) });
  const record = JSON.parse(await readFile(join(run.directory, 'run.json'), 'utf8'));
  const evidence = record.evidence?.evidence ?? [];
  checks.push({ name: 'evidence-count=1', pass: evidence.length === 1, detail: String(evidence.length) });
  for (const e of evidence) {
    const bytes = await readFile(resolve(ws, e.report.path));
    const actual = createHash('sha256').update(bytes).digest('hex');
    checks.push({ name: `report-sha256:${e.report.id}`, pass: actual === e.sha256 && bytes.length === e.bytes,
      detail: `recorded=${e.sha256.slice(0, 12)} recomputed=${actual.slice(0, 12)} bytes=${bytes.length}` });
    const units = (e.digest?.units ?? []).map((u) => u.name).sort().join(',');
    checks.push({ name: 'digest-units=column_major,row_major', pass: units === 'column_major,row_major', detail: units });
  }
  await rm(ws, { recursive: true, force: true });
  return { status: checks.every((c) => c.pass) ? 'pass' : 'fail', checks };
}

const EXPECTED_TOOLS = ['cancel_evidence_job', 'get_evidence_job', 'launch_evidence_prefetch'];
function mcpParity(tools) {
  const pass = JSON.stringify(tools) === JSON.stringify(EXPECTED_TOOLS);
  return { name: 'mcp-tools=3-expected', pass, detail: tools.join(',') };
}

async function mcpProbe(serverArgv, iterations, rssRuns, ws) {
  const r = await exec(bin.node, [join(benchDir, 'probes/mcp-probe.mjs'), JSON.stringify(serverArgv), String(iterations), ws, String(rssRuns)],
    { env: { ...childEnv, PERFDIGEST_BENCH_CHILD_ENV: JSON.stringify(childEnv) }, cwd: repo, timeout: 600_000, maxBuffer: 1 << 24 });
  return JSON.parse(r.stdout);
}

// ---------------------------------------------------------------- build parity tree
async function buildTree(kind) {
  const tree = await mkdtemp(join(scratch, `tree-${kind}-`));
  for (const entry of ['package.json', 'tsconfig.json', 'tsconfig.test.json', 'src', 'test', 'examples', 'scripts']) {
    await cp(join(repo, entry), join(tree, entry), { recursive: true });
  }
  await symlink(join(repo, 'node_modules'), join(tree, 'node_modules'));
  return tree;
}
const compilerArgv = (backend, project, outDir) => (backend === 'tsc-6.0.3'
  ? [bin.node, tsc, '-p', project, ...(outDir ? ['--outDir', outDir] : [])]
  : [bin.tsgo, '-p', project, ...(outDir ? ['--outDir', outDir] : [])]);

async function buildParity(backend) {
  const tree = await buildTree(backend === 'tsc-6.0.3' ? 'tsc' : 'tsgo');
  const checks = [];
  const step = async (name, argv) => {
    try { await exec(argv[0], argv.slice(1), { cwd: tree, env: childEnv, timeout: 300_000, maxBuffer: 1 << 24 }); checks.push({ name, pass: true }); return true; }
    catch (e) { checks.push({ name, pass: false, detail: String(e.stdout ?? '').concat(e.stderr ?? '').slice(-400) }); return false; }
  };
  if (await step('emit-dist', compilerArgv(backend, join(tree, 'tsconfig.json')))
      && await step('emit-test-build', compilerArgv(backend, join(tree, 'tsconfig.test.json')))) {
    const tests = (await readdir(join(tree, '.test-build/test'))).filter((f) => f.endsWith('.test.js')).map((f) => join(tree, '.test-build/test', f));
    await step('npm-test-equivalent (node --test .test-build/test/*.test.js)', [bin.node, '--test', ...tests]);
    const demo = await demoParity([bin.node], join(tree, 'dist/cli.js'));
    checks.push(...demo.checks.map((c) => ({ ...c, name: `dist-under-node:${c.name}` })));
    const ws = await mkdtemp(join(scratch, 'mcp-'));
    const probe = await mcpProbe([bin.node, join(tree, 'dist/cli.js'), 'mcp', '--workspace', ws], 1, 0, ws);
    checks.push({ ...mcpParity(probe.tools), name: 'dist-under-node:mcp-tools=3-expected' });
    // Informational: how many emitted .js files are byte-identical to the repo's tsc dist.
    const files = (await readdir(join(tree, 'dist'))).filter((f) => f.endsWith('.js'));
    const same = files.filter((f) => existsSync(join(repo, 'dist', f)) && sha256File(join(tree, 'dist', f)) === sha256File(join(repo, 'dist', f))).length;
    checks.push({ name: 'info:js-byte-identical-to-repo-dist', pass: true, detail: `${same}/${files.length}` });
  }
  const gate = checks.filter((c) => !c.name.startsWith('info:'));
  return { status: gate.every((c) => c.pass) ? 'pass' : 'fail', checks };
}

// ---------------------------------------------------------------- worker fixture
async function workerFixture(iterations) {
  const dir = await mkdtemp(join(scratch, 'worker-'));
  const big = join(dir, 'synthetic-16MiB.bin');
  const block = createHash('sha512').update('perfdigest-bench').digest();
  await writeFile(big, Buffer.concat(Array.from({ length: (16 << 20) / block.length }, () => block)));
  const trace = join(repo, 'examples');
  const reports = [big, ...(await readdir(trace)).filter((f) => f.endsWith('.mjs')).map((f) => join(trace, f))];
  const manifest = join(dir, 'worker-manifest.json');
  await writeFile(manifest, JSON.stringify({ version: 1, envAllowlist: ['PATH', 'LANG'],
    commands: Array.from({ length: iterations }, () => ({ command: '/bin/true', args: [] })), reports }));
  return { dir, manifest };
}

// ---------------------------------------------------------------- cells
const manifestPath = resolve(opts.manifest ?? join(benchDir, 'manifests/default.json'));
const manifestText = await readFile(manifestPath, 'utf8');
const manifest = manifestSchema.parse(JSON.parse(manifestText));
const d = opts.smoke ? manifest.smokeDefaults : manifest.defaults;
const only = opts.only ? new Set(opts.only.split(',')) : null;
const selected = manifest.cells.filter((c) => (only ? only.has(c.id) : (!opts.smoke || c.smoke)));
const cells = [];
let goWorkerBin = null; let worker = null;
const receipts = {};

for (const c of selected) {
  const runs = opts.smoke ? d.runs : (c.runs ?? d.runs);
  const warmup = opts.smoke ? d.warmup : (c.warmup ?? d.warmup);
  const base = { id: c.id, group: c.group, backend: c.backend, scenario: c.scenario, baseline: c.baseline };
  const notRun = (reason, command = []) => cells.push({ ...base, status: 'not-run', reason, command, parity: { status: 'not-checked', checks: [] } });
  process.stderr.write(`[bench] ${c.id} ...\n`);
  try {
    if (c.group === 'build') {
      if (c.backend === 'tsgo-7-preview' && !usable(bin.tsgo)) { notRun('tsgo not installed (run `npm ci` in bench/ or set PERFDIGEST_BENCH_TSGO)'); continue; }
      const outDir = join(scratch, `out-${c.backend}`);
      const argv = compilerArgv(c.backend, join(repo, 'tsconfig.json'), outDir);
      const prepare = ['rm', '-rf', outDir];
      const samples = await hyperfine(argv, { runs, warmup, prepare });
      const resources = await gnuTime(argv, { runs: d.rssRuns, prepare });
      const parity = await buildParity(c.backend);
      cells.push({ ...base, status: 'measured', command: display(argv), warmup,
        method: 'hyperfine -N; --prepare removes outDir (no incremental state; OS page cache warm); full type-check + emit of tsconfig.json',
        wall: stats(samples, 'ms'), ...resources, parity, extra: { samplesMs: samples } });
    } else if (c.group === 'runtime' && c.backend === 'uvx') {
      if (!usable(bin.uvx)) { notRun('uvx not on PATH'); continue; }
      const ws = await mkdtemp(join(scratch, 'uvx-'));
      const argv = [bin.uvx, 'perfdigest-mcp'];
      const probe = await mcpProbe(argv, runs, bin.time ? d.rssRuns : 0, ws);
      cells.push({ ...base, status: 'measured', command: display(argv), method: 'constant Node MCP client: spawn uvx perfdigest-mcp -> initialize -> tools/list -> close, per iteration (the plugin does this once per digested report)',
        wall: stats(probe.samplesMs, 'ms'), ...(probe.rssKb.length ? { peakRssKb: stats(probe.rssKb, 'kb') } : {}),
        parity: { status: 'not-applicable', checks: [{ name: 'info:perfdigest-mcp-tools', pass: probe.tools.includes('summarize_report'), detail: probe.tools.join(',') }] },
        extra: { samplesMs: probe.samplesMs, note: 'Upstream PerfDigest MCP server (independently maintained); measured only to size per-digest session cost.' } });
    } else if (c.group === 'runtime') {
      if (!runtimeAvailable(c.backend)) { notRun(`${c.backend} binary not found (set PERFDIGEST_BENCH_${c.backend.toUpperCase()})`); continue; }
      const prefix = runtimePrefix(c.backend);
      if (c.scenario === 'cli-help') {
        const argv = [...prefix, cli, '--help'];
        const samples = await hyperfine(argv, { runs, warmup });
        const help = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: childEnv });
        const parity = { status: /Codex-first MVP/.test(help.stdout) ? 'pass' : 'fail', checks: [{ name: 'help-banner', pass: /Codex-first MVP/.test(help.stdout) }] };
        cells.push({ ...base, status: 'measured', command: display(argv), warmup, method: 'hyperfine -N', wall: stats(samples, 'ms'),
          ...(await gnuTime(argv, { runs: d.rssRuns })), parity, extra: { samplesMs: samples } });
      } else if (c.scenario === 'offline-demo') {
        const ws = await mkdtemp(join(scratch, `demo-${c.backend}-`));
        const argv = [...prefix, cli, 'demo', '--provider', 'offline', '--agent', 'none', '--workspace', ws];
        const cmdDisplay = display(argv.map((a) => a.replace(ws, '<workspace>')));
        const parity = await demoParity(prefix);
        if (parity.status !== 'pass') {
          const failed = parity.checks.filter((x) => !x.pass).map((x) => `${x.name}: ${x.detail ?? 'fail'}`).join('; ');
          cells.push({ ...base, status: 'not-run', reason: `contract parity failed (${failed})`, command: cmdDisplay, parity });
          continue;
        }
        const prepare = ['rm', '-rf', join(ws, '.perfdigest')];
        const samples = await hyperfine(argv, { runs, warmup, prepare });
        cells.push({ ...base, status: 'measured', command: cmdDisplay, warmup,
          method: 'hyperfine -N; fresh .perfdigest per run; end-to-end incl. capture child, uvx perfdigest-mcp digest session and verifier child (both run under the same runtime via process.execPath)',
          wall: stats(samples, 'ms'), ...(await gnuTime(argv, { runs: d.rssRuns, prepare })), parity, extra: { samplesMs: samples } });
      } else if (c.scenario === 'mcp-tools-list') {
        const ws = await mkdtemp(join(scratch, `mcp-${c.backend}-`));
        const argv = [...prefix, cli, 'mcp', '--workspace', ws];
        for (let i = 0; i < warmup; i++) await mcpProbe(argv, 1, 0, ws);
        const probe = await mcpProbe(argv, runs, bin.time ? d.rssRuns : 0, ws);
        const check = mcpParity(probe.tools);
        cells.push({ ...base, status: 'measured', command: display(argv.map((a) => a.replace(ws, '<workspace>'))), warmup,
          method: 'constant Node MCP client (SDK StdioClientTransport): spawn server -> initialize -> tools/list -> close, timed per iteration; RSS from separate GNU-time-wrapped iterations',
          wall: stats(probe.samplesMs, 'ms'), ...(probe.rssKb.length ? { peakRssKb: stats(probe.rssKb, 'kb') } : {}),
          parity: { status: check.pass ? 'pass' : 'fail', checks: [check] }, extra: { samplesMs: probe.samplesMs } });
      } else if (c.scenario === 'spawn-overhead') {
        const iterations = d.spawnIterations;
        const argv = [...prefix, join(benchDir, 'probes/spawn-loop.mjs'), String(iterations)];
        for (let i = 0; i < warmup; i++) spawnSync(argv[0], argv.slice(1), { env: childEnv });
        const r = await exec(argv[0], argv.slice(1), { env: childEnv, cwd: repo, maxBuffer: 1 << 24 });
        const samples = JSON.parse(r.stdout).samplesMs.slice(1); // drop the first (cold) spawn
        cells.push({ ...base, status: 'measured', command: display(argv), warmup,
          method: `per-spawn latency of node:child_process.spawn('/bin/true') measured in-process, ${iterations} sequential spawns, first dropped; CPU/RSS are for the whole loop process`,
          wall: stats(samples, 'ms'), ...(await gnuTime(argv, { runs: d.rssRuns })),
          parity: { status: 'not-applicable', checks: [] }, extra: { iterations } });
      }
    } else if (c.group === 'worker') {
      worker ??= await workerFixture(d.spawnIterations);
      let argv;
      if (c.backend === 'go-worker-prototype') {
        if (!usable(bin.go)) { notRun('go toolchain not found'); continue; }
        if (!goWorkerBin) {
          goWorkerBin = join(scratch, 'perfdigest-worker');
          await exec(bin.go, ['build', '-trimpath', '-o', goWorkerBin, '.'], { cwd: join(benchDir, 'go-worker'), env: { ...childEnv, GOFLAGS: '-mod=mod', GOCACHE: process.env.GOCACHE ?? join(os.homedir(), '.cache/go-build'), GOPATH: process.env.GOPATH ?? join(os.homedir(), 'go') } });
        }
        argv = [goWorkerBin, worker.manifest];
      } else {
        argv = [bin.node, join(benchDir, 'go-worker/node-worker.mjs'), worker.manifest];
      }
      const r = await exec(argv[0], argv.slice(1), { env: childEnv, maxBuffer: 1 << 24 });
      receipts[c.backend] = JSON.parse(r.stdout);
      const samples = await hyperfine(argv, { runs, warmup });
      cells.push({ ...base, status: 'measured', command: display(argv.map((a) => a.replace(worker.manifest, '<worker-manifest>'))), warmup,
        method: `hyperfine -N; one process runs ${d.spawnIterations} x /bin/true without a shell (allowlisted env) and SHA-256 hashes a 16 MiB file + example scripts, printing a JSON receipt`,
        wall: stats(samples, 'ms'), ...(await gnuTime(argv, { runs: d.rssRuns })), parity: { status: 'not-checked', checks: [] },
        extra: { samplesMs: samples, prototype: true } });
    }
  } catch (error) {
    cells.push({ ...base, status: 'failed', reason: String(error?.stderr || error?.message || error).slice(-600), command: [], parity: { status: 'fail', checks: [] } });
  }
}

if (!bin.hyperfine) for (const c of cells) if (c.method) c.method = `[fallback in-process timer: hyperfine absent] ${c.method}`;

// Worker receipt parity: identical hashes/bytes/exit codes (timings excluded).
if (receipts['node-worker'] && receipts['go-worker-prototype']) {
  const key = (r) => JSON.stringify({ c: r.commands.map((x) => [x.argv, x.exitCode]), r: r.reports.map((x) => [x.path, x.sha256, x.bytes]) });
  const pass = key(receipts['node-worker']) === key(receipts['go-worker-prototype']);
  for (const cell of cells.filter((x) => x.group === 'worker' && x.status === 'measured')) {
    cell.parity = { status: pass ? 'pass' : 'fail', checks: [{ name: 'receipt-identical (argv, exit codes, sha256, bytes)', pass }] };
  }
}

// ---------------------------------------------------------------- result document
const cpuModel = (os.cpus()[0]?.model ?? 'unknown').trim();
const label = opts['host-label'] ?? `${cpuModel.toLowerCase().replace(/\bw\/.*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${os.arch()}`;
const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();
const now = new Date();
const measured = cells.filter((c) => c.status === 'measured');
const result = {
  schema: 'perfdigest.benchmark-result.v1',
  createdAt: now.toISOString(),
  manifest: { id: manifest.id, path: relative(repo, manifestPath), sha256: createHash('sha256').update(manifestText).digest('hex') },
  subject: { repo: 'onlyxItachi/perfdigest-plugin', gitSha: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--', 'src', 'test', 'package.json', 'tsconfig.json']) !== '', ref: git(['rev-parse', '--abbrev-ref', 'HEAD']) },
  host: { label, os: `${os.type()} ${os.release()}`.trim(), kernel: os.release(), arch: os.arch(), cpuModel, logicalCpus: os.cpus().length,
    memTotalKb: Math.round(os.totalmem() / 1024), loadavg1AtStart: os.loadavg()[0] },
  tools, mode: opts.smoke ? 'smoke' : 'full', cells,
  claims: [
    `Medians below were measured on ONE host (${label}) in one sequential session; they rank backends only for this host and this commit.`,
    'A non-baseline backend is reported as "accepted for further study" only when its parity status is pass; no superiority claim is made for any cell whose parity is not pass.',
  ],
  limits: [
    'Single host, single session: results do not generalize to other CPUs, kernels, filesystems or CI runners.',
    'No CPU frequency pinning, core isolation or turbo control; background load was not controlled beyond sequential execution (loadavg recorded).',
    'Build "cold" means no incremental/tsbuildinfo state; the OS page cache and node_modules are warm.',
    'offline-demo latency is dominated by the uvx perfdigest-mcp child (a Python process), which is identical across runtimes; runtime differences are a small fraction of it.',
    'Bun/Deno execute the tsc-emitted ESM through their Node-compat layers; incompatibilities outside these four scenarios (Codex SDK, Decisions HTTP, init) were not exercised.',
    'The Go worker is a prototype that only mirrors exec + hash + receipt; it is not a functional replacement for the TypeScript runner.',
    ...(opts.smoke ? ['SMOKE mode: tiny N, numbers are for plumbing validation only and must not be compared.'] : []),
  ],
};
const parsed = resultSchema.safeParse(result);
if (!parsed.success) { console.error(JSON.stringify(parsed.error.issues, null, 2)); process.exitCode = 1; }
const out = resolve(opts.out ?? (opts.smoke ? join(scratch, 'smoke-result.json')
  : join(benchDir, 'results', `${now.toISOString().slice(0, 10)}-${label}.json`)));
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
for (const c of cells) {
  const w = c.wall ? `median ${c.wall.median.toFixed(2)} ${c.wall.unit} [${c.wall.min.toFixed(2)}..${c.wall.max.toFixed(2)}] sd ${c.wall.stdev.toFixed(2)} n=${c.wall.n}` : c.reason ?? '';
  const rss = c.peakRssKb ? ` rss ${Math.round(c.peakRssKb.median)} KB` : '';
  console.log(`${c.id.padEnd(30)} ${c.status.padEnd(8)} parity=${c.parity.status.padEnd(14)} ${w}${rss}`);
}
console.log(`result: ${out}${parsed.success ? ' (schema-valid)' : ' (SCHEMA INVALID)'}`);
if (!opts.smoke) await rm(scratch, { recursive: true, force: true });
if (measured.length === 0 || cells.some((c) => c.status === 'failed')) process.exitCode = 1;
