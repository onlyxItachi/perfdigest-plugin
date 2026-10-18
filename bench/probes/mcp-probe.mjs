// MCP stdio discovery probe. Always runs under the harness's Node so the CLIENT is
// constant; only the SERVER runtime varies. Per iteration it measures:
//   spawn server -> initialize handshake -> tools/list -> close
// Usage: node bench/probes/mcp-probe.mjs '<json argv of server>' ITERATIONS WORKSPACE [RSS_WRAPPER_RUNS]
// With RSS_WRAPPER_RUNS > 0, additional iterations wrap the server in GNU time to
// capture its peak RSS (those iterations are excluded from the latency samples).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [argvJson, iterArg, workspace, rssArg] = process.argv.slice(2);
const server = JSON.parse(argvJson);
const iterations = Number(iterArg ?? 5);
const rssRuns = Number(rssArg ?? 0);
const env = JSON.parse(process.env.PERFDIGEST_BENCH_CHILD_ENV ?? '{}');

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
if (rssRuns > 0) {
  const dir = await mkdtemp(join(tmpdir(), 'pd-mcp-rss-'));
  for (let i = 0; i < rssRuns; i++) {
    const out = join(dir, `time-${i}.txt`);
    await once('/usr/bin/time', ['-f', '%M', '-o', out, ...server]);
    // GNU time writes after the child exits; close() above waits for exit.
    for (let tries = 0; tries < 50; tries++) {
      const text = await readFile(out, 'utf8').catch(() => '');
      const kb = Number(text.trim().split('\n').pop());
      if (text && Number.isFinite(kb)) { rssKb.push(kb); break; }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await rm(dir, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ iterations, samplesMs: samples, tools, rssKb })}\n`);
