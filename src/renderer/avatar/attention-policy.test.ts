/**
 * These pin behaviour that came from conversation-analysis findings rather than
 * from taste, so that a future "tidy-up" of the numbers has to argue with a
 * test instead of silently making her stare.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ATTENTION_POSE,
  BACKCHANNEL_SECONDS,
  FIXATION_SECONDS,
  GAZE_AT_USER,
  type Attention,
} from './attention-policy.ts';

const STATES: Attention[] = ['idle', 'listening', 'thinking', 'speaking'];

test('every state has a full policy', () => {
  for (const state of STATES) {
    assert.ok(GAZE_AT_USER[state] !== undefined, `${state} has no gaze ratio`);
    assert.ok(FIXATION_SECONDS[state], `${state} has no fixation range`);
    assert.ok(ATTENTION_POSE[state], `${state} has no posture`);
  }
});

test('she looks at you more while listening than while speaking', () => {
  // The central finding: listeners hold the partner's gaze roughly three
  // quarters of the time, speakers well under half. Inverting this is what
  // makes an avatar feel like it is staring through you.
  assert.ok(
    GAZE_AT_USER.listening > GAZE_AT_USER.speaking,
    `listening ${GAZE_AT_USER.listening} should exceed speaking ${GAZE_AT_USER.speaking}`,
  );
  assert.ok(GAZE_AT_USER.listening >= 0.6, 'listening gaze is too low to read as attention');
  assert.ok(GAZE_AT_USER.speaking <= 0.6, 'speaking gaze is high enough to read as staring');
});

test('thinking looks away the most', () => {
  const others = STATES.filter((state) => state !== 'thinking').map((state) => GAZE_AT_USER[state]);
  assert.ok(
    others.every((ratio) => GAZE_AT_USER.thinking < ratio),
    'working something out should break eye contact',
  );
});

test('no state is a constant stare or a constant avoidance', () => {
  for (const state of STATES) {
    const ratio = GAZE_AT_USER[state];
    assert.ok(ratio > 0 && ratio < 1, `${state} gaze ratio ${ratio} is absolute`);
  }
});

test('fixations are held long enough to read as looking, not twitching', () => {
  for (const state of STATES) {
    const [from, to] = FIXATION_SECONDS[state];
    assert.ok(from > 0.5, `${state} fixations start at ${from}s, which reads as a flicker`);
    assert.ok(to > from, `${state} fixation range is inverted`);
    assert.ok(to <= 6, `${state} fixations up to ${to}s will read as frozen`);
  }
});

test('gaze shifts faster while speaking than while listening', () => {
  // A speaker's gaze moves more: away in long stretches, back to hand over the
  // turn. A listener holds.
  assert.ok(FIXATION_SECONDS.speaking[1] < FIXATION_SECONDS.listening[1]);
});

test('backchannel nods land in the range real listeners produce', () => {
  const [from, to] = BACKCHANNEL_SECONDS;
  // Feedback every ten to twenty seconds in ordinary conversation. Faster than
  // this is a bobblehead; slower and she reads as not listening.
  assert.ok(from >= 5, `a nod every ${from}s is a bobblehead`);
  assert.ok(to <= 30, `a nod every ${to}s is not backchannelling`);
  assert.ok(to > from, 'the interval must be a range, or the nod is a metronome');
});

test('postures are subtle enough not to be a gesture', () => {
  for (const state of STATES) {
    for (const [bone, euler] of Object.entries(ATTENTION_POSE[state])) {
      for (const angle of euler) {
        assert.ok(
          Math.abs(angle) <= 10,
          `${state}.${bone} at ${angle}° is a pose, not a posture bias`,
        );
      }
    }
  }
});

test('listening leans toward the person and thinking leans away', () => {
  assert.ok((ATTENTION_POSE.listening.spine?.[0] ?? 0) > 0, 'listening should lean in');
  assert.ok((ATTENTION_POSE.thinking.spine?.[0] ?? 0) < 0, 'thinking should lean back');
  assert.deepEqual(ATTENTION_POSE.idle, {}, 'idle should add nothing over the rest pose');
});
