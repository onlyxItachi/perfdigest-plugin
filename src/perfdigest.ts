import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { childEnvironment, executable, redact } from './environment.js';
import type { ReportSpec } from './config.js';

export async function withPerfDigest<T>(workspace: string, signal: AbortSignal | undefined, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'perfdigest-plugin', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: executable('uvx'), args: ['perfdigest-mcp'],
    cwd: workspace, env: childEnvironment(), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  try {
    await client.connect(transport, { timeout: 60_000, ...(signal ? { signal } : {}) });
    return await run(client);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error(redact(`PerfDigest MCP failed: ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`));
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

export async function digestReport(workspace: string, report: ReportSpec, absolutePath: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return withPerfDigest(workspace, signal, async client => {
    const result = await client.callTool({ name: 'summarize_report', arguments: {
      report_ref: absolutePath, format: report.format, top_n: 3,
    } }, undefined, { timeout: 30_000, ...(signal ? { signal } : {}) });
    if (result.isError) throw new Error('summarize_report returned an MCP tool error');
    const structured = result.structuredContent;
    const content = result.content as Array<{ type: string; text?: string }>;
    const digest: unknown = structured ?? JSON.parse(content.filter(p => p.type === 'text').map(p => p.text).join('\n'));
    return validateDigest(digest, report.format, absolutePath);
  });
}

export function validateDigest(value: unknown, format: string, reportPath: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid PerfDigest result');
  const digest = value as Record<string, unknown>;
  if (digest.error || digest.format !== format || digest.raw_ref !== reportPath
      || !Number.isInteger(digest.total_units) || (digest.total_units as number) < 1
      || !Array.isArray(digest.units) || digest.units.length < 1
      || digest.returned !== digest.units.length || digest.units.length > (digest.total_units as number)) {
    throw new Error('PerfDigest did not return a nonempty digest for the requested report and format');
  }
  if (JSON.stringify(digest).length > 40_000) throw new Error('Digest exceeds MVP context budget; raw report remains on disk');
  // Do not fill or coerce metrics: null is an unmeasured value, never zero.
  return digest;
}
