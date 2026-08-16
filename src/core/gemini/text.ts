/**
 * The two things Anna asks Gemini for that are not a live conversation.
 *
 * Both are background work. Neither may ever block a turn, and neither may take
 * down a session by throwing — a failed consolidation costs a few facts, and a
 * failed picture costs a picture.
 */

import { GoogleGenAI, Modality } from '@google/genai';

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

export function createGeminiDistiller(apiKey: string, model = DISTILLER_MODEL): Distiller {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async distil(system, transcript) {
      const response = await ai.models.generateContent({
        model,
        contents: transcript,
        config: {
          systemInstruction: system,
          temperature: 0.2,
          maxOutputTokens: 900,
          abortSignal: AbortSignal.timeout(DISTIL_TIMEOUT_MS),
        },
      });
      return response.text ?? '';
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

export interface PortraitRequest {
  apiKey: string;
  /** What the picture should show, in Anna's own words. */
  description: string;
  /**
   * Her appearance, verbatim from the profile.
   *
   * Only used when there is no {@link reference} — see `portraitPrompt` for
   * why a photograph and a written description must not both be sent.
   */
  appearance: string;
  /**
   * The photograph of her that the new picture must be of.
   *
   * This is the whole trick to consistency. Describing a face in words gets you
   * a different person every time; handing the model her photograph and asking
   * for the same person somewhere else gets you the same person. It has to be a
   * *fixed* image to work — referencing the last generated picture instead
   * walks her face away from the original one generation at a time.
   */
  reference?: { data: Buffer; mimeType: string };
  model?: string;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

/**
 * Makes a new picture of Anna.
 *
 * Returns null rather than throwing on every failure path, including a refusal:
 * image models decline requests for photorealistic people often enough that a
 * refusal has to be an ordinary outcome here, not an exception.
 */
export async function generatePortrait(request: PortraitRequest): Promise<GeneratedImage | null> {
  const ai = new GoogleGenAI({ apiKey: request.apiKey });
  const parts: Array<Record<string, unknown>> = [];

  if (request.reference) {
    parts.push({
      inlineData: {
        data: request.reference.data.toString('base64'),
        mimeType: request.reference.mimeType,
      },
    });
  }

  parts.push({ text: portraitPrompt(request) });

  // The output ratio is set rather than assumed. The documentation gives no
  // rule that an edit inherits the input image's shape, and a portrait
  // photograph returned as a square is a crop through her face.
  const aspectRatio = request.reference ? aspectRatioOf(request.reference.data) : null;

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
 * ## The written appearance is not sent when there is a photograph
 *
 * Measured, not assumed. The profile describes her hair as a chin-length black
 * bob; the photograph that was uploaded is a woman with long fair hair. Sending
 * both produced a photorealistic picture of the right face under the *written*
 * hair — the model resolved the contradiction, and it had no way to know which
 * side was authoritative.
 *
 * So when there is a photograph, the photograph is the whole answer to what she
 * looks like. The words are what is left when there is no photograph at all,
 * and then they are the only thing holding her together between generations.
 */
export function portraitPrompt(
  request: Pick<PortraitRequest, 'description' | 'appearance' | 'reference'>,
): string {
  const lines: string[] = [];

  if (request.reference) {
    lines.push(
      'A photorealistic candid photograph of the exact woman in the reference image.',
      'This is the same real person, photographed again on a different day. Her face,',
      'bone structure, hair, hair colour, hair length and build must remain',
      'completely unchanged. Copy her appearance from the reference image and do',
      'not restyle her.',
    );
  } else {
    lines.push('A photorealistic candid photograph of a real woman.', '', request.appearance);
  }

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
