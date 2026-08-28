import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frontmatterValue, parseProfileFile } from './frontmatter.ts';
import { REFUSALS, TEMPERAMENTS, TRAITS, WANTS, applyWizard, withSection } from './wizard.ts';
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
    past: parseProfileFile(identity).body,
    voice: frontmatterValue(files.voice ?? '', 'voice') ?? '',
    pace: frontmatterValue(files.voice ?? '', 'pace') ?? '',
    wants: [],
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

test('identity writes three keys and replaces the paragraph under them', () => {
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

test('clearing the past box leaves her past alone rather than deleting it', () => {
  const changed = applyWizard(shipped(), { age: '31', past: '   ' }, MET);
  assert.ok((changed.identity ?? '').includes('Oakland'));
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
