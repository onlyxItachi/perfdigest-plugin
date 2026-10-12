// Real local subprocess/MCP integration. No Decisions or Codex model calls.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { withPerfDigest } from '../dist/perfdigest.js';
import { demoManifest } from '../dist/demo.js';
import { investigate } from '../dist/run.js';

const parent = resolve('work/integration');
await mkdir(parent, { recursive: true });
const workspace = await mkdtemp(join(parent, 'local-'));
const tools = await withPerfDigest(workspace, undefined, async client => (await client.listTools()).tools.map(t => t.name));
for (const tool of ['summarize_report', 'list_kernels', 'get_metrics', 'compare_metrics', 'expand', 'platform_capabilities', 'suggest_profile_command']) {
  assert.ok(tools.includes(tool), tool);
}
const manifest = await demoManifest(workspace);
const result = await investigate({ workspace, manifest, agent: 'none', routing: 'offline' });
assert.equal(result.status, 'complete');
assert.equal(result.verification.exitCode, 0);
assert.equal(result.analysis, null);
assert.equal(result.evidence.decision.requests, 0);
assert.equal(result.evidence.evidence[0].digest.total_units, 2);
assert.equal(result.evidence.evidence[0].provenance, 'perfdigest_mcp');
assert.ok((await readFile(join(result.directory, 'run.json'), 'utf8')).includes('offline_order'));
console.log(JSON.stringify({ status: 'passed', scope: 'real CPU execution + uvx perfdigest-mcp, no model calls', tools, directory: result.directory }, null, 2));
