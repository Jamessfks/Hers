/**
 * Persistence.
 *
 * Real files in a temp directory rather than a mocked filesystem, because every
 * case worth testing here is a disagreement between the manifest and the disk —
 * and a fake disk that always agrees with the manifest cannot produce one.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CLIP_SLOT_NAMES, libraryProgress, pendingWork, startGenerating } from './clips.ts';
import { ClipLibraryStore, hashSourceImage, libraryDirName } from './library-store.ts';

const PHOTO_A = new Uint8Array([1, 2, 3, 4]);
const PHOTO_B = new Uint8Array([9, 8, 7, 6]);

async function withStore(
  body: (store: ClipLibraryStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'anna-clips-'));
  try {
    await body(new ClipLibraryStore({ root }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// -- setup ------------------------------------------------------------------

test('opening a library writes the photograph and a manifest', async () => {
  await withStore(async (store, root) => {
    const library = await store.open(
      { bytes: PHOTO_A, mimeType: 'image/png' },
      { providerId: 'manual', now: 1_000 },
    );

    assert.equal(library.sourceHash, hashSourceImage(PHOTO_A));
    assert.equal(library.sourceFile, 'source.png');
    assert.equal(libraryProgress(library).pending, CLIP_SLOT_NAMES.length);

    const dir = join(root, libraryDirName(library.sourceHash));
    assert.deepEqual([...(await readFile(store.sourcePath(library)))], [...PHOTO_A]);
    assert.deepEqual((await readdir(dir)).sort(), ['clips', 'library.json', 'source.png']);
  });
});

test('a library round-trips through disk', async () => {
  await withStore(async (store) => {
    let library = await store.open({ bytes: PHOTO_A }, { providerId: 'luma' });
    library = startGenerating(library, 'nod', { providerId: 'luma', id: 'j1', submittedAt: 5 });
    library = await store.writeClip(library, 'idle', new Uint8Array([1]), {
      durationMs: 5_000,
      costUsd: 0.3,
    });
    await store.save(library);

    const loaded = await store.load(library.sourceHash);
    assert.ok(loaded);
    assert.equal(loaded.providerId, 'luma');
    assert.equal(loaded.clips.idle.status, 'ready');
    assert.equal(loaded.clips.idle.durationMs, 5_000);
    assert.equal(loaded.clips.idle.spentUsd, 0.3);
    assert.equal(loaded.clips.nod.status, 'generating');
    assert.equal(loaded.clips.nod.job?.id, 'j1', 'the job handle is the point of saving');
  });
});

test('there is nothing to load for a photograph that was never used', async () => {
  await withStore(async (store) => {
    assert.equal(await store.load(hashSourceImage(PHOTO_B)), null);
  });
});

// -- invalidation -----------------------------------------------------------

test('changing the photograph gives a new library and leaves the old one alone', async () => {
  await withStore(async (store) => {
    let first = await store.open({ bytes: PHOTO_A }, { providerId: 'manual' });
    first = await store.writeClip(first, 'idle', new Uint8Array([1]), { durationMs: 5_000 });
    first = await store.writeClip(first, 'nod', new Uint8Array([2]), { durationMs: 700 });
    await store.save(first);

    const second = await store.open({ bytes: PHOTO_B }, { providerId: 'manual' });

    // Nothing had to notice the photo changed: a different image is a different
    // directory, so there is no stale-flag path that can be got wrong.
    assert.notEqual(second.sourceHash, first.sourceHash);
    assert.equal(libraryProgress(second).ready, 0);
    assert.equal(libraryProgress(second).alive, false);
    assert.deepEqual(pendingWork(second).length, CLIP_SLOT_NAMES.length);

    // And switching back finds the finished work, rather than spending again.
    const back = await store.open({ bytes: PHOTO_A }, { providerId: 'manual' });
    assert.equal(libraryProgress(back).ready, 2);
    assert.equal(back.clips.nod.durationMs, 700, 'durations survive the round trip');
  });
});

test('two photographs never share a directory', async () => {
  await withStore(async (store) => {
    const a = await store.open({ bytes: PHOTO_A }, { providerId: 'manual' });
    const b = await store.open({ bytes: PHOTO_B }, { providerId: 'manual' });
    assert.notEqual(store.dirFor(a.sourceHash), store.dirFor(b.sourceHash));

    const libraries = await store.listLibraries();
    assert.equal(libraries.length, 2);
  });
});

// -- resuming ---------------------------------------------------------------

test('a build interrupted between the clip and the manifest loses nothing', async () => {
  await withStore(async (store) => {
    const library = await store.open({ bytes: PHOTO_A }, { providerId: 'manual' });
    await store.save(library);

    // Bytes land, then the process dies before the manifest is written. This is
    // the ordering library-store.ts chooses on purpose.
    await writeFile(join(store.clipsDir(library.sourceHash), 'idle.mp4'), new Uint8Array([1]));
    await writeFile(join(store.clipsDir(library.sourceHash), 'nod.mp4'), new Uint8Array([2]));

    const resumed = await store.load(library.sourceHash);
    assert.ok(resumed);
    assert.equal(resumed.clips.idle.status, 'ready');
    assert.equal(resumed.clips.nod.file, 'nod.mp4');
    assert.equal(libraryProgress(resumed).alive, true);
    assert.ok(!pendingWork(resumed).includes('nod'), 'a clip on disk is not re-generated');
  });
});

test('a partial build resumes exactly where it stopped', async () => {
  await withStore(async (store) => {
    let library = await store.open({ bytes: PHOTO_A }, { providerId: 'manual' });
    for (const slot of ['idle', 'nod', 'tilt_head'] as const) {
      library = await store.writeClip(library, slot, new Uint8Array([1]), { durationMs: 700 });
    }
    library = startGenerating(library, 'lean_in', {
      providerId: 'manual',
      id: 'in-flight',
      submittedAt: 1,
    });
    await store.save(library);

    // Restart: a brand new store object over the same directory.
    const resumed = await store.load(library.sourceHash);
    assert.ok(resumed);

    const progress = libraryProgress(resumed);
    assert.equal(progress.ready, 3);
    assert.equal(progress.generating, 1);

    const remaining = pendingWork(resumed);
    assert.equal(remaining.length, CLIP_SLOT_NAMES.length - 4);
    assert.ok(!remaining.includes('idle'));
    assert.ok(!remaining.includes('lean_in'), 'an in-flight job is resumed, not re-submitted');
    assert.equal(remaining[0], 'shake_head', 'the queue keeps its priority order');
  });
});

test('a clip deleted from disk comes back into the queue', async () => {
  await withStore(async (store) => {
    let library = await store.open({ bytes: PHOTO_A }, { providerId: 'manual' });
    library = await store.writeClip(library, 'nod', new Uint8Array([1]), { durationMs: 700 });
    await store.save(library);

    await rm(join(store.clipsDir(library.sourceHash), 'nod.mp4'));

    const loaded = await store.load(library.sourceHash);
    assert.ok(loaded);
    assert.equal(loaded.clips.nod.status, 'pending');
    assert.ok(pendingWork(loaded).includes('nod'));
  });
});

test('a mangled manifest does not throw away the clips it indexed', async () => {
  await withStore(async (store) => {
    let library = await store.open({ bytes: PHOTO_A }, { providerId: 'manual' });
    library = await store.writeClip(library, 'idle', new Uint8Array([1]), { durationMs: 5_000 });
    await store.save(library);

    // A truncated write, which is the failure the atomic rename exists to
    // prevent — simulated here to prove the recovery path underneath it.
    await writeFile(join(store.dirFor(library.sourceHash), 'library.json'), '{"version": 1, "clip');

    const loaded = await store.load(library.sourceHash);
    assert.ok(loaded, 'a lost manifest must not read as a lost library');
    assert.equal(loaded.clips.idle.status, 'ready');
    assert.equal(loaded.sourceFile, 'source.jpg', 'the still is found again by name');
  });
});

test('saving leaves no temporary files behind', async () => {
  await withStore(async (store) => {
    const library = await store.open({ bytes: PHOTO_A }, { providerId: 'manual' });
    await store.save(library);
    await store.save(library);

    const names = await readdir(store.dirFor(library.sourceHash));
    assert.ok(!names.some((name) => name.endsWith('.tmp')), `stray temp file in ${names.join()}`);
  });
});

test('removing a library takes the clips with it', async () => {
  await withStore(async (store) => {
    const library = await store.open({ bytes: PHOTO_A }, { providerId: 'manual' });
    await store.writeClip(library, 'idle', new Uint8Array([1]), { durationMs: 5_000 });

    await store.remove(library.sourceHash);
    assert.equal(await store.load(library.sourceHash), null);
    assert.deepEqual(await store.listLibraries(), []);
  });
});

test('the store survives a root that does not exist yet', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'anna-clips-')), 'not', 'created', 'yet');
  const store = new ClipLibraryStore({ root });
  try {
    assert.deepEqual(await store.listLibraries(), []);
    assert.equal(await store.load('deadbeef'), null);
    const library = await store.open({ bytes: PHOTO_A }, { providerId: 'manual' });
    assert.equal(libraryProgress(library).total, CLIP_SLOT_NAMES.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
