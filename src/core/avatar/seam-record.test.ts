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

test('a clip that does not close is demoted, and keeps its file', () => {
  const library = recordSeam(withClip(), 'wave', {
    closesCleanly: false,
    summary: 'mean delta 0.11',
  });
  const entry = library.clips['wave'];
  assert.equal(entry.status, 'failed');
  // The bytes are paid for. Deleting the file would turn a cosmetic defect into
  // a second charge to get it back.
  assert.equal(entry.file, 'wave.mp4');
  assert.match(entry.error ?? '', /does not return to the source pose/);
});

test('the same verdict reaches the same conclusion whichever door it comes in', () => {
  // `completeClip` takes a verdict when one is available at write time;
  // `recordSeam` applies one that arrives later. They must not disagree, or a
  // clip's fate would depend on which process happened to measure it first.
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

  assert.equal(atWrite.clips['wave'].status, afterwards.clips['wave'].status);
  assert.equal(atWrite.clips['wave'].error, afterwards.clips['wave'].error);
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
