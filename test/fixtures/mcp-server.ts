// Synthetic MCP responses for failure/provenance tests; no profiler or API claims.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, appendFile } from 'node:fs/promises';

const server = new McpServer({ name: 'fixture-only', version: '0.0.0' });
server.registerTool('summarize_report', {
  inputSchema: { report_ref: z.string(), format: z.string(), top_n: z.number() },
}, async ({ report_ref, format, top_n }) => {
  const input = JSON.parse(await readFile(report_ref, 'utf8')) as { mode?: string; totalUnits?: number };
  if (input.mode === 'slow') await new Promise(r => setTimeout(r, 2000));
  if (input.mode === 'change') await appendFile(report_ref, ' ');
  if (input.mode === 'error') return { isError: true, content: [{ type: 'text', text: 'fixture parse error' }] };
  const total = input.mode === 'empty' ? 0 : (input.totalUnits ?? 1);
  const count = Math.min(top_n, total);
  const units = Array.from({ length: count }, (_, idx) => ({
    index: idx,
    name: count === 1 && !input.totalUnits ? 'fixture' : `unit_${idx}`,
    duration_us: 12 * (total - idx),
    metrics: { calls: 1, cache_misses: null },
  }));
  const data = { format, raw_ref: report_ref, total_units: total, returned: units.length, units };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
});
await server.connect(new StdioServerTransport());
