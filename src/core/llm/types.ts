/**
 * The provider-agnostic language model interface.
 *
 * Anna never talks to a vendor SDK. She talks to this. Three consequences that
 * are worth the indirection:
 *
 *  - The user brings their own key for whichever provider they already pay for,
 *    and switching providers is a dropdown, not a rewrite.
 *  - Nothing above this layer knows what a "system prompt" or a "content block"
 *    looks like, so provider quirks stay in one file each.
 *  - Streaming is the only mode. A companion that waits for a complete response
 *    before making a sound is a companion with a two-second dead stare, and no
 *    amount of animation polish recovers from that.
 */

import type { ModelOption } from './models.ts';

export type { ModelOption };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: readonly ChatMessage[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** Aborts the request when the user interrupts Anna mid-sentence. */
  signal?: AbortSignal;
}

/**
 * A `fetch` implementation.
 *
 * Injected rather than reached for globally so the adapters can be tested
 * against recorded vendor payloads — including the failure shapes, which is
 * where the interesting behaviour lives and which no live account will
 * reliably reproduce on demand.
 */
export type FetchLike = typeof globalThis.fetch;

export interface ProviderOptions {
  /** Override for tests, or to point at a compatible gateway. */
  fetch?: FetchLike;
  /** Override the API root. Used by OpenAI-compatible endpoints. */
  baseUrl?: string;
}

export interface LlmProvider {
  readonly id: string;
  /** Human-readable name for the settings UI. */
  readonly label: string;
  /** Fallback list, used when the live one cannot be fetched. */
  readonly suggestedModels: readonly string[];
  /** Streams the reply as it is generated. Yields raw text deltas. */
  stream(request: CompletionRequest): AsyncIterable<string>;
  /** Cheap credential check for the onboarding screen. */
  validateKey(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * The models this account can actually use, newest-first as the vendor
   * returns them. Never throws: an unreachable list degrades the picker to the
   * built-in catalogue, which is a worse menu rather than a broken screen.
   */
  listModels(): Promise<ModelOption[]>;
}

export class LlmError extends Error {
  readonly status: number | undefined;
  readonly provider: string | undefined;

  constructor(message: string, status?: number, provider?: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.provider = provider;
  }

  /** True when retrying the same request might work. */
  get retryable(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}
