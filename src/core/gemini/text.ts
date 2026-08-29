/**
 * The two things she asks Gemini for that are not a live conversation.
 *
 * Both are background work. Neither may ever block a turn, and neither may take
 * down a session by throwing — a failed consolidation costs a few facts.
 */

import { FinishReason, GoogleGenAI, ThinkingLevel } from '@google/genai';

import type { Distiller } from '../memory/types.ts';

/**
 * Distilling a transcript into facts is a small structured job on short text,
 * so it does not need the frontier model — but it does need to follow a format,
 * and Flash-Lite drops the format often enough to lose memories. Flash is the
 * cheapest model that reliably does not.
 */
export const DISTILLER_MODEL = 'gemini-3.5-flash';

/**
 * Deadlines for the background calls.
 *
 * Both of these run off the critical path, which is exactly why they need
 * deadlines: nothing above them is watching, so a request that hangs simply
 * never finishes and the work it was doing silently stops happening.
 */
const DISTIL_TIMEOUT_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
/**
 * Shorter than the other two, because this one is on a clock.
 *
 * A caption that takes longer than the interval between captions is a caption
 * that is describing a room that has already changed, and the watcher drops
 * frames while one is in flight — so a slow answer costs the next one as well.
 */
const CAPTION_TIMEOUT_MS = 10_000;

/**
 * `maxOutputTokens` is a parameter because the budget is shared with thinking.
 *
 * Gemini 3 spends part of any output allowance reasoning before it writes, so a
 * cap sized for a short reply can truncate the reply itself. The default suits a
 * consolidation pass; a job that asks for a dozen facts and a summary needs to
 * say so.
 */
export function createGeminiDistiller(
  apiKey: string,
  model = DISTILLER_MODEL,
  maxOutputTokens = 900,
): Distiller {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async distil(system, transcript) {
      const response = await ai.models.generateContent({
        model,
        contents: transcript,
        config: {
          systemInstruction: system,
          temperature: 0.2,
          maxOutputTokens,
          /*
           * The third call in this file to need this, and the last one without it.
           *
           * The header above already explains that Gemini 3 spends part of any
           * output allowance reasoning before it writes, and it was written for
           * this function — yet the fix went to the caption and the transcriber
           * and not to the distiller. Observed truncating a real consolidation
           * on 2026-08-29: two facts written, "ran out of output budget; the
           * last fact was dropped" on the third. Extracting facts from a
           * transcript is mechanical, so thinking here can only take room the
           * facts need.
           */
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          abortSignal: AbortSignal.timeout(DISTIL_TIMEOUT_MS),
        },
      });

      // `MAX_TOKENS` is the SDK's own name for "ran out of output budget", and
      // the enum is the authority on the spelling. Absent means the backend did
      // not say; that is reported as not truncated, because inventing the answer
      // would throw away a good fact on every reply that omits the field.
      const truncated = response.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS;
      return { text: response.text ?? '', truncated };
    },
  };
}

/**
 * Turns a file someone sent into words the live session can hear.
 *
 * This exists because of a codec, not a design preference. The Live API takes
 * raw 16kHz PCM and nothing else, and a Telegram voice note is Opus in an Ogg
 * container. Decoding that in-process would mean either a native dependency
 * with a Windows toolchain requirement or a WebAssembly decoder several times
 * the size of this entire program.
 *
 * So the file goes to a Gemini model that already understands it, and what
 * comes back is fed to the live session as though the user had typed it. The
 * conversation stays in one session with one memory, and the cost is one extra
 * round trip on a message that was already asynchronous.
 */
/**
 * One sentence about what is in front of the camera.
 *
 * Short on purpose, and the shortness is the feature: this caption is never
 * shown to anybody and never spoken. Its only job is to be *diffable* against
 * the last one — see `senses/watch.ts` — so a paragraph would add cost, latency
 * and false positives without adding a single change she could notice.
 *
 * Temperature zero for the same reason. Two captions of an identical scene
 * differing because the sampler felt like it would fire the change detector
 * every twenty seconds forever.
 */
export async function captionFrame(
  apiKey: string,
  frame: Buffer,
  model = DISTILLER_MODEL,
): Promise<string> {
  if (!apiKey) return '';
  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { data: frame.toString('base64'), mimeType: 'image/jpeg' } },
            {
              text: [
                'One short sentence describing only what is plainly visible: who is there,',
                'what they are doing, what they are holding, the light, the room.',
                'No preamble, no hedging, no speculation about how they feel.',
              ].join('\n'),
            },
          ],
        },
      ],
      config: {
        temperature: 0,
        maxOutputTokens: 200,
        /*
         * Thinking off, or the caption is a fragment.
         *
         * Measured on 2026-08-29 against two solid-colour frames: with thinking
         * left at its default this returned "The image is a solid," and "The
         * image consists entirely of a solid," — cut off exactly where the
         * useful word was about to appear, because the reasoning had already
         * spent the two hundred tokens. `createGeminiDistiller` documents this
         * hazard above and this call had never been given the same treatment.
         *
         * It is not a cosmetic truncation. `CameraWatcher` diffs one caption
         * against the last to decide whether anything changed, and two
         * fragments that both stop before the noun score 0.67 against a
         * threshold of 0.8 — so a room that had genuinely changed read as
         * unchanged, and criterion 2 quietly did not work. With thinking
         * minimal the same two frames caption as "a solid, dark, uniform black
         * surface" and "a solid, uniform light beige background".
         *
         * Minimal rather than a larger budget: it is one sentence about one
         * picture, reasoning buys nothing, and this runs every twenty seconds
         * for as long as she is awake.
         */
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        abortSignal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
      },
    });
    return (response.text ?? '').trim();
  } catch {
    return '';
  }
}

export async function transcribeMedia(
  apiKey: string,
  media: { data: Buffer; mimeType: string },
  model = DISTILLER_MODEL,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { data: media.data.toString('base64'), mimeType: media.mimeType } },
            {
              text: [
                'Write out what the person says, verbatim, as plain text with no quotation marks',
                'and no preamble.',
                'If the recording also shows them, add one short sentence afterwards, in square',
                'brackets, describing only what is plainly visible — for example',
                '[they are outside, it is dark, they look tired].',
                'If nothing is said, give only the bracketed description.',
              ].join('\n'),
            },
          ],
        },
      ],
      config: {
        temperature: 0,
        maxOutputTokens: 400,
        // Same hazard as the caption above, and the same answer: transcribing is
        // mechanical, so reasoning can only eat the budget the words need. Not
        // separately measured — the caption is the case that was caught.
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      },
    });
    return (response.text ?? '').trim();
  } catch {
    return '';
  }
}
