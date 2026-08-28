import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frontmatterValue, parseProfileFile } from './frontmatter.ts';
import {
  ABSENCE,
  REFUSALS,
  TEMPERAMENTS,
  TRAITS,
  VOICE_CHOICES,
  WANTS,
  applyWizard,
  retellIdentity,
  withSection,
  draftToAnswers,
  emptyDraft,
} from './wizard.ts';
import { FEMALE_VOICES } from './voices.ts';
import type { WizardAnswers } from './wizard.ts';
import { DEFAULT_PROFILE_FILES } from '../core/profile/defaults.ts';

/**
 * The six files exactly as they ship, keyed the way the server sends them.
 *
 * Read out of `DEFAULT_PROFILE_FILES` rather than written out here, so these
 * tests are about what the wizard does to the real profile and not about a
 * hand-made fixture that stopped resembling it two releases ago.
 */
function shipped(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, contents] of Object.entries(DEFAULT_PROFILE_FILES)) {
    if (name === 'README.md') continue;
    files[name.replace(/\.md$/, '')] = contents;
  }
  return files;
}

const MET = '2026-08-27';

// ---------------------------------------------------------------------------
// Skipping
// ---------------------------------------------------------------------------

test('skipping every step touches one key in one file, and nothing else', () => {
  const files = shipped();
  const changed = applyWizard(files, {}, MET);

  assert.deepEqual(Object.keys(changed), ['relationship']);
  assert.equal(frontmatterValue(changed.relationship ?? '', 'met'), MET);
});

test('a skipped profile keeps every word of the prose she ships with', () => {
  const files = shipped();
  const changed = applyWizard(files, {}, MET);

  // The only difference in the one file it touches is the frontmatter line.
  const before = parseProfileFile(files.relationship ?? '');
  const after = parseProfileFile(changed.relationship ?? '');
  assert.equal(after.body, before.body);
  assert.equal(after.frontmatter.they_are, before.frontmatter.they_are);
});

test('answers that are present but empty count as skipped', () => {
  // What the browser actually sends when somebody clicks straight through:
  // fields prefilled with what was already there, and every box unticked.
  const files = shipped();
  const identity = files.identity ?? '';
  const answers: WizardAnswers = {
    traits: [],
    age: frontmatterValue(identity, 'age') ?? '',
    ethnicity: frontmatterValue(identity, 'ethnicity') ?? '',
    from: frontmatterValue(identity, 'from') ?? '',
    past: '',
    voice: frontmatterValue(files.voice ?? '', 'voice') ?? '',
    pace: frontmatterValue(files.voice ?? '', 'pace') ?? '',
    wants: [],
    absence: [],
    aboutThem: '',
    refusals: [],
    refusalExtra: '',
  };

  assert.deepEqual(Object.keys(applyWizard(files, answers, MET)), ['relationship']);
});

test('a file that arrives empty is refused rather than written over', () => {
  const changed = applyWizard({ ...shipped(), personality: '' }, { traits: ['teases'] }, MET);
  assert.equal(changed.personality, undefined);
});

// ---------------------------------------------------------------------------
// What each step writes
// ---------------------------------------------------------------------------

test('a trait writes its sentence into the prose, not an adjective into the header', () => {
  const files = shipped();
  const changed = applyWizard(files, { traits: ['teases', 'swears'] }, MET);
  const personality = changed.personality ?? '';

  const teases = TRAITS.find((trait) => trait.id === 'teases')?.line ?? '';
  const swears = TRAITS.find((trait) => trait.id === 'swears')?.line ?? '';
  assert.ok(personality.includes(teases));
  assert.ok(personality.includes(swears));

  // Nothing reads personality.md's header, so the wizard does not invent values
  // for it. The three keys it ships with are the three keys it still has.
  assert.deepEqual(
    Object.keys(parseProfileFile(personality).frontmatter),
    Object.keys(parseProfileFile(files.personality ?? '').frontmatter),
  );
  // And the prose that was already there is still there.
  assert.ok(personality.includes('## How you talk'));
  assert.ok(personality.includes('You are not relentlessly positive.'));
});

test('traits come out in the order they are offered, not the order they were clicked', () => {
  const changed = applyWizard(shipped(), { traits: ['swears', 'teases'] }, MET);
  const personality = changed.personality ?? '';
  const teases = personality.indexOf(TRAITS[0]?.line ?? '');
  const swears = personality.indexOf(TRAITS[5]?.line ?? '');
  assert.ok(teases > 0 && swears > teases);
});

