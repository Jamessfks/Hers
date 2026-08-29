import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_LIVE_MODEL, KNOWN_LIVE_MODELS, capabilitiesOf } from './models.ts';

/**
 * These assertions encode things learned by spending money, and they exist so
 * they cannot be quietly undone — in either direction.
 *
 * On 2026-08-17, `gemini-2.5-flash-native-audio-preview-12-2025` closed the
 * socket with `1011` whenever function declarations met audio input, narrowed
 * by bisection to exactly that pair. On 2026-08-29 the same probe, extended to
 * send a real second of speech, found it survives — blocking and
 * `NON_BLOCKING`. The fix was upstream. What these tests now pin is the current
 * measurement and the reason the default did not move with it.
 */
test('the default model is one that can use tools while being spoken to', () => {
  assert.equal(capabilitiesOf(DEFAULT_LIVE_MODEL).toolsWithAudio, true);
});

test('the 2.5 native-audio model takes tools with audio again, as measured', () => {
  const caps = capabilitiesOf('gemini-2.5-flash-native-audio-preview-12-2025');
  assert.equal(caps.toolsWithAudio, true, 'measured 2026-08-29, having been false on 2026-08-17');
  assert.equal(caps.affectiveDialog, true, 'which is the only reason to reach for it');
});

/**
 * The default stays on 3.1 even though 2.5 now qualifies on paper.
 *
 * 2.5 is the only model that can carry `enableAffectiveDialog`, and that field
 * was the whole argument for it. The argument is weaker than it looks: mood in
 * the voice was measured working on 3.1 through the system instruction alone,
 * at a 58% pace spread across three arms of identical words. Against that, 3.1
 * answers in 1211 ms and takes `thinkingLevel`. Moving the default is a
 * latency comparison nobody has run, so it has not been moved.
 */
test('the default is still 3.1, which cannot do affective dialogue', () => {
  assert.equal(DEFAULT_LIVE_MODEL, 'gemini-3.1-flash-live-preview');
  assert.equal(capabilitiesOf(DEFAULT_LIVE_MODEL).affectiveDialog, false);
  assert.equal(capabilitiesOf(DEFAULT_LIVE_MODEL).thinkingLevel, true);
});

test('an unknown model is assumed tool-capable but not affective', () => {
  const caps = capabilitiesOf('gemini-9-something-not-released-yet');
  assert.equal(
    caps.toolsWithAudio,
    true,
    'refusing tools by default would silently halve every future model',
  );
  assert.equal(
    caps.affectiveDialog,
    false,
    'sending a config field a model does not accept is a rejected setup',
  );
});

test('every model we name has a capability record', () => {
  for (const model of KNOWN_LIVE_MODELS) {
    const caps = capabilitiesOf(model);
    assert.equal(typeof caps.toolsWithAudio, 'boolean', model);
    assert.equal(typeof caps.affectiveDialog, 'boolean', model);
  }
});
