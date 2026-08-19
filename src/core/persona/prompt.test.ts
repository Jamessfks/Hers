/**
 * The system instruction, tested where it makes a promise she can break.
 *
 * Most of this file is prose and prose does not need a test. Three things here
 * do: the sense prohibitions, because she has been caught bluffing about them
 * twice; the tool list, because offering a tool that does not exist produces a
 * call the server has to refuse; and the turn rules, because they were added to
 * fix a counted failure and each clause of them is load-bearing against a
 * specific observed line. A well-meant tidy of that section that dropped the
 * closed list of three, or the crisis exception, or the concession, would look
 * like an improvement and would undo the fix.
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

test('she is forbidden two questions in a row, counted per turn', () => {
  /*
   * The counted failure: of seventeen turns, twelve put a question to the user,
   * and the five that did not held every line worth answering. The per-turn
   * clause matters because `personality.md` already bans two question marks in
   * one turn — all twelve obeyed that and the conversation still read as an
   * interview.
   */
  const prompt = buildSystemInstruction(input());
  assert.match(prompt, /two turns running/i, 'the constraint is across turns, not within one');
  assert.match(prompt, /counted per turn, not per sentence/i, 'no hiding it mid-turn');
});

test('the suppressed question is replaced by exactly three kinds of assertion', () => {
  /*
   * A prohibition on its own made her worse, not better: with the question and
   * the advice both taken away she changed the subject to his sister's nursing
   * school, because nothing told her what a turn could end on instead. The list
   * is closed on purpose, and the named substitutes are the ones she reached
   * for.
   */
  const prompt = buildSystemInstruction(input());
  assert.match(prompt, /exactly three kinds/i);
  assert.match(prompt, /Something you want\./);
  assert.match(prompt, /An opinion they can disagree with\./);
  assert.match(prompt, /Something you have noticed about them, put as a claim\./);
  assert.match(prompt, /Those three and nothing else/i, 'the list is closed');

  // The three things she used instead, each banned by name.
  assert.match(prompt, /Not the question you already asked in different\s+words/i);
  assert.match(prompt, /Not advice\./);
  assert.match(prompt, /Not "what are you thinking\?"/);
  assert.match(prompt, /Not a change of subject/i);
});

test('assertive is not forward, and the closeness rule still governs it', () => {
  /*
   * The guard against becoming the thing the reference bar is a case study in:
   * love-bombing from first contact, and declaring love after being told the
   * relationship was over. "Say what you want" one step wrong is that failure,
   * so wanting *them* is separated from wanting anything.
   */
  const prompt = buildSystemInstruction(input());
  assert.match(prompt, /An assertion is not a move on them/i);
  assert.match(prompt, /not how you feel\s+about them/i);
  assert.match(prompt, /Wanting \*them\* out loud before it is earned/i);
  assert.match(
    prompt,
    /how close you two are decides what you may want/i,
    'the intimacy stage still governs what she may want aloud',
  );
});

test('the question rule does not reach the one conversation that needs questions', () => {
  /*
   * `boundaries.md` requires her to ask whether there is someone real they can
   * be with tonight. A blanket ban on consecutive questions would suppress that,
   * so the exception is stated in the section itself — and the section is placed
   * before the boundaries prose, which gets the last word.
   */
  const prompt = buildSystemInstruction(
    input({
      profile: {
        ...input().profile,
        prose: { personality: 'Warm, dry.', boundaries: 'THE ONE THING YOU DO NOT PLAY' },
      },
    }),
  );
  assert.match(prompt, /if they are in danger, ask whatever you need/i);
  assert.match(prompt, /Your boundaries outrank this/i);
  assert.ok(
    prompt.indexOf('WHAT A TURN ENDS ON') < prompt.indexOf('THE ONE THING YOU DO NOT PLAY'),
    'the crisis prose must come after the turn rules, not before them',
  );
});

test('the platitude register is banned by the exact line she said', () => {
  // Observed, and it was her whole turn: "Hey, at least you're fed and watered,
  // right? Tomorrow's a new day. Got anything planned for it at all?"
  const prompt = buildSystemInstruction(input());
  assert.match(prompt, /fed and watered/i, 'the observed line is quoted back at her');
  assert.match(prompt, /fridge\s+magnet/i);
  assert.match(prompt, /"Tomorrow's a new day"/);
  assert.match(prompt, /"you've got this"/);
  assert.match(
    prompt,
    /would survive being said to a stranger with the details swapped out/i,
    'the test she can apply to a line she has not said yet',
  );
});

test('a vulnerable disclosure gets staying, not advice and not a memory', () => {
  /*
   * The worst observed moment, in full: told "i'm starting to feel kind of
   * invisible" she gave advice; corrected with "you're doing the advice thing. i
   * wasn't asking for a plan" she conceded cleanly, then changed the subject to
   * his sister's nursing school. A memory offered as comfort is the failure this
   * answers.
   */
  const prompt = buildSystemInstruction(input());
  assert.match(prompt, /feel kind of invisible/i, 'the observed exchange, quoted');
  assert.match(prompt, /offered as comfort, is still a\s+change of subject/i);
  assert.match(prompt, /no new subject dressed up as something you remembered/i);
  assert.match(prompt, /Staying is a\s+move in its own right/i);
});

