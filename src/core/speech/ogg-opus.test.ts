import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VOICE_SAMPLE_RATE, encodeOggOpus, pcmSeconds } from './ogg-opus.ts';

/**
 * A container is the kind of thing that either matches the specification byte
 * for byte or is rejected with no explanation — Telegram's `sendVoice` answers
 * a malformed file with a generic 400 and nothing else. So these read the file
 * back the way a demuxer would: RFC 3533 for the pages and the checksum, RFC
 * 7845 for what has to be inside the first two of them.
 *
 * Everything here is structural. Whether it *sounds* right is a question for
 * ears, and one round trip through a real Telegram chat has already answered it.
 */

/** One second of a 220Hz tone, which is a signal rather than a silence. */
function tone(seconds: number, rate: number = VOICE_SAMPLE_RATE): Buffer {
  const samples = Math.round(seconds * rate);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 8000), i * 2);
  }
  return pcm;
}

interface Page {
  flags: number;
  granule: bigint;
  serial: number;
  sequence: number;
  packets: number;
  body: Buffer;
}

/**
 * Walks the file as pages, checking every CRC on the way through.
 *
 * The checksum is the field most likely to be quietly wrong — it is computed
 * over the header with its own slot zeroed and then continued over the body,
 * which is easy to describe and easy to implement one byte off.
 */
function readPages(file: Buffer): { pages: Page[]; badCrc: number; trailing: number } {
  const pages: Page[] = [];
  let badCrc = 0;
  let at = 0;

  while (at + 27 <= file.length) {
    if (file.subarray(at, at + 4).toString('ascii') !== 'OggS') break;
    const segments = file.readUInt8(at + 26);
    const headerLength = 27 + segments;
    if (at + headerLength > file.length) break;

    const lacing = file.subarray(at + 27, at + headerLength);
    let bodyLength = 0;
    let packets = 0;
    for (const value of lacing) {
      bodyLength += value;
      if (value < 255) packets += 1;
    }
    const total = headerLength + bodyLength;
    if (at + total > file.length) break;

    const page = Buffer.from(file.subarray(at, at + total));
    const stated = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    if (crc32(page) !== stated) badCrc += 1;

    pages.push({
      flags: file.readUInt8(at + 5),
      granule: file.readBigUInt64LE(at + 6),
      serial: file.readUInt32LE(at + 14),
      sequence: file.readUInt32LE(at + 18),
      packets,
      body: Buffer.from(file.subarray(at + headerLength, at + total)),
    });
    at += total;
  }

  return { pages, badCrc, trailing: file.length - at };
}

/**
 * RFC 3533: direct algorithm, initial value and final XOR both zero,
 * polynomial 0x04c11db7, not reflected.
 *
 * Computed bit by bit rather than by borrowing the encoder's lookup table. A
 * table built wrong would agree with itself, and this test would pass while
 * every player rejected the file.
 */
