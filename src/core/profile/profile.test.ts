import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ensureProfile,
  loadProfile,
  loadVolatility,
  parseProfileFile,
  readProfileFiles,
  saveProfileFiles,
  serialiseProfileFile,
} from './profile.ts';
import { PROFILE_FILES } from './types.ts';

const scratch = () => mkdtemp(path.join(tmpdir(), 'hers-profile-'));

// -- frontmatter ------------------------------------------------------------

test('frontmatter is parsed and the prose is left alone', () => {
  const { frontmatter, body } = parseProfileFile(
    '---\nheight: 5 ft 6 in\neye_color: dark brown\n---\n\nYou look like this.\n',
  );
  assert.equal(frontmatter.height, '5 ft 6 in');
  assert.equal(frontmatter.eye_color, 'dark brown');
  assert.equal(body, 'You look like this.');
});

test('keys are forgiving, because people type all three of these', () => {
  const { frontmatter } = parseProfileFile('---\nEye_Color: brown\nHair color: black\n---\nx');
  assert.equal(frontmatter.eye_color, 'brown');
  assert.equal(frontmatter.hair_color, 'black');
});

test('a value with a colon in it survives', () => {
  const { frontmatter } = parseProfileFile('---\npace: unhurried: with pauses\n---\nx');
  assert.equal(frontmatter.pace, 'unhurried: with pauses');
});

test('quotes, CRLF and a byte order mark are all tolerated', () => {
  const { frontmatter, body } = parseProfileFile('﻿---\r\nname: "Anna"\r\n---\r\n\r\nProse.\r\n');
  assert.equal(frontmatter.name, 'Anna');
  assert.equal(body, 'Prose.');
});

test('a file with no frontmatter is all prose', () => {
  const { frontmatter, body } = parseProfileFile('Just words.\n');
  assert.deepEqual(frontmatter, {});
  assert.equal(body, 'Just words.');
});

test('frontmatter round-trips', () => {
  const original = { frontmatter: { name: 'Anna', age: '26' }, body: 'Prose here.' };
  const reparsed = parseProfileFile(serialiseProfileFile(original));
  assert.deepEqual(reparsed.frontmatter, original.frontmatter);
  assert.equal(reparsed.body, original.body);
});

// -- loading ----------------------------------------------------------------

test('a fresh folder is written and reads back as the default Anna', async () => {
  const dir = await scratch();
  const profile = await ensureProfile(dir);

  const files = await readdir(dir);
  for (const name of PROFILE_FILES) {
    assert.ok(files.includes(`${name}.md`), `${name}.md was not written`);
  }
  assert.ok(files.includes('gallery'));

  assert.equal(profile.identity.name, 'Anna');
  assert.equal(profile.voice.voice, 'Aoede');
  assert.equal(profile.moodBaseline.warmth, 0.55);
  assert.ok(profile.prose.personality?.includes('not an assistant'));
});

test('every attribute the product promises is a real field', async () => {
  // Not appearance: that is the uploaded photograph, and there is deliberately
  // no written description of her to contradict it.
  const dir = await scratch();
  const profile = await ensureProfile(dir);
  const required = [
    profile.identity.age,
    profile.identity.gender,
    profile.identity.ethnicity,
    profile.voice.voice,
    profile.prose.personality,
    profile.prose.mood,
  ];
  for (const [index, value] of required.entries()) {
    assert.ok(value && value.trim().length > 0, `attribute ${index} is empty`);
  }
});

test('a deleted file comes back rather than taking the app down', async () => {
  const dir = await scratch();
  await ensureProfile(dir);
  await rm(path.join(dir, 'identity.md'));

  const profile = await loadProfile(dir);
  assert.equal(profile.identity.name, 'Anna', 'a missing file must fall back, not blank out');

  await ensureProfile(dir);
  assert.ok((await readdir(dir)).includes('identity.md'), 'and be rewritten next start');
});

