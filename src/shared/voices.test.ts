import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_VOICE, FEMALE_VOICES, PREBUILT_VOICES, VOICES } from './voices.ts';

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

test('the menu offers her the fourteen Google labels female', () => {
  assert.equal(FEMALE_VOICES.length, 14);
  assert.ok(FEMALE_VOICES.every((voice) => voice.gender === 'female'));
  assert.deepEqual(
    FEMALE_VOICES.map((voice) => voice.name),
    [
      'Zephyr', 'Kore', 'Leda', 'Aoede', 'Callirrhoe', 'Autonoe', 'Despina',
      'Erinome', 'Laomedeia', 'Achernar', 'Gacrux', 'Pulcherrima',
      'Vindemiatrix', 'Sulafat',
    ],
  );
});

test('every voice carries one of the two labels Google publishes', () => {
  for (const { name, gender } of VOICES) {
    assert.ok(gender === 'female' || gender === 'male', `${name}: ${gender}`);
  }
  assert.equal(VOICES.filter((voice) => voice.gender === 'male').length, 16);
});

test('the voice she ships with is one the menu offers', () => {
  // Otherwise a fresh profile opens the menu on a name that is not in it.
  assert.ok(FEMALE_VOICES.some((voice) => voice.name === DEFAULT_VOICE));
});

test('the other sixteen are still accepted, just not offered', () => {
  // voice.md is a file somebody may already have edited. Narrowing the menu
  // must not quietly reset a profile that says `voice: Puck`.
  assert.ok(PREBUILT_VOICES.includes('Puck'));
});