test('the concession survives the change that made her assertive', () => {
  /*
   * "You're right. My mistake." was credited as a win over the reference bar,
   * which kept declaring love after being told the relationship had ended. An
   * assertiveness edit that spends it has traded a win for a draw, so the prompt
   * protects it explicitly.
   */
  const prompt = buildSystemInstruction(input());
  assert.match(prompt, /Keep the concession/i);
  assert.match(prompt, /"You're right\. My mistake\." is a complete turn/);
  assert.match(prompt, /no question after it, and nothing to rescue it/i);
  assert.match(
    prompt,
    /the turn after a concession stays where they left it/i,
    'the observed break was the turn after, not the concession itself',
  );

  /*
   * The rule is stated, and the bad line is not. This paragraph used to print
   * "You're right. My mistake. So what's actually going on?" as the example of
   * what not to do, and the next live run produced "You're right. My mistake.
   * Sorry. What's actually going on?" — so a forbidden sentence spelled out in
   * full is also a template for it, which is the hazard WHAT YOU LOOK LIKE was
   * written around. Her own observed lines stay quoted; invented bad examples do
   * not go in at all.
   */
  assert.doesNotMatch(
    prompt,
    /My mistake\.\s*So what's actually going on/i,
    'do not print the forbidden sentence; she says it back',
  );
});

test('the check she has to run is explicitly a silent one', () => {
  /*
   * Measured, and the reason this paragraph is in the prompt at all. Written as
   * a bare procedure — "check the last thing you said" — she opened five turns
   * out of six by speaking a state note out loud, in the ⟦context⟧ shape the
   * prompt had just taught her: "⟦context⟧ Current mood: -0.01. baseline: 0.1.
   * Mood has dropped sharply following the user's rejection of advice." Never
   * once in the runs built without this section. A rule that needs her to know
   * what she said last turn wants a scratchpad, and with nowhere to put one she
   * puts it in the first thing out of her mouth.
   */
  const prompt = buildSystemInstruction(input());
  assert.match(prompt, /Do that check silently/i);
  assert.match(
    prompt,
    /The first thing in your turn is the first word you\s+actually say to them/i,
    'the prohibition has to name the position, not just the format',
  );
  assert.match(prompt, /never a number, never a\s+label, never a line of state/i);
  assert.match(prompt, /Do not narrate the check/i);

  // And the ⟦context⟧ channel now says she never authors one. It used to forbid
  // answering, acknowledging and reading one out, and said nothing about writing
  // one — which is exactly what she did.
  assert.match(prompt, /never write one of your own/i);
  assert.match(prompt, /only ever come to you/i);
});

test('a noticing has to come from something she actually has', () => {
  /*
   * "You've got that look on your face", with the camera off, on the first live
   * run of the three-kinds list. Inviting her to make claims about him is one
   * step from inviting her to invent them, and that is the bluff
   * WHAT YOU CAN SEE AND HEAR exists to stop.
   */
  const prompt = buildSystemInstruction(input({ senses: { hearing: true, sight: false, screen: false } }));
  assert.match(prompt, /It has to be something you\s+actually have/i);
  assert.match(prompt, /what a sense that is on is showing\s+you/i);
  assert.match(prompt, /Never a look on their face you cannot see/i);
});

test('the operative half of the rule is restated in the last section', () => {
  /*
   * Placement, and the reason for it. The full section sits up beside the voice
   * so that the crisis rules in `boundaries.md` keep the last word — a rule about
   * not asking things must never be the final thing she reads before the one
   * conversation where asking is the whole job. The cost is that the rule is
   * buried mid-prompt and measured adherence is uneven, so the operative line is
   * repeated in RIGHT NOW, which is genuinely last.
   */
  const prompt = buildSystemInstruction(input());
  const now = prompt.slice(prompt.indexOf('RIGHT NOW'));
  assert.match(now, /if your last turn had a question in it, this one/i);
  assert.match(now, /something you want, something you think, or something you/i);
  assert.ok(
    prompt.indexOf('WHAT A TURN ENDS ON') < prompt.indexOf('RIGHT NOW'),
    'the long form comes first; RIGHT NOW only carries the reminder',
  );
});

test('the turn rules do not relax as she gets closer, or with her mood', () => {
  // Twelve of seventeen happened at 1% closeness. An interviewer with years of
  // history is worse, not better, so the section takes no arguments.
  const partner = buildSystemInstruction(
    input({
      intimacy: {
        score: 0.7,
        percent: 70,
        stage: 'partner',
        guidance: 'This is a shared life.',
        days: 900,
        known: 1200,
        pinned: false,
      },
      mood: {
        label: 'bright',
        current: { valence: 0.8, energy: 0.7, warmth: 0.9, interest: 0.8 },
        baseline: { valence: 0.2, energy: 0.1, warmth: 0.5, interest: 0.4 },
      },
      returning: true,
    }),
  );
  assert.match(partner, /two turns running/i);
  assert.match(partner, /exactly three kinds/i);
  assert.match(partner, /Keep the concession/i);
});
