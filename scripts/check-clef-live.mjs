// Explicit opt-in: one provider request using measured PerfDigest evidence, then Codex review.
// Local HTTP alone cannot attest which weights/process produced a response.
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { demoManifest } from '../dist/demo.js';
import { investigate } from '../dist/run.js';
import { createDecisionProvider, providerName } from '../dist/providers.js';
import { manifestSchema } from '../dist/config.js';
import { writeJson } from '../dist/files.js';
import { redact } from '../dist/environment.js';

if (process.env.PERFDIGEST_RUN_CLEF_INTEGRATION !== '1') {
  console.log(JSON.stringify({ status: 'skipped', requests: 0, inferenceValidated: false, responseValidated: false }));
  process.exit(0);
}
const { values } = parseArgs({ options: { provider: { type: 'string' }, manifest: { type: 'string' },
  workspace: { type: 'string' }, codex: { type: 'boolean' }, quantization: { type: 'string' },
  'decision-model': { type: 'string' } } });
if (!['cloudflare', 'local'].includes(values.provider)) throw new Error('Explicit --provider cloudflare|local required');
const provider = providerName(values.provider);
const modelOption = values['decision-model'] !== undefined ? { cloudflareModel: values['decision-model'] } : {};
createDecisionProvider(provider, modelOption); // Fail before capture/ChatGPT access; unknown models never reach the network.
const parent = resolve('work/clef'); await mkdir(parent, { recursive: true });
const workspace = values.workspace ? resolve(values.workspace) : await mkdtemp(join(parent, `${provider}-`));
await mkdir(workspace, { recursive: true });
try {
  const manifest = values.manifest ? manifestSchema.parse(JSON.parse(await readFile(resolve(values.manifest), 'utf8')))
    : await demoManifest(workspace);
  // Local tests must use a trace captured before starting inference; no GPU workload/capture competes with Clef.
  if (provider === 'local' && (!values.manifest || manifest.captures.length)) {
    throw new Error('Local Clef integration requires --manifest with captures=[]; capture before loading the local server');
  }
  const result = await investigate({ workspace, manifest, routing: provider, agent: values.codex ? 'codex' : 'none', ...modelOption,
    model: 'gpt-6-astra', effort: 'max', onEvent: (event, detail) => process.stderr.write(`${event}${detail ? `: ${redact(detail)}` : ''}\n`) });
  const decision = result.evidence?.decision;
  const receipt = { status: result.status, responseValidated: !!decision,
    inferenceValidated: provider === 'cloudflare' && !!decision, syntheticFixture: provider === 'cloudflare' ? false : null,
    identityBasis: provider === 'cloudflare' ? 'authenticated TLS request to fixed Workers AI model endpoint'
      : 'local SystemOne response only; correlate independent server/process/model-hash receipt before claiming genuine Clef inference',
    provider, model: decision?.model ?? null, requestedModel: decision?.requestedModel ?? null, quantization: provider === 'local' ? values.quantization ?? null : null,
    quantizationBasis: provider === 'local' ? 'caller label; verify against independent model hash receipt' : 'provider managed, not observed',
    requests: decision?.requests ?? null, decision: decision ?? null,
    evidence: result.evidence?.evidence.map(e => ({ id: e.report.id, reference: e.report.path, sha256: e.sha256, provenance: e.provenance })) ?? [],
    verification: result.verification ? { exitCode: result.verification.exitCode, timedOut: result.verification.timedOut, aborted: result.verification.aborted } : null,
    wallMs: result.telemetry.wallMs, overlapMs: result.telemetry.evidenceModelOverlapMs,
    codex: { execution: values.codex ? 'existing_chatgpt_login' : 'not_requested', model: values.codex ? 'gpt-6-astra' : null,
      effort: values.codex ? 'max' : null, sameThread: result.analysis && result.review ? result.analysis.threadId === result.review.threadId : null,
      usage: { analysis: result.analysis?.usage ?? null, review: result.review?.usage ?? null } },
    runDirectory: result.directory, error: result.decisionsError ?? result.error,
    limits: ['Controlled CPU example, not a solved PyTorch issue', 'One trial, no speedup or calibration claim', 'Provider confidence is not verification'],
  };
  await writeJson(join(workspace, 'clef-receipt.json'), receipt);
  console.log(redact(JSON.stringify(receipt, null, 2)));
  assert.equal(result.status, 'complete'); assert.equal(decision.requests, 1); assert.equal(result.verification.exitCode, 0);
  if (values.codex) assert.equal(result.analysis.threadId, result.review.threadId);
} catch (error) { console.error(redact(error instanceof Error ? error.message : 'Clef integration failed')); process.exitCode = 1; }
