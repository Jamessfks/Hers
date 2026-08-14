/**
 * Looking at the user.
 *
 * A single non-streaming multimodal call, kept separate from the streaming
 * conversation providers on purpose. Vision here is not a conversation: it is
 * one question, asked on a slow timer, whose answer is a short sentence that
 * gets folded into Anna's situation. Wiring it through the streaming interface
 * would mean giving that interface an image type, a non-streaming mode, and a
 * second response shape, all to serve one caller.
 *
 * The prompt is as important as the plumbing. Asked to "describe this image", a
 * vision model returns a paragraph about the room, the lighting and the
 * furniture, and Anna ends up commenting on someone's curtains. Asked the
 * question below, it returns the one clause a person in the room would actually
 * register.
 */

import type { LlmProviderId } from '../../shared/protocol.ts';
import { tryJson } from './sse.ts';

const PROMPT = `
Look at this person the way a friend sitting across the room would.

Answer with one short clause describing their posture and apparent state, in
the third person, present tense. Examples of the register:
  "slumped forward, rubbing their eyes"
  "sitting up, focused"
  "leaning back with their arms crossed"
  "not in frame"

Do not describe the room, their clothes, their appearance, or anything on their
screen. Do not guess at emotions you cannot see. If the frame is empty or too
dark to tell, answer exactly: not in frame
`.trim();

/** Vision-capable defaults, used when the conversation model is text-only. */
const VISION_MODELS: Record<LlmProviderId, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4.1-mini',
  google: 'gemini-2.5-flash',
};

export interface LookRequest {
  provider: LlmProviderId;
  apiKey: string;
  /** JPEG bytes, base64, no data-URL prefix. */
  jpegBase64: string;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Returns a short description of the person, or null when the frame is
 * unusable. Never throws: a failed look is a moment of not noticing, not an
 * error the user should hear about.
 */
export async function describePerson(request: LookRequest): Promise<string | null> {
  try {
    const model = request.model ?? VISION_MODELS[request.provider];
    const text = await callVisionModel(request, model);
    const clean = text.trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (!clean || clean.startsWith('not in frame')) return null;
    // Guard against a model that ignores the instruction and writes an essay.
    return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
  } catch {
    return null;
  }
}

async function callVisionModel(request: LookRequest, model: string): Promise<string> {
  const { provider, apiKey, jpegBase64, signal } = request;

  if (provider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: signal ?? null,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 60,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 },
              },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      }),
    });
    const body = tryJson<{ content?: Array<{ text?: string }> }>(await response.text());
    return body?.content?.[0]?.text ?? '';
  }

  if (provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: signal ?? null,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: 60,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${jpegBase64}`, detail: 'low' },
              },
            ],
          },
        ],
      }),
    });
    const body = tryJson<{ choices?: Array<{ message?: { content?: string } }> }>(
      await response.text(),
    );
    return body?.choices?.[0]?.message?.content ?? '';
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    signal: signal ?? null,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: jpegBase64 } },
            { text: PROMPT },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 60 },
    }),
  });
  const body = tryJson<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  }>(await response.text());
  return body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