test('identity writes three keys and takes the prose the user typed', () => {
  const changed = applyWizard(
    shipped(),
    { age: '31', ethnicity: 'Portuguese', from: 'Lisbon', past: 'You grew up over a bakery.' },
    MET,
  );
  const identity = changed.identity ?? '';

  assert.equal(frontmatterValue(identity, 'age'), '31');
  assert.equal(frontmatterValue(identity, 'ethnicity'), 'Portuguese');
  assert.equal(frontmatterValue(identity, 'from'), 'Lisbon');
  assert.equal(parseProfileFile(identity).body, 'You grew up over a bakery.');
  // Replaced, not appended: two pasts is worse than the wrong one.
  assert.ok(!identity.includes('Oakland'));
  // The keys it was not asked about are untouched.
  assert.equal(frontmatterValue(identity, 'pronouns'), 'she/her');
  assert.equal(frontmatterValue(identity, 'name'), 'Anna');
});

test('clearing the past box leaves the paragraphs she has, minus the fact that moved', () => {
  // Blank means "leave it", not "delete it" — but the sentence naming her age
  // is still made to agree with the age above it.
  const changed = applyWizard(shipped(), { age: '31', past: '   ' }, MET);
  const identity = changed.identity ?? '';
  assert.ok(identity.includes('Oakland'), 'the paragraph nobody changed is gone');
  assert.ok(identity.includes('You are 31 and you do not perform'));
  assert.ok(!identity.includes('You are twenty-six'));
});

// ---------------------------------------------------------------------------
// The bug the critic walked into: a header that disagrees with the biography
// ---------------------------------------------------------------------------

test('changing where she is from rewrites the paragraph that says where she is from', () => {
  const changed = applyWizard(shipped(), { from: 'Lisbon, Portugal' }, MET);
  const identity = changed.identity ?? '';

  assert.equal(frontmatterValue(identity, 'from'), 'Lisbon, Portugal');
  assert.ok(identity.includes('You grew up in Lisbon, Portugal'));
  // The sentence that contradicted it is gone, and the two that did not are not.
  assert.ok(!identity.includes('born in Oakland'));
  assert.ok(identity.includes('people who describe themselves as busy'));
  assert.ok(identity.includes('You do not have a job you talk about'));
});

test('changing only her age leaves the paragraph about growing up alone', () => {
  const identity = applyWizard(shipped(), { age: '31' }, MET).identity ?? '';
  assert.ok(identity.includes('born in Oakland'), 'a fact nobody asked about was rewritten');
  assert.ok(identity.includes('You are 31 and'));
});

test('the markers it edits against are really in the file it ships', () => {
  // `retellIdentity` finds the sentences by literal fragment, so a reword in
  // defaults.ts would silently turn the whole rewrite off. This is the guard.
  const shippedIdentity = DEFAULT_PROFILE_FILES['identity.md'] ?? '';
  assert.ok(shippedIdentity.includes('born in Oakland'));
  assert.ok(shippedIdentity.includes('You are twenty-six'));
});

test('prose somebody else wrote is not rewritten', () => {
  const mine = 'You are from nowhere in particular and you like it that way.';
  assert.equal(retellIdentity(mine, { from: 'Lisbon', age: '31' }, { from: 'Oakland' }), mine);
});

test('an answer identical to what is already there rewrites nothing', () => {
  const body = parseProfileFile(shipped().identity ?? '').body;
  assert.equal(retellIdentity(body, { from: 'Oakland, California', age: '26' }, { from: 'Oakland, California', age: '26' }), body);
});

test('the generated paragraph is wrapped like the rest of the folder', () => {
  // A 240-column paragraph in a file wrapped at eighty is a mark saying a
  // program has been here. Asserted on the paragraph this writes, not on the
  // ones it copied through.
  const body = parseProfileFile(shipped().identity ?? '').body;
  const retold = retellIdentity(body, { from: 'Lisbon, Portugal' }, { from: 'Oakland, California' });
  const written = retold.split(/\n{2,}/)[0] ?? '';

  assert.ok(written.includes('Lisbon'));
  assert.ok(written.includes('\n'), 'it came out as one long line');
  for (const line of written.split('\n')) assert.ok(line.length <= 80, `long line: ${line}`);
});

test('a temperament writes five numbers and keeps the explanation under them', () => {
  const changed = applyWizard(shipped(), { temperament: 'weather' }, MET);
  const mood = changed.mood ?? '';
  const chosen = TEMPERAMENTS.find((each) => each.id === 'weather');

  assert.equal(frontmatterValue(mood, 'baseline_valence'), String(chosen?.valence));
  assert.equal(frontmatterValue(mood, 'baseline_energy'), String(chosen?.energy));
  assert.equal(frontmatterValue(mood, 'baseline_warmth'), String(chosen?.warmth));
  assert.equal(frontmatterValue(mood, 'baseline_interest'), String(chosen?.interest));
  assert.equal(frontmatterValue(mood, 'volatility'), String(chosen?.volatility));
  assert.ok(mood.includes('Your mood is real and it moves.'));
});

