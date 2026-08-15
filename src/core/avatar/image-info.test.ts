/**
 * Header parsing, against bytes rather than against fixtures of my own making
 * where it matters.
 *
 * The JPEG case reads the actual photograph Anna's avatar is built from when it
 * is present, because that file is the reason this module exists: it is named
 * `.png`, it contains JPEG, and it is square. A synthetic fixture would have
 * agreed with whatever assumption produced it.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { aspectMismatch, nearestAspectRatio, sniffImage } from './image-info.ts';

const HEDRA_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '9:21', '21:9'] as const;

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

/** A minimal JPEG: SOI, a JFIF app segment, then SOF0 at a non-fixed offset. */
function jpeg(width: number, height: number, padding = 0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  // A comment segment of arbitrary length, which is exactly what pushes SOF0
  // off any fixed offset in a real generated image.
  const comment = padding > 0 ? [0xff, 0xfe, (padding + 2) >> 8, (padding + 2) & 0xff, ...new Array(padding).fill(0x20)] : [];
  const sof = [
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...comment, ...sof]);
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

test('a JPEG is read even when the frame header is not at a fixed offset', () => {
  assert.deepEqual(sniffImage(jpeg(1024, 1024)), {
    mimeType: 'image/jpeg',
    width: 1024,
    height: 1024,
  });
  assert.deepEqual(sniffImage(jpeg(1920, 1080, 4000)), {
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
  });
});

test('a Huffman table is not mistaken for a frame header', () => {
  // 0xC4 is inside the SOFn numeric range and is not a frame. Reading
  // dimensions out of it yields plausible nonsense rather than an error.
  const withHuffman = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc4, 0x00, 0x08, 0x11, 0x22, 0x33, 0x44,
    ...jpeg(640, 480).subarray(2),
  ]);
  assert.deepEqual(sniffImage(withHuffman), {
    mimeType: 'image/jpeg',
    width: 640,
    height: 480,
  });
});

test('a PNG is read from IHDR', () => {
  assert.deepEqual(sniffImage(png(800, 1200)), {
    mimeType: 'image/png',
    width: 800,
    height: 1200,
  });
});

test('bytes that are not an image are null, not a guess', () => {
  assert.equal(sniffImage(new Uint8Array([0x25, 0x50, 0x44, 0x46])), null, 'a PDF');
  assert.equal(sniffImage(new Uint8Array(0)), null, 'nothing at all');
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8])), null, 'a truncated JPEG');
});

test('a malformed segment length does not hang the parser', () => {
  // A zero length would leave `at` where it was and spin forever.
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0, 0, 0, 0, 0])), null);
});

test('the real source photograph is JPEG despite its .png name', async (t) => {
  // Skipped rather than failed when the file is not there: this asserts a fact
  // about one machine's Downloads folder, and a missing file is not a defect in
  // the parser.
  const path = join(homedir(), 'Downloads', 'Anna_origin.png');
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    t.skip('Anna_origin.png is not on this machine');
    return;
  }

  const info = sniffImage(bytes);
  assert.ok(info, 'the source photograph must be readable');
  assert.equal(info.mimeType, 'image/jpeg', 'the extension says PNG and the bytes say JPEG');
  assert.equal(info.width, 1024);
  assert.equal(info.height, 1024);
});

// ---------------------------------------------------------------------------
// Aspect ratio
// ---------------------------------------------------------------------------

test('a square photograph picks 1:1, not the portrait default', () => {
  // The bug this prevents: a hardcoded 9:16 default, chosen because the panel
  // is portrait, applied to a 1024x1024 source.
  assert.equal(nearestAspectRatio(1024, 1024, HEDRA_RATIOS), '1:1');
});

test('ratios are compared in log space, so a square is not dragged towards 9:21', () => {
  // Linearly, |21/9 - 1| = 1.33 and |9/21 - 1| = 0.57, so a naive comparison
  // prefers the tall one for a square image. It should prefer neither.
  const chosen = nearestAspectRatio(1000, 1001, HEDRA_RATIOS);
  assert.equal(chosen, '1:1');
});

test('obvious shapes pick the obvious ratio', () => {
  assert.equal(nearestAspectRatio(1080, 1920, HEDRA_RATIOS), '9:16');
  assert.equal(nearestAspectRatio(1920, 1080, HEDRA_RATIOS), '16:9');
  assert.equal(nearestAspectRatio(1200, 1600, HEDRA_RATIOS), '3:4');
  assert.equal(nearestAspectRatio(1600, 1200, HEDRA_RATIOS), '4:3');
});

test('a model offering only one ratio returns it whatever the photograph is', () => {
  assert.equal(nearestAspectRatio(1024, 1024, ['16:9']), '16:9');
});

test('mismatch is zero for an exact match and grows with the error', () => {
  assert.equal(aspectMismatch(1024, 1024, '1:1'), 0);
  // A square forced into 16:9 is a large mismatch, and should be reportable as
  // "this will crop her" rather than silently accepted.
  assert.ok(aspectMismatch(1024, 1024, '16:9') > 0.5);
  assert.ok(aspectMismatch(1920, 1080, '16:9') < 0.01);
});
