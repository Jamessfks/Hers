import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasChosenName } from './first-run.ts';
import { isPlaceholderName } from './naming.ts';

/** The rest of an identity, so a test can vary the one field it is about. */
const WHO = {
  name: 'Anna',
  age: '26',
  gender: 'female',
  pronouns: 'she/her',
  ethnicity: 'Chinese-American',
  from: 'Oakland, California',
};

// ---------------------------------------------------------------------------
// The placeholder, however it was typed
// ---------------------------------------------------------------------------

test('the placeholder is the placeholder however it was typed', () => {
  for (const typed of ['anna', 'Anna', ' ANNA ', 'aNnA', '']) {
    assert.equal(isPlaceholderName(typed), true, JSON.stringify(typed));
  }
  for (const chosen of ['Mei', 'Annabel', 'Anna Lee']) {
    assert.equal(isPlaceholderName(chosen), false, chosen);
  }
  assert.equal(isPlaceholderName(undefined), true, 'an absent name is the default');
});

// ---------------------------------------------------------------------------
// Whether there is a name to print
// ---------------------------------------------------------------------------

test('the shipped placeholder is not a name anybody chose', () => {
  assert.equal(hasChosenName({ ...WHO, name: 'Anna' }), false);
  assert.equal(hasChosenName({ ...WHO, name: 'anna' }), false);
});

test('a name she chose, and a name somebody typed, both count', () => {
  assert.equal(hasChosenName({ ...WHO, name: 'Mei', named: 'self' }), true);
  assert.equal(hasChosenName({ ...WHO, name: 'Mei' }), true);
  // The marker is enough on its own, even if the name were somehow the default.
  assert.equal(hasChosenName({ ...WHO, name: 'Anna', named: 'self' }), true);
});
