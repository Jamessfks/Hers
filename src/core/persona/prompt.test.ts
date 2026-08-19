/**
 * The system instruction, tested where it makes a promise she can break.
 *
 * Most of this file is prose and prose does not need a test. Two things here do:
 * the sense prohibitions, because she has been caught bluffing about them twice,
 * and the tool list, because offering a tool that does not exist produces a call
 * the server has to refuse.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSystemInstruction } from './prompt.ts';
import type { PromptInput } from './prompt.ts';

function input(over: Partial<PromptInput> = {}): PromptInput {
  return {
    profile: {
      dir: '/tmp/profile',
      identity: {
        name: 'Mei',
        age: '26',
        gender: 'female',
        pronouns: 'she/her',
        ethnicity: 'Chinese-American',
        from: 'Oakland, California',
      },
      voice: { voice: 'Aoede', languageCode: 'en-US', pace: 'unhurried', accent: 'General American' },
      moodBaseline: { valence: 0.25, energy: 0.1, warmth: 0.55, interest: 0.4 },
      prose: { personality: 'Warm, dry, hard to embarrass.' },
    },
    mood: {
      label: 'even',
      current: { valence: 0.2, energy: 0.1, warmth: 0.5, interest: 0.4 },
      baseline: { valence: 0.2, energy: 0.1, warmth: 0.5, interest: 0.4 },
    },
    memories: [],
    senses: { hearing: false, sight: false, screen: false },
    localTime: 'Monday 11:40pm',
    channel: 'desktop',
    returning: false,
    hasFace: true,
    intimacy: {
      score: 0.02,
      percent: 2,
      stage: 'stranger',
      guidance: 'You have just met. Be curious, not familiar.',
      days: 1,
      known: 2,
      pinned: false,
    },
    ...over,
  } as PromptInput;
}

test('with every sense off she is told not to describe what she cannot see', () => {
  /*
   * The bluff this prevents, observed: with `senses` all false she opened a
   * conversation with "You look busy." A user with the camera off catches that
   * immediately, and being caught inventing costs more than being dull.
   *
   * The all-off branch used to be the *weaker* of the two — the specific
   * prohibition lived only in the partial case, which needed it less.
   */
  const prompt = buildSystemInstruction(input());
  assert.match(prompt, /switched off right now/i);
  assert.match(prompt, /Say nothing about how they\s+look/i, 'must forbid describing them');
  assert.match(prompt, /whether they seem busy or\s+tired/i, 'the exact bluff observed');
  assert.match(prompt, /never describe what you would\s+see if it were on/i);
});

test('the prohibition is no weaker when only some senses are off', () => {
  const prompt = buildSystemInstruction(
    input({ senses: { hearing: true, sight: false, screen: false } }),
  );
  assert.match(prompt, /you can hear them/i);
  assert.match(prompt, /cannot see them/i);
  assert.match(prompt, /never describe what you would/i);
});

test('a sense that is on is not described as off', () => {
  const prompt = buildSystemInstruction(
    input({ senses: { hearing: true, sight: true, screen: true } }),
  );
  assert.doesNotMatch(prompt, /switched off right now/i);
  assert.match(prompt, /one picture/i, 'both cameras composite into one frame');
});

test('she is only told about expressions that exist', () => {
  const none = buildSystemInstruction(input());
  assert.doesNotMatch(none, /^look /m, 'no faces made, so no tool to offer');

  const some = buildSystemInstruction(input({ faces: ['smiling', 'curious'] }));
  assert.match(some, /^look /m);
  assert.match(some, /smiling, curious/);
});

test('she is told she has a face and must never describe it in words', () => {
  // The invention this prevents, observed: asked what she looked like she said
  // "artist… maybe a little punk adjacent?" — every word of it made up.
  const prompt = buildSystemInstruction(input({ hasFace: true }));
  assert.match(prompt, /never answer that question in words/i);
  assert.match(prompt, /Do not say your hair is any colour/i, 'the prohibition is explicit');

  // And with no photograph she is told that instead, rather than being told to
  // stay quiet about a face she does not have.
  const faceless = buildSystemInstruction(input({ hasFace: false }));
  assert.doesNotMatch(faceless, /never answer that question in words/i);
});