test('an edited profile is what reaches the model', async () => {
  const dir = await scratch();
  await ensureProfile(dir);
  await writeFile(
    path.join(dir, 'identity.md'),
    '---\nname: Mei\nage: 31\ngender: female\nethnicity: Korean-Canadian\n---\n\nShe is from Vancouver.\n',
    'utf8',
  );

  const profile = await loadProfile(dir);
  assert.equal(profile.identity.name, 'Mei');
  assert.equal(profile.identity.age, '31');
  assert.equal(profile.identity.ethnicity, 'Korean-Canadian');
  assert.equal(profile.prose.identity, 'She is from Vancouver.');
});

test('a nonsense voice falls back instead of failing the session', async () => {
  const dir = await scratch();
  await ensureProfile(dir);
  await writeFile(path.join(dir, 'voice.md'), '---\nvoice: Gandalf\n---\nx', 'utf8');
  assert.equal((await loadProfile(dir)).voice.voice, 'Aoede');

  await writeFile(path.join(dir, 'voice.md'), '---\nvoice: kore\n---\nx', 'utf8');
  assert.equal((await loadProfile(dir)).voice.voice, 'Kore', 'case should not matter');
});

test('mood numbers are coerced, clamped and never NaN', async () => {
  const dir = await scratch();
  await ensureProfile(dir);
  await writeFile(
    path.join(dir, 'mood.md'),
    '---\nbaseline_valence: 0,4\nbaseline_energy: 87\nbaseline_warmth: banana\nvolatility: 9\n---\nx',
    'utf8',
  );

  const profile = await loadProfile(dir);
  assert.equal(profile.moodBaseline.valence, 0.4, 'a decimal comma is what half the world types');
  assert.equal(profile.moodBaseline.energy, 1, 'out of range must clamp');
  assert.equal(profile.moodBaseline.warmth, 0.55, 'unparseable must fall back');
  assert.equal(await loadVolatility(dir), 1);
});

// -- saving -----------------------------------------------------------------

test('saving writes only the files the loader knows', async () => {
  const dir = await scratch();
  await ensureProfile(dir);

  const written = await saveProfileFiles(dir, {
    personality: 'She is quieter now.',
    'identity.md': '---\nname: Anna\n---\nStill Anna.',
    somethingElse: 'should not appear',
  });

  assert.deepEqual(written.sort(), ['identity', 'personality']);
  assert.equal(await readFile(path.join(dir, 'personality.md'), 'utf8'), 'She is quieter now.');
  assert.ok(!(await readdir(dir)).includes('somethingElse.md'));
});

test('a traversing name cannot escape the profile folder', async () => {
  const dir = await scratch();
  await ensureProfile(dir);
  const outside = path.join(dir, '..', 'escaped.md');

  const written = await saveProfileFiles(dir, {
    '../../escaped': 'no',
    '../../.ssh/authorized_keys': 'definitely not',
    '/etc/passwd': 'no',
    '..\\..\\windows.md': 'no',
  });

  assert.deepEqual(written, [], `traversal was accepted: ${written.join(', ')}`);
  await assert.rejects(() => readFile(outside, 'utf8'));
});

test('an absurdly large file is refused rather than written', async () => {
  const dir = await scratch();
  await ensureProfile(dir);
  const before = await readFile(path.join(dir, 'personality.md'), 'utf8');
  await saveProfileFiles(dir, { personality: 'x'.repeat(300_000) });
  assert.equal(await readFile(path.join(dir, 'personality.md'), 'utf8'), before);
});

test('the editor gets every file back, in one shape', async () => {
  const dir = await scratch();
  await ensureProfile(dir);
  const files = await readProfileFiles(dir);
  assert.deepEqual(Object.keys(files).sort(), [...PROFILE_FILES].sort());
  for (const [name, contents] of Object.entries(files)) {
    assert.ok(contents.length > 0, `${name} came back empty`);
  }
});
