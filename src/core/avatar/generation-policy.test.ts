/**
 * The spend governor.
 *
 * Every assertion here is about money that would otherwise leave the user's
 * account, so the cases that matter most are the refusals.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BUILD_ORDER, createLibrary, type ClipLibrary, type ClipSlotName } from './clips.ts';
import {
  DEFAULT_TIER,
  TIERS,
  mayGenerate,
  nextPrewarmSlot,
  spentUsd,
  type GenerationState,
} from './generation-policy.ts';

const FRESH: GenerationState = { generatedThisSession: 0, lastGeneratedAt: null };

function library(): ClipLibrary {
  return createLibrary({ sourceHash: 'abc', sourceFile: 'source.jpg', providerId: 'hedra' });
}

/** Marks a slot as rendered, at a cost, the way a finished build would. */
function withReady(base: ClipLibrary, slots: Array<[ClipSlotName, number]>): ClipLibrary {
  const clips = { ...base.clips };
  for (const [slot, cost] of slots) {
    clips[slot] = { ...clips[slot], status: 'ready', file: `${slot}.mp4`, spentUsd: cost };
  }
  return { ...base, clips };
}

// ---------------------------------------------------------------------------
// Reuse — the rule that holds at every tier
// ---------------------------------------------------------------------------

test('a slot already on disk is never re-rendered, at any tier', () => {
  const withWave = withReady(library(), [['wave', 0.25]]);
  for (const tier of ['low', 'medium', 'high'] as const) {
    const verdict = mayGenerate('wave', withWave, tier, FRESH);
    assert.equal(verdict.allowed, false, `${tier} would have re-rendered wave`);
    assert.match(verdict.allowed === false ? verdict.reason : '', /already in the library/);
  }
});

test('reuse wins even when every other limit is wide open', () => {
  // The check has to come first, not last: at `high` with a fresh session
  // nothing else would stop it.
  const withIdle = withReady(library(), [['idle', 0.25]]);
  assert.equal(mayGenerate('idle', withIdle, 'high', FRESH).allowed, false);
});

// ---------------------------------------------------------------------------
// Which slots each tier will pay for
// ---------------------------------------------------------------------------

test('low renders the idle loop and refuses everything else', () => {
  const empty = library();
  assert.equal(mayGenerate('idle', empty, 'low', FRESH).allowed, true);

  for (const slot of ['wave', 'nod', 'shrug'] as const) {
    const verdict = mayGenerate(slot, empty, 'low', FRESH);
    assert.equal(verdict.allowed, false, `low paid for ${slot}`);
    assert.match(verdict.allowed === false ? verdict.reason : '', /does not render/);
  }
});

test('medium covers the top of the build order and stops there', () => {
  const empty = library();
  assert.equal(mayGenerate('nod', empty, 'medium', FRESH).allowed, true);
  // `sit_down` is deep in BUILD_ORDER — outside the five medium pays for.
  assert.equal(mayGenerate('sit_down', empty, 'medium', FRESH).allowed, false);
});

test('high will pay for any slot in the build order', () => {
  const empty = library();
  for (const slot of BUILD_ORDER) {
    assert.equal(mayGenerate(slot, empty, 'high', FRESH).allowed, true, `high refused ${slot}`);
  }
});

// ---------------------------------------------------------------------------
// The four ceilings
// ---------------------------------------------------------------------------

test('the session ceiling stops a single afternoon running away', () => {
  const state = { generatedThisSession: TIERS.medium.maxPerSession, lastGeneratedAt: null };
  const verdict = mayGenerate('nod', library(), 'medium', state);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed === false ? verdict.reason : '', /this session/);
});

test('the library ceiling counts clips already rendered, not just this run', () => {
  const full = withReady(library(), [
    ['idle', 0.25],
    ['nod', 0.25],
    ['tilt_head', 0.25],
    ['lean_in', 0.25],
    ['shake_head', 0.25],
  ]);
  const verdict = mayGenerate('lean_back', full, 'medium', FRESH);
  assert.equal(verdict.allowed, false);
});

test('the spend ceiling is measured against the manifest, not a counter', () => {
  // One expensive clip is enough to stop the next one, even though the count is
  // nowhere near any limit. This is the backstop that does not depend on the
  // per-clip price being known in advance — and it is not knowable, because
  // Hedra bills on the driving audio and will not quote before ingest.
  const pricey = withReady(library(), [['idle', 6]]);
  assert.equal(spentUsd(pricey), 6);
  const verdict = mayGenerate('nod', pricey, 'medium', FRESH);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed === false ? verdict.reason : '', /\$6\.00/);
});

test('the cooldown stops one missing gesture being asked for over and over', () => {
  const now = 1_000_000;
  const recent = { generatedThisSession: 1, lastGeneratedAt: now - 60_000 };
  const verdict = mayGenerate('nod', library(), 'medium', recent, now);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed === false ? verdict.reason : '', /minute/);

  const later = { generatedThisSession: 1, lastGeneratedAt: now - 11 * 60_000 };
  assert.equal(mayGenerate('nod', library(), 'medium', later, now).allowed, true);
});

test('low has no cooldown because it has nothing to cool down', () => {
  // One clip, ever. A cooldown would be a limit on a thing that cannot recur.
  assert.equal(TIERS.low.cooldownMinutes, 0);
  assert.equal(TIERS.low.maxTotal, 1);
});

// ---------------------------------------------------------------------------
// Pre-warming
// ---------------------------------------------------------------------------

test('only the high tier fills the library unprompted', () => {
  const empty = library();
  assert.equal(nextPrewarmSlot(empty, 'low', FRESH), null);
  assert.equal(nextPrewarmSlot(empty, 'medium', FRESH), null);
  assert.equal(nextPrewarmSlot(empty, 'high', FRESH), 'idle');
});

test('pre-warming walks the build order and skips what is already there', () => {
  const started = withReady(library(), [['idle', 0.25]]);
  assert.equal(nextPrewarmSlot(started, 'high', FRESH), BUILD_ORDER[1]);
});

test('pre-warming stops when a ceiling is reached rather than looping', () => {
  const spent = withReady(library(), [['idle', 21]]);
  assert.equal(nextPrewarmSlot(spent, 'high', FRESH), null);
});

// ---------------------------------------------------------------------------
// The tiers as a set
// ---------------------------------------------------------------------------

test('the tiers are ordered — each one permits at least as much as the last', () => {
  assert.ok(TIERS.low.eligible.length < TIERS.medium.eligible.length);
  assert.ok(TIERS.medium.eligible.length < TIERS.high.eligible.length);
  assert.ok(TIERS.low.spendCeilingUsd < TIERS.medium.spendCeilingUsd);
  assert.ok(TIERS.medium.spendCeilingUsd < TIERS.high.spendCeilingUsd);
  assert.ok(TIERS.low.maxTotal < TIERS.medium.maxTotal);
  assert.ok(TIERS.medium.maxTotal < TIERS.high.maxTotal);
});

test('every tier can render the idle loop, because without it nothing moves', () => {
  for (const tier of ['low', 'medium', 'high'] as const) {
    assert.ok(TIERS[tier].eligible.includes('idle'), `${tier} cannot render idle`);
  }
});

test('the default is the middle one', () => {
  assert.equal(DEFAULT_TIER, 'medium');
});
