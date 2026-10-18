// MCP stdio discovery probe. Always runs under the harness's Node so the CLIENT is
// constant; only the SERVER runtime varies. Per iteration it measures:
//   spawn server -> initialize handshake -> tools/list -> close
// Usage: node bench/probes/mcp-probe.mjs '<json argv of server>' ITERATIONS WORKSPACE [RSS_WRAPPER_RUNS]
// With RSS_WRAPPER_RUNS > 0, additional iterations wrap the server in a transient cgroup v2 scope
// (when `systemd-run --user --scope` is available) and GNU time to capture both:
//   - `cgroupPeakKb`: cgroup v2 `memory.peak` across the server process tree
//   - `rssKb`: GNU `/usr/bin/time -f '%M'` peak RSS of the single largest child process
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { usable } from '../lib/binaries.mjs';

const [argvJson, iterArg, workspace, rssArg] = process.argv.slice(2);
const server = JSON.parse(argvJson);
const iterations = Number(iterArg ?? 5);
const rssRuns = Number(rssArg ?? 0);
const env = JSON.parse(process.env.PERFDIGEST_BENCH_CHILD_ENV ?? '{}');

const CGROUP_STDIO_WRAPPER = `#!/bin/sh
OUT_FILE="$1"
TIME_BIN="$2"
shift 2
CG_REL=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup 2>/dev/null)
CG_DIR="/sys/fs/cgroup\${CG_REL}"
if [ -n "$TIME_BIN" ] && [ "$TIME_BIN" != "none" ]; then
  "$TIME_BIN" -f "%M" -o "\${OUT_FILE}.time" "$@"
  EC=$?
  T_LINE=$(tail -n 1 "\${OUT_FILE}.time" 2>/dev/null || echo "")
  rm -f "\${OUT_FILE}.time"
else
  "$@"
  EC=$?
  T_LINE=""
fi
PEAK=$(cat "\${CG_DIR}/memory.peak" 2>/dev/null || echo "")
printf '{"cgroupPeakBytes":%s,"maxSingleRssKb":%s}\\n' "\${PEAK:-null}" "\${T_LINE:-null}" > "$OUT_FILE"
exit "$EC"
`;

async function once(command, args) {
  const t = performance.now();
  const client = new Client({ name: 'perfdigest-bench', version: '0.0.0' });
  const transport = new StdioClientTransport({ command, args, cwd: workspace, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
  try {
    await client.connect(transport, { timeout: 60_000 });
    const tools = (await client.listTools()).tools.map((x) => x.name).sort();
    const elapsed = performance.now() - t;
    return { elapsed, tools };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n${stderr}`);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

const samples = []; let tools = [];
for (let i = 0; i < iterations; i++) {
  const r = await once(server[0], server.slice(1));
  samples.push(r.elapsed); tools = r.tools;
}
const rssKb = [];
const cgroupPeakKb = [];
let memoryCoverage = 'none';
if (rssRuns > 0) {
  const dir = await mkdtemp(join(tmpdir(), 'pd-mcp-rss-'));
  const wrapper = join(dir, 'mcp-cg-wrapper.sh');
  await writeFile(wrapper, CGROUP_STDIO_WRAPPER, 'utf8');
  await chmod(wrapper, 0o755);
  const systemdRun = usable('/usr/bin/systemd-run') ? '/usr/bin/systemd-run' : null;
  const timeBin = usable('/usr/bin/time') ? '/usr/bin/time' : 'none';

  for (let i = 0; i < rssRuns; i++) {
    const out = join(dir, `res-${i}.json`);
    if (systemdRun) {
      try {
        await once(systemdRun, ['--user', '--scope', '--quiet', '--', wrapper, out, timeBin, ...server]);
        for (let tries = 0; tries < 50; tries++) {
          const text = await readFile(out, 'utf8').catch(() => '');
          if (text.trim().endsWith('}')) {
            const parsed = JSON.parse(text);
            if (typeof parsed.cgroupPeakBytes === 'number' && parsed.cgroupPeakBytes > 0) {
              cgroupPeakKb.push(Math.round(parsed.cgroupPeakBytes / 1024));
            }
            if (typeof parsed.maxSingleRssKb === 'number' && Number.isFinite(parsed.maxSingleRssKb)) {
              rssKb.push(parsed.maxSingleRssKb);
            }
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        continue;
      } catch {
        // Fallback to plain GNU time if user systemd bus is unavailable
      }
    }
    if (timeBin !== 'none') {
      const timeOut = join(dir, `time-${i}.txt`);
      await once(timeBin, ['-f', '%M', '-o', timeOut, ...server]);
      for (let tries = 0; tries < 50; tries++) {
        const text = await readFile(timeOut, 'utf8').catch(() => '');
        const kb = Number(text.trim().split('\n').pop());
        if (text && Number.isFinite(kb)) { rssKb.push(kb); break; }
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }
  await rm(dir, { recursive: true, force: true });
  memoryCoverage = cgroupPeakKb.length
    ? 'cgroup_v2_tree_peak'
    : rssKb.length
      ? 'max_single_process_only_incomplete_tree'
      : 'none';
}
process.stdout.write(`${JSON.stringify({ iterations, samplesMs: samples, tools, rssKb, cgroupPeakKb, memoryCoverage })}\n`);