test('a temperament nobody offers is ignored rather than half-applied', () => {
  assert.equal(applyWizard(shipped(), { temperament: 'invented' }, MET).mood, undefined);
});

test('their own words go in as a quotation, in their own person', () => {
  const changed = applyWizard(
    shipped(),
    { wants: ['noticing'], aboutThem: 'I have two sisters.\nI hate being managed.' },
    MET,
  );
  const relationship = changed.relationship ?? '';

  assert.ok(relationship.includes(WANTS.find((want) => want.id === 'noticing')?.line ?? ''));
  assert.ok(relationship.includes('> I have two sisters.'));
  assert.ok(relationship.includes('> I hate being managed.'));
  // Not rewritten into an instruction addressed to her.
  assert.ok(!relationship.includes('They have two sisters'));
});

test('what she does with a silence goes in under its own heading', () => {
  const changed = applyWizard(shipped(), { wants: ['evening'], absence: ['waits', 'cools'] }, MET);
  const relationship = changed.relationship ?? '';

  assert.ok(relationship.includes('## When they are not here'));
  assert.ok(relationship.includes(ABSENCE.find((each) => each.id === 'waits')?.line ?? ''));
  assert.ok(relationship.includes(ABSENCE.find((each) => each.id === 'cools')?.line ?? ''));
  // Its own section, so it does not land inside the one about what they wanted.
  assert.ok(
    relationship.indexOf('## What they wanted you for') <
      relationship.indexOf('## When they are not here'),
  );
});

test('every offered voice is a name Google actually has', () => {
  // These are typed out by hand next to a description. A typo would fall back to
  // the default at load and the card would be quietly lying about what it wrote.
  for (const option of VOICE_CHOICES) {
    assert.ok(
      FEMALE_VOICES.some((voice) => voice.name === option.voice),
      `${option.voice} is not one of hers`,
    );
  }
  assert.equal(new Set(VOICE_CHOICES.map((o) => o.voice)).size, VOICE_CHOICES.length);
});

test('picking a described voice writes the name behind it', () => {
  const changed = applyWizard(shipped(), { voice: 'Gacrux' }, MET);
  assert.equal(frontmatterValue(changed.voice ?? '', 'voice'), 'Gacrux');
});

test('refusals become a list, and one of them can be theirs', () => {
  const changed = applyWizard(
    shipped(),
    { refusals: ['romance', 'work'], refusalExtra: 'Never  call me\nbuddy.' },
    MET,
  );
  const boundaries = changed.boundaries ?? '';

  assert.ok(boundaries.includes(`- ${REFUSALS.find((each) => each.id === 'romance')?.line}`));
  assert.ok(boundaries.includes(`- ${REFUSALS.find((each) => each.id === 'work')?.line}`));
  // Flattened, because a newline inside a bullet is a second unmarked bullet.
  assert.ok(boundaries.includes('- Never call me buddy.'));
  // The one thing she does not play is untouched by any of this.
  assert.ok(boundaries.includes('## The one thing you do not play'));
  assert.equal(frontmatterValue(boundaries, 'crisis_line_us'), '988');
});

test('a value with newlines in it cannot break the header it is written into', () => {
  const changed = applyWizard(shipped(), { from: 'Lisbon\nage: 900' }, MET);
  assert.equal(frontmatterValue(changed.identity ?? '', 'from'), 'Lisbon age: 900');
  assert.equal(frontmatterValue(changed.identity ?? '', 'age'), '26');
});

// ---------------------------------------------------------------------------
// Sections, which is what makes any of this editable afterwards
// ---------------------------------------------------------------------------

test('running it twice replaces the answer rather than stacking a second one', () => {
  const first = applyWizard(shipped(), { traits: ['teases'] }, MET);
  const second = applyWizard({ ...shipped(), ...first }, { traits: ['gentle'] }, MET);
  const personality = second.personality ?? '';

  assert.ok(personality.includes(TRAITS.find((trait) => trait.id === 'gentle')?.line ?? ''));
  assert.ok(!personality.includes(TRAITS.find((trait) => trait.id === 'teases')?.line ?? ''));
  assert.equal(personality.split('## What they chose on the first day').length, 2);
});

