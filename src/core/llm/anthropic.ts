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
import { LlmError, type CompletionRequest, type LlmProvider } from './types.ts';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

interface AnthropicDelta {
  type: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string };
}

export function createAnthropicProvider(apiKey: string): LlmProvider {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
  };

  return {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    suggestedModels: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],

    async *stream(request: CompletionRequest) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers,
        signal: request.signal ?? null,
        body: JSON.stringify({
          model: request.model,
          system: request.system,
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

    async validateKey() {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      // A 400 means the key authenticated and the model name was the problem,
      // which is still a working key.
      if (response.ok || response.status === 400) return { ok: true as const };
      return { ok: false as const, reason: await describeFailure(response) };
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
