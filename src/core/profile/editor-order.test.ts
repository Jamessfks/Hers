import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROFILE_ORDER } from '../../web/profile-order.ts';
import { PROFILE_FILES } from './types.ts';

/**
 * The browser cannot import the server's copy of this list — that module is
 * compiled against Node's types — so there are two lists. This is the thing
 * that stops them drifting: add a profile file and forget the editor, and this
 * fails rather than the tab quietly never appearing.
 */
test('the editor shows exactly the files the loader reads', () => {
  assert.deepEqual([...PROFILE_ORDER], [...PROFILE_FILES]);
});
