// Dependency-free so setup validation and the runtime provider share one model list.
/**
 * Cloudflare Workers AI Clef decision models. All share the SystemOne/Jev typed-question
 * contract (noul, choice/criteria, score/criteria) and its confidence semantics (0 at a
 * uniform distribution; not calibrated, not correctness). The plugin sends text state only.
 * `liveQualified` records the last genuine inference observed by this project; null means
 * the model is documented by Cloudflare but has not been exercised live here.
 */
export interface CloudflareModelSpec {
  readonly id: `@cf/cloudflare/${string}`;
  readonly requestModel: string;
  readonly identities: readonly string[];
  readonly confidenceSemantics: 'systemone_uniform_zero';
  readonly questionTypes: readonly ['noul', 'choice', 'score'];
  readonly pluginInputs: readonly ['text'];
  readonly documentedMediaInputs: readonly string[];
  readonly documentation: string;
  readonly liveQualified: string | null;
}
const spec = (name: string, media: string[], liveQualified: string | null): CloudflareModelSpec => ({
  id: `@cf/cloudflare/${name}`, requestModel: name, identities: [name, `@cf/cloudflare/${name}`],
  confidenceSemantics: 'systemone_uniform_zero', questionTypes: ['noul', 'choice', 'score'], pluginInputs: ['text'],
  documentedMediaInputs: media, documentation: `https://developers.cloudflare.com/workers-ai/models/${name}/`, liveQualified,
});
export const cloudflareModels = {
  'clef-flash': spec('clef-flash', [], '2026-10-18'),
  clef: spec('clef', ['image'], null),
  'clef-omni': spec('clef-omni', ['image', 'audio', 'video'], null),
} as const satisfies Record<string, CloudflareModelSpec>;
export type CloudflareModelName = keyof typeof cloudflareModels;
export const defaultCloudflareModel: CloudflareModelName = 'clef-flash';
export function isCloudflareModelName(name: string): name is CloudflareModelName {
  return Object.hasOwn(cloudflareModels, name);
}
