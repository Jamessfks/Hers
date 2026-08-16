/**
 * Recording a seam verdict against a clip that is already on disk.
 *
 * The measurement itself is covered in seam.test.ts. This is about the state
 * machine around it — the half that went unwritten for so long that
 * `hologram.ts` documented an invariant nothing enforced.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  completeClip,
  createLibrary,
  recordSeam,
  startGenerating,
  unverifiedClips,
  type ClipLibrary,
} from './clips.ts';

function withClip(): ClipLibrary {
  const base = createLibrary({ sourceHash: 'abc', sourceFile: 'source.jpg', providerId: 'hedra' });
  // The state a clip is actually in when it lands: on disk, playable, and never
  // measured, because main cannot decode a video.
  return completeClip(base, 'wave', { file: 'wave.mp4', durationMs: 4000, costUsd: 0.25 });
}

test('a clip written without a measurement is ready but not verified', () => {
  const library = withClip();
  assert.equal(library.clips['wave'].status, 'ready');
  assert.equal(library.clips['wave'].verified, undefined);
  assert.deepEqual(unverifiedClips(library), ['wave']);
});

test('a clean verdict marks it verified and takes it off the queue', () => {
  const library = recordSeam(withClip(), 'wave', { closesCleanly: true, summary: 'mean delta 0.004' });
  assert.equal(library.clips['wave'].status, 'ready');
  assert.equal(library.clips['wave'].verified, true);
  assert.deepEqual(unverifiedClips(library), []);
});

test('a measured cut point replaces the nominal duration', () => {
  // The point of searching the hold: the clip is fine, it just runs on past
  // where it closed, and the cut decides how long the gesture lasts.
  const library = recordSeam(withClip(), 'wave', {
    closesCleanly: true,
    summary: 'mean delta 0.006 (cut early)',
    cutAtMs: 3200,
  });
  assert.equal(library.clips['wave'].durationMs, 3200);
});

test('a clip that does not close keeps playing, and stops claiming to loop', () => {
  const library = recordSeam(withClip(), 'wave', {
    closesCleanly: false,
    summary: 'mean delta 0.11',
  });
  const entry = library.clips['wave'];
  // Still ready: removing it would take her body away over a visible seam, and
  // this may be the only clip she has. See the note in recordSeam.
  assert.equal(entry.status, 'ready');
  assert.equal(entry.verified, false);
  assert.equal(entry.file, 'wave.mp4');
  assert.match(entry.error ?? '', /Does not return to the source pose/);
});

test('the same verdict is treated differently at write time and afterwards', () => {
  /*
   * The one place these two deliberately disagree, and it is worth pinning.
   *
   * `completeClip` is judging a render that has just been paid for: a bad one
   * should go back in the queue rather than into the library, so it fails.
   * `recordSeam` is judging a clip that is already in the library and may be
   * the only one she has — failing it there removes it from `ready` and takes
   * her body away over a visible seam. It stays playable and stops claiming to
   * loop, which is exactly what the `verified` flag is for.
   */
  const verdict = { closesCleanly: false, summary: 'mean delta 0.11' };
  const atWrite = completeClip(
    startGenerating(
      createLibrary({ sourceHash: 'abc', sourceFile: 'source.jpg', providerId: 'hedra' }),
      'wave',
    ),
    'wave',
    { file: 'wave.mp4', durationMs: 4000, seam: verdict },
  );
  const afterwards = recordSeam(withClip(), 'wave', verdict);

  assert.equal(atWrite.clips['wave'].status, 'failed', 'a fresh bad render goes back in the queue');
  assert.equal(afterwards.clips['wave'].status, 'ready', 'an existing clip keeps playing');
  // Both record why, so the setup screen can offer to re-render either one.
  assert.match(atWrite.clips['wave'].error ?? '', /source pose/);
  assert.match(afterwards.clips['wave'].error ?? '', /source pose/);
});

test('recording a seam for a clip that was never written is refused', () => {
  // A verdict about a file that does not exist is a caller bug. Inventing a
  // `ready` entry for it would put the manifest in a state nothing else in the
  // module can produce.
  const empty = createLibrary({ sourceHash: 'abc', sourceFile: 'source.jpg', providerId: 'hedra' });
  assert.throws(
    () => recordSeam(empty, 'wave', { closesCleanly: true, summary: 'fine' }),
    /no clip on disk/,
  );
});

test('a verified clip does not reappear on the queue after another change', () => {
  const verified = recordSeam(withClip(), 'wave', { closesCleanly: true, summary: 'fine' });
  const andAnother = completeClip(verified, 'nod', { file: 'nod.mp4', durationMs: 4000 });
  assert.deepEqual(unverifiedClips(andAnother), ['nod']);
});
