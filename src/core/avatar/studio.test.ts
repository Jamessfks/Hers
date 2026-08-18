import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AvatarStudio, IMAGE_LIMITS } from './studio.ts';

/** A real 300x300 PNG header — big enough to pass, small enough to inline. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  header.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

/** A JPEG header with a real SOF0 frame, which is what `sniffImage` reads. */
function jpeg(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt16BE(0xffd8, 0);
  bytes.writeUInt16BE(0xffc0, 2);
  bytes.writeUInt16BE(11, 4);
  bytes[6] = 8;
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[11] = 3;
  return bytes;
}

async function studio() {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), 'hers-avatar-')), 'avatar');
  const instance = new AvatarStudio({ dir });
  await instance.load();
  return { dir, studio: instance };
}

// -- the photograph ---------------------------------------------------------

test('a fresh studio has no face and says so', async () => {
  const { studio: s } = await studio();
  const state = s.state();
  assert.equal(state.hasSource, false);
  assert.equal(state.sourceUrl, null);
  assert.equal(state.width, 0);
  assert.equal(state.height, 0);
});

test('a real image is accepted and becomes the source', async () => {
  const { studio: s } = await studio();
  const state = await s.setSource(png(512, 640), 'image/png');
  assert.equal(state.hasSource, true);
  assert.equal(state.width, 512);
  assert.equal(state.height, 640);
  assert.match(state.sourceUrl ?? '', /^\/avatar\/source\?v=/);
  assert.ok(existsSync(s.sourcePath() ?? ''));
});

test('the same picture twice is the same url, a different one is not', async () => {
  const { studio: s } = await studio();
  const first = (await s.setSource(png(512, 640), 'image/png')).sourceUrl;
  const same = (await s.setSource(png(512, 640), 'image/png')).sourceUrl;
  const other = (await s.setSource(png(640, 512), 'image/png')).sourceUrl;

  assert.equal(first, same, 'the same bytes must not bust the cache');
  assert.notEqual(first, other, 'a new picture must, or the old one stays on screen');
});

test('what is refused, and why, in words a person can act on', async () => {
  const { studio: s } = await studio();

  await assert.rejects(() => s.setSource(Buffer.alloc(0), 'image/png'), /empty/);
  await assert.rejects(
    () => s.setSource(Buffer.from('this is just text'), 'image/jpeg'),
    /JPEG, PNG or WebP/,
  );
  await assert.rejects(() => s.setSource(png(64, 64), 'image/png'), /at least 256 pixels/);
  await assert.rejects(() => s.setSource(png(9000, 9000), 'image/png'), /cannot be over/);
  await assert.rejects(
    () => s.setSource(Buffer.alloc(IMAGE_LIMITS.maxBytes + 1, 1), 'image/png'),
    /The limit is/,
  );
});

test('the bytes decide the format, not the content-type header', async () => {
  const { studio: s } = await studio();
  // Claimed as JPEG, actually PNG. The magic number is the evidence.
  const state = await s.setSource(png(400, 400), 'image/jpeg');
  assert.equal(state.hasSource, true);
  assert.equal(s.sourceMimeType(), 'image/png');
});

test('the photograph is offered as a file, so she can send it as well as generate from it', async () => {
  const { studio: s, dir } = await studio();
  assert.equal(s.face(), null, 'nothing to send before anything is uploaded');

  await s.setSource(png(512, 640), 'image/png');
  const face = s.face();
  assert.equal(face?.name, 'source.png');
  assert.equal(face?.mimeType, 'image/png');
  assert.equal(face?.absolutePath, path.join(dir, 'source.png'));
  assert.equal(face?.absolutePath, s.sourcePath(), 'one photograph, not two ideas of where it is');

  // Replacing it replaces what gets sent, rather than leaving the old one.
  await s.setSource(png(400, 400), 'image/jpeg');
  assert.equal(s.face()?.absolutePath, s.sourcePath());
});

test('the bytes are handed over for generating a picture of her', async () => {
  const { studio: s } = await studio();
  assert.equal(await s.sourceImage(), null, 'no photograph is a real answer, not an empty buffer');

  const uploaded = png(512, 640);
  await s.setSource(uploaded, 'image/png');
  const image = await s.sourceImage();
  assert.equal(image?.mimeType, 'image/png');
  assert.deepEqual(image?.data, uploaded, 'she must be generated from the photograph itself');
});

test('only one photograph is kept when the format changes', async () => {
  const { dir, studio: s } = await studio();
  await s.setSource(jpeg(400, 400), 'image/jpeg');
  await s.setSource(png(400, 500), 'image/png');

  const sources = (await readdir(dir)).filter((name) => name.startsWith('source.'));
  assert.deepEqual(sources, ['source.png'], `left ${sources.join(', ')} behind`);
});

test('the photograph survives a restart, because the manifest is the record', async () => {
  const { dir, studio: s } = await studio();
  await s.setSource(png(512, 640), 'image/png');

  const revived = new AvatarStudio({ dir });
  const state = await revived.load();
  assert.equal(state.hasSource, true);
  assert.equal(state.width, 512);
  assert.equal(state.height, 640);
  assert.equal(revived.sourcePath(), s.sourcePath());
});
