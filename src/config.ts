import { z } from 'zod';

export const commandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).max(100).default([]),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
}).strict();
export const reportSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(id => id !== '__human_review__', 'Reserved routing choice'),
  path: z.string().min(1),
  format: z.string().min(1),
  description: z.string().max(1000),
}).strict();
export const manifestSchema = z.object({
  version: z.literal(1),
  issue: z.string().min(1).max(12_000),
  captures: z.array(commandSchema).max(4).default([]),
  reports: z.array(reportSchema).min(1).max(8),
  verification: commandSchema,
}).strict().refine(m => new Set(m.reports.map(r => r.id)).size === m.reports.length, 'Report IDs must be unique');
export type CommandSpec = z.infer<typeof commandSchema>;
export type ReportSpec = z.infer<typeof reportSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export const providerNames = ['offline', 'openai', 'local', 'cloudflare'] as const;
export type ProviderName = typeof providerNames[number];
/** decisions is the backwards-compatible alias for openai-luna. */
export type RoutingMode = ProviderName | 'decisions' | 'openai-luna' | 'clef-local' | 'clef-cloudflare';
export type AgentMode = 'none' | 'codex';

export interface TimelineEvent {
  event: string;
  at: string;
  elapsedMs: number;
  detail?: string;
}
export type Emit = (event: string, detail?: string) => void;

export interface CommandReceipt {
  command: string;
  args: string[];
  startedAt: string;
  elapsedMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
}

export interface RouteDecision {
  source: 'offline_order' | 'openai_decisions' | 'clef_local' | 'clef_cloudflare';
  provider?: ProviderName;
  model?: string;
  confidenceSemantics?: 'provider_reported' | 'systemone_uniform_zero';
  transport?: 'openai_https' | 'local_mock' | 'injected_client' | 'loopback_http' | 'cloudflare_https';
  inputSha256?: string;
  evidenceCount?: number;
  selectedId: string | null;
  confidence: number | null;
  probabilities?: Array<{ value: string; probability: number }>;
  reason: 'selected' | 'refused' | 'low_confidence' | 'human_review';
  latencyMs: number;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: null;
}

export interface EvidencePacket {
  status: 'complete' | 'needs_review';
  routing: RoutingMode;
  decision: RouteDecision;
  evidence: Array<{
    report: ReportSpec;
    sha256: string;
    bytes: number;
    modifiedAt: string;
    provenance: 'perfdigest_mcp';
    digest: Record<string, unknown>;
  }>;
}
