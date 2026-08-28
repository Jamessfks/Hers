import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frontmatterValue, parseProfileFile, setFrontmatterValue } from './frontmatter.ts';

const FILE = `---
voice: Aoede
pace: unhurried
---

<!-- A comment somebody wrote. -->

She speaks slowly.
`;

test('changing one key leaves the prose, the comment and the other keys alone', () => {
  const updated = setFrontmatterValue(FILE, 'voice', 'Kore');

  assert.equal(frontmatterValue(updated, 'voice'), 'Kore');
  assert.equal(frontmatterValue(updated, 'pace'), 'unhurried');
  assert.ok(updated.includes('<!-- A comment somebody wrote. -->'));
  assert.ok(updated.includes('She speaks slowly.'));
});

test('a file with no frontmatter gains a block rather than being refused', () => {
  // The profile folder is allowed to be half-written; a menu must still work.
  const updated = setFrontmatterValue('Just prose.\n', 'voice', 'Sulafat');

  assert.equal(frontmatterValue(updated, 'voice'), 'Sulafat');
  assert.ok(updated.includes('Just prose.'));
});

test('the key is found however it was typed', () => {
  assert.equal(frontmatterValue('---\nLanguage_Code: en-GB\n---\nx', 'language code'), 'en-GB');
  assert.equal(frontmatterValue('---\nlanguage code: en-GB\n---\nx', 'Language_Code'), 'en-GB');
});

test('a value is trimmed on the way in', () => {
  assert.equal(frontmatterValue(setFrontmatterValue(FILE, 'voice', '  Puck  '), 'voice'), 'Puck');
});

test('an absent key reads as undefined rather than empty string', () => {
  assert.equal(frontmatterValue(FILE, 'accent'), undefined);
});

test('setting a key twice is the same as setting it once', () => {
  const once = setFrontmatterValue(FILE, 'voice', 'Leda');
  assert.equal(setFrontmatterValue(once, 'voice', 'Leda'), once);
});

test('the parser still reports frontmatter and body separately', () => {
  const { frontmatter, body } = parseProfileFile(FILE);
  assert.equal(frontmatter.voice, 'Aoede');
  assert.ok(body.startsWith('<!--'));
});
