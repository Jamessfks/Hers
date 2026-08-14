/**
 * The demo voice is a real provider, so it gets real tests — particularly the
 * WAV parsing, which is the part that silently produces noise rather than
 * failing when it is wrong.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { createSayTts, decodeWav } from './mock-tts.ts';

const run = promisify(execFile);

function wav(samples: Int16Array, extraChunk = false): Uint8Array {
  const dataBytes = samples.length * 2;
  const extra = extraChunk ? 8 + 4 : 0;
  const buffer = new ArrayBuffer(44 + extra + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + extra + dataBytes, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 22050, true);
  view.setUint32(28, 44100, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  let offset = 36;
  if (extraChunk) {
    // A `fact` chunk before `data`, which is exactly what breaks a parser that
    // assumes samples begin at byte 44.
    ascii(offset, 'fact');
    view.setUint32(offset + 4, 4, true);
    view.setUint32(offset + 8, samples.length, true);
    offset += 12;
  }
  ascii(offset, 'data');
  view.setUint32(offset + 4, dataBytes, true);
  offset += 8;
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(offset + i * 2, samples[i] ?? 0, true);
  }
  return bytes;
}

test('decodes a plain WAV to the right samples', () => {
  const pcm = decodeWav(wav(Int16Array.from([0, 16384, -16384, 32767])));
  assert.equal(pcm.length, 4);
  assert.equal(pcm[0], 0);
  assert.ok(Math.abs((pcm[1] ?? 0) - 0.5) < 1e-4);
  assert.ok(Math.abs((pcm[2] ?? 0) + 0.5) < 1e-4);
});

test('finds the data chunk when another chunk comes first', () => {
  // Assuming byte 44 gives a burst of noise at the start of every clause.
  const samples = Int16Array.from([1000, -1000, 2000, -2000]);
  assert.deepEqual(
    Array.from(decodeWav(wav(samples, true))),
    Array.from(decodeWav(wav(samples, false))),
    'a leading fact chunk must not shift the samples',
  );
});

test('a non-WAV buffer degrades to raw samples rather than throwing', () => {
  assert.doesNotThrow(() => decodeWav(new Uint8Array([1, 2, 3, 4])));
});

test('speaks real audio through the streaming interface', async (t) => {
  // Guarded: `say` only exists on macOS.
  const available = await run('/usr/bin/say', ['-v', '?']).then(
    () => true,
    () => false,
  );
  if (!available) return t.skip('macOS `say` not available');

  const tts = createSayTts('Samantha');
  const chunks = [];
  for await (const chunk of tts.synthesize({ text: 'Hey. You look wrecked.', voiceId: 'Samantha' })) {
    chunks.push(chunk);
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.pcm.length, 0);
  assert.ok(chunks.length > 1, 'should stream in frames, not one buffer');
  assert.ok(total > 22050 * 0.5, `expected at least half a second of audio, got ${total} samples`);
  assert.equal(chunks[0]?.sampleRate, 22050);

  const peak = Math.max(...chunks.flatMap((chunk) => Array.from(chunk.pcm, Math.abs)));
  assert.ok(peak > 0.05, `audio is silent (peak ${peak}) — the viseme path needs real signal`);
});

test('lists only English system voices', async (t) => {
  const voices = await createSayTts().listVoices();
  if (voices.length <= 1) return t.skip('no system voices enumerated');
  assert.ok(voices.some((voice) => voice.id === 'Samantha'));
  assert.ok(voices.every((voice) => voice.name.includes('en')));
});
