/**
 * A library that rotates rather than fills.
 *
 * The cap is a capacity, not a budget — the tier already governs spending — so
 * hitting it is not a stop. It is the moment the least-used clip is given up so
 * a wanted one can take its place, and every assertion here is about that choice
 * being the right one and being made safely.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  completeClip,
  createLibrary,
  evictClip,
  evictionCandidate,
  notePlayed,
  startGenerating,
  type ClipLibrary,
  type ClipSlotName,
} from './clips.ts';
import { mayGenerate, type GenerationState } from './generation-policy.ts';

const FRESH: GenerationState = { generatedThisSession: 0, lastGeneratedAt: null, maxClips: 3 };

/** A library holding exactly the slots given, each rendered. */
function holding(slots: ClipSlotName[]): ClipLibrary {
  let library = createLibrary({ sourceHash: 'abc', sourceFile: 'source.jpg', providerId: 'hedra' });
  for (const slot of slots) {
    library = completeClip(startGenerating(library, slot), slot, {
      file: `${slot}.mp4`,
      durationMs: 4000,
      costUsd: 0.25,
    });
  }
  return library;
}

// ---------------------------------------------------------------------------
// Which clip goes
// ---------------------------------------------------------------------------

test('the least-recently-played clip is the one given up', () => {
  let library = holding(['idle', 'nod', 'tilt_head']);
  library = notePlayed(library, 'nod', 5_000);
  library = notePlayed(library, 'tilt_head', 1_000);

  assert.equal(evictionCandidate(library), 'tilt_head');
});

test('a clip that has never been played goes before one that has', () => {
  // The cheapest thing to lose is the thing that has sat there unused.
  let library = holding(['idle', 'nod', 'wave']);
  library = notePlayed(library, 'nod', 5_000);

  assert.equal(evictionCandidate(library), 'wave');
});

test('idle is never given up, however long since it played', () => {
  // It is the only clip that plays when nothing else is happening, which is
  // most of the time. Losing it turns her back into a photograph.
  let library = holding(['idle', 'nod']);
  library = notePlayed(library, 'nod', 9_000);
  // idle has no lastPlayedAt at all, so a naive LRU would pick it first.
  assert.equal(evictionCandidate(library), 'nod');
});

test('a library holding only idle has nothing it can give up', () => {
  assert.equal(evictionCandidate(holding(['idle'])), null);
});

test('playing a clip does not disturb when it was last changed', () => {
  // `updatedAt` answers "when did this slot change"; several things read it.
  // Playing is not a change, and conflating the two would make every gesture
  // look like a state transition.
  const library = holding(['idle', 'nod']);
  const before = library.clips['nod'].updatedAt;
  const after = notePlayed(library, 'nod', before + 10_000);
  assert.equal(after.clips['nod'].updatedAt, before);
  assert.equal(after.clips['nod'].lastPlayedAt, before + 10_000);
});

// ---------------------------------------------------------------------------
// Giving it up
// ---------------------------------------------------------------------------

test('an evicted slot goes back to pending with no file and no strikes', () => {
  const library = evictClip(holding(['idle', 'nod']), 'nod');
  const entry = library.clips['nod'];
  assert.equal(entry.status, 'pending');
  assert.equal(entry.file, null);
  // Given up for room, not because it failed. Carrying a strike would exhaust
  // a perfectly renderable gesture over a few rotations.
  assert.equal(entry.attempts, 0);
});

test('eviction keeps what the clip cost', () => {
  // The money was spent. A library that forgets it under-reports forever, and
  // the spend ceiling is measured against exactly this number.
  const library = evictClip(holding(['idle', 'nod']), 'nod');
  assert.equal(library.clips['nod'].spentUsd, 0.25);
});

test('evicting something that is not there is refused', () => {
  assert.throws(() => evictClip(holding(['idle']), 'nod'), /nothing to evict/);
});

// ---------------------------------------------------------------------------
// The policy's side of it
// ---------------------------------------------------------------------------

test('at capacity, generating is allowed but names a clip to give up', () => {
  let library = holding(['idle', 'nod', 'tilt_head']);
  library = notePlayed(library, 'nod', 5_000);
  library = notePlayed(library, 'tilt_head', 1_000);

  const verdict = mayGenerate('lean_in', library, 'high', FRESH);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.allowed === true ? verdict.evict : null, 'tilt_head');
});

test('under capacity, nothing is given up', () => {
  const verdict = mayGenerate('nod', holding(['idle']), 'high', FRESH);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.allowed === true ? verdict.evict : 'set', undefined);
});

test('a full library with nothing to give up refuses rather than evicting idle', () => {
  const verdict = mayGenerate('nod', holding(['idle']), 'high', {
    ...FRESH,
    maxClips: 1,
  });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed === false ? verdict.reason : '', /nothing she can give up/);
});

test('the capacity cap does not override the tier being out of budget', () => {
  // Two ceilings, and the spending one still wins. Rotating a library is not a
  // reason to spend past what the user allowed.
  const library = holding(['idle', 'nod', 'tilt_head']);
  const verdict = mayGenerate('lean_in', library, 'low', FRESH);
  assert.equal(verdict.allowed, false);
});

test('a clip already in the library is still never re-rendered at capacity', () => {
  const library = holding(['idle', 'nod', 'tilt_head']);
  const verdict = mayGenerate('nod', library, 'high', FRESH);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed === false ? verdict.reason : '', /already in the library/);
});
