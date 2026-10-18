// Shared binary resolution for benchmark harnesses.
// Never hardcodes user home directories or host-specific paths.
// Resolution priority per tool:
//   1. Explicit PERFDIGEST_BENCH_<TOOL> environment variable
//   2. System PATH lookup
//   3. Optional PERFDIGEST_BENCH_TOOLS_DIR or repo-relative .tools/ or ../tools/ directory
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export function usable(p) {
  try {
    if (p) accessSync(p, constants.X_OK);
    return Boolean(p);
  } catch {
    return false;
  }
}

export function which(name, pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (usable(p)) return p;
  }
  return null;
}

export function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

export function versionOf(cmd, args, env, re = /(\d+\.\d+\.\d+[^\s]*)/) {
  if (!usable(cmd)) return null;
  const r = spawnSync(cmd, args, { encoding: 'utf8', env });
  const m = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(re);
  return m ? m[1] : null;
}

function findInToolDirs(repoRoot, relativeCandidates) {
  const roots = [
    process.env.PERFDIGEST_BENCH_TOOLS_DIR ? resolve(process.env.PERFDIGEST_BENCH_TOOLS_DIR) : null,
    resolve(repoRoot, '.tools'),
    resolve(repoRoot, '../tools'),
  ].filter(Boolean);
  for (const root of roots) {
    for (const rel of relativeCandidates) {
      const candidate = join(root, rel);
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveBenchBinaries(repoRoot) {
  const benchDir = join(repoRoot, 'bench');
  const localTsgo = join(benchDir, 'node_modules/@typescript/native-preview-linux-x64/lib/tsgo');
  const repoTsgo = join(repoRoot, 'node_modules/@typescript/native-preview-linux-x64/lib/tsgo');

  const bun =
    process.env.PERFDIGEST_BENCH_BUN ??
    which('bun') ??
    findInToolDirs(repoRoot, ['bun-linux-x64/bun', 'bun/bun', 'bun']);

  const deno =
    process.env.PERFDIGEST_BENCH_DENO ??
    which('deno') ??
    findInToolDirs(repoRoot, ['deno-bin/deno', 'deno/deno', 'deno']);

  const tsgo =
    process.env.PERFDIGEST_BENCH_TSGO ??
    (usable(localTsgo) ? localTsgo : null) ??
    (usable(repoTsgo) ? repoTsgo : null) ??
    which('tsgo') ??
    findInToolDirs(repoRoot, ['tsgo/tsgo', 'tsgo']);

  const go = process.env.PERFDIGEST_BENCH_GO ?? which('go');
  const uvx = process.env.PERFDIGEST_BENCH_UVX ?? which('uvx');
  const hyperfine = which('hyperfine');
  const time = usable('/usr/bin/time') ? '/usr/bin/time' : which('time');
  const systemdRun = usable('/usr/bin/systemd-run') ? '/usr/bin/systemd-run' : which('systemd-run');

  return {
    node: process.execPath,
    bun: usable(bun) ? bun : null,
    deno: usable(deno) ? deno : null,
    tsgo: usable(tsgo) ? tsgo : null,
    go: usable(go) ? go : null,
    uvx: usable(uvx) ? uvx : null,
    hyperfine: usable(hyperfine) ? hyperfine : null,
    time: usable(time) ? time : null,
    systemdRun: usable(systemdRun) ? systemdRun : null,
  };
}
