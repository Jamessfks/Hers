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

export interface LlmProvider {
  readonly id: string;
  /** Human-readable name for the settings UI. */
  readonly label: string;
  /** Models we suggest in the picker. The field stays free-text. */
  readonly suggestedModels: readonly string[];
  /** Streams the reply as it is generated. Yields raw text deltas. */
  stream(request: CompletionRequest): AsyncIterable<string>;
  /** Cheap credential check for the onboarding screen. */
  validateKey(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly provider?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  /** True when retrying the same request might work. */
  get retryable(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}
