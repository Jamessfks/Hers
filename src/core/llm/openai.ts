/**
 * OpenAI Chat Completions API.
 *
 * Quirks this file absorbs:
 *  - the system prompt is an ordinary message with role "system";
 *  - the stream terminates with a literal `data: [DONE]` sentinel that is not
 *    JSON, so a parser that calls JSON.parse unconditionally throws on the last
 *    frame of every successful request;
 *  - a chunk can carry an empty `content` string, which must not be treated as
 *    end of stream.
 *
 * The Chat Completions shape is used rather than the newer Responses API
 * because it is what every OpenAI-compatible gateway also speaks. Pointing
 * `baseUrl` at Groq, Together, OpenRouter or a local llama.cpp server is then a
 * configuration change, which keeps a promise the settings screen makes.
 */

import { readSse, tryJson } from './sse.ts';
import { MODEL_CATALOG, isConversational, rankModels, type ModelOption } from './models.ts';
import {
  LlmError,
  type CompletionRequest,
  type LlmProvider,
  type ProviderOptions,
} from './types.ts';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

interface OpenAiChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  error?: { message?: string };
}

export function createOpenAiProvider(apiKey: string, options: ProviderOptions = {}): LlmProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  const root = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    id: 'openai',
    label: 'OpenAI (or any compatible endpoint)',
    suggestedModels: MODEL_CATALOG.openai,

    async *stream(request: CompletionRequest) {
      const response = await doFetch(`${root}/chat/completions`, {
        method: 'POST',
        headers,
        signal: request.signal ?? null,
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: 'system', content: request.system }, ...request.messages],
          max_completion_tokens: request.maxTokens ?? 400,
          temperature: request.temperature ?? 1,
          stream: true,
        }),
      });

      if (!response.ok || !response.body) {
        throw new LlmError(await describeFailure(response), response.status, 'openai');
      }

      for await (const event of readSse(response.body)) {
        if (event.data === '[DONE]') return;
        const frame = tryJson<OpenAiChunk>(event.data);
        if (!frame) continue;
        if (frame.error) {
          throw new LlmError(frame.error.message ?? 'stream error', undefined, 'openai');
        }
        const delta = frame.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    },

    async validateKey() {
      const response = await doFetch(`${root}/models`, { headers });
      if (response.ok) return { ok: true as const };
      return { ok: false as const, reason: await describeFailure(response) };
    },

    async listModels(): Promise<ModelOption[]> {
      try {
        const response = await doFetch(`${root}/models`, { headers });
        if (!response.ok) return [];
        const body = (await response.json()) as { data?: Array<{ id?: string }> };
        const models = (body.data ?? [])
          .filter((entry): entry is { id: string } => Boolean(entry.id))
          .map((entry) => ({ id: entry.id, label: entry.id }))
          // The list endpoint returns embeddings, moderation, audio and image
          // models alongside the chat ones. Anna can only talk through a chat
          // model, and a picker that opens on `babbage-002` is a broken picker.
          .filter((model) => isConversational('openai', model.id));
        return rankModels('openai', models);
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
  if (response.status === 429) return 'Rate limited, or the account is out of credit.';
  return `OpenAI returned ${response.status}${detail ? `: ${detail}` : ''}`;
}
