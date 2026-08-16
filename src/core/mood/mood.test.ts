import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Mood, describe as describeMood, moodBriefing } from './mood.ts';
import type { MoodVector } from '../../shared/protocol.ts';

const ANCHOR: MoodVector = { valence: 0.25, energy: 0.1, warmth: 0.55, interest: 0.4 };

function fixture(options: { dir?: string; volatility?: number } = {}) {
  let clock = 1_700_000_000_000;
  const mood = new Mood({
    anchor: ANCHOR,
    volatility: options.volatility ?? 0.5,
    ...(options.dir ? { dir: options.dir } : {}),
    now: () => clock,
  });
  return { mood, advance: (ms: number) => (clock += ms) };
}

test('starts at the baseline written in the profile', () => {
  const { mood } = fixture();
  assert.deepEqual(mood.read().current, ANCHOR);
  assert.deepEqual(mood.read().baseline, ANCHOR);
});

test('an event moves her and time brings her back', () => {
  const { mood, advance } = fixture();
  mood.nudge({ valence: -0.6 });
  const knocked = mood.read().current.valence;
  assert.ok(knocked < ANCHOR.valence - 0.3, `expected a real drop, got ${knocked}`);

  // Two half-lives of a 0.5-volatility mood: 20min * (0.5 + 0.5) * 2.
  advance(40 * 60 * 1000);
  const settled = mood.read().current.valence;
  assert.ok(settled > knocked, 'mood must decay back toward the baseline');
  assert.ok(
    Math.abs(settled - ANCHOR.valence) < Math.abs(knocked - ANCHOR.valence) / 3,
    `expected most of the way back after two half-lives, got ${settled}`,
  );
});

test('a volatile mood swings harder and lingers longer', () => {
  const calm = fixture({ volatility: 0.15 });
  const stormy = fixture({ volatility: 1 });
  calm.mood.nudge({ valence: -0.5 });
  stormy.mood.nudge({ valence: -0.5 });

  const calmHit = calm.mood.read().current.valence;
  const stormyHit = stormy.mood.read().current.valence;
  assert.ok(stormyHit < calmHit, 'higher volatility must move her further');

  calm.advance(20 * 60 * 1000);
  stormy.advance(20 * 60 * 1000);
  const calmLeft = Math.abs(calm.mood.read().current.valence - ANCHOR.valence);
  const stormyLeft = Math.abs(stormy.mood.read().current.valence - ANCHOR.valence);
  assert.ok(stormyLeft > calmLeft, 'higher volatility must also settle more slowly');
});

test('a long absence is a reset, not an enormous decay', () => {
  const { mood, advance } = fixture();
  mood.nudge({ valence: -0.8, energy: -0.8 });
  advance(30 * 24 * 60 * 60 * 1000);
  const after = mood.read();
  assert.ok(Math.abs(after.current.valence - after.baseline.valence) < 0.02);
  for (const axis of ['valence', 'energy', 'warmth', 'interest'] as const) {
    assert.ok(Number.isFinite(after.current[axis]), `${axis} went non-finite`);
  }
});

test('the baseline drifts over days but cannot escape the profile', () => {
  const { mood, advance } = fixture();

  // Two months of relentlessly bad days.
  for (let day = 0; day < 60; day += 1) {
    mood.nudge({ valence: -1, warmth: -1 }, 3);
    advance(24 * 60 * 60 * 1000);
  }

  const drifted = mood.read().baseline;
  assert.ok(drifted.valence < ANCHOR.valence, 'sustained experience must move the baseline');
  assert.ok(
    drifted.valence >= ANCHOR.valence - 0.3 - 1e-9,
    `drift must stay within 0.3 of the anchor, got ${drifted.valence}`,
  );
  assert.ok(drifted.warmth >= ANCHOR.warmth - 0.3 - 1e-9);
});

test('nonsense from the model is clamped rather than believed', () => {
  const { mood } = fixture();
  mood.nudge({ valence: 47, energy: Number.NaN, warmth: -999, interest: Number.POSITIVE_INFINITY });
  const current = mood.read().current;
  for (const axis of ['valence', 'energy', 'warmth', 'interest'] as const) {
    assert.ok(Number.isFinite(current[axis]), `${axis} is ${current[axis]}`);
    assert.ok(current[axis] >= -1 && current[axis] <= 1, `${axis} out of range: ${current[axis]}`);
  }
});

test('mood survives a restart, decayed by however long it was away', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-mood-'));
  const first = fixture({ dir });
  first.mood.nudge({ valence: -0.7 });
  const knocked = first.mood.read().current.valence;
  await first.mood.flush();

  const saved = JSON.parse(await readFile(path.join(dir, 'mood.state.json'), 'utf8')) as {
    updatedAt: number;
  };
  assert.ok(Number.isFinite(saved.updatedAt));

  const second = new Mood({ anchor: ANCHOR, volatility: 0.5, dir, now: () => saved.updatedAt });
  await second.restore();
  assert.ok(
    Math.abs(second.read().current.valence - knocked) < 0.01,
    'a restart at the same instant must find the same mood',
  );
});

test('a corrupt state file is a shrug, not a crash', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-mood-'));
  await writeFile(path.join(dir, 'mood.state.json'), '{not json at all', 'utf8');
  const mood = new Mood({ anchor: ANCHOR, dir });
  await assert.doesNotReject(() => mood.restore());
  assert.deepEqual(mood.read().current, ANCHOR);
});

test('editing mood.md outvotes a drifted state file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-mood-'));
  await writeFile(
    path.join(dir, 'mood.state.json'),
    JSON.stringify({
      baseline: { valence: -0.9, energy: -0.9, warmth: -0.9, interest: -0.9 },
      current: { valence: -0.9, energy: -0.9, warmth: -0.9, interest: -0.9 },
      updatedAt: Date.now(),
    }),
    'utf8',
  );

  const mood = new Mood({ anchor: ANCHOR, dir });
  await mood.restore();
  assert.ok(
    mood.read().baseline.valence >= ANCHOR.valence - 0.3 - 1e-9,
    'a state file may not drag the baseline past what the profile allows',
  );
});

test('every mood has words for it', () => {
  const values = [-1, -0.5, -0.2, 0, 0.2, 0.5, 1];
  for (const valence of values) {
    for (const energy of values) {
      for (const warmth of [-0.8, 0, 0.8]) {
        const label = describeMood({ valence, energy, warmth, interest: 0.1 });
        assert.ok(label.length > 0, `no label for ${valence}/${energy}/${warmth}`);
        assert.ok(!/\d/.test(label), `label leaked a number: ${label}`);
      }
    }
  }
});

test('the briefing never hands the model a number to read out', () => {
  const briefing = moodBriefing({
    baseline: ANCHOR,
    current: { valence: -0.9, energy: -0.8, warmth: -0.5, interest: -0.7 },
    label: 'flat and a bit low',
  });
  assert.ok(!/-?\d+\.\d+/.test(briefing), `briefing contains a raw number: ${briefing}`);
  assert.match(briefing, /Never name it/);
});
