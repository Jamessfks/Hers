/**
 * Key validation, against mocked providers.
 *
 * These cover the screen a new user meets first. The interesting cases are all
 * failures — a wrong key, a key in the wrong box, an empty account, a dead
 * network — and none of them can be produced on demand against a live vendor.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LlmProvider } from '../core/llm/types.ts';
import type { SttProvider } from '../core/speech/stt.ts';
import type { TtsProvider } from '../core/speech/index.ts';
import { looksMisplaced, validateKey, wavOfSilence, type ProviderFactories } from './key-validation.ts';

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

interface Recorder {
  llmKeys: string[];
  ttsKeys: string[];
  sttAudio: Array<{ bytes: Uint8Array; mimeType: string }>;
}

function factories(
  behaviour: {
    llm?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    voices?: () => Promise<Array<{ id: string; name: string }>>;
    transcribe?: () => Promise<{ text: string; confidence: number }>;
  } = {},
): { factories: ProviderFactories; recorder: Recorder } {
  const recorder: Recorder = { llmKeys: [], ttsKeys: [], sttAudio: [] };

  const llm = (_provider: string, key: string): LlmProvider => {
    recorder.llmKeys.push(key);
    return {
      id: 'mock',
      label: 'mock',
      suggestedModels: [],
      async *stream() {
        yield '';
      },
      validateKey: behaviour.llm ?? (async () => ({ ok: true as const })),
      async listModels() {
        return [];
      },
    };
  };

  const tts = (_provider: string, key: string): TtsProvider => {
    recorder.ttsKeys.push(key);
    return {
      id: 'mock',
      label: 'mock',
      typicalFirstByteMs: 0,
      async *synthesize() {
        yield { pcm: new Float32Array(0), sampleRate: 44100 };
      },
      listVoices: behaviour.voices ?? (async () => [{ id: 'v1', name: 'Voice' }]),
    };
  };

  const stt = (_provider: string, _key: string): SttProvider => ({
    id: 'mock',
    async transcribe(bytes, mimeType) {
      recorder.sttAudio.push({ bytes, mimeType });
      return behaviour.transcribe ? behaviour.transcribe() : { text: '', confidence: 1 };
    },
  });

  return {
    factories: { llm, tts, stt } as unknown as ProviderFactories,
    recorder,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

test('a good language key is accepted and passed through trimmed', async () => {
  const { factories: f, recorder } = factories();
  const verdict = await validateKey({
    kind: 'llm',
    provider: 'anthropic',
    key: '  sk-ant-good  ',
    factories: f,
  });
  assert.deepEqual(verdict, { ok: true });
  assert.deepEqual(recorder.llmKeys, ['sk-ant-good'], 'whitespace from a paste is stripped');
});

test('a rejected language key returns the provider reason verbatim', async () => {
  const { factories: f } = factories({
    llm: async () => ({ ok: false as const, reason: 'That key was rejected. Check it and try again.' }),
  });
  const verdict = await validateKey({ kind: 'llm', provider: 'anthropic', key: 'bad', factories: f });
  assert.deepEqual(verdict, { ok: false, reason: 'That key was rejected. Check it and try again.' });
});

test('an empty field is refused without a network call', async () => {
  const { factories: f, recorder } = factories();
  const verdict = await validateKey({ kind: 'llm', provider: 'openai', key: '   ', factories: f });
  assert.equal(verdict.ok, false);
  assert.deepEqual(recorder.llmKeys, [], 'must not hit the network for an empty field');
});

test('a voice key is checked by listing voices', async () => {
  const { factories: f, recorder } = factories();
  assert.deepEqual(
    await validateKey({ kind: 'tts', provider: 'cartesia', key: 'ct-good', factories: f }),
    { ok: true },
  );
  assert.deepEqual(recorder.ttsKeys, ['ct-good']);
});

test('a working voice key on an account with no voices is called out', async () => {
  const { factories: f } = factories({ voices: async () => [] });
  const verdict = await validateKey({ kind: 'tts', provider: 'cartesia', key: 'k', factories: f });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : '', /no voices/i);
});

test('a transcription key is checked with a real request, not a guess', async () => {
  const { factories: f, recorder } = factories();
  assert.deepEqual(
    await validateKey({ kind: 'stt', provider: 'deepgram', key: 'dg', factories: f }),
    { ok: true },
  );
  assert.equal(recorder.sttAudio.length, 1);
  assert.equal(recorder.sttAudio[0]?.mimeType, 'audio/wav');
  assert.ok(recorder.sttAudio[0]!.bytes.length > 44, 'should send actual samples, not just a header');
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('a thrown provider error becomes a verdict, never a rejection', async () => {
  // A rejected promise here surfaces as an unhandled IPC error and the settings
  // window shows nothing at all — strictly worse than a sentence.
  const { factories: f } = factories({
    llm: async () => {
      throw new Error('Anthropic returned 500');
    },
  });
  const verdict = await validateKey({ kind: 'llm', provider: 'anthropic', key: 'k', factories: f });
  assert.deepEqual(verdict, { ok: false, reason: 'Anthropic returned 500' });
});

test('being offline is reported as being offline, not as a bad key', async () => {
  const { factories: f } = factories({
    llm: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const verdict = await validateKey({ kind: 'llm', provider: 'openai', key: 'k', factories: f });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : '', /connection/i);
  assert.doesNotMatch(verdict.ok === false ? verdict.reason : '', /rejected/i);
});

test('a failure in any of the three kinds is handled the same way', async () => {
  for (const kind of ['llm', 'tts', 'stt'] as const) {
    const boom = async () => {
      throw new Error('nope');
    };
    const { factories: f } = factories({ llm: boom, voices: boom, transcribe: boom });
    const verdict = await validateKey({ kind, provider: 'x', key: 'k', factories: f });
    assert.equal(verdict.ok, false, `${kind} should return a verdict`);
  }
});

// ---------------------------------------------------------------------------
// Misplaced keys
// ---------------------------------------------------------------------------

test('a key pasted into the wrong provider box is flagged', async () => {
  const warning = looksMisplaced('llm.openai', 'sk-ant-api03-xxxx');
  assert.match(warning ?? '', /Anthropic/);
});

test('a correctly placed key produces no warning', () => {
  assert.equal(looksMisplaced('llm.anthropic', 'sk-ant-api03-xxxx'), null);
  assert.equal(looksMisplaced('llm.google', 'AIzaSyXXXX'), null);
  assert.equal(looksMisplaced('tts.elevenlabs', 'sk_abc123'), null);
});

test('a bare sk- key is not mistaken for an Anthropic key', () => {
  // OpenAI keys are `sk-...` and Anthropic's are `sk-ant-...`; the more
  // specific prefix has to be checked first or every OpenAI key gets flagged.
  assert.equal(looksMisplaced('llm.openai', 'sk-proj-abc123'), null);
});

test('a provider with no known prefix never produces a false warning', () => {
  assert.equal(looksMisplaced('tts.cartesia', 'anything-at-all'), null);
  assert.equal(looksMisplaced('stt.deepgram', '0123456789abcdef'), null);
});

test('an empty field is not flagged as misplaced', () => {
  assert.equal(looksMisplaced('llm.anthropic', ''), null);
  assert.equal(looksMisplaced('llm.anthropic', '   '), null);
});

// ---------------------------------------------------------------------------
// The probe payload
// ---------------------------------------------------------------------------

test('the silence probe is a valid WAV of the requested length', () => {
  const wav = wavOfSilence(0.1, 16000);
  const text = new TextDecoder().decode(wav.subarray(0, 4));
  assert.equal(text, 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16000, 'sample rate');
  assert.equal(view.getUint16(34, true), 16, 'bit depth');
  assert.equal(wav.length, 44 + 1600 * 2, '0.1s at 16kHz, 16-bit');
});
