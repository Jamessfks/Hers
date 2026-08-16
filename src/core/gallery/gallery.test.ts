import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Gallery, mimeFor } from './gallery.ts';

async function gallery(files: string[] = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-gallery-'));
  await mkdir(dir, { recursive: true });
  for (const name of files) {
    await writeFile(path.join(dir, name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  return { dir, gallery: new Gallery(dir) };
}

test('an empty or missing folder is an empty gallery, not an error', async () => {
  const missing = new Gallery(path.join(tmpdir(), 'anna-nothing-here-at-all'));
  assert.deepEqual(await missing.list(), []);
  assert.equal(await missing.pick('anything'), null);
});

test('images and clips are listed, and everything else is ignored', async () => {
  const g = await gallery(['a.jpg', 'b.png', 'c.mp4', 'notes.txt', 'captions.json']);
  const names = (await g.gallery.list()).map((item) => item.name).sort();
  assert.deepEqual(names, ['a.jpg', 'b.png', 'c.mp4']);

  const kinds = new Map((await g.gallery.list()).map((item) => [item.name, item.kind]));
  assert.equal(kinds.get('a.jpg'), 'image');
  assert.equal(kinds.get('c.mp4'), 'clip');
});

test('a file name is a caption when there is nothing better', async () => {
  const g = await gallery(['at-the-window_rainy.jpg']);
  const [item] = await g.gallery.list();
  assert.equal(item?.caption, 'at the window rainy');
});

test('captions.json wins over the file name', async () => {
  const g = await gallery(['x1.jpg']);
  await writeFile(
    path.join(g.dir, 'captions.json'),
    JSON.stringify({ 'x1.jpg': 'Standing at the window watching it rain.' }),
  );
  const [item] = await g.gallery.list();
  assert.equal(item?.caption, 'Standing at the window watching it rain.');
});

test('a broken captions.json is ignored rather than fatal', async () => {
  const g = await gallery(['x1.jpg']);
  await writeFile(path.join(g.dir, 'captions.json'), '{{{not json');
  assert.equal((await g.gallery.list()).length, 1);
});

test('a description finds the picture that fits', async () => {
  const g = await gallery([
    'at-the-window-rainy.jpg',
    'laughing-in-the-kitchen.jpg',
    'tired-late-at-night.jpg',
  ]);

  assert.equal((await g.gallery.pick('watching the rain'))?.name, 'at-the-window-rainy.jpg');
  assert.equal((await g.gallery.pick('laughing'))?.name, 'laughing-in-the-kitchen.jpg');
  assert.equal((await g.gallery.pick('exhausted, late'))?.name, 'tired-late-at-night.jpg');
});

test('nothing fitting returns nothing rather than the least-bad thing', async () => {
  const g = await gallery(['at-the-window-rainy.jpg']);
  assert.equal(
    await g.gallery.pick('riding a motorbike across the surface of mars'),
    null,
    'a wrong picture is worse than no picture',
  );
});

test('generating is refused without a key rather than attempted', async () => {
  const g = await gallery([]);
  assert.equal(await g.gallery.pick('anything', { allowNew: true }), null);
});

test('resolve only ever returns a file the listing knows', async () => {
  const g = await gallery(['smiling.jpg']);
  await writeFile(path.join(g.dir, '..', 'outside.jpg'), Buffer.from([1]));

  assert.equal((await g.gallery.resolve('smiling.jpg'))?.name, 'smiling.jpg');
  for (const attempt of [
    '../outside.jpg',
    '../../etc/passwd',
    '..\\outside.jpg',
    '/etc/passwd',
    './smiling.jpg/../../outside.jpg',
  ]) {
    assert.equal(await g.gallery.resolve(attempt), null, `${attempt} resolved to something`);
  }
});

test('mime types cover what the gallery accepts', () => {
  assert.equal(mimeFor('.jpg'), 'image/jpeg');
  assert.equal(mimeFor('.JPG'), 'image/jpeg');
  assert.equal(mimeFor('.png'), 'image/png');
  assert.equal(mimeFor('.webp'), 'image/webp');
  assert.equal(mimeFor('.mp4'), 'video/mp4');
  assert.equal(mimeFor('.webm'), 'video/webm');
  assert.equal(mimeFor('.unknown'), 'image/jpeg');
});
