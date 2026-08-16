/**
 * Clip library state.
 *
 * The cases worth writing down are the ones that cost money: a slot submitted
 * twice, a build interrupted halfway, a manifest that disagrees with the disk,
 * and a slot that fails forever. None of them need a filesystem or a vendor,
 * which is the reason every function under test is a pure one.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GESTURE_NAMES } from '../../shared/protocol.ts';
import {
  BUILD_ORDER,
  CLIP_SLOT_NAMES,
  IDLE_SLOT,
  LIBRARY_VERSION,
  MAX_ATTEMPTS,
  attachJob,
  clipFileName,
  completeClip,
  createLibrary,
  exhaustedSlots,
  failClip,
  libraryProgress,
  matchesSource,
  parseLibrary,
  pendingWork,
  reconcile,
  requeueClip,
  unverifiedClips,
  resetAttempts,
  resolvePlayback,
  resumableJobs,
  slotOfClipFile,
  startGenerating,
  type ClipLibrary,
} from './clips.ts';

function fixture(): ClipLibrary {
  return createLibrary({
    sourceHash: 'abc123',
    sourceFile: 'source.jpg',
    providerId: 'manual',
    now: 1_000,
  });
}

// -- shape ------------------------------------------------------------------

test('every gesture in the protocol has a slot, plus idle', () => {
  for (const name of GESTURE_NAMES) {
    assert.ok(CLIP_SLOT_NAMES.includes(name), `missing slot for ${name}`);
  }
  assert.ok(CLIP_SLOT_NAMES.includes(IDLE_SLOT));
  assert.equal(CLIP_SLOT_NAMES.length, GESTURE_NAMES.length + 1);
});

test('the build order covers every slot exactly once', () => {
  // A slot missing here is a clip that is never generated and never reported
  // as missing either — the library just quietly stops at 18 of 19.
  assert.deepEqual([...BUILD_ORDER].sort(), [...CLIP_SLOT_NAMES].sort());
  assert.equal(BUILD_ORDER[0], IDLE_SLOT, 'idle must be built first');
});

test('a new library is entirely pending', () => {
  const library = fixture();
  const progress = libraryProgress(library);
  assert.equal(progress.pending, CLIP_SLOT_NAMES.length);
  assert.equal(progress.ready, 0);
  assert.equal(progress.fraction, 0);
  assert.equal(progress.alive, false);
  assert.deepEqual(pendingWork(library), [...BUILD_ORDER]);
});

// -- transitions ------------------------------------------------------------

test('a slot walks from pending to ready', () => {
  let library = fixture();
  library = startGenerating(library, 'nod', null, 2_000);
  assert.equal(library.clips.nod.status, 'generating');
  assert.equal(library.clips.nod.attempts, 1);

  library = attachJob(library, 'nod', { providerId: 'manual', id: 'job-1', submittedAt: 2_100 });
  assert.equal(library.clips.nod.job?.id, 'job-1');

  library = completeClip(
    library,
    'nod',
    { file: 'nod.mp4', durationMs: 700, costUsd: 0.25 },
    3_000,
  );
  assert.equal(library.clips.nod.status, 'ready');
  assert.equal(library.clips.nod.job, null, 'a finished job must not stay attached');
  assert.equal(library.clips.nod.spentUsd, 0.25);
  assert.equal(libraryProgress(library).spentUsd, 0.25);
});

test('submitting a slot that is already generating is refused', () => {
  // The one transition that costs money rather than correctness.
  const library = startGenerating(fixture(), 'nod');
  assert.throws(() => startGenerating(library, 'nod'), /already generating/);
});

test('a ready slot cannot be marked failed', () => {
  const library = completeClip(
    startGenerating(fixture(), 'nod'),
    'nod',
    { file: 'nod.mp4', durationMs: 700 },
  );
  assert.throws(() => failClip(library, 'nod', 'nope'), /cannot go from ready to failed/);
});

test('a failed slot is retried until it has had enough', () => {
  let library = fixture();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    assert.ok(pendingWork(library).includes('wave'), `attempt ${attempt} should be queued`);
    library = startGenerating(library, 'wave');
    library = failClip(library, 'wave', 'the model refused', { costUsd: 0.1 });
  }

  assert.equal(library.clips.wave.attempts, MAX_ATTEMPTS);
  assert.ok(!pendingWork(library).includes('wave'), 'a slot that failed three times stops costing');
  assert.deepEqual(exhaustedSlots(library), ['wave']);
  // Failed attempts are still billed, and the library says so.
  assert.equal(Math.round(library.clips.wave.spentUsd * 100), 30);

  library = resetAttempts(library, 'wave');
  assert.ok(pendingWork(library).includes('wave'), '"try again" must actually try again');
});

// -- resuming ---------------------------------------------------------------

test('a clip file on disk beats whatever the manifest says', () => {
  // The crash-between-write-and-save case. We paid for these bytes.
  const library = reconcile(fixture(), new Set(['nod.mp4', 'idle.webm']), 5_000);
  assert.equal(library.clips.nod.status, 'ready');
  assert.equal(library.clips.nod.file, 'nod.mp4');
  assert.equal(library.clips[IDLE_SLOT].file, 'idle.webm', 'any container the browser plays');
  assert.equal(libraryProgress(library).alive, true);
});

test('a ready slot whose file vanished goes back in the queue', () => {
  let library = completeClip(
    startGenerating(fixture(), 'nod'),
    'nod',
    { file: 'nod.mp4', durationMs: 700 },
  );
  library = reconcile(library, new Set(), 5_000);
  assert.equal(library.clips.nod.status, 'pending');
  assert.match(library.clips.nod.error ?? '', /went missing/);
  assert.ok(pendingWork(library).includes('nod'));
});

test('an in-flight job survives a restart instead of being paid for twice', () => {
  const job = { providerId: 'runway', id: 'job-9', submittedAt: 4_000 };
  let library = startGenerating(fixture(), 'wave', job, 4_000);
  library = reconcile(library, new Set(), 5_000);

  assert.equal(library.clips.wave.status, 'generating');
  assert.deepEqual(resumableJobs(library), [{ slot: 'wave', job }]);
  assert.ok(!pendingWork(library).includes('wave'), 'a live job must not also be re-submitted');
});

test('an attempt that died before its job id was saved is requeued, loudly', () => {
  let library = startGenerating(fixture(), 'wave', null, 4_000);
  library = reconcile(library, new Set(), 5_000);

  assert.equal(library.clips.wave.status, 'pending');
  assert.deepEqual(resumableJobs(library), []);
  assert.match(library.clips.wave.error ?? '', /charged for already/);
  assert.ok(pendingWork(library).includes('wave'));
});

test('reconcile is idempotent', () => {
  const once = reconcile(fixture(), new Set(['nod.mp4']), 5_000);
  const twice = reconcile(once, new Set(['nod.mp4']), 6_000);
  assert.deepEqual(twice.clips.nod, once.clips.nod, 'a no-op reconcile must not churn the entry');
});

test('a partial build reports honest progress', () => {
  let library = reconcile(fixture(), new Set(['idle.mp4', 'nod.mp4', 'tilt_head.mp4']), 5_000);
  library = startGenerating(library, 'lean_in', {
    providerId: 'runway',
    id: 'j',
    submittedAt: 6_000,
  });

  const progress = libraryProgress(library);
  assert.equal(progress.ready, 3);
  assert.equal(progress.generating, 1);
  assert.equal(progress.pending, CLIP_SLOT_NAMES.length - 4);
  assert.equal(progress.total, CLIP_SLOT_NAMES.length);
  assert.ok(progress.fraction > 0.15 && progress.fraction < 0.16);
  assert.equal(progress.alive, true);
});

// -- playback ---------------------------------------------------------------

test('a half-built library still has something to play', () => {
  const library = reconcile(fixture(), new Set(['idle.mp4', 'nod.mp4']), 5_000);

  assert.deepEqual(resolvePlayback(library, 'nod'), {
    kind: 'clip',
    slot: 'nod',
    file: 'nod.mp4',
    durationMs: 0,
  });

  // The wave has not been generated. She keeps breathing rather than freezing;
  // the gesture simply does not happen.
  const wave = resolvePlayback(library, 'wave');
  assert.equal(wave.kind, 'clip');
  assert.equal(wave.kind === 'clip' && wave.slot, IDLE_SLOT);
});

test('an empty library falls back to the photograph', () => {
  const still = resolvePlayback(fixture(), 'nod');
  assert.equal(still.kind, 'still');
  assert.match(still.kind === 'still' ? still.reason : '', /not been generated/);
});

test('a missing idle clip does not fall back to itself', () => {
  const still = resolvePlayback(fixture(), IDLE_SLOT);
  assert.equal(still.kind, 'still');
});

// -- identity ---------------------------------------------------------------

test('a library belongs to exactly one photograph', () => {
  const library = fixture();
  assert.ok(matchesSource(library, 'abc123'));
  assert.ok(!matchesSource(library, 'def456'), 'a different photo is a different library');
});

// -- file names -------------------------------------------------------------

test('clip file names round-trip through slot names', () => {
  for (const slot of CLIP_SLOT_NAMES) {
    assert.equal(slotOfClipFile(clipFileName(slot)), slot);
    assert.equal(slotOfClipFile(clipFileName(slot, '.webm')), slot);
  }
  assert.equal(slotOfClipFile('.DS_Store'), null);
  assert.equal(slotOfClipFile('source.jpg'), null);
  assert.equal(slotOfClipFile('library.json'), null);
});

// -- manifests --------------------------------------------------------------

test('a manifest from another build loses nothing that is on disk', () => {
  const raw = {
    version: 1,
    sourceHash: 'abc123',
    sourceFile: 'source.png',
    providerId: 'luma',
    createdAt: 10,
    clips: {
      nod: { slot: 'nod', status: 'ready', file: 'nod.mp4', durationMs: 700 },
      // A gesture this build has never heard of, and one it has but the old
      // build did not write.
      moonwalk: { slot: 'moonwalk', status: 'ready', file: 'moonwalk.mp4' },
    },
  };

  const library = parseLibrary(raw);
  assert.ok(library);
  assert.equal(library.clips.nod.status, 'ready');
  assert.equal(library.clips.nod.durationMs, 700);
  assert.equal(library.clips.wave.status, 'pending', 'unseen slots come back pending');
  assert.ok(!('moonwalk' in library.clips), 'unknown slots are dropped');
  assert.equal(library.sourceFile, 'source.png');
});

test('a mangled entry resets that slot and not the library', () => {
  const library = parseLibrary({
    version: 1,
    sourceHash: 'abc123',
    clips: { nod: 'not an object', wave: { status: 'exploded' } },
  });
  assert.ok(library);
  assert.equal(library.clips.nod.status, 'pending');
  assert.equal(library.clips.wave.status, 'pending');
  assert.equal(Object.keys(library.clips).length, CLIP_SLOT_NAMES.length);
});

test('something that is not a library is refused', () => {
  assert.equal(parseLibrary(null), null);
  // A version from the future: this build cannot know what it means, and
  // guessing at a manifest that indexes paid-for clips is worse than refusing.
  assert.equal(parseLibrary({ version: LIBRARY_VERSION + 1, sourceHash: 'x' }), null);
  assert.equal(parseLibrary({ version: 1 }), null, 'no source hash means no identity');
});

test('a version-1 manifest keeps its clips and loses its seam verdicts', () => {
  /*
   * The verdicts in a version-1 manifest were measured against the source
   * photograph resampled to the vendor's frame size, and it was mostly the
   * resample they were reporting. A wrong `true` claims a seam that pops; a
   * wrong `false` cannot be cleared without paying to render the slot again.
   * Everything else in the file is still good, and the clips it points at cost
   * money, so this is a re-measure rather than a rebuild.
   */
  const library = parseLibrary({
    version: 1,
    sourceHash: 'abc123',
    clips: {
      nod: { slot: 'nod', status: 'ready', file: 'nod.mp4', durationMs: 700, verified: false },
      wave: { slot: 'wave', status: 'ready', file: 'wave.mp4', verified: true, lastPlayedAt: 42 },
    },
  });
  assert.ok(library);
  assert.equal(library.version, LIBRARY_VERSION, 'and is written back at the current version');
  assert.equal(library.clips.nod.status, 'ready', 'the clips are kept');
  assert.equal(library.clips.nod.durationMs, 700);
  assert.equal(library.clips.wave.lastPlayedAt, 42, 'so is what she has actually used');
  assert.deepEqual(unverifiedClips(library), ['nod', 'wave'], 'both go back to be measured');
});

