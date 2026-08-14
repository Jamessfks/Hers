/**
 * Cartesia Sonic.
 *
 * The default, because it is the fastest thing available: Cartesia's
 * state-space architecture benchmarks around 40-90ms to first audio, where the
 * alternatives sit at 150ms and up. That difference is the whole gap between a
 * companion who answers and one who waits a beat before answering, and a beat
 * is exactly how long it takes to feel like a machine.
 *
 * Streams float32 PCM over SSE, which is the only vendor here that hands back
 * samples we can play with no conversion at all.
 */

import { readSse, tryJson } from '../llm/sse.ts';
import {
  TtsError,
  base64ToBytes,
  f32leToFloat32,
  type AudioChunk,
  type SynthesisRequest,
  type TtsProvider,
} from './types.ts';

const BASE_URL = 'https://api.cartesia.ai';
const API_VERSION = '2025-04-16';
const SAMPLE_RATE = 44100;

interface CartesiaFrame {
  type: string;
  data?: string;
  error?: string;
}

export function createCartesiaTts(apiKey: string, model = 'sonic-3'): TtsProvider {
  const headers = {
    'content-type': 'application/json',
    'X-API-Key': apiKey,
    'Cartesia-Version': API_VERSION,
  };

  return {
    id: 'cartesia',
    label: 'Cartesia Sonic',
    typicalFirstByteMs: 90,

    async *synthesize(request: SynthesisRequest): AsyncIterable<AudioChunk> {
      const response = await fetch(`${BASE_URL}/tts/sse`, {
        method: 'POST',
        headers,
        signal: request.signal ?? null,
        body: JSON.stringify({
          model_id: model,
          transcript: request.text,
          voice: { mode: 'id', id: request.voiceId },
          language: 'en',
          output_format: {
            container: 'raw',
            encoding: 'pcm_f32le',
            sample_rate: SAMPLE_RATE,
          },
        }),
      });

      if (!response.ok || !response.body) {
        throw new TtsError(await describeFailure(response), response.status, 'cartesia');
      }

      for await (const event of readSse(response.body)) {
        const frame = tryJson<CartesiaFrame>(event.data);
        if (!frame) continue;
        if (frame.type === 'error') {
          throw new TtsError(frame.error ?? 'stream error', undefined, 'cartesia');
        }
        if (frame.type === 'chunk' && frame.data) {
          // f32le frames are 4 bytes and Cartesia base64-encodes whole frames,
          // so no realignment is needed here.
          yield { pcm: f32leToFloat32(base64ToBytes(frame.data)), sampleRate: SAMPLE_RATE };
        }
        if (frame.type === 'done') return;
      }
    },

    async listVoices() {
      const response = await fetch(`${BASE_URL}/voices?limit=100`, { headers });
      if (!response.ok) throw new TtsError(await describeFailure(response), response.status);
      const body = (await response.json()) as {
        data?: Array<{ id: string; name: string; description?: string }>;
      };
      return (body.data ?? []).map((voice) => ({
        id: voice.id,
        name: voice.name,
        ...(voice.description && { description: voice.description }),
      }));
    },
  };
}

async function describeFailure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  if (response.status === 401 || response.status === 403) return 'Cartesia rejected that key.';
  if (response.status === 402) return 'Cartesia account is out of credit.';
  return `Cartesia returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
}
