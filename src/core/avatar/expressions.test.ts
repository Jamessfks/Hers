import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXPRESSION_NAMES, isExpression, promptFor } from './expressions.ts';

test('the expressions are distinct names, and nothing else is one', () => {
  assert.equal(new Set(EXPRESSION_NAMES).size, EXPRESSION_NAMES.length);
  for (const name of EXPRESSION_NAMES) assert.ok(isExpression(name), name);

  // The name reaches a URL and a filename, so it has to stay boring.
  for (const name of EXPRESSION_NAMES) assert.match(name, /^[a-z]+$/);

  for (const bad of ['', 'RESTING', 'nope', '../source', 'resting ', 42, null, undefined, {}]) {
    assert.equal(isExpression(bad), false, JSON.stringify(bad));
  }
});

test('every prompt pins the three things that make the cut work', () => {
  /*
   * The interface swaps the photograph for one of these and back with no
   * transition. That only reads as one person in one room if the face is the only
   * thing that changed — so each prompt has to hold the likeness, hold the frame,
   * and ask for a photograph rather than a drawing. Drift here does not look like
   * a worse picture, it looks like a different woman.
   */
  for (const name of EXPRESSION_NAMES) {
    const prompt = promptFor(name);
    assert.match(prompt, /photorealistic/i, `${name}: must ask for a photograph`);
    assert.match(prompt, /remain completely unchanged/i, `${name}: must hold the likeness`);
    assert.match(prompt, /identical framing/i, `${name}: must hold the frame`);
    assert.match(prompt, /identical background/i, `${name}: must hold the setting`);
    assert.match(prompt, /nothing changes except her expression/i, `${name}`);
    assert.match(prompt, /reference image/i, `${name}: must point at the photograph`);
  }
});

test('the prompt says which face it wants, and no other', () => {
  const resting = promptFor('resting');
  const laughing = promptFor('laughing');
  assert.notEqual(resting, laughing);
  assert.match(laughing, /laugh/i);
  assert.doesNotMatch(resting, /laugh/i);
});