test('a library survives a save and load round trip through JSON', () => {
  let library = completeClip(
    startGenerating(fixture(), 'nod', { providerId: 'luma', id: 'j1', submittedAt: 1 }),
    'nod',
    { file: 'nod.mp4', durationMs: 700, costUsd: 0.2 },
  );
  library = requeueClip(library, 'wave', 'user asked for a redo');

  const parsed = parseLibrary(JSON.parse(JSON.stringify(library)));
  assert.deepEqual(parsed, library);
});

test('a clip that does not close is failed, not marked ready', () => {
  // The whole seamlessness claim rests on this. Bytes used to be accepted on
  // the strength of a prompt that *asked* the model to return to the pose.
  const library = startGenerating(fixture(), 'nod');
  const next = completeClip(library, 'nod', {
    file: 'nod.webm',
    durationMs: 5000,
    seam: { closesCleanly: false, summary: 'worst region moved 41%' },
  });
  assert.equal(next.clips.nod.status, 'failed');
  assert.match(next.clips.nod.error ?? '', /does not return to the source pose/);
  assert.match(next.clips.nod.error ?? '', /41%/, 'the measurement reaches the user');
});

test('a measured clip is marked verified and cut where it actually closes', () => {
  const library = fixture();
  const next = completeClip(library, 'nod', {
    file: 'nod.webm',
    durationMs: 5000,
    seam: { closesCleanly: true, summary: 'closes cleanly (0.4%)', cutAtMs: 4120 },
  });
  assert.equal(next.clips.nod.status, 'ready');
  assert.equal(next.clips.nod.verified, true);
  assert.equal(next.clips.nod.durationMs, 4120, 'the measured cut point beats the nominal one');
});

