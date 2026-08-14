import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeWav, mixToMono } from './wav.ts';

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

test('encodeWav writes a header CoreAudio will accept', () => {
  const wav = encodeWav(new Float32Array(160), 16000);
  const header = view(wav);

  assert.equal(ascii(wav, 0, 4), 'RIFF');
  assert.equal(ascii(wav, 8, 4), 'WAVE');
  assert.equal(ascii(wav, 12, 4), 'fmt ');
  assert.equal(ascii(wav, 36, 4), 'data');

  assert.equal(header.getUint16(20, true), 1, 'format tag must say uncompressed PCM');
  assert.equal(header.getUint16(22, true), 1, 'mono');
  assert.equal(header.getUint32(24, true), 16000, 'sample rate');
  assert.equal(header.getUint16(34, true), 16, 'bits per sample');
  // byte rate and block align have to agree with the rest or the file plays at
  // the wrong speed, which reads to a recogniser as a different language.
  assert.equal(header.getUint32(28, true), 16000 * 2);
  assert.equal(header.getUint16(32, true), 2);
});

test('encodeWav declares the sizes that actually follow it', () => {
  const wav = encodeWav(new Float32Array(100), 22050);
  const header = view(wav);
  assert.equal(wav.length, 44 + 200);
  assert.equal(header.getUint32(40, true), 200, 'data chunk length');
  assert.equal(header.getUint32(4, true), wav.length - 8, 'RIFF length excludes its own 8 bytes');
});

test('encodeWav carries the sample rate it was given rather than assuming one', () => {
  // decodeAudioData is *specified* to resample to the context rate, but the
  // header must follow the buffer, not our hopes about it.
  assert.equal(view(encodeWav(new Float32Array(1), 48000)).getUint32(24, true), 48000);
});

test('encodeWav maps the full range without wrapping', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000);
  const samples = view(wav);
  assert.equal(samples.getInt16(44, true), 0);
  assert.equal(samples.getInt16(46, true), 32767);
  assert.equal(samples.getInt16(48, true), -32768);
  assert.equal(samples.getInt16(50, true), 16383);
});

test('encodeWav clamps rather than letting a loud sample invert', () => {
  // Two's-complement overflow turns a shouted vowel into a click. Anything past
  // full scale has to saturate.
  const wav = encodeWav(new Float32Array([2, -2, 1.0001]), 16000);
  const samples = view(wav);
  assert.equal(samples.getInt16(44, true), 32767);
  assert.equal(samples.getInt16(46, true), -32768);
  assert.equal(samples.getInt16(48, true), 32767);
});

test('mixToMono passes a single channel straight through', () => {
  const only = new Float32Array([0.25, -0.5]);
  assert.equal(mixToMono([only]), only);
});

test('mixToMono averages a stereo capture instead of truncating it', () => {
  const mixed = mixToMono([new Float32Array([1, 0, -1]), new Float32Array([0, 0.5, -0.5])]);
  assert.deepEqual(Array.from(mixed), [0.5, 0.25, -0.75]);
});

test('mixToMono survives being handed nothing', () => {
  assert.equal(mixToMono([]).length, 0);
});
