/**
 * Google Gemini generateContent API.
 *
 * Quirks this file absorbs:
 *  - messages are `contents` with `parts`, and the assistant role is spelled
 *    "model";
 *  - the system prompt goes in `systemInstruction`, which has the same
 *    parts-shaped body as a message;
 *  - streaming requires `?alt=sse`; without it the endpoint returns a single
 *    JSON array and the whole reply lands at once, which looks like the
 *    streaming worked until you time the first audio;
 *  - a blocked response arrives as a 200 with `promptFeedback.blockReason` and
 *    no candidates, so "no error and no text" has to be handled explicitly.
 */

import { readSse, tryJson } from './sse.ts';
import { LlmError, type CompletionRequest, type LlmProvider } from './types.ts';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export function createGoogleProvider(apiKey: string): LlmProvider {
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey };

  return {
    id: 'google',
    label: 'Google (Gemini)',
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],

    async *stream(request: CompletionRequest) {
      const url = `${ENDPOINT}/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
      const response = await fetch(url, {
        method: 'POST',
        headers,
        signal: request.signal ?? null,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: request.messages.map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          generationConfig: {
            maxOutputTokens: request.maxTokens ?? 400,
            temperature: request.temperature ?? 1,
          },
        }),
      });

      if (!response.ok || !response.body) {
        throw new LlmError(await describeFailure(response), response.status, 'google');
      }

      let produced = false;
      for await (const event of readSse(response.body)) {
        const frame = tryJson<GeminiChunk>(event.data);
        if (!frame) continue;
        if (frame.error) {
          throw new LlmError(frame.error.message ?? 'stream error', undefined, 'google');
        }
        if (frame.promptFeedback?.blockReason) {
          throw new LlmError(
            `Gemini blocked the turn (${frame.promptFeedback.blockReason}).`,
            undefined,
            'google',
          );
        }
        for (const part of frame.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) {
            produced = true;
            yield part.text;
          }
        }
      }

      if (!produced) {
        throw new LlmError('Gemini returned an empty response.', undefined, 'google');
      }
    },

    async validateKey() {
      const response = await fetch(`${ENDPOINT}?pageSize=1`, { headers });
      if (response.ok) return { ok: true as const };
      return { ok: false as const, reason: await describeFailure(response) };
    },
  };
}

async function describeFailure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  const parsed = tryJson<{ error?: { message?: string } }>(body);
  const detail = parsed?.error?.message ?? body.slice(0, 200);
  if (response.status === 400 || response.status === 403) {
    return 'That key was rejected, or the Generative Language API is not enabled for it.';
  }
  if (response.status === 429) return 'Rate limited by Google.';
  return `Google returned ${response.status}${detail ? `: ${detail}` : ''}`;
}
