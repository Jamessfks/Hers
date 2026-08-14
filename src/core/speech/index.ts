/** Voice registry, plus the defaults the onboarding screen offers. */

import type { TtsProviderId } from '../../shared/protocol.ts';
import { createCartesiaTts } from './cartesia.ts';
import { createElevenLabsTts } from './elevenlabs.ts';
import { createHumeTts } from './hume.ts';
import type { TtsProvider } from './types.ts';

export type { AudioChunk, SynthesisRequest, TtsProvider } from './types.ts';
export { TtsError } from './types.ts';

const FACTORIES: Record<TtsProviderId, (key: string) => TtsProvider> = {
  cartesia: createCartesiaTts,
  elevenlabs: createElevenLabsTts,
  hume: createHumeTts,
};

export function createTtsProvider(id: TtsProviderId, apiKey: string): TtsProvider {
  const factory = FACTORIES[id];
  if (!factory) throw new Error(`Unknown voice provider: ${id}`);
  return factory(apiKey);
}

/**
 * Ranked for this product, not in general.
 *
 * The ordering is deliberate and is the answer to "which three and why":
 * Cartesia wins on the axis that decides whether a companion feels present at
 * all, ElevenLabs wins on the axis that decides whether she feels like a
 * person, and Hume is the only one that will take a direction rather than a
 * setting. Anything below these three is a worse version of one of them.
 */
export const TTS_PROVIDER_INFO: ReadonlyArray<{
  id: TtsProviderId;
  label: string;
  why: string;
  keyUrl: string;
  typicalFirstByteMs: number;
}> = [
  {
    id: 'cartesia',
    label: 'Cartesia Sonic',
    why: 'Fastest to first sound. The default, because latency is the thing you feel.',
    keyUrl: 'https://play.cartesia.ai/keys',
    typicalFirstByteMs: 90,
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    why: 'The most expressive voices anywhere. Slightly slower, noticeably more alive.',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    typicalFirstByteMs: 150,
  },
  {
    id: 'hume',
    label: 'Hume Octave',
    why: 'Takes an acting note per line, so Anna directs her own delivery.',
    keyUrl: 'https://platform.hume.ai/settings/keys',
    typicalFirstByteMs: 250,
  },
];
