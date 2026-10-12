// Synthetic MCP responses for failure/provenance tests; no profiler or API claims.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, appendFile } from 'node:fs/promises';

const server = new McpServer({ name: 'fixture-only', version: '0.0.0' });
server.registerTool('summarize_report', {
  inputSchema: { report_ref: z.string(), format: z.string(), top_n: z.number() },
}, async ({ report_ref, format }) => {
  const input = JSON.parse(await readFile(report_ref, 'utf8')) as { mode?: string };
  if (input.mode === 'slow') await new Promise(r => setTimeout(r, 2000));
  if (input.mode === 'change') await appendFile(report_ref, ' ');
  if (input.mode === 'error') return { isError: true, content: [{ type: 'text', text: 'fixture parse error' }] };
  const units = input.mode === 'empty' ? [] : [{ name: 'fixture', duration_us: 12, metrics: { calls: 1, cache_misses: null } }];
  const data = { format, raw_ref: report_ref, total_units: units.length, returned: units.length, units };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
});
await server.connect(new StdioServerTransport());
