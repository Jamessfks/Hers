import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_VOICE, PREBUILT_VOICES, VOICES } from './voices.ts';

test('every voice Google documents is offered, once', () => {
  assert.equal(VOICES.length, 30);
  assert.equal(new Set(PREBUILT_VOICES).size, 30, 'a duplicate would appear twice in the menu');
});

test('the shipped default is one she can actually be given', () => {
  assert.ok(PREBUILT_VOICES.includes(DEFAULT_VOICE));
});

test('names are spelled the way the Live API expects them', () => {
  // `voiceName` is matched exactly by the API. A stray space or a lowercase
  // initial is a session that opens and then has no voice.
  for (const { name } of VOICES) {
    assert.match(name, /^[A-Z][A-Za-z]+$/, name);
    assert.equal(name, name.trim(), name);
  }
});

test('each one says how it sounds, in one word', () => {
  for (const { name, character } of VOICES) {
    assert.ok(character.length > 0, `${name} has no description`);
    assert.doesNotMatch(character, /\s/, `${name}: "${character}" is a sentence, not a word`);
  }
});

test('the two lists cannot drift, because one is made from the other', () => {
  assert.deepEqual([...PREBUILT_VOICES], VOICES.map((voice) => voice.name));
});
