import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_LIVE_MODEL, KNOWN_LIVE_MODELS, capabilitiesOf } from './models.ts';

/**
 * These assertions encode something learned by spending money, and they exist
 * so it cannot be quietly undone. On
 * `gemini-2.5-flash-native-audio-preview-12-2025`, function declarations
 * combined with audio input close the socket with `1011 Internal error
 * occurred.` — reproduced on every attempt, and narrowed by bisection to
 * exactly that pair. Changing the default back to it, or marking it as
 * tool-capable, breaks Her voice path completely and silently.
 */
test('the default model is one that can use tools while being spoken to', () => {
  assert.equal(capabilitiesOf(DEFAULT_LIVE_MODEL).toolsWithAudio, true);
});

test('the 2.5 native-audio model is still recorded as unable to', () => {
  const caps = capabilitiesOf('gemini-2.5-flash-native-audio-preview-12-2025');
  assert.equal(caps.toolsWithAudio, false, 'this is a measured fact, not a preference');
  assert.equal(caps.affectiveDialog, true, 'which is the only reason to choose it');
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
