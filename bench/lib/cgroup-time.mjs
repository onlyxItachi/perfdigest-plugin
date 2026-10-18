// Resource measurement helper separating:
//   1. cgroup v2 process-tree memory peak (`memory.peak` across all concurrent processes in a
//      transient `systemd-run --user --scope` unit) + cgroup v2 `cpu.stat` (`user_usec`, `system_usec`).
//   2. GNU `/usr/bin/time -f '%U %S %M'` `ru_maxrss` (`maxSingleProcessRssKb`), which reports ONLY
//      the peak resident set size of the single largest individual child process (`wait4` / `RUSAGE_CHILDREN`),
//      NOT aggregate process-tree memory.
// When cgroup v2 user scope measurement is unavailable, `memoryCoverage` is explicitly recorded as
// `'max_single_process_only_incomplete_tree'` (or `'none'`).
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stats } from './stats.mjs';

const CGROUP_SH_WRAPPER = `#!/bin/sh
OUT_FILE="$1"
TIME_BIN="$2"
shift 2
CG_REL=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup 2>/dev/null)
CG_DIR="/sys/fs/cgroup\${CG_REL}"
if [ -n "$TIME_BIN" ] && [ "$TIME_BIN" != "none" ]; then
  "$TIME_BIN" -f "%U %S %M" -o "\${OUT_FILE}.time" "$@" >/dev/null 2>&1
  EC=$?
  T_LINE=$(tail -n 1 "\${OUT_FILE}.time" 2>/dev/null || echo "")
  rm -f "\${OUT_FILE}.time"
else
  "$@" >/dev/null 2>&1
  EC=$?
  T_LINE=""
fi
PEAK=$(cat "\${CG_DIR}/memory.peak" 2>/dev/null || echo "")
U_USEC=$(awk '$1 == "user_usec" {print $2}' "\${CG_DIR}/cpu.stat" 2>/dev/null || echo "")
S_USEC=$(awk '$1 == "system_usec" {print $2}' "\${CG_DIR}/cpu.stat" 2>/dev/null || echo "")
printf '{"exitCode":%d,"cgroupPeakBytes":%s,"cgroupUserUsec":%s,"cgroupSysUsec":%s,"gnuTime":"%s"}\\n' \\
  "$EC" "\${PEAK:-null}" "\${U_USEC:-null}" "\${S_USEC:-null}" "$T_LINE" > "$OUT_FILE"
exit "$EC"
`;

export function createResourceRunner({ scratch, env, cwd, timeBin, systemdRunBin }) {
  const wrapperPath = join(scratch, 'pd-cgroup-runner.sh');
  writeFileSync(wrapperPath, CGROUP_SH_WRAPPER, 'utf8');
  chmodSync(wrapperPath, 0o755);

  let cgroupAvailable = false;
  if (systemdRunBin) {
    const probeOut = join(scratch, 'cg-probe.json');
    const r = spawnSync(
      systemdRunBin,
      ['--user', '--scope', '--quiet', '--', wrapperPath, probeOut, timeBin ?? 'none', '/bin/true'],
      { env, cwd, stdio: 'ignore', timeout: 10_000 },
    );
    if (r.status === 0) {
      try {
        const parsed = JSON.parse(readFileSync(probeOut, 'utf8'));
        cgroupAvailable = typeof parsed.cgroupPeakBytes === 'number' && parsed.cgroupPeakBytes > 0;
      } catch {
        cgroupAvailable = false;
      }
    }
    rmSync(probeOut, { force: true });
  }

  return {
    cgroupAvailable,
    memoryCoverage: cgroupAvailable
      ? 'cgroup_v2_tree_peak'
      : timeBin
        ? 'max_single_process_only_incomplete_tree'
        : 'none',

    measure(argv, { runs, prepare }) {
      if (!cgroupAvailable && !timeBin) {
        return { memoryCoverage: 'none' };
      }
      const gnuUserMs = [];
      const gnuSysMs = [];
      const maxSingleRssKb = [];
      const cgPeakKb = [];
      const cgUserMs = [];
      const cgSysMs = [];

      for (let i = 0; i < runs; i++) {
        if (prepare) spawnSync(prepare[0], prepare.slice(1), { env, cwd, stdio: 'ignore' });
        const out = join(scratch, `res-${Date.now()}-${i}.json`);
        if (cgroupAvailable) {
          const r = spawnSync(
            systemdRunBin,
            ['--user', '--scope', '--quiet', '--', wrapperPath, out, timeBin ?? 'none', ...argv],
            { env, cwd, stdio: 'ignore', timeout: 120_000 },
          );
          if (r.status !== 0) {
            rmSync(out, { force: true });
            throw new Error(`Resource probe exited ${r.status} for ${argv.join(' ')}`);
          }
          const rec = JSON.parse(readFileSync(out, 'utf8'));
          rmSync(out, { force: true });
          if (typeof rec.cgroupPeakBytes === 'number' && rec.cgroupPeakBytes > 0) {
            cgPeakKb.push(Math.round(rec.cgroupPeakBytes / 1024));
          }
          if (typeof rec.cgroupUserUsec === 'number') cgUserMs.push(rec.cgroupUserUsec / 1000);
          if (typeof rec.cgroupSysUsec === 'number') cgSysMs.push(rec.cgroupSysUsec / 1000);
          if (rec.gnuTime) {
            const parts = String(rec.gnuTime).trim().split(/\s+/).map(Number);
            if (parts.length === 3 && parts.every(Number.isFinite)) {
              gnuUserMs.push(parts[0] * 1000);
              gnuSysMs.push(parts[1] * 1000);
              maxSingleRssKb.push(parts[2]);
            }
          }
        } else {
          const r = spawnSync(timeBin, ['-f', '%U %S %M', '-o', out, ...argv], {
            env,
            cwd,
            stdio: 'ignore',
            timeout: 120_000,
          });
          if (r.status !== 0) {
            rmSync(out, { force: true });
            throw new Error(`GNU time probe exited ${r.status} for ${argv.join(' ')}`);
          }
          const [u, s, m] = readFileSync(out, 'utf8').trim().split('\n').pop().split(/\s+/).map(Number);
          rmSync(out, { force: true });
          gnuUserMs.push(u * 1000);
          gnuSysMs.push(s * 1000);
          maxSingleRssKb.push(m);
        }
      }

      const med = (xs) => stats(xs, 'ms').median;
      const singleRssStats = maxSingleRssKb.length ? stats(maxSingleRssKb, 'kb') : undefined;
      const cgroupTreeStats = cgPeakKb.length ? stats(cgPeakKb, 'kb') : undefined;
      const cpuObj = gnuUserMs.length
        ? {
            unit: 'ms',
            n: runs,
            userMedian: med(gnuUserMs),
            sysMedian: med(gnuSysMs),
            ...(cgUserMs.length ? { cgroupUserMedianMs: Number(med(cgUserMs).toFixed(2)) } : {}),
            ...(cgSysMs.length ? { cgroupSysMedianMs: Number(med(cgSysMs).toFixed(2)) } : {}),
          }
        : undefined;

      return {
        memoryCoverage: cgroupTreeStats
          ? 'cgroup_v2_tree_peak'
          : singleRssStats
            ? 'max_single_process_only_incomplete_tree'
            : 'none',
        ...(cpuObj ? { cpu: cpuObj } : {}),
        ...(singleRssStats ? { peakRssKb: singleRssStats } : {}),
        ...(cgroupTreeStats ? { cgroupTreePeakKb: cgroupTreeStats } : {}),
      };
    },
  };
}