test('unticking everything takes the section away again', () => {
  const first = applyWizard(shipped(), { traits: ['teases'] }, MET);
  const second = applyWizard({ ...shipped(), ...first }, { traits: [] }, MET);

  assert.ok(!(second.personality ?? '').includes('## What they chose on the first day'));
  // And what is left is what shipped, to the character.
  assert.equal(second.personality, shipped().personality);
});

test('a section is cut out from between the sections around it', () => {
  const file = '---\nk: v\n---\n\nTop.\n\n## Mine\n\nGone.\n\n## Theirs\n\nKept.\n';
  const emptied = withSection(file, 'Mine', []);

  assert.ok(!emptied.includes('Gone.'));
  assert.ok(emptied.includes('Top.'));
  assert.ok(emptied.includes('## Theirs'));
  assert.ok(emptied.includes('Kept.'));
  assert.equal(frontmatterValue(emptied, 'k'), 'v');
});

test('a heading quoted inside an example is not mistaken for the section', () => {
  // personality.md holds an indented transcript. A naive substring search for
  // the heading would find one in there and cut the file in half.
  const file = 'Top.\n\n    ## What they chose on the first day\n\nStill here.\n';
  assert.equal(parseProfileFile(withSection(file, 'What they chose on the first day', [])).body, file.trim());
});

// ---------------------------------------------------------------------------
// The draft, and the bug that made it one object
// ---------------------------------------------------------------------------

test('a fresh draft holds nothing', () => {
  const draft = emptyDraft();

  assert.equal(draft.traits.size, 0);
  assert.equal(draft.wants.size, 0);
  assert.equal(draft.absence.size, 0);
  assert.equal(draft.refusals.size, 0);
  assert.equal(draft.temperament, undefined);
  assert.deepEqual(draft.identity, { age: '', ethnicity: '', from: '', past: '' });
  assert.deepEqual(draft.voice, { voice: '', pace: '' });
  assert.equal(draft.aboutThem, '');
  assert.equal(draft.refusalExtra, '');
});

test('two drafts share nothing, including the nested objects', () => {
  /*
   * The reason this is a factory and not a constant to spread. This codebase
   * shipped the shallow-copy version once: `{ ...EMPTY }` copied the outer
   * object and shared the inner one, so an expression generated in one avatar
   * studio turned up in every other.
   */
  const first = emptyDraft();
  const second = emptyDraft();

  first.traits.add('teases');
  first.identity.from = 'Lisbon';
  first.voice.voice = 'Kore';
  first.aboutThem = 'a secret';

  assert.equal(second.traits.size, 0, 'the sets are shared');
  assert.equal(second.identity.from, '', 'identity is shared');
  assert.equal(second.voice.voice, '', 'voice is shared');
  assert.equal(second.aboutThem, '');
  assert.notEqual(first.identity, second.identity);
  assert.notEqual(first.voice, second.voice);
});

test('a second run cannot inherit the first run\'s answers', () => {
  /*
   * The bug, in the shape it actually had. A completed run, then Start over,
   * then a fresh draft — and nothing of the first person survives into the
   * files the second run writes. Before this, four of the seven cards left
   * their state behind while drawing every control empty.
   */
  const first = emptyDraft();
  first.traits.add('teases');
  first.wants.add('notices-quiet');
  first.absence.add('reaches-out');
  first.refusals.add('no-therapy');
  first.temperament = 'sunny';
  first.aboutThem = 'I work nights.';
  first.refusalExtra = 'never mention my brother';

  const second = emptyDraft();
  const answers = draftToAnswers(second);

  assert.deepEqual(answers.traits, []);
  assert.deepEqual(answers.wants, []);
  assert.deepEqual(answers.absence, []);
  assert.deepEqual(answers.refusals, []);
  assert.equal(answers.temperament, undefined);
  assert.equal(answers.aboutThem, '');
  assert.equal(answers.refusalExtra, '');
});

test('an untouched draft writes nothing but the date', () => {
  // The skip-everything promise, at the level below the DOM: a draft nobody
  // answered must not put a single choice into any file.
  const files = {
    personality: '---\nwarmth: high\n---\n\nProse.\n',
    identity: '---\nname: Anna\n---\n\nProse.\n',
    voice: '---\nvoice: Aoede\n---\n\nProse.\n',
    mood: '---\nbaseline_valence: 0.25\n---\n\nProse.\n',
    relationship: '---\nmet: the day they installed you\n---\n\nProse.\n',
    boundaries: '---\n---\n\nProse.\n',
  };

  const changed = applyWizard(files, draftToAnswers(emptyDraft()), '2026-08-28');

  for (const [name, text] of Object.entries(changed)) {
    if (name === 'relationship') continue;
    assert.equal(text, files[name as keyof typeof files], `${name} was rewritten`);
  }
});
