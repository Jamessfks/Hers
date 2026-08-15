/**
 * Checking a key before it is stored.
 *
 * Extracted from the IPC layer for one reason: this is the code path a new user
 * hits first, and it is the one place where being wrong is most expensive. If a
 * bad key is accepted, the app looks configured and then goes mute the first
 * time it is spoken to, with the real error buried in a console nobody opens.
 *
 * Everything is injected — the provider factories included — so the dispatch,
 * the error phrasing and the offline path can all be tested against mocks
 * rather than against three live vendor accounts.
 */

import type { LlmProvider } from '../core/llm/types.ts';
import type { SttProvider } from '../core/speech/stt.ts';
import type { TtsProvider } from '../core/speech/index.ts';
import type {
  KeyKind,
  LlmProviderId,
  SttProviderId,
  TtsProviderId,
  VideoProviderId,
} from '../shared/protocol.ts';

export type KeyVerdict = { ok: true } | { ok: false; reason: string };

export interface ProviderFactories {
  llm(provider: LlmProviderId, key: string): LlmProvider;
  tts(provider: TtsProviderId, key: string): TtsProvider;
  stt(provider: SttProviderId, key: string): SttProvider;
  video(provider: VideoProviderId, key: string): { validateKey(): Promise<KeyVerdict> };
}

/**
 * Obviously-malformed keys, caught before a network round trip.
 *
 * This is a courtesy, not a security control — the real check is the request.
 * But "that looks like an OpenAI key, and you have pasted it into the Anthropic
 * box" is a far more useful thing to be told than "401 authentication_error",
 * and it is the single most common mistake on a screen with three key fields.
 */
const KEY_SHAPES: Record<string, { prefix: string; vendor: string }> = {
  'llm.anthropic': { prefix: 'sk-ant-', vendor: 'an Anthropic' },
  'llm.google': { prefix: 'AIza', vendor: 'a Google' },
  'tts.elevenlabs': { prefix: 'sk_', vendor: 'an ElevenLabs' },
};

/** Prefixes that identify a key as belonging to some *other* provider. */
const FOREIGN_PREFIXES: Array<{ prefix: string; belongsTo: string }> = [
  { prefix: 'sk-ant-', belongsTo: 'Anthropic' },
  { prefix: 'AIza', belongsTo: 'Google' },
  { prefix: 'sk_', belongsTo: 'ElevenLabs' },
];

export function looksMisplaced(slot: string, key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return null;

  const expected = KEY_SHAPES[slot];
  if (expected && trimmed.startsWith(expected.prefix)) return null;

  for (const foreign of FOREIGN_PREFIXES) {
    if (!trimmed.startsWith(foreign.prefix)) continue;
    if (expected?.prefix === foreign.prefix) continue;
    // An OpenAI key is bare `sk-`, which `sk-ant-` also starts with, so check
    // the more specific prefixes first and never flag `sk-` on its own.
    if (foreign.prefix === 'sk_' && slot.endsWith('elevenlabs')) continue;
    return `That looks like ${foreign.belongsTo === 'Anthropic' ? 'an' : 'a'} ${foreign.belongsTo} key. Is it in the right box?`;
  }

  if (expected && !trimmed.startsWith(expected.prefix)) {
    return `${expected.vendor.charAt(0).toUpperCase() + expected.vendor.slice(1)} key normally starts with "${expected.prefix}". Save it anyway if you are sure.`;
  }

  return null;
}

export interface ValidateInput {
  kind: KeyKind;
  provider: string;
  key: string;
  factories: ProviderFactories;
}

/**
 * Runs the cheapest genuine check each provider offers.
 *
 * Never throws: a rejected promise here becomes an unhandled IPC error and the
 * settings window shows nothing at all, which is strictly worse than a sentence
 * saying the network is down.
 */
export async function validateKey(input: ValidateInput): Promise<KeyVerdict> {
  const key = input.key.trim();
  if (!key) return { ok: false, reason: 'That field is empty.' };

  try {
    switch (input.kind) {
      case 'llm':
        return await input.factories.llm(input.provider as LlmProviderId, key).validateKey();

      case 'tts': {
        // No voice vendor offers a dedicated health endpoint, but all three
        // list voices — which is both a credential check and the exact thing
        // the next control on the screen needs.
        const voices = await input.factories.tts(input.provider as TtsProviderId, key).listVoices();
        return voices.length > 0
          ? { ok: true }
          : { ok: false, reason: 'That key works, but the account has no voices on it.' };
      }

      case 'stt':
        // Transcription has no free health endpoint, so send it a fraction of a
        // second of silence. It costs almost nothing and is a real end-to-end
        // check rather than a guess about the key's shape.
        await input.factories
          .stt(input.provider as SttProviderId, key)
          .transcribe(wavOfSilence(0.1), 'audio/wav');
        return { ok: true };

      case 'video':
        // The video adapters check the balance as well as the key, because a
        // valid key on an empty account fails at the first render — long after
        // this screen, and with a message about billing rather than about setup.
        return await input.factories.video(input.provider as VideoProviderId, key).validateKey();

      default:
        return { ok: false, reason: `Unknown key type: ${String(input.kind)}` };
    }
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return 'Could not reach that provider.';
  // A failed fetch is a TypeError with a uselessly generic message; the user
  // needs to know it is their network rather than their key.
  if (error.name === 'TypeError' || /fetch failed|network/i.test(error.message)) {
    return 'Could not reach that provider. Check your connection and try again.';
  }
  return error.message;
}

/** A minimal 16-bit mono WAV, used only as a credential probe. */
export function wavOfSilence(seconds: number, sampleRate = 16000): Uint8Array {
  const samples = Math.floor(seconds * sampleRate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);

  return new Uint8Array(buffer);
}