function crc32(bytes: Buffer): number {
  let crc = 0;
  for (const byte of bytes) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

// ---------------------------------------------------------------------------

test('the file is whole pages, every checksum correct, nothing left over', () => {
  const file = encodeOggOpus(tone(1.4));
  assert.ok(file, 'nothing was encoded');

  const { pages, badCrc, trailing } = readPages(file);
  assert.ok(pages.length >= 3, `expected header, tags and audio; got ${pages.length} pages`);
  assert.equal(badCrc, 0, 'a bad checksum is a file no demuxer will open');
  assert.equal(trailing, 0, 'trailing bytes mean a page length was computed wrong');
});

test('the identity header is alone on the first page, and says what RFC 7845 requires', () => {
  const { pages } = readPages(encodeOggOpus(tone(0.5))!);
  const first = pages[0]!;

  assert.equal(first.packets, 1, 'the ID header must be placed alone on the first page');
  assert.equal(first.flags & 0x02, 0x02, 'beginning-of-stream');
  assert.equal(first.granule, 0n);

  const head = first.body;
  assert.equal(head.subarray(0, 8).toString('ascii'), 'OpusHead');
  assert.equal(head.readUInt8(8), 1, 'version MUST be 1');
  assert.equal(head.readUInt8(9), 1, 'mono');
  assert.ok(head.readUInt16LE(10) > 0, 'a pre-skip of zero starts the clip with a click');
  assert.equal(head.readUInt32LE(12), VOICE_SAMPLE_RATE, 'the original input rate');
  assert.equal(head.readUInt8(18), 0, 'channel mapping family 0: mono or stereo, no table');
});

test('the comment header is the second page', () => {
  const { pages } = readPages(encodeOggOpus(tone(0.5))!);
  assert.equal(pages[1]?.body.subarray(0, 8).toString('ascii'), 'OpusTags');
});

test('the stream is marked as ending, exactly once, on the last page', () => {
  const { pages } = readPages(encodeOggOpus(tone(3))!);
  const ends = pages.filter((page) => (page.flags & 0x04) === 0x04);

  assert.equal(ends.length, 1, 'more than one end-of-stream is a malformed file');
  assert.equal(ends[0], pages.at(-1), 'and it belongs on the last one');
});

test('pages are numbered in order and share one stream serial', () => {
  const { pages } = readPages(encodeOggOpus(tone(3))!);
  assert.deepEqual(
    pages.map((page) => page.sequence),
    pages.map((_, index) => index),
  );
  assert.equal(new Set(pages.map((page) => page.serial)).size, 1);
});

test('granule positions count 48kHz samples whatever the audio was encoded at', () => {
  // The rule that is easiest to get wrong and hardest to notice: get it wrong
  // and the file plays at the right speed while reporting the wrong duration.
  const seconds = 2;
  const { pages } = readPages(encodeOggOpus(tone(seconds))!);
  const final = Number(pages.at(-1)!.granule);

  assert.ok(
    Math.abs(final - seconds * 48_000) <= 48_000 * 0.03,
    `${final} granules for ${seconds}s of ${VOICE_SAMPLE_RATE}Hz audio — expected about ${seconds * 48_000}`,
  );
});

test('granule positions only ever go forwards', () => {
  const { pages } = readPages(encodeOggOpus(tone(3))!);
  let previous = -1n;
  for (const page of pages.slice(2)) {
    assert.ok(page.granule > previous, `granule went backwards: ${page.granule} after ${previous}`);
    previous = page.granule;
  }
});

test('no page carries more than the 255 segments the format allows', () => {
  // A page's segment table is one byte of count, so 256 would wrap to zero and
  // silently produce an empty page.
  const file = encodeOggOpus(tone(12))!;
  let at = 0;
  while (at + 27 <= file.length && file.subarray(at, at + 4).toString('ascii') === 'OggS') {
    const segments = file.readUInt8(at + 26);
    assert.ok(segments >= 1 && segments <= 255, `${segments} segments`);
    let body = 0;
    for (const value of file.subarray(at + 27, at + 27 + segments)) body += value;
    at += 27 + segments + body;
  }
  assert.equal(at, file.length);
});

test('audio too short to make a single frame is nothing rather than a broken file', () => {
  assert.equal(encodeOggOpus(Buffer.alloc(0)), null);
  assert.equal(encodeOggOpus(Buffer.alloc(10)), null, 'less than one 20ms frame');
});

test('longer audio is a longer file', () => {
  const short = encodeOggOpus(tone(0.5))!.length;
  const long = encodeOggOpus(tone(2))!.length;
  assert.ok(long > short * 2, `${short} then ${long} — silence would compress to nothing`);
});

test('the duration Telegram is told matches the audio', () => {
  assert.equal(pcmSeconds(tone(3)), 3);
  assert.equal(pcmSeconds(tone(0.4)), 1, 'never zero: Telegram shows a zero-length voice note badly');
  assert.equal(pcmSeconds(Buffer.alloc(0)), 1);
});
