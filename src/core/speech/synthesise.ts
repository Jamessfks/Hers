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
 * different person reading her words. Its audio tags — `[sighs]`, `[tired]` —
 * are deliberately not used here: the text being spoken is a transcript of
 * something she already said, and stage directions invented after the fact
 * would be a performance of an emotion she did not have.
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
  model = TTS_MODEL,
): Promise<Buffer | null> {
  if (!apiKey || !text.trim()) return null;
  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text }] }],
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
