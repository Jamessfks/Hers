import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrameAligner, f32leToFloat32, s16leToFloat32 } from './types.ts';

test('s16le decodes signed values across the full range', () => {
  // 0, 32767 (max positive), -32768 (max negative), -1
  const bytes = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0xff, 0xff]);
  const pcm = s16leToFloat32(bytes);
  assert.equal(pcm.length, 4);
  assert.equal(pcm[0], 0);
  assert.ok(Math.abs((pcm[1] ?? 0) - 0.99997) < 1e-4);
  assert.equal(pcm[2], -1);
  assert.ok(Math.abs((pcm[3] ?? 0) + 1 / 32768) < 1e-9);
});

test('s16le ignores a trailing odd byte rather than corrupting the frame', () => {
  assert.equal(s16leToFloat32(new Uint8Array([0x00, 0x00, 0x7f])).length, 1);
});

test('f32le survives an unaligned source buffer', () => {
  const source = new Float32Array([0.25, -0.5, 1]);
  const padded = new Uint8Array(source.buffer.byteLength + 1);
  padded.set(new Uint8Array(source.buffer), 1);
  assert.deepEqual(Array.from(f32leToFloat32(padded.subarray(1))), [0.25, -0.5, 1]);
});

test('FrameAligner never emits a partial frame and loses no bytes', () => {
  const aligner = new FrameAligner(2);
  // Deliberately split on an odd boundary, the case that produces static.
  const first = aligner.push(new Uint8Array([1, 2, 3]));
  assert.deepEqual(Array.from(first), [1, 2]);
  const second = aligner.push(new Uint8Array([4, 5, 6, 7]));
  assert.deepEqual(Array.from(second), [3, 4, 5, 6]);
  const third = aligner.push(new Uint8Array([8]));
  assert.deepEqual(Array.from(third), [7, 8]);
});

test('FrameAligner holds everything back until a full frame arrives', () => {
  const aligner = new FrameAligner(4);
  assert.equal(aligner.push(new Uint8Array([1, 2])).length, 0);
  assert.equal(aligner.push(new Uint8Array([3])).length, 0);
  assert.deepEqual(Array.from(aligner.push(new Uint8Array([4, 5]))), [1, 2, 3, 4]);
});
