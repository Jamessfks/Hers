/**
 * Header parsing, against bytes rather than against fixtures of my own making
 * where it matters.
 *
 * The JPEG case is assembled byte by byte with real segment lengths, because a
 * fixture that skips the segment chain would agree with whatever assumption
 * produced it — and the chain is the thing this module exists to walk.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sniffImage } from './image-info.ts';

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

test('a JPEG that calls itself a PNG is read as a JPEG', () => {
  /*
   * Not hypothetical. The photograph this project was first built against was
   * named `.png` and held JPEG bytes — `ffd8ffe0`, JFIF, baseline — because that
   * is what a browser download plus a rename produce. Trusting the extension
   * sent a JPEG to an endpoint told to expect a PNG, and it failed on the far
   * side with a message that named neither.
   *
   * The bytes are assembled rather than pasted so the segment lengths are real:
   * the parser walks the chain, and a fixture whose APP0 length is wrong tests
   * the walk against a file no encoder would produce.
   */
  const jfif = [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [
    0x08, // 8 bits per sample
    0x04, 0x00, // height: 1024
    0x04, 0x00, // width: 1024
    0x03, // three components, three bytes each
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  const jpeg = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, jfif.length + 2, ...jfif, // APP0, length counts itself
    0xff, 0xc0, 0x00, sof0.length + 2, ...sof0, // SOF0, baseline
    0xff, 0xd9, // EOI
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // the walk needs room to look ahead
  ]);

  const info = sniffImage(jpeg);
  assert.ok(info, 'the bytes decide, not the name');
  assert.equal(info.mimeType, 'image/jpeg');
  assert.equal(info.width, 1024);
  assert.equal(info.height, 1024);
});
