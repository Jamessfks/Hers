import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Gallery, mimeFor, wantsHerFace } from './gallery.ts';
import type { GalleryOptions } from './gallery.ts';

async function gallery(files: string[] = [], options: GalleryOptions = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-gallery-'));
  await mkdir(dir, { recursive: true });
  for (const name of files) {
    await writeFile(path.join(dir, name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  return { dir, gallery: new Gallery(dir, options) };
}

/** The bytes of the photograph, distinct from every generated file's bytes. */
const FACE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A gallery that also has an uploaded photograph behind it, the way a real one
 * does. The photograph deliberately lives outside the gallery folder, because
 * that is where `AvatarStudio` keeps it.
 */
async function withFace(files: string[] = [], options: GalleryOptions = {}) {
  const avatarDir = await mkdtemp(path.join(tmpdir(), 'anna-face-'));
  const absolutePath = path.join(avatarDir, 'source.png');
  await writeFile(absolutePath, FACE_BYTES);

  const g = await gallery(files, {
    face: () => ({ name: 'source.png', absolutePath, mimeType: 'image/png', addedAt: 1 }),
    ...options,
  });
  return { ...g, facePath: absolutePath };
}

/** A stand-in for the image model that records what it was asked for. */
function recorder() {
  const calls: Array<{ description: string; reference?: { data: Buffer; mimeType: string } }> = [];
  const generator = async (request: {
    description: string;
    reference?: { data: Buffer; mimeType: string };
  }) => {
    calls.push(request);
    return { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };
  };
  return { calls, generator: generator as unknown as GalleryOptions['generator'] };
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

// -- her actual face --------------------------------------------------------

/**
 * These exist because of a real complaint: asked "can I see your picture now?"
 * on Telegram, she sent a stylised drawing of a woman who was not the woman in
 * the photograph that had been uploaded, while the web showed the photograph.
 * Three separate faults produced it, and each has a test here.
 */

test('a description that names only her is recognised as asking for her face', () => {
  for (const asking of [
    'a picture of you',
    'a picture of you right now',
    'you',
    'yourself',
    'your face',
    'a photo of you',
    'a selfie',
    'what do you look like',
    'can I see a real picture of you',
    'show me you',
  ]) {
    assert.equal(wantsHerFace(asking), true, `"${asking}" is a request for her face`);
  }

  for (const asking of [
    'at the window watching the rain',
    'laughing in the kitchen',
    'you at the beach',
    'a picture of you holding a coffee',
    'evening, warm indoor light, looking at the camera',
    'you laughing',
  ]) {
    assert.equal(wantsHerFace(asking), false, `"${asking}" describes a scene, so it is generated`);
  }

  assert.equal(wantsHerFace(''), false, 'an empty description asks for nothing');
});

test('asking only for her sends the photograph she was given', async () => {
  // The exact file the old code kept re-sending: a previous generation whose
  // derived caption matches the request word for word.
  const g = await withFace(['a-picture-of-you-right-now-1786883162943.jpg']);

  const item = await g.gallery.pick('a picture of you right now');
  assert.equal(item?.name, 'source.png', 'she must send her own face, not a picture of it');
  assert.equal(item?.absolutePath, g.facePath);
});

test('a picture of her is never invented when the real one is on disk', async () => {
  const r = recorder();
  const g = await withFace([], { generator: r.generator });

  const item = await g.gallery.pick('can I see your picture now', {
    allowNew: true,
    apiKey: 'test-key',
  });

  assert.equal(item?.name, 'source.png');
  assert.equal(r.calls.length, 0, 'generating a face we already have is a bill and a worse answer');
});

test('a described scene is still answered from the folder, not with the photograph', async () => {
  const g = await withFace(['at-the-window-rainy.jpg', 'laughing-in-the-kitchen.jpg']);

  assert.equal((await g.gallery.pick('watching the rain'))?.name, 'at-the-window-rainy.jpg');
  assert.equal((await g.gallery.pick('laughing'))?.name, 'laughing-in-the-kitchen.jpg');
});

test('the photograph is servable by name, so the web renders what was sent', async () => {
  const g = await withFace(['at-the-window-rainy.jpg']);

  // The web turns whatever `pick` returned into `/gallery/<name>`, which is
  // served through `resolve`. If this were null the browser would show a
  // broken image for the one picture that is definitely her.
  const resolved = await g.gallery.resolve('source.png');
  assert.equal(resolved?.absolutePath, g.facePath);
  assert.equal(resolved?.kind, 'image');

  // Still a name check rather than a path one: a name that is not hers finds
  // nothing, and traversal is stripped rather than followed — `../source.png`
  // is the photograph because its basename is, not because it walked anywhere.
  for (const attempt of ['/etc/passwd', 'source.jpg', 'manifest.json', '../../.env']) {
    assert.equal(await g.gallery.resolve(attempt), null, `${attempt} resolved to something`);
  }
  assert.equal((await g.gallery.resolve('../source.png'))?.absolutePath, g.facePath);
});

test('a new picture is generated from her photograph, never from the last generated one', async () => {
  const r = recorder();
  // A generated picture already sits in the folder and is newer than the
  // photograph. The old code referenced this, so each picture was a copy of a
  // copy and her face walked away from the original a step at a time.
  const g = await withFace(['evening-warm-light-1786882138316.jpg'], { generator: r.generator });

  await g.gallery.generate('laughing in the kitchen', { apiKey: 'test-key' });

  assert.equal(r.calls.length, 1);
  assert.deepEqual(
    r.calls[0]?.reference?.data,
    FACE_BYTES,
    'the reference must be the uploaded photograph',
  );
  assert.equal(r.calls[0]?.reference?.mimeType, 'image/png');
});

test('with no photograph at all the newest picture is still the reference', async () => {
  const r = recorder();
  const g = await gallery(['older.jpg'], { generator: r.generator });
  await g.gallery.generate('laughing', { apiKey: 'test-key' });

  assert.equal(r.calls.length, 1);
  assert.ok(r.calls[0]?.reference, 'some consistency beats none when there is no face to use');
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
