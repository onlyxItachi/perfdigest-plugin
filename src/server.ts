import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { reportSchema, type EvidencePacket, type RoutingMode } from './config.js';
import { createDecisionProvider, providerName } from './providers.js';
import { gatherEvidence } from './evidence.js';
import { redact } from './environment.js';

type Job = { controller: AbortController; createdAt: number; done: Promise<void>;
  state: 'running' | 'complete' | 'needs_review' | 'failed' | 'cancelled';
  result?: EvidencePacket; error?: string };
const reply = (data: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data,
});

export async function serve(workspace: string, defaultRouting: RoutingMode = 'offline',
  options: { cloudflareModel?: string } = {}): Promise<void> {
  const jobs = new Map<string, Job>();
  const server = new McpServer({ name: 'perfdigest-evidence', version: '0.1.0' }, { instructions:
    'Read-only asynchronous evidence from saved local reports. Launch a job, continue independent work, then collect it. Confidence is not correctness. This server never runs capture commands or applies patches. Offline routing is explicitly labeled.' });
  const cleanup = () => {
    for (const [id, job] of jobs) if (Date.now() - job.createdAt > 300_000) {
      job.controller.abort(); jobs.delete(id);
    }
  };
  const expiry = setInterval(cleanup, 30_000); expiry.unref();
  server.registerTool('launch_evidence_prefetch', {
    description: 'Start evidence collection without blocking. Uses existing reports; never runs a profiler or build. Select a provider explicitly; hosted modes need dedicated credentials in this server process.',
    inputSchema: { issue: z.string().min(1).max(12_000), reports: z.array(reportSchema).min(1).max(8),
      mode: z.enum(['offline', 'cloudflare', 'local', 'openai', 'decisions', 'clef-local', 'clef-cloudflare', 'openai-luna']).default(defaultRouting) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ issue, reports, mode }) => {
    cleanup();
    if (new Set(reports.map(r => r.id)).size !== reports.length) throw new Error('Report IDs must be unique');
    if (jobs.size >= 32) throw new Error('Job limit reached; collect or cancel existing jobs');
    // The configured Cloudflare model applies only to Cloudflare jobs; other modes never receive it.
    const provider = createDecisionProvider(mode, providerName(mode) === 'cloudflare' && options.cloudflareModel !== undefined
      ? { cloudflareModel: options.cloudflareModel } : {});
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const id = crypto.randomUUID();
    const job: Job = { controller, createdAt: Date.now(), state: 'running', done: Promise.resolve() };
    job.done = gatherEvidence({ workspace, issue, reports, routing: mode, signal, provider })
      .then(result => { job.state = result.status; job.result = result; })
      .catch(error => { job.state = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = redact(error instanceof Error ? error.message : String(error)); });
    jobs.set(id, job);
    return reply({ jobId: id, status: 'running', routing: mode });
  });
  server.registerTool('get_evidence_job', {
    description: 'Poll or await an evidence job in-execution. A terminal result is consumed once; jobs expire after five minutes.',
    inputSchema: { jobId: z.string(), waitMs: z.number().int().min(0).max(60000).default(0) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ jobId, waitMs }) => {
    cleanup(); const job = jobs.get(jobId);
    if (!job) return reply({ jobId, status: 'not_found' });
    const waitStart = Date.now();
    if (job.state === 'running' && waitMs) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([job.done, new Promise<void>(r => { timer = setTimeout(r, waitMs); })]);
      if (timer) clearTimeout(timer);
    }
    const waitedMs = Date.now() - waitStart;
    if (job.state !== 'running') jobs.delete(jobId);
    return reply({
      jobId,
      status: job.state,
      deliveryMode: job.state === 'complete' ? 'in_execution_tool_delivery' : null,
      waitedMs,
      ...(job.result ? { packet: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
    });
  });
  server.registerTool('cancel_evidence_job', {
    description: 'Cancel an evidence job and release its slot.', inputSchema: { jobId: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ jobId }) => {
    const job = jobs.get(jobId);
    if (!job) return reply({ jobId, status: 'not_found' });
    job.controller.abort(); jobs.delete(jobId);
    return reply({ jobId, status: 'cancelled' });
  });
  const close = () => {
    clearInterval(expiry);
    for (const job of jobs.values()) job.controller.abort();
    void server.close();
  };
  process.once('SIGINT', close); process.once('SIGTERM', close); process.stdin.once('end', close);
  await server.connect(new StdioServerTransport());
}
