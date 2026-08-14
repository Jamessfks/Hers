/**
 * Hume Octave.
 *
 * The third option, and the interesting one. Octave takes a natural-language
 * *acting note* alongside the text — "say this quietly, like you already knew
 * the answer" — instead of exposing a fixed set of emotion presets. For a
 * companion that is the right primitive: Anna already decides her own emotional
 * beat when she writes an expression directive, and this is the only vendor
 * that will take that decision as an instruction rather than as a parameter.
 *
 * Slower than the other two. Worth it on the turns that matter.
 */

import { readSse, tryJson } from '../llm/sse.ts';
import {
  TtsError,
  base64ToBytes,
  s16leToFloat32,
  type AudioChunk,
  type SynthesisRequest,
  type TtsProvider,
} from './types.ts';

const BASE_URL = 'https://api.hume.ai/v0/tts';
const SAMPLE_RATE = 48000;

/** Turns an expression name into the acting note Octave actually wants. */
const ACTING_NOTES: Record<string, string> = {
  warm: 'warm and unhurried, like talking to someone you know well',
  amused: 'amused, holding back a laugh',
  playful: 'playful and teasing',
  smirk: 'dry, with a half-smile in the voice',
  concerned: 'quiet and careful, genuinely worried',
  sad: 'subdued, heavier than usual',
  tender: 'soft and close, almost under the breath',
  skeptical: 'flat and unconvinced',
  surprised: 'caught off guard',
  thoughtful: 'slower, thinking it through out loud',
};

interface HumeFrame {
  type?: string;
  audio?: string;
  error?: string;
}

export function createHumeTts(apiKey: string): TtsProvider {
  const headers = { 'content-type': 'application/json', 'X-Hume-Api-Key': apiKey };

  return {
    id: 'hume',
    label: 'Hume Octave',
    typicalFirstByteMs: 250,

    async *synthesize(request: SynthesisRequest): AsyncIterable<AudioChunk> {
      const description = request.emotion ? ACTING_NOTES[request.emotion] : undefined;

      const response = await fetch(`${BASE_URL}/stream/json`, {
        method: 'POST',
        headers,
        signal: request.signal ?? null,
        body: JSON.stringify({
          utterances: [
            {
              text: request.text,
              voice: { id: request.voiceId, provider: 'HUME_AI' },
              ...(description && { description }),
            },
          ],
          format: { type: 'pcm' },
          instant_mode: true,
          strip_headers: true,
        }),
      });

      if (!response.ok || !response.body) {
        throw new TtsError(await describeFailure(response), response.status, 'hume');
      }

      for await (const event of readSse(response.body)) {
        const frame = tryJson<HumeFrame>(event.data);
        if (!frame) continue;
        if (frame.error) throw new TtsError(frame.error, undefined, 'hume');
        if (frame.audio) {
          yield { pcm: s16leToFloat32(base64ToBytes(frame.audio)), sampleRate: SAMPLE_RATE };
        }
      }
    },

    async listVoices() {
      const response = await fetch(`${BASE_URL}/voices?provider=HUME_AI&page_size=100`, { headers });
      if (!response.ok) throw new TtsError(await describeFailure(response), response.status);
      const body = (await response.json()) as {
        voices_page?: Array<{ id: string; name: string }>;
      };
      return (body.voices_page ?? []).map((voice) => ({ id: voice.id, name: voice.name }));
    },
  };
}

async function describeFailure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  if (response.status === 401) return 'Hume rejected that key.';
  return `Hume returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
}
