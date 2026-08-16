import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tidyCaption } from '../../web/caption.ts';

test('a caption someone wrote is kept', () => {
  for (const written of [
    'Standing at the window watching it rain.',
    'laughing in the kitchen',
    'Tired, late at night',
    'at the window rainy',
  ]) {
    assert.equal(tidyCaption(written), written, `dropped a real caption: ${written}`);
  }
});

test('a truncated file-name slug is dropped', () => {
  // The real one, off a generated file: the name is a 48-character slug of the
  // prompt, so it ends mid-phrase.
  for (const slug of [
    'evening warm indoor light buoyant looking at the',
    'morning light coffee somewhere nearby quietly pleased looking at',
    'leaning against a textured wall slight amusement and',
  ]) {
    assert.equal(tidyCaption(slug), '', `kept a slug: ${slug}`);
  }
});

test('nothing is nothing', () => {
  assert.equal(tidyCaption(undefined), '');
  assert.equal(tidyCaption('   '), '');
});
