import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { childEnvironment } from '../src/environment.js';
import { fixtureUv, testDirectory } from './helpers.js';

test('plugin MCP discovers tools and completes, consumes, cancels and rejects unsafe jobs', async () => {
  const root = await testDirectory('mcp');
  const client = new Client({ name: 'fixture-client', version: '0.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'mcp', '--workspace', root],
    env: { ...childEnvironment(), PATH: `${await fixtureUv(root)}${delimiter}${process.env.PATH}` }, stderr: 'pipe' });
  try {
    await writeFile(join(root, 'trace.json'), '{}');
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(),
      ['cancel_evidence_job', 'get_evidence_job', 'launch_evidence_prefetch']);
    const reports = [{ id: 'trace', path: 'trace.json', format: 'chrome-trace', description: 'Fixture only' }];
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError, structuredContent: result.structuredContent as Record<string, unknown> | undefined };
    };
    const launched = await call('launch_evidence_prefetch', { issue: 'fixture', reports });
    const jobId = (launched.structuredContent as {jobId: string}).jobId;
    assert.equal(launched.structuredContent?.status, 'running');
    const completed = await call('get_evidence_job', { jobId, waitMs: 5000 });
    assert.equal(completed.structuredContent?.status, 'complete');
    assert.equal((await call('get_evidence_job', { jobId })).structuredContent?.status, 'not_found');
    await writeFile(join(root, 'trace.json'), '{"mode":"slow"}');
    const slow = await call('launch_evidence_prefetch', { issue: 'fixture', reports });
    const slowId = slow.structuredContent?.jobId;
    assert.equal((await call('cancel_evidence_job', { jobId: slowId })).structuredContent?.status, 'cancelled');
    assert.equal((await call('get_evidence_job', { jobId: slowId })).structuredContent?.status, 'not_found');
    assert.equal((await call('launch_evidence_prefetch', { issue: 'fixture', reports, mode: 'decisions' })).isError, true);
    assert.equal((await call('launch_evidence_prefetch', { issue: 'fixture', reports: [reports[0], reports[0]] })).isError, true);
    assert.equal((await call('launch_evidence_prefetch', { issue: 'fixture', reports: [{ ...reports[0], id: '__human_review__' }] })).isError, true);
  } finally { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true }); }
});
