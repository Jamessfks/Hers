/**
 * Which model Anna talks through.
 *
 * This file exists because of a specific, silent bug. Model names used to live
 * in two places — a `suggestedModels` array on each provider and a duplicate
 * table in the settings window — and the settings window carried the *current*
 * model across a provider change. Switch from Anthropic to OpenAI and the
 * config still said `claude-sonnet-5`, so every single request 404'd with a
 * vendor error nobody would connect back to a dropdown they had touched a
 * minute earlier.
 *
 * The fixes are all here:
 *
 *  - one catalogue, imported by both the providers and the UI;
 *  - {@link modelBelongsTo}, so a model from the wrong vendor is detectable
 *    rather than merely wrong;
 *  - {@link resolveModel}, a pure function that can never return a model
 *    belonging to a different provider than the one being configured.
 *
 * The catalogue is a *fallback*. Providers fetch their real model list at
 * runtime — see `listModels` — because a hardcoded list is out of date the day
 * a vendor ships anything.
 */

import type { LlmProviderId } from '../../shared/protocol.ts';

export interface ModelOption {
  id: string;
  /** Human label. Falls back to the id when the vendor gives no display name. */
  label: string;
}

/**
 * Known-good models per provider, best default first.
 *
 * "Best default" means best *for a companion*: fast enough to stay inside the
 * latency budget, warm enough not to sound like a support agent. That is not
 * the same as the vendor's flagship, which is why the largest model is never
 * first.
 */
export const MODEL_CATALOG: Record<LlmProviderId, readonly string[]> = {
  anthropic: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
  google: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
};

export function defaultModelFor(provider: LlmProviderId): string {
  return MODEL_CATALOG[provider][0] ?? '';
}

/**
 * Which provider a model name belongs to, by naming convention.
 *
 * Vendors are consistent enough about their own prefixes that this is reliable,
 * and the cost of being wrong is small: an unrecognised name is treated as
 * "could be anyone's", which means a custom or fine-tuned model is left alone
 * rather than being helpfully deleted.
 */
export function modelBelongsTo(model: string): LlmProviderId | null {
  const name = model.trim().toLowerCase();
  if (!name) return null;
  if (name.startsWith('claude')) return 'anthropic';
  if (name.startsWith('gemini') || name.startsWith('models/gemini')) return 'google';
  if (/^(gpt|o[1-4]($|-)|chatgpt|text-|davinci)/.test(name)) return 'openai';
  return null;
}

/** True when this model definitely belongs to some *other* vendor. */
export function isForeignModel(provider: LlmProviderId, model: string): boolean {
  const owner = modelBelongsTo(model);
  return owner !== null && owner !== provider;
}

export interface ResolveModelInput {
  provider: LlmProviderId;
  /** The model currently in config, which may belong to another provider. */
  current?: string;
  /** What the user last chose for each provider. */
  remembered?: Partial<Record<LlmProviderId, string>>;
  /** Live model ids from the provider, if the list could be fetched. */
  available?: readonly string[];
}

/**
 * Picks the model to use for `provider`.
 *
 * Ordered by how much the user has told us:
 *
 *   1. what they last chose for *this* provider, if it still exists;
 *   2. the current model, but only if it is not obviously another vendor's —
 *      this is what lets a custom or fine-tuned name survive a round trip;
 *   3. the first catalogue entry the provider actually offers;
 *   4. the first thing the provider offers at all;
 *   5. the catalogue default, when nothing could be fetched.
 *
 * The one guarantee worth stating: given a non-empty `available`, the result is
 * always in it. Given an empty one, the result is never a model that belongs to
 * a different vendor.
 */
export function resolveModel(input: ResolveModelInput): string {
  const { provider, current, remembered, available } = input;
  const offered = available ?? [];
  const has = (model: string | undefined): model is string =>
    Boolean(model) && (offered.length === 0 || offered.includes(model as string));

  const rememberedForProvider = remembered?.[provider];
  if (has(rememberedForProvider) && !isForeignModel(provider, rememberedForProvider)) {
    return rememberedForProvider;
  }

  if (current && !isForeignModel(provider, current) && has(current)) return current;

  for (const candidate of MODEL_CATALOG[provider]) {
    if (offered.length === 0 || offered.includes(candidate)) return candidate;
  }

  return offered[0] ?? defaultModelFor(provider);
}

/**
 * Orders a fetched model list so the useful ones are at the top.
 *
 * Vendor list endpoints return everything, in no helpful order — embeddings,
 * moderation endpoints, dated snapshots, deprecated generations. A companion's
 * settings screen should open on something you would actually pick, not on
 * `babbage-002`.
 */
export function rankModels(
  provider: LlmProviderId,
  models: readonly ModelOption[],
): ModelOption[] {
  const catalogue = MODEL_CATALOG[provider];
  const rank = (id: string): number => {
    const index = catalogue.indexOf(id);
    if (index !== -1) return index;
    // Unknown but plausibly a chat model: after the catalogue, before the junk.
    return isConversational(provider, id) ? 100 : 1000;
  };
  return [...models].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** Rough filter for "could Anna hold a conversation through this". */
export function isConversational(provider: LlmProviderId, id: string): boolean {
  const name = id.toLowerCase();
  if (/embed|moderation|whisper|tts|dall-e|image|audio|realtime|search|rerank|aqa/.test(name)) {
    return false;
  }
  if (provider === 'anthropic') return name.startsWith('claude');
  if (provider === 'google') return name.includes('gemini');
  return /^(gpt|o[1-4]($|-)|chatgpt)/.test(name);
}
