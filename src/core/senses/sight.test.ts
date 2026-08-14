import assert from 'node:assert/strict';
import { test } from 'node:test';

import { needsFreshLook, readChanged } from './sight.ts';

test('recognises when the conversation needs eyes', () => {
  for (const message of [
    'can you see me?',
    'how do I look',
    'what am I wearing',
    'look at my desk',
    'do you like my hair',
    'notice anything different?',
    'what colour is my shirt',
    "I'm showing you this",
  ]) {
    assert.equal(needsFreshLook(message), true, `should look: "${message}"`);
  }
});

test('does not fire a camera capture on an ordinary message', () => {
  // A false positive costs a vision call and latency on a turn that did not
  // need it — and points a camera at someone for no reason.
  for (const message of [
    'i had a rough day',
    'my manager rewrote my design doc',
    'what would you do',
    'i saw a film last night',
    'do you remember what upset me',
    'look, it is fine',
  ]) {
    assert.equal(needsFreshLook(message), false, `should not look: "${message}"`);
  }
});

test('the same observation in different words is not a change', () => {
  assert.equal(
    readChanged('slumped forward, rubbing their eyes', 'slumped, rubbing eyes'),
    false,
    'she must not report the same posture every time the timer fires',
  );
});

test('a genuinely different observation is a change', () => {
  assert.equal(readChanged('sitting upright, focused', 'slumped forward, head in hands'), true);
  assert.equal(readChanged(undefined, 'sitting upright'), true, 'the first read is always new');
});
