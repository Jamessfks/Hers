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
  evictClip,
  notePlayed,
  parseLibrary,
  recordSeam,
  reconcile,
  requeueClip,
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

/*
 * The verdict has to outlive the process, and it did not.
 *
 * `save` serialises the whole entry, so `verified` reached the manifest — and
 * `parseEntry` dropped it on the way back, along with `lastPlayedAt`. Every
 * launch therefore started from "measured nothing, played nothing", which
 * re-decoded a library's worth of video to reach conclusions already written
 * down, and reduced the eviction ordering to BUILD_ORDER.
 */
test('a measurement survives a restart', () => {
  const measured = recordSeam(withClip(), 'wave', { closesCleanly: true, summary: 'fine' });
  const reloaded = parseLibrary(JSON.parse(JSON.stringify(measured)))!;
  assert.equal(reloaded.clips['wave'].verified, true);
  assert.deepEqual(unverifiedClips(reloaded), [], 'and is not measured all over again');
});

test('a drifting clip is measured once, not on every launch', () => {
  // `verified: false` is a third state, not a falsy one. Testing it for
  // truthiness put every drifting clip back on the queue forever.
  const drifted = recordSeam(withClip(), 'wave', { closesCleanly: false, summary: 'moved 40%' });
  assert.equal(drifted.clips['wave'].verified, false);
  assert.deepEqual(unverifiedClips(drifted), []);

  const reloaded = parseLibrary(JSON.parse(JSON.stringify(drifted)))!;
  assert.equal(reloaded.clips['wave'].verified, false);
  assert.deepEqual(unverifiedClips(reloaded), []);
});

test('when the file used goes, so does the verdict about it', () => {
  const measured = recordSeam(withClip(), 'wave', { closesCleanly: false, summary: 'moved 40%' });

  // Evicted for room: the bytes are deleted, so there is nothing measured.
  const evicted = evictClip(measured, 'wave');
  assert.ok(
    !('verified' in evicted.clips['wave']),
    'cleared, not set to undefined: JSON drops an undefined key, so a manifest ' +
      'holding one stops matching the library it was written from',
  );

  // Rendered again into the same slot: new bytes, and it goes back on the queue
  // rather than inheriting the previous occupant's verdict.
  const again = completeClip(
    startGenerating(evicted, 'wave'),
    'wave',
    { file: 'wave.mp4', durationMs: 4000 },
  );
  assert.equal(again.clips['wave'].verified, undefined);
  assert.deepEqual(unverifiedClips(again), ['wave']);
});

test('a slot put back in the queue forgets what was measured about the old clip', () => {
  const measured = recordSeam(withClip(), 'wave', { closesCleanly: true, summary: 'fine' });
  const requeued = requeueClip(measured, 'wave', 'user asked for a redo');
  assert.equal(requeued.clips['wave'].verified, undefined);
});

test('a clip that fails its seam at write time is not measured again later', () => {
  // completeClip fails it, leaving the paid-for bytes on disk. reconcile then
  // finds those bytes and promotes the slot back to ready on the next launch —
  // at which point nothing should ask the renderer to reach the same verdict.
  const failed = completeClip(
    startGenerating(createLibrary({ sourceHash: 'abc', sourceFile: 's.jpg', providerId: 'hedra' }), 'wave'),
    'wave',
    { file: 'wave.mp4', durationMs: 4000, seam: { closesCleanly: false, summary: 'moved 40%' } },
  );
  assert.equal(failed.clips['wave'].status, 'failed');

  const recovered = reconcile(failed, new Set(['wave.mp4']));
  assert.equal(recovered.clips['wave'].status, 'ready');
  assert.deepEqual(unverifiedClips(recovered), []);
});

test('different bytes in the same slot are measured again', () => {
  // Someone drops a `.webm` over our `.mp4`. The recorded verdict is about a
  // file that is no longer there.
  const measured = recordSeam(withClip(), 'wave', { closesCleanly: true, summary: 'fine' });
  const swapped = reconcile(measured, new Set(['wave.webm']));
  assert.equal(swapped.clips['wave'].file, 'wave.webm');
  assert.deepEqual(unverifiedClips(swapped), ['wave']);
});

test('when a clip was last played survives a restart', () => {
  // Without this the eviction ordering starts every session believing nothing
  // has ever been played, which collapses least-recently-used into BUILD_ORDER.
  const played = notePlayed(withClip(), 'wave', 1_700_000_000_000);
  const reloaded = parseLibrary(JSON.parse(JSON.stringify(played)))!;
  assert.equal(reloaded.clips['wave'].lastPlayedAt, 1_700_000_000_000);
});

test('a play reported for a slot that is not in the library is ignored', () => {
  // The renderer is the one that knows what reached the screen, so this name
  // now crosses a process boundary and is an input rather than a constant.
  const library = withClip();
  assert.equal(notePlayed(library, 'not_a_slot' as never), library);
});

test('what was played is forgotten along with the clip that was played', () => {
  /*
   * `lastPlayedAt` belongs to a file, exactly as `verified` does, and only one
   * of the two was being cleared. A slot evicted for room kept the timestamp of
   * its *previous* occupant, so the moment a new clip was rendered into it — a
   * clip that has just been paid for and never had a chance to play — it ranked
   * below everything played this session and was the next thing eviction
   * reached for. Before the manifest carried `lastPlayedAt` across a restart
   * this reset itself every launch and could not be seen.
   */
  const played = notePlayed(withClip(), 'wave', 90);
  const evicted = evictClip(played, 'wave');
  assert.ok(!('lastPlayedAt' in evicted.clips['wave']));

  const again = completeClip(startGenerating(evicted, 'wave'), 'wave', {
    file: 'wave.mp4',
    durationMs: 4000,
    costUsd: 0.25,
  });
  assert.equal(again.clips['wave'].lastPlayedAt, undefined, 'a fresh render has never played');
});

test('a manifest round-trips deep-equal after a field has been cleared', () => {
  // The reason clearing deletes the key rather than writing undefined. Nothing
  // compares these two today, which is exactly why the difference would sit
  // there until something did.
  const cleared = requeueClip(
    recordSeam(withClip(), 'wave', { closesCleanly: true, summary: 'fine' }),
    'wave',
  );
  assert.deepEqual(parseLibrary(JSON.parse(JSON.stringify(cleared))), cleared);
});

test('a slot committed to being re-rendered forgets its verdict before the bytes land', () => {
  /*
   * `writeClip` writes the file and leaves the manifest to the caller, so a
   * crash in between is meant to cost nothing. Once `verified` became
   * load-bearing it could: a re-render writes new bytes under the *same* file
   * name, and `reconcile` comparing names cannot tell the old verdict does not
   * belong to them. Clearing at submit closes the window without hashing.
   */
  const measured = recordSeam(withClip(), 'wave', { closesCleanly: true, summary: 'fine' });
  const requeued = requeueClip(measured, 'wave');
  const generating = startGenerating(requeued, 'wave');
  assert.ok(!('verified' in generating.clips['wave']));

  // And a crash right there leaves a manifest that reconcile cannot mislabel.
  const recovered = reconcile(generating, new Set(['wave.mp4']));
  assert.equal(recovered.clips['wave'].status, 'ready');
  assert.deepEqual(unverifiedClips(recovered), ['wave']);
});
