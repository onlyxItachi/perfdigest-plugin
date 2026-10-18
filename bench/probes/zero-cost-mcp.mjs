#!/usr/bin/env node
// Fast, zero-cost deterministic MCP stdio responder for orchestration benchmarks.
// Excludes Python/uvx cold start (~268 ms) and model inference (~2-5 s).
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    continue;
  }
  if (msg.method === 'initialize') {
    const res = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'zero-cost-mcp', version: '1.0.0' },
      },
    };
    process.stdout.write(JSON.stringify(res) + '\n');
  } else if (msg.method === 'notifications/initialized') {
    // Client notification; no response needed
  } else if (msg.method === 'tools/list') {
    const res = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'summarize_report',
            description: 'Zero cost summarize_report responder',
            inputSchema: {
              type: 'object',
              properties: {
                report_ref: { type: 'string' },
                format: { type: 'string' },
                top_n: { type: 'number' },
              },
              required: ['report_ref', 'format'],
            },
          },
        ],
      },
    };
    process.stdout.write(JSON.stringify(res) + '\n');
  } else if (msg.method === 'tools/call') {
    const args = msg.params?.arguments ?? {};
    const reportRef = args.report_ref ?? '';
    const format = args.format ?? 'chrome-trace';
    const topN = args.top_n ?? 3;
    const units = Array.from({ length: Math.min(topN, 3) }, (_, idx) => ({
      index: idx,
      name: `unit_${idx}`,
      duration_us: 100 * (idx + 1),
      metrics: { calls: 1, cache_misses: null },
    }));
    const data = {
      format,
      raw_ref: reportRef,
      total_units: units.length,
      returned: units.length,
      units,
    };
    const res = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
      },
    };
    process.stdout.write(JSON.stringify(res) + '\n');
  }
}
