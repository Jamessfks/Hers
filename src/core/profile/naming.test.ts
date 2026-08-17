import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { PLACEHOLDER_NAME, cleanName, pickFrom } from './naming.ts';
import { ensureProfile, loadProfile, writeChosenName } from './profile.ts';

// -- what counts as a name --------------------------------------------------

test('a single given name is accepted, and tidied', () => {
  assert.equal(cleanName('Mira'), 'Mira');
  assert.equal(cleanName('  wen  '), 'Wen', 'capitalised, because it goes on a page');
  assert.equal(cleanName('"Ines"'), 'Ines', 'a model that quotes itself still chose a name');
  assert.equal(cleanName('Mei-Ling'), 'Mei-Ling', 'a hyphen is part of real names');
  assert.equal(cleanName("Sa'id"), "Sa'id");
  assert.equal(cleanName('Zoë'), 'Zoë', '[a-z] is not a theory of names');
});

test('anything that is not a name is refused', () => {
  for (const bad of [
    '',
    'A',
    'I would love to be called Maya',
    'Maya Chen',
    'Maya!',
    'Maya\nChen',
    'the name I choose is Maya',
    'Assistant-3000',
    'x'.repeat(21),
  ]) {
    assert.equal(cleanName(bad), null, JSON.stringify(bad));
  }
});

test('she may not choose the placeholder, however politely', () => {
  // Taking it would leave the marker unwritten and loop the choice forever.
  assert.equal(cleanName(PLACEHOLDER_NAME), null);
  assert.equal(cleanName('anna'), null, 'in any casing');
});

// -- writing it down --------------------------------------------------------

test('the chosen name is written, and the rest of the file is left alone', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-naming-'));
  await ensureProfile(dir);

  const before = await readFile(path.join(dir, 'identity.md'), 'utf8');
  assert.match(before, /name: Anna/, 'the project ships with a placeholder');

  await writeChosenName(dir, 'Mira', 'It sounds like someone who would argue with you.');
  const after = await readFile(path.join(dir, 'identity.md'), 'utf8');

  assert.match(after, /name: Mira/);
  assert.match(after, /named: self/, 'the marker is what makes it permanent');
  assert.match(after, /She chose this name herself/, 'the file explains itself to whoever opens it');

  // Everything else survives: the prose, and every key this program did not set.
  assert.match(after, /age: 26/);
  assert.match(after, /ethnicity: Chinese-American/);
  const prose = before.split('---').at(-1)?.trim() ?? '';
  assert.ok(prose.length > 40 && after.includes(prose), 'her written identity is untouched');
});

test('a hand-edited key nobody has heard of survives the write', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-naming-'));
  await ensureProfile(dir);
  const file = path.join(dir, 'identity.md');
  await writeFile(
    file,
    ['---', 'name: Anna', 'age: 26', 'favourite_tea: genmaicha', '---', '', 'Some prose.'].join('\n'),
    'utf8',
  );

  await writeChosenName(dir, 'Wen', '');
  const after = await readFile(file, 'utf8');
  assert.match(after, /favourite_tea: genmaicha/, 'this folder is the user’s, not ours');
  assert.match(after, /name: Wen/);
});

test('the loader reads the marker back, which is what stops a re-roll', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-naming-'));
  await ensureProfile(dir);

  assert.equal((await loadProfile(dir)).identity.named, undefined, 'nobody has chosen yet');
  assert.equal((await loadProfile(dir)).identity.name, PLACEHOLDER_NAME);

  await writeChosenName(dir, 'Mira', 'because');
  const profile = await loadProfile(dir);
  assert.equal(profile.identity.name, 'Mira');
  assert.equal(profile.identity.named, 'self');
});

test('writing twice does not stack the note', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-naming-'));
  await ensureProfile(dir);
  await writeChosenName(dir, 'Mira', 'first');
  await writeChosenName(dir, 'Mira', 'second');

  const after = await readFile(path.join(dir, 'identity.md'), 'utf8');
  assert.equal(after.match(/She chose this name herself/g)?.length, 1);
});

// -- which of her own names she ends up with --------------------------------

test('one of her candidates is taken, and only valid ones count', () => {
  const shortlist = {
    names: [
      { name: 'I would love to be called Maya', why: 'not a name' },
      { name: 'Anna', why: 'she was told not to' },
      { name: 'Mira', why: 'first real one' },
      { name: 'mira', why: 'the same name again' },
      { name: 'Wen', why: 'second real one' },
    ],
  };

  assert.equal(pickFrom(shortlist, () => 0)?.name, 'Mira');
  assert.equal(pickFrom(shortlist, () => 0.99)?.name, 'Wen', 'the duplicate did not take a slot');

  // The reason travels with the name it belongs to, not with the list.
  assert.equal(pickFrom(shortlist, () => 0)?.why, 'first real one');
});

test('every candidate is reachable, so the choice is genuinely spread', () => {
  const shortlist = {
    names: ['Mira', 'Wen', 'Ines', 'Suyin', 'Nari', 'Bo'].map((name) => ({ name, why: '' })),
  };

  const picked = new Set<string>();
  for (let i = 0; i < 6; i += 1) picked.add(pickFrom(shortlist, () => i / 6)!.name);
  assert.equal(picked.size, 6, 'a shortlist nobody can reach the end of is a first choice');
});

test('a shortlist with nothing usable in it is not a name', () => {
  assert.equal(pickFrom({ names: [{ name: 'Anna', why: '' }] }, () => 0), null);
  assert.equal(pickFrom({ names: [] }, () => 0), null);
  assert.equal(pickFrom({ names: 'Mira' }, () => 0), null, 'a string is not a shortlist');
  assert.equal(pickFrom(null, () => 0), null);
  assert.equal(pickFrom({}, () => 0), null);
});

test('a random of exactly 1 does not fall off the end', () => {
  // `Math.random` cannot return 1, but a stub can, and an out-of-range index
  // would be a crash on the one code path that must not have one.
  const shortlist = { names: [{ name: 'Mira', why: '' }, { name: 'Wen', why: '' }] };
  assert.equal(pickFrom(shortlist, () => 1)?.name, 'Wen');
});
