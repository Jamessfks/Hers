/**
 * The two things Anna asks Gemini for that are not a live conversation.
 *
 * Both are background work. Neither may ever block a turn, and neither may take
 * down a session by throwing — a failed consolidation costs a few facts, and a
 * failed picture costs a picture.
 */

import { GoogleGenAI, Modality } from '@google/genai';

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
        },
      });
      return response.text ?? '';
    },
  };
}

export interface PortraitRequest {
  apiKey: string;
  /** What the picture should show, in Anna's own words. */
  description: string;
  /** Her appearance, verbatim from the profile, so her face stays her face. */
  appearance: string;
  /**
   * A previous picture of her, if there is one.
   *
   * This is the whole trick to consistency. Describing a face in words gets you
   * a different person every time; handing the model the last picture and
   * asking for the same person somewhere else gets you the same person.
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

  parts.push({
    text: [
      request.reference
        ? 'Generate a new image of the same woman shown in the reference image, keeping her face, hair and build identical.'
        : 'Generate an image of a woman matching this description exactly.',
      '',
      request.appearance,
      '',
      `The picture should show: ${request.description}.`,
      '',
      'Stylised illustration, not a photograph of a real person. Warm natural light,',
      'shallow depth of field, candid framing. No text, no watermark, no logo.',
    ].join('\n'),
  });

  try {
    const response = await ai.models.generateContent({
      model: request.model ?? IMAGE_MODEL,
      contents: [{ role: 'user', parts: parts as never }],
      config: { responseModalities: [Modality.IMAGE] },
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
