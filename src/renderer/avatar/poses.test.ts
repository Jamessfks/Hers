import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GESTURE_NAMES } from '../../shared/protocol.ts';
import { GESTURE_CLIPS, easeInOutCubic, sampleClip } from './poses.ts';

test('every gesture in the protocol has a clip', () => {
  for (const name of GESTURE_NAMES) {
    assert.ok(GESTURE_CLIPS[name], `missing clip for ${name}`);
  }
});

test('every clip starts and ends at a sane place', () => {
  for (const name of GESTURE_NAMES) {
    const clip = GESTURE_CLIPS[name];
    assert.equal(clip.keys[0]?.at, 0, `${name} must have a key at t=0`);
    assert.equal(clip.keys.at(-1)?.at, 1, `${name} must have a key at t=1`);
    assert.ok(clip.durationMs > 0, `${name} needs a duration`);
  }
});

test('keyframes are ordered', () => {
  for (const name of GESTURE_NAMES) {
    const times = GESTURE_CLIPS[name].keys.map((key) => key.at);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${name} keys are out of order`);
  }
});

test('clips stay within plausible joint limits', () => {
  // A humanoid shoulder does not rotate 200 degrees. This catches a typo'd
  // sign or a stray zero before it reaches a rig and snaps an arm backwards.
  for (const name of GESTURE_NAMES) {
    for (const key of GESTURE_CLIPS[name].keys) {
      for (const [bone, euler] of Object.entries(key.pose)) {
        for (const angle of euler) {
          assert.ok(
            Math.abs(angle) <= 90,
            `${name}.${bone} has an implausible ${angle} degree rotation`,
          );
        }
      }
    }
  }
});

test('sampling is continuous across a keyframe boundary', () => {
  const clip = GESTURE_CLIPS.nod;
  const before = sampleClip(clip, 0.2999);
  const after = sampleClip(clip, 0.3001);
  const delta = Math.abs((before.head?.[0] ?? 0) - (after.head?.[0] ?? 0));
  assert.ok(delta < 0.5, `expected a continuous curve, jumped by ${delta} degrees`);
});

test('sampling clamps outside the clip', () => {
  assert.deepEqual(sampleClip(GESTURE_CLIPS.nod, -5), sampleClip(GESTURE_CLIPS.nod, 0));
  assert.deepEqual(sampleClip(GESTURE_CLIPS.nod, 9), sampleClip(GESTURE_CLIPS.nod, 1));
});

test('non-held clips return to rest', () => {
  for (const name of GESTURE_NAMES) {
    if (name === 'sit_down') continue;
    const final = sampleClip(GESTURE_CLIPS[name], 1);
    for (const [bone, euler] of Object.entries(final)) {
      for (const angle of euler) {
        assert.ok(Math.abs(angle) < 0.001, `${name}.${bone} does not return to rest`);
      }
    }
  }
});

test('the ease is monotonic and anchored at both ends', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  let previous = -1;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const value = easeInOutCubic(t);
    assert.ok(value >= previous, 'ease must not go backwards');
    previous = value;
  }
});
