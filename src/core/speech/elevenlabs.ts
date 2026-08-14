/**
 * ElevenLabs.
 *
 * Picked for expressiveness rather than speed. Their v3 voices carry emotional
 * range that nothing else matches — laughter, a catch in the breath, a line
 * delivered dry — which is worth more to a companion than the ~60ms Cartesia
 * saves. Flash v2.5 is used as the streaming model because it is the one tuned
 * for conversational latency; the expressive models are a settings change away.
 *
 * Note on PCM: `pcm_44100` is gated to paid tiers. On a free key the request
 * fails, so we fall back to `pcm_22050`, which every tier can produce, and
 * resample nothing — the renderer plays whatever sample rate we declare.
 */

import {
  FrameAligner,
  TtsError,
  s16leToFloat32,
  type AudioChunk,
  type SynthesisRequest,
  type TtsProvider,
} from './types.ts';

const BASE_URL = 'https://api.elevenlabs.io/v1';

export function createElevenLabsTts(apiKey: string, model = 'eleven_flash_v2_5'): TtsProvider {
  const headers = { 'content-type': 'application/json', 'xi-api-key': apiKey };

  async function open(request: SynthesisRequest, format: string): Promise<Response> {
    const url = `${BASE_URL}/text-to-speech/${encodeURIComponent(request.voiceId)}/stream?output_format=${format}`;
    return fetch(url, {
      method: 'POST',
      headers,
      signal: request.signal ?? null,
      body: JSON.stringify({
        text: request.text,
        model_id: model,
        // Low stability leaves room for the delivery to vary line to line,
        // which is what stops a companion sounding like an announcer.
        voice_settings: { stability: 0.35, similarity_boost: 0.75, style: 0.4, speed: 1.0 },
      }),
    });
  }

  return {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    typicalFirstByteMs: 150,

    async *synthesize(request: SynthesisRequest): AsyncIterable<AudioChunk> {
      let sampleRate = 44100;
      let response = await open(request, 'pcm_44100');

      if (!response.ok && (response.status === 401 || response.status === 422)) {
        // Almost always the paid-tier gate on 44.1k. Retry at a rate every
        // account can produce before deciding the key is bad.
        sampleRate = 22050;
        response = await open(request, 'pcm_22050');
      }

      if (!response.ok || !response.body) {
        throw new TtsError(await describeFailure(response), response.status, 'elevenlabs');
      }

      const aligner = new FrameAligner(2);
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const aligned = aligner.push(value);
          if (aligned.length > 0) yield { pcm: s16leToFloat32(aligned), sampleRate };
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    },

    async listVoices() {
      const response = await fetch(`${BASE_URL}/voices`, { headers: { 'xi-api-key': apiKey } });
      if (!response.ok) throw new TtsError(await describeFailure(response), response.status);
      const body = (await response.json()) as {
        voices?: Array<{ voice_id: string; name: string; description?: string }>;
      };
      return (body.voices ?? []).map((voice) => ({
        id: voice.voice_id,
        name: voice.name,
        ...(voice.description && { description: voice.description }),
      }));
    },
  };
}

async function describeFailure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  if (response.status === 401) return 'ElevenLabs rejected that key.';
  if (response.status === 429) return 'ElevenLabs rate limit, or the character quota is spent.';
  return `ElevenLabs returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
}