test('an unmeasured clip still plays, but does not claim to be seamless', () => {
  // A hand-dropped clip has bytes and no verdict. Refusing it would make the
  // manual provider unusable; implying it was checked would be a lie.
  const library = fixture();
  const next = completeClip(library, 'nod', { file: 'nod.webm', durationMs: 5000 });
  assert.equal(next.clips.nod.status, 'ready');
  assert.equal(next.clips.nod.verified, undefined);
});

test('a failed clip still records what it cost', () => {
  // The money was spent whether or not the frame came back clean.
  const library = startGenerating(fixture(), 'nod');
  const next = completeClip(library, 'nod', {
    file: 'nod.webm',
    durationMs: 5000,
    costUsd: 0.35,
    seam: { closesCleanly: false, summary: 'drifted' },
  });
  assert.equal(next.clips.nod.spentUsd, 0.35);
});

// ---------------------------------------------------------------------------
// Regressions from the first live render
// ---------------------------------------------------------------------------

test('a slot can fail twice without the second failure throwing', () => {
  // This cost a paid clip. `failed -> failed` was missing from the transition
  // table, so the second failClip threw *inside the catch block* handling the
  // first — replacing the real error and aborting the rest of the build.
  let library = createLibrary({ sourceHash: 'h', sourceFile: 's.jpg', providerId: 'hedra' });
  library = failClip(startGenerating(library, IDLE_SLOT), IDLE_SLOT, 'moderation refused it');
  assert.equal(library.clips[IDLE_SLOT].status, 'failed');

  const again = failClip(library, IDLE_SLOT, 'and again');
  assert.equal(again.clips[IDLE_SLOT].status, 'failed');
  assert.equal(again.clips[IDLE_SLOT].error, 'and again');
});

test('a failed slot can be generated again', () => {
  // The other half of the same bug: a retry left the slot `failed`, so nothing
  // downstream would accept the finished clip.
  let library = createLibrary({ sourceHash: 'h', sourceFile: 's.jpg', providerId: 'hedra' });
  library = failClip(startGenerating(library, IDLE_SLOT), IDLE_SLOT, 'first attempt');

  const retry = startGenerating(library, IDLE_SLOT);
  assert.equal(retry.clips[IDLE_SLOT].status, 'generating');
  assert.equal(retry.clips[IDLE_SLOT].attempts, 2, 'the retry counts against the attempt limit');

  const done = completeClip(retry, IDLE_SLOT, { file: 'idle.mp4', durationMs: 5000, costUsd: 0.25 });
  assert.equal(done.clips[IDLE_SLOT].status, 'ready');
  assert.equal(done.clips[IDLE_SLOT].error, null);
});
