/**
 * Hearing.
 *
 * Transcription runs in the main process, on a finished utterance, rather than
 * as a live socket from the renderer. That is a deliberate trade:
 *
 *  - a live streaming socket would shave a couple of hundred milliseconds, but
 *    it needs the API key in the renderer, and the renderer is the process that
 *    loads user-supplied character files from disk. Keys stay in main;
 *  - the renderer already knows when the user stopped talking, because it runs
 *    the voice-activity detector that decides when to stop recording. Sending
 *    one blob at that moment costs one round trip on a two-second utterance.
 *
 * If the latency ever matters more than the isolation, the interface below is
 * the seam: add a streaming implementation behind it and move the socket into
 * main, not into the renderer.
 */

import type { SttProviderId } from '../../shared/protocol.ts';

export interface Transcript {
  text: string;
  /** 0..1 where the provider reports it; 1 when it does not. */
  confidence: number;
}

export interface SttProvider {
  readonly id: string;
  transcribe(audio: Uint8Array, mimeType: string): Promise<Transcript>;
}

export function createDeepgramStt(apiKey: string): SttProvider {
  return {
    id: 'deepgram',
    async transcribe(audio, mimeType) {
      const url =
        'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&language=en';
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Token ${apiKey}`, 'content-type': mimeType },
        body: audio as unknown as BodyInit,
      });
      if (!response.ok) throw new Error(await describe(response, 'Deepgram'));

      const body = (await response.json()) as {
        results?: {
          channels?: Array<{
            alternatives?: Array<{ transcript?: string; confidence?: number }>;
          }>;
        };
      };
      const best = body.results?.channels?.[0]?.alternatives?.[0];
      return { text: (best?.transcript ?? '').trim(), confidence: best?.confidence ?? 1 };
    },
  };
}

export function createOpenAiStt(apiKey: string, model = 'whisper-1'): SttProvider {
  return {
    id: 'openai',
    async transcribe(audio, mimeType) {
      const form = new FormData();
      form.append('file', new Blob([audio as unknown as BlobPart], { type: mimeType }), 'speech.webm');
      form.append('model', model);
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!response.ok) throw new Error(await describe(response, 'OpenAI'));
      const body = (await response.json()) as { text?: string };
      return { text: (body.text ?? '').trim(), confidence: 1 };
    },
  };
}

const FACTORIES: Record<SttProviderId, (key: string) => SttProvider> = {
  deepgram: createDeepgramStt,
  openai: createOpenAiStt,
};

export function createSttProvider(id: SttProviderId, apiKey: string): SttProvider {
  const factory = FACTORIES[id];
  if (!factory) throw new Error(`Unknown transcription provider: ${id}`);
  return factory(apiKey);
}

async function describe(response: Response, vendor: string): Promise<string> {
  const body = await response.text().catch(() => '');
  if (response.status === 401) return `${vendor} rejected that key.`;
  return `${vendor} returned ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`;
}
