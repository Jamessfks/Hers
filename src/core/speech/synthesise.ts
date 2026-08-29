/**
 * The fallback that keeps "voice notes only" from quietly becoming "text".
 *
 * Her Telegram replies are the audio the Live session actually produced,
 * re-encoded by `ogg-opus.ts`. That is better than any re-render — it is the
 * take, with the pauses she made. But a turn can land with no audio at all:
 * she answers a Telegram message while nothing is playing at the desk, and the
 * transcript arrives with an empty PCM buffer behind it.
 *
 * v1 sent text in that case. That is the promise breaking on the one path
 * nobody watches. So the empty case is synthesised instead, in her own
 * `voiceName`, and text is what happens only when this fails too.
 *
 * `gemini-3.1-flash-tts-preview` because it takes the same prebuilt voice names
 * the Live API does, so the fallback sounds like her rather than like a
 * different person reading her words.
 *
 * ## Tags no, direction yes
 *
 * Its audio tags — `[sighs]`, `[tired]` — are still not used, and the reason is
 * worth keeping: an inline tag chooses *where* the sigh goes, and this code has
 * no idea. The text is a transcript of something she already said, so a sigh
 * inserted after the fact is a performance of a beat she did not take.
 *
 * A style direction is a different thing and is allowed, because it chooses
 * *how* rather than *where*, and the mood it comes from is known rather than
 * invented — it is the same briefing the live session was holding for that
 * turn. Without it the fallback is the one place her voice goes flat: the same
 * words, in her voice, with none of the weather in them. The TTS models
 * document natural-language style prompting, which is exactly what this is.
 */

import { GoogleGenAI } from '@google/genai';

export const TTS_MODEL = 'gemini-3.1-flash-tts-preview';

/**
 * Long enough for a paragraph, short enough not to hold a message hostage.
 *
 * This runs while somebody is watching a "typing" indicator on a phone, which
 * is a stricter deadline than any of the background calls have.
 */
const TTS_TIMEOUT_MS = 20_000;

/**
 * Signed 16-bit little-endian mono at 24 kHz, or null.
 *
 * The same shape the Live API produces on the way out, which is what lets
 * `encodeOggOpus` take either without knowing where it came from.
 */
export async function synthesise(
  apiKey: string,
  text: string,
  voiceName: string,
  options: { direction?: string; model?: string } = {},
): Promise<Buffer | null> {
  if (!apiKey || !text.trim()) return null;
  const ai = new GoogleGenAI({ apiKey });
  /*
   * The direction goes above the words and is separated from them plainly.
   *
   * The model reads the whole prompt as the thing to say unless it is told
   * otherwise, and a stray "Say this warmly:" spoken out loud is worse than a
   * flat delivery.
   */
  const prompt = options.direction
    ? `${options.direction.trim()}\n\nSay only the following, and none of the above:\n${text}`
    : text;
  try {
    const response = await ai.models.generateContent({
      model: options.model ?? TTS_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        abortSignal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      },
    });
    const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    return data ? Buffer.from(data, 'base64') : null;
  } catch {
    // Null, not a throw. Every caller's fallback is text, and a companion who
    // says nothing because a synthesiser was down is worse than one who typed.
    return null;
  }
}
