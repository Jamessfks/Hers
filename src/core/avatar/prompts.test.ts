/**
 * Generation prompts.
 *
 * These assertions are cheap and the failures they catch are not: a missing
 * prompt is a gesture the model will emit and the library will never contain,
 * and a prompt that forgets to close its loop produces a clip that looks fine
 * on its own and jumps every time it is played next to another one — which is
 * only visible after the money has been spent.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GESTURE_CLIPS } from '../../renderer/avatar/poses.ts';
import { GESTURE_NAMES } from '../../shared/protocol.ts';
import { CLIP_SLOT_NAMES, IDLE_SLOT } from './clips.ts';
import {
  CLIP_PROMPTS,
  CLIP_SECONDS,
  NEGATIVE_PROMPT,
  OPEN_LOOP_SLOTS,
  SHARED_RULES,
  buildClipPrompt,
} from './prompts.ts';

test('every gesture in the protocol has a generation prompt', () => {
  for (const name of GESTURE_NAMES) {
    const prompt = CLIP_PROMPTS[name];
    assert.ok(prompt, `missing prompt for ${name}`);
    assert.ok(prompt.motion.trim().length > 20, `${name} needs a real instruction`);
  }
});

test('the idle clip has a prompt too', () => {
  assert.ok(CLIP_PROMPTS[IDLE_SLOT].motion.includes('breathes'));
  for (const slot of CLIP_SLOT_NAMES) assert.ok(CLIP_PROMPTS[slot], `missing prompt for ${slot}`);
});

test('clip timing matches the VRM renderer beat for beat', () => {
  // The same `[nod]` has to read at the same speed whichever renderer draws
  // her, otherwise the persona's timing is tuned against one of them and wrong
  // on the other.
  for (const name of GESTURE_NAMES) {
    assert.equal(
      CLIP_PROMPTS[name].beatMs,
      GESTURE_CLIPS[name].durationMs,
      `${name} disagrees with poses.ts`,
    );
  }
});

test('every beat fits inside the clip we actually buy', () => {
  for (const slot of CLIP_SLOT_NAMES) {
    const prompt = CLIP_PROMPTS[slot];
    assert.ok(prompt.beatMs > 0, `${slot} needs a duration`);
    assert.ok(
      prompt.beatMs <= CLIP_SECONDS * 1000,
      `${slot} asks for ${prompt.beatMs}ms out of a ${CLIP_SECONDS}s clip`,
    );
  }
});

test('only the two posture changes leave the source pose', () => {
  // Everything else must be able to follow anything else. See the header of
  // prompts.ts for what an open loop costs at playback time.
  assert.deepEqual([...OPEN_LOOP_SLOTS].sort(), ['sit_down', 'stand_up']);
});

test('a closed clip is told to return to the photograph', () => {
  const built = buildClipPrompt('nod');
  assert.ok(built.prompt.startsWith(CLIP_PROMPTS.nod.motion), 'the action must lead');
  assert.match(built.prompt, /final frame returns to the photograph/);
  assert.match(built.prompt, /settles back into the photograph pose/);
  assert.match(built.prompt, /locked off/, 'framing must be pinned');
  assert.equal(built.seconds, CLIP_SECONDS);
  assert.equal(built.beatMs, CLIP_PROMPTS.nod.beatMs);
  assert.equal(built.anchorSlot, null);
});

test('an open clip is not told two contradictory things', () => {
  const built = buildClipPrompt('sit_down');
  assert.ok(
    !built.prompt.includes('final frame returns to the photograph'),
    'sitting down cannot end standing up',
  );
  assert.match(built.prompt, /holds the new pose/);
  // The framing rules that still apply must survive the edit.
  assert.match(built.prompt, /locked off/);
  assert.match(built.prompt, /first frame is the photograph/);
});

test('stand_up is anchored to a frame that has to exist first', () => {
  const built = buildClipPrompt('stand_up');
  assert.equal(built.anchorSlot, 'sit_down');
  assert.ok(
    CLIP_SLOT_NAMES.includes(built.anchorSlot),
    'an anchor must name a slot that is generated',
  );
  for (const slot of CLIP_SLOT_NAMES) {
    if (slot === 'stand_up') continue;
    assert.equal(buildClipPrompt(slot).anchorSlot, null, `${slot} should start from the photo`);
  }
});

test('the negative prompt stays out of the positive one', () => {
  // "no morphing" in the prompt body reliably produces morphing. The two
  // fields are separate for that reason and must not be concatenated.
  for (const slot of CLIP_SLOT_NAMES) {
    const built = buildClipPrompt(slot);
    assert.ok(!built.prompt.includes(NEGATIVE_PROMPT), `${slot} leaked its negative prompt`);
    assert.ok(built.avoid.includes('morphing face'));
    assert.ok(built.avoid.includes('camera movement'));
  }
});

test('per-gesture warnings are added to the shared negative prompt', () => {
  const lean = buildClipPrompt('lean_in');
  assert.match(lean.avoid, /walking toward the camera/);
  assert.ok(lean.avoid.startsWith(NEGATIVE_PROMPT), 'the shared list must still be there');
});

test('the shared rules pin identity, framing and the mouth', () => {
  const joined = SHARED_RULES.join(' ');
  assert.match(joined, /background/);
  assert.match(joined, /same size and in the same place/);
  assert.match(joined, /not speaking/);
  assert.match(joined, /Exactly one action/);
});
