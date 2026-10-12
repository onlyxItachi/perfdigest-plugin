import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { EvidencePacket, ProviderName, ReportSpec, RouteDecision, RoutingMode } from './config.js';
import { DecisionsError, decisionsClient, localDecisionsClient, decisionsFailure, decisionsInput,
  offlineSelection, routeDecision, routingQuestion, selectReport, type DecisionsErrorKind } from './decisions.js';
import { validateLocalEndpoint } from './setup.js';

export function providerName(mode: RoutingMode): ProviderName {
  switch (mode) {
    case 'decisions': case 'openai-luna': case 'openai': return 'openai';
    case 'clef-local': case 'local': return 'local';
    case 'clef-cloudflare': case 'cloudflare': return 'cloudflare';
    case 'offline': return 'offline';
    default: throw new DecisionsError('schema');
  }
}
// A bounded provider switch, not a generic agent/provider framework.
export interface DecisionProvider {
  readonly name: ProviderName;
  select(issue: string, reports: ReportSpec[], signal?: AbortSignal,
    evidence?: EvidencePacket['evidence']): Promise<RouteDecision>;
}
export class ProviderError extends DecisionsError {
  constructor(readonly provider: ProviderName, kind: DecisionsErrorKind, status: number | null = null) {
    super(kind, status);
    this.message = kind === 'missing_credential'
      ? `Provider ${provider}: required account/token configuration is missing. No request or fallback was made.`
      : `Provider ${provider}: ${this.message}`;
  }
}
const choiceValue = z.union([z.string().min(1), z.boolean()]);
const questionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), name: z.string().regex(/^[\w.-]{1,100}$/), instructions: z.string() }),
  z.object({ type: z.literal('choice'), name: z.string().regex(/^[\w.-]{1,100}$/), instructions: z.string(),
    choices: z.array(z.object({ value: choiceValue, description: z.string().optional() })).min(2).max(255) }),
  z.object({ type: z.literal('score'), name: z.string().regex(/^[\w.-]{1,100}$/), instructions: z.string(),
    levels: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(2).max(10) }),
]);
export type DecisionQuestion = z.infer<typeof questionSchema>;
// Encode mixed boolean/string choices without conflating true with "true".
function keys(question: Extract<DecisionQuestion, { type: 'choice' }>): string[] {
  return question.choices.map((c, i) => typeof c.value === 'boolean' || question.choices.some(v => typeof v.value === 'boolean')
    ? `option_${i}` : String(c.value));
}
function questionsChecked(questions: DecisionQuestion[]) {
  const parsed = z.array(questionSchema).min(1).max(64).parse(questions);
  if (new Set(parsed.map(q => q.name)).size !== parsed.length) throw new DecisionsError('schema');
  for (const q of parsed) if (q.type === 'choice' && new Set(q.choices.map(c => JSON.stringify(c.value))).size !== q.choices.length) {
    throw new DecisionsError('schema');
  }
  return parsed;
}
export function toSystemOne(state: string, questions: DecisionQuestion[]) {
  const checked = questionsChecked(questions);
  return { model: 'clef-flash', state, questions: Object.fromEntries(checked.map(q => [q.name,
    q.type === 'predicate' ? { type: 'noul', instructions: q.instructions }
      : q.type === 'score' ? { type: 'score', instructions: q.instructions,
        criteria: q.levels.map(l => l.description ? `${l.label}: ${l.description}` : l.label) }
        : { type: 'choice', instructions: q.instructions,
          criteria: Object.fromEntries(q.choices.map((c, i) => [keys(q)[i]!, c.description ?? String(c.value)])) },
  ])) };
}
const probability = z.number().finite().min(0).max(1);
const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({ type: z.literal('choice'), choice: z.string(), confidence: probability, probabilities: z.record(z.string(), probability) }),
  z.object({ type: z.literal('score'), score: z.number().finite(), confidence: probability,
    probabilities: z.record(z.string(), probability), legend: z.record(z.string(), z.string()) }),
]);
const systemResponse = z.object({ model: z.string().min(1), answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }) });
// Native adapters can round each probability and score to four decimals. Bound the
// resulting error per field, without renormalizing probabilities or confidence.
const roundingHalfUnit = 0.00005;
const arithmeticEpsilon = 1e-12;
export function normalizeSystemOne(raw: unknown, questions: DecisionQuestion[]) {
  const checked = questionsChecked(questions);
  const result = systemResponse.parse(raw);
  if (Object.keys(result.answers).length !== checked.length) throw new DecisionsError('schema');
  return { model: result.model, usage: result.usage, answers: checked.map(q => {
    const answer = result.answers[q.name];
    if (!answer || answer.type !== (q.type === 'predicate' ? 'noul' : q.type)) throw new DecisionsError('schema');
    if (answer.type === 'noul') return { name: q.name, type: 'predicate' as const, probability: answer.noul };
    const allowed = q.type === 'choice' ? keys(q) : q.type === 'score' ? q.levels.map((_, i) => String(i)) : [];
    if (Object.keys(answer.probabilities).length !== allowed.length || allowed.some(k => answer.probabilities[k] === undefined)
      || Math.abs(Object.values(answer.probabilities).reduce((s, p) => s + p, 0) - 1)
        > allowed.length * roundingHalfUnit + arithmeticEpsilon) throw new DecisionsError('schema');
    if (answer.type === 'choice' && q.type === 'choice') {
      const index = allowed.indexOf(answer.choice);
      if (index < 0 || answer.probabilities[answer.choice]! + arithmeticEpsilon < Math.max(...Object.values(answer.probabilities))) {
        throw new DecisionsError('schema');
      }
      return { name: q.name, type: 'choice' as const, choice: q.choices[index]!.value, confidence: answer.confidence,
        probabilities: allowed.map((key, i) => ({ value: q.choices[i]!.value, probability: answer.probabilities[key]! })) };
    }
    if (answer.type === 'score' && q.type === 'score') {
      const expectedScore = allowed.reduce((sum, key, index) => sum + index * answer.probabilities[key]!, 0);
      // Each p_i contributes at most i * halfUnit, plus one halfUnit for score.
      const scoreTolerance = (1 + allowed.length * (allowed.length - 1) / 2) * roundingHalfUnit + arithmeticEpsilon;
      if (answer.score < 0 || answer.score > q.levels.length - 1 || Math.abs(answer.score - expectedScore) > scoreTolerance
          || Object.keys(answer.legend).length !== allowed.length
          || allowed.some((key, index) => {
            const level = q.levels[index]!;
            return answer.legend[key] !== (level.description ? `${level.label}: ${level.description}` : level.label);
          })) throw new DecisionsError('schema');
      return { name: q.name, type: 'score' as const, score: answer.score, confidence: answer.confidence,
        probabilities: allowed.map((key, i) => ({ value: i, label: q.levels[i]!.label, probability: answer.probabilities[key]! })) };
    }
    throw new DecisionsError('schema');
  }) };
}
function localEndpoint(value: string): string {
  try { return validateLocalEndpoint(value); } catch { throw new ProviderError('local', 'schema'); }
}
function httpFailure(provider: ProviderName, status: number, code?: number): ProviderError {
  // Workers AI's documented quota and paid-model codes are billing boundaries, not transient rate limits.
  return new ProviderError(provider, code === 3036 || code === 5035 ? 'billing'
    : status === 401 ? 'authentication' : status === 402 ? 'billing'
    : status === 403 ? 'permission' : status === 429 ? 'rate_limit'
      : status === 400 || status === 422 ? 'schema' : 'service', status);
}
export function createDecisionProvider(mode: RoutingMode, options: { decisionsMockURL?: string } = {}): DecisionProvider {
  const name = providerName(mode);
  if (options.decisionsMockURL && name !== 'openai') throw new DecisionsError('schema');
  if (name === 'offline') return { name, select: async (_issue, reports) => offlineSelection(reports) };
  if (name === 'openai') {
    const client = options.decisionsMockURL ? localDecisionsClient(options.decisionsMockURL) : decisionsClient();
    return { name, select: (issue, reports, signal, evidence) => selectReport(client, issue, reports, signal, evidence) };
  }
  let endpoint: string;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (name === 'local') endpoint = localEndpoint(process.env.PERFDIGEST_CLEF_URL ?? 'http://127.0.0.1:8137/v1/systemone');
  else {
    const account = process.env.PERFDIGEST_CLOUDFLARE_ACCOUNT_ID?.trim();
    const token = process.env.PERFDIGEST_CLOUDFLARE_API_TOKEN?.trim();
    if (!account || !token) throw new ProviderError(name, 'missing_credential');
    if (!/^[a-f0-9]{32}$/i.test(account) || /[\r\n]/.test(token)) throw new ProviderError(name, 'schema');
    endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/clef-flash`;
    headers.authorization = `Bearer ${token}`;
  }
  return { name, async select(issue, reports, signal, evidence = []) {
    const start = performance.now();
    try {
      signal?.throwIfAborted();
      const input = decisionsInput(issue, reports, evidence);
      const questions = [routingQuestion(reports)];
      let response: Response;
      try {
        response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(toSystemOne(input, questions)),
          redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(name === 'local' ? 120_000 : 30_000), ...(signal ? [signal] : [])]) });
      } catch { throw new ProviderError(name, signal?.aborted ? 'cancelled' : 'network'); }
      // One request, no retries, no redirect, no upstream body/headers in diagnostics.
      let text: string;
      try { text = await response.text(); } catch { throw new ProviderError(name, signal?.aborted ? 'cancelled' : 'network'); }
      if (Buffer.byteLength(text) > 128_000) throw new ProviderError(name, 'schema');
      if (!response.ok) {
        let code: number | undefined;
        if (name === 'cloudflare') {
          try {
            const body = JSON.parse(text) as { errors?: Array<{ code?: number }> };
            // Keep only a recognized numeric classification; never retain server text.
            code = body.errors?.find(e => e.code === 3036 || e.code === 5035)?.code;
          } catch { /* HTTP category remains authoritative even for a malformed error body. */ }
        }
        throw httpFailure(name, response.status, code);
      }
      let raw: unknown = JSON.parse(text);
      if (name === 'cloudflare') {
        const envelope = z.object({ success: z.boolean(), result: z.unknown(), errors: z.array(z.unknown()).optional() }).parse(raw);
        if (!envelope.success) throw new ProviderError(name, 'service', response.status);
        raw = envelope.result;
      }
      const normalized = normalizeSystemOne(raw, questions);
      // Check the advertised model identity; this alone cannot verify the server's weights.
      if (!['clef-flash', '@cf/cloudflare/clef-flash'].includes(normalized.model)) throw new ProviderError(name, 'schema');
      return routeDecision(normalized, reports, { source: name === 'local' ? 'clef_local' : 'clef_cloudflare',
        provider: name, transport: name === 'local' ? 'loopback_http' : 'cloudflare_https', confidenceSemantics: 'systemone_uniform_zero',
        inputSha256: createHash('sha256').update(input).digest('hex'), evidenceCount: evidence.length,
        latencyMs: Math.round(performance.now() - start) });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const failure = decisionsFailure(error);
      throw new ProviderError(name, signal?.aborted ? 'cancelled' : failure.kind, failure.httpStatus);
    }
  } };
}
