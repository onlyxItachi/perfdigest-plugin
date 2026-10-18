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
/** 'generic' requires an explicit adapter (CLI: --agent-command); nothing is selected implicitly. */
export type AgentMode = 'none' | 'codex' | 'generic';
export type AgentDeliveryMode = 'two_turn' | 'single_turn';

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
  /** Cloudflare model endpoint actually requested, e.g. @cf/cloudflare/clef. */
  requestedModel?: string;
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

/**
 * Hash-checked provenance for every report digested during a run, recorded even when the
 * router abstains or fails. `delivered` is true only for evidence handed to the agent.
 * Digest contents stay in `EvidencePacket.evidence`; this record never carries raw data.
 */
export interface EvidenceProvenance {
  id: string;
  reference: string;
  format: string;
  sha256: string;
  bytes: number;
  modifiedAt: string;
  provenance: 'perfdigest_mcp';
  delivered: boolean;
}

/**
 * accepted: a report route passed policy. abstained: refusal, human review or low confidence.
 * rejected: schema or identity validation failed (request refused as invalid, or response
 * failed validation, unknown choice or unexpected model identity). failed: transport,
 * authentication, billing or other provider error. not_reached: the run failed before routing.
 */
export type DecisionOutcome = 'accepted' | 'abstained' | 'rejected' | 'failed' | 'not_reached';

export interface EvidencePacket {
  status: 'complete' | 'needs_review';
  routing: RoutingMode;
  decision: RouteDecision;
  /** Every digested report, including those not delivered. */
  considered: EvidenceProvenance[];
  /** Evidence delivered to the agent (empty unless a route was accepted). */
  evidence: Array<{
    report: ReportSpec;
    sha256: string;
    bytes: number;
    modifiedAt: string;
    provenance: 'perfdigest_mcp';
    digest: Record<string, unknown>;
  }>;
  /**
   * Optional non-selected candidate digests already computed during measured routing,
   * included only when `includeCorroborating: true` and a route was accepted.
   */
  corroborating?: EvidencePacket['evidence'];
}
