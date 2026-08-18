/**
 * The two things she asks Gemini for that are not a live conversation.
 *
 * Both are background work. Neither may ever block a turn, and neither may take
 * down a session by throwing — a failed consolidation costs a few facts, and a
 * failed picture costs a picture.
 */

import { FinishReason, GoogleGenAI, Modality } from '@google/genai';

import { sniffImage } from '../avatar/image-info.ts';
import type { Distiller } from '../memory/types.ts';

/**
 * Distilling a transcript into facts is a small structured job on short text,
 * so it does not need the frontier model — but it does need to follow a format,
 * and Flash-Lite drops the format often enough to lose memories. Flash is the
 * cheapest model that reliably does not.
 */
export const DISTILLER_MODEL = 'gemini-3.5-flash';

/** Nano Banana 2. Fast, cheap, and good at holding a face across generations. */
export const IMAGE_MODEL = 'gemini-3.1-flash-image';

/**
 * Deadlines for the background calls.
 *
 * All three of these run off the critical path, which is exactly why they need
 * deadlines: nothing above them is watching, so a request that hangs simply
 * never finishes and the work it was doing silently stops happening. Image
 * generation gets far longer than the others because it genuinely takes it.
 */
const DISTIL_TIMEOUT_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 120_000;

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
        abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      },
    });
    return (response.text ?? '').trim();
  } catch {
    return '';
  }
}

interface PortraitBase {
  apiKey: string;
  /**
   * The photograph of her that the new picture must be of. Not optional.
   *
   * This is the whole trick to consistency. Describing a face in words gets you
   * a different person every time; handing the model her photograph and asking
   * for the same person somewhere else gets you the same person. It has to be a
   * *fixed* image to work — referencing the last generated picture instead
   * walks her face away from the original one generation at a time.
   *
   * Required rather than defaulted, because the alternative is not a worse
   * picture of her, it is a good picture of somebody else.
   */
  reference: { data: Buffer; mimeType: string };
  model?: string;
}

/**
 * Either a description to wrap, or a prompt that replaces the wrapping.
 *
 * A union rather than two optional fields, so "neither" cannot be written. The
 * two cases want genuinely different prompts and must not share one: a scene
 * picture asks for her photographed again on a different day, with its own light
 * and lens, while an expression asks for the *same* frame with nothing changed
 * but her face. Wrapping the second in the first produces a good photograph of
 * her somewhere else, which is not what the caller wanted.
 */
export type PortraitRequest =
  | (PortraitBase & {
      /** What the picture should show, in her own words. */
      description: string;
      prompt?: never;
    })
  | (PortraitBase & {
      /** A complete prompt, used as given. */
      prompt: string;
      description?: never;
    });

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

/**
 * Makes a new picture of her.
 *
 * Returns null rather than throwing on every failure path, including a refusal:
 * image models decline requests for photorealistic people often enough that a
 * refusal has to be an ordinary outcome here, not an exception.
 */
export async function generatePortrait(request: PortraitRequest): Promise<GeneratedImage | null> {
  const ai = new GoogleGenAI({ apiKey: request.apiKey });
  const parts: Array<Record<string, unknown>> = [
    {
      inlineData: {
        data: request.reference.data.toString('base64'),
        mimeType: request.reference.mimeType,
      },
    },
    { text: request.prompt ?? portraitPrompt(request) },
  ];

  // The output ratio is set rather than assumed. The documentation gives no
  // rule that an edit inherits the input image's shape, and a portrait
  // photograph returned as a square is a crop through her face.
  const aspectRatio = aspectRatioOf(request.reference.data);

  try {
    const response = await ai.models.generateContent({
      model: request.model ?? IMAGE_MODEL,
      contents: [{ role: 'user', parts: parts as never }],
      config: {
        responseModalities: [Modality.IMAGE],
        ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
        abortSignal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      },
    });

    for (const candidate of response.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        const inline = part.inlineData;
        if (inline?.data && inline.mimeType?.startsWith('image/')) {
          return { data: Buffer.from(inline.data, 'base64'), mimeType: inline.mimeType };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The prompt, built to the shape the image model's own documentation asks for.
 *
 * Two things it must do, and the previous version did neither:
 *
 *  1. **Ask for a photograph.** It used to end with "Stylised illustration, not
 *     a photograph of a real person", which is precisely what came back — and
 *     it also defeated the reference image, because a face cannot survive being
 *     redrawn in another medium. The docs give a template for this case
 *     ("A photorealistic [type of shot] of a [subject] in a [setting].
 *     [Description of the light]. Shot from a [camera angle] with a [lens
 *     type].") and this follows it: shot, subject, setting, light, lens.
 *  2. **Say the face may not change.** The documented phrasing for holding a
 *     likeness across an edit is an explicit instruction — "Ensure the woman's
 *     face and features remain completely unchanged" — rather than a hope that
 *     supplying a reference is enough.
 *
 * ## The photograph is the only description of her there is
 *
 * There was once a written appearance in her profile as well, and sending both
 * was measured rather than reasoned about: the profile described a chin-length
 * black bob, the uploaded photograph was a woman with long fair hair, and what
 * came back was the right face under the *written* hair. The model resolved the
 * contradiction, and nothing in the request told it which side was
 * authoritative.
 *
 * So the words went, and this prompt now only has one shape. There is no branch
 * for "no photograph" because there is no such case — the gallery declines to
 * generate at all without one, on the grounds that the alternative is not a
 * worse picture of her but a good picture of a stranger.
 */
export function portraitPrompt(request: { description: string }): string {
  const lines: string[] = [
    'A photorealistic candid photograph of the exact woman in the reference image.',
    'This is the same real person, photographed again on a different day. Her face,',
    'bone structure, hair, hair colour, hair length and build must remain',
    'completely unchanged. Copy her appearance from the reference image and do',
    'not restyle her.',
  ];

  lines.push(
    '',
    `The photograph shows her: ${request.description}.`,
    '',
    'Soft natural available light. Shot at eye level on a 50mm lens at f/1.8, shallow',
    'depth of field. Real skin texture and real pores, the imperfect framing of a',
    'photograph somebody actually took.',
    '',
    'It must be a photograph. Not an illustration, drawing, painting, render, anime or',
    'cartoon. No text, no watermark, no logo.',
  );

  return lines.join('\n');
}

/**
 * The nearest ratio the model accepts to the reference photograph's own shape.
 *
 * The accepted values are a fixed enum, so "the same shape as the input" has to
 * be resolved to one of them; the nearest by ratio is the one that crops least.
 * Null when the bytes cannot be read, which leaves the model to its default
 * rather than asserting a shape that might be wrong.
 */
function aspectRatioOf(image: Buffer): string | null {
  const info = sniffImage(image);
  if (!info || info.width <= 0 || info.height <= 0) return null;

  const wanted = info.width / info.height;
  let best: { name: string; distance: number } | null = null;
  for (const [name, ratio] of ASPECT_RATIOS) {
    const distance = Math.abs(ratio - wanted);
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best?.name ?? null;
}

/** Exactly what `imageConfig.aspectRatio` documents as supported, and nothing else. */
const ASPECT_RATIOS: ReadonlyArray<readonly [string, number]> = [
  ['1:1', 1],
  ['2:3', 2 / 3],
  ['3:2', 3 / 2],
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['9:16', 9 / 16],
  ['16:9', 16 / 9],
  ['21:9', 21 / 9],
];
