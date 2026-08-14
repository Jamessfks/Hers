/**
 * Anthropic Messages API.
 *
 * Quirks this file absorbs so nothing above it has to care:
 *  - the system prompt is a top-level field, not a message with role "system";
 *  - deltas arrive as `content_block_delta` events with a nested `text` field;
 *  - errors mid-stream arrive as an SSE `error` event with HTTP 200 already
 *    sent, so a status check alone will happily stream a failure as silence.
 */

import { readSse, tryJson } from './sse.ts';
import { MODEL_CATALOG, isConversational, rankModels, type ModelOption } from './models.ts';
import {
  LlmError,
  type CompletionRequest,
  type LlmProvider,
  type ProviderOptions,
} from './types.ts';

const API_VERSION = '2023-06-01';

interface AnthropicDelta {
  type: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string };
}

export function createAnthropicProvider(
  apiKey: string,
  options: ProviderOptions = {},
): LlmProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const root = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
  };

  return {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    suggestedModels: MODEL_CATALOG.anthropic,

    async *stream(request: CompletionRequest) {
      const response = await doFetch(`${root}/v1/messages`, {
        method: 'POST',
        headers,
        signal: request.signal ?? null,
        body: JSON.stringify({
          model: request.model,
          /*
           * The persona is ~4kB and identical on every turn, so it is cached
           * rather than re-read each time.
           *
           * Measured on a real 10-turn session with Haiku: time to first
           * performance event was 900-1550ms, most of it spent re-processing a
           * prompt that had not changed. A cache hit also bills those tokens at
           * a tenth of the input rate, which matters when the whole point is to
           * run this on someone's own key.
           *
           * The breakpoint goes on the system block only. Messages change every
           * turn, so caching them would thrash the cache for no benefit.
           */
          system: [
            {
              type: 'text',
              text: request.system,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: request.messages,
          max_tokens: request.maxTokens ?? 400,
          temperature: request.temperature ?? 1,
          stream: true,
        }),
      });

      if (!response.ok || !response.body) {
        throw new LlmError(await describeFailure(response), response.status, 'anthropic');
      }

      for await (const event of readSse(response.body)) {
        const frame = tryJson<AnthropicDelta>(event.data);
        if (!frame) continue;
        if (frame.type === 'error') {
          throw new LlmError(frame.error?.message ?? 'stream error', undefined, 'anthropic');
        }
        if (frame.type === 'content_block_delta' && frame.delta?.text) {
          yield frame.delta.text;
        }
      }
    },

    /**
     * Checked against the models endpoint rather than by sending a message.
     *
     * The previous check POSTed a one-token completion: it works, but it bills
     * the user for validating a key and it hardcodes a model name that will
     * eventually be retired, at which point key validation starts failing for
     * everyone with a perfectly good key. A GET is free and cannot go stale.
     */
    async validateKey() {
      const response = await doFetch(`${root}/v1/models?limit=1`, { headers });
      if (response.ok) return { ok: true as const };
      return { ok: false as const, reason: await describeFailure(response) };
    },

    async listModels(): Promise<ModelOption[]> {
      try {
        const response = await doFetch(`${root}/v1/models?limit=100`, { headers });
        if (!response.ok) return [];
        const body = (await response.json()) as {
          data?: Array<{ id?: string; display_name?: string }>;
        };
        const models = (body.data ?? [])
          .filter((entry): entry is { id: string; display_name?: string } => Boolean(entry.id))
          .map((entry) => ({ id: entry.id, label: entry.display_name ?? entry.id }))
          .filter((model) => isConversational('anthropic', model.id));
        return rankModels('anthropic', models);
      } catch {
        return [];
      }
    },
  };
}

async function describeFailure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  const parsed = tryJson<{ error?: { message?: string } }>(body);
  const detail = parsed?.error?.message ?? body.slice(0, 200);
  if (response.status === 401) return 'That key was rejected. Check it and try again.';
  if (response.status === 429) return 'Rate limited by Anthropic. Slow down or upgrade the plan.';
  return `Anthropic returned ${response.status}${detail ? `: ${detail}` : ''}`;
}
