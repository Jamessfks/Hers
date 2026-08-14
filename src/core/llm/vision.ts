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

/**
 * The passive look, on a timer.
 *
 * Narrow on purpose: posture and state only, nothing about the room, the
 * clothes or the screen. A companion that volunteers observations about your
 * appearance is a different and worse product.
 *
 * The `off:` line exists because the alternative was grepping the prose for
 * words like "slump" and "rubbing" — which only ever matched because those
 * words were in this prompt's own examples. Asking the model for the judgement
 * is both more honest and far more reliable than pattern-matching its writing.
 */
const PASSIVE_PROMPT = `
Look at this person the way a friend sitting across the room would.

Reply with exactly two lines and nothing else:

state: <one short clause, third person, present tense, describing posture and
apparent state. e.g. "slumped forward, rubbing their eyes" or "sitting up,
focused". If the frame is empty or too dark to tell, write: not in frame>
off: <yes or no — does this person look like they are having a hard time?
Tired, upset, tense, defeated, in pain. Answer no if they simply look neutral
or busy.>

Do not describe the room, their clothes, their appearance, or anything on their
screen. Do not guess at emotions you cannot see.
`.trim();

/**
 * The requested look, when the user has actually asked her to look.
 *
 * The passive prompt forbids describing appearance and objects, which is right
 * for a camera sampling you every 45 seconds and useless when someone holds
 * something up and says "look at this". Asking is consent, so the restriction
 * lifts — but only for that turn, and only because they asked.
 */
const REQUESTED_PROMPT = `
Someone has just asked you to look at them, so look properly.

Reply with exactly two lines and nothing else:

state: <one or two short clauses describing what you can actually see — what
they are doing, what they are holding or showing you, anything obviously
different about them. Third person, present tense. If the frame is empty or too
dark, write: not in frame>
off: <yes or no — do they look like they are having a hard time?>

They asked, so it is fine to mention what they are wearing or holding. Still do
not read anything off their screen, and do not guess at feelings you cannot see.
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
  /** True when the user asked her to look, which lifts the usual restraint. */
  requested?: boolean;
}

export interface Look {
  /** One clause about their state, or null when there is nobody to see. */
  read: string | null;
  /**
   * The model's own judgement that they are having a hard time.
   *
   * A flag rather than keywords in prose. The old approach grepped the reply
   * for 'slump', 'rubbing' and friends — words that only appeared because the
   * prompt's own examples used them, so it matched roughly one plausible
   * description in fifteen and missed "head down", "face in their hands" and
   * "pinching the bridge of their nose" entirely.
   */
  distressed: boolean;
}

/**
 * Returns a short description of the person, or null when the frame is
 * unusable. Never throws: a failed look is a moment of not noticing, not an
 * error the user should hear about.
 */
export async function describePerson(request: LookRequest): Promise<Look> {
  try {
    const model = request.model ?? VISION_MODELS[request.provider];
    const text = await callVisionModel(request, model);
    return parseLook(text);
  } catch {
    return { read: null, distressed: false };
  }
}

/**
 * Parses the two-line reply, tolerantly.
 *
 * Models drop the labels, add a preamble, or answer in one line. None of that
 * should cost a look, so an unlabelled reply is treated as the state clause and
 * a missing flag as "no".
 */
export function parseLook(text: string): Look {
  const lines = text.trim().split('\n').map((line) => line.trim()).filter(Boolean);

  let state = '';
  let distressed = false;
  for (const line of lines) {
    const stateMatch = /^state\s*:\s*(.+)$/i.exec(line);
    const offMatch = /^off\s*:\s*(.+)$/i.exec(line);
    if (stateMatch?.[1]) state = stateMatch[1];
    else if (offMatch?.[1]) distressed = /^y(es)?\b/i.test(offMatch[1].trim());
    else if (!state) state = line;
  }

  const clean = state.replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (!clean || clean.startsWith('not in frame')) return { read: null, distressed: false };
  // Guard against a model that ignores the instruction and writes an essay.
  const read = clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
  return { read, distressed };
}

function promptFor(request: LookRequest): string {
  return request.requested ? REQUESTED_PROMPT : PASSIVE_PROMPT;
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
        max_tokens: 120,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 },
              },
              { type: 'text', text: promptFor(request) },
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
        max_completion_tokens: 120,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptFor(request) },
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
            { text: promptFor(request) },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 120 },
    }),
  });
  const body = tryJson<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  }>(await response.text());
  return body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
