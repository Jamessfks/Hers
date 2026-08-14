import assert from 'node:assert/strict';
import { test } from 'node:test';

import { merge } from './merge.ts';

const CONFIG = {
  llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
  tts: { provider: 'cartesia', voiceId: 'abc' },
  senses: { camera: false, microphone: false, cameraIntervalSeconds: 45 },
  presence: { proactive: true, quietHours: [1, 8] },
};

test('a nested write keeps its siblings', () => {
  const next = merge(CONFIG, { tts: { voiceId: 'xyz' } });
  assert.equal(next.tts.voiceId, 'xyz');
  assert.equal(next.tts.provider, 'cartesia', 'sibling key must survive');
  assert.equal(next.llm.model, 'claude-sonnet-5', 'unrelated branch must survive');
});

test('merging does not mutate the original', () => {
  const before = structuredClone(CONFIG);
  merge(CONFIG, { senses: { camera: true } });
  assert.deepEqual(CONFIG, before);
});

test('false and 0 are written, not skipped as falsy', () => {
  const next = merge(CONFIG, { presence: { proactive: false }, senses: { cameraIntervalSeconds: 0 } });
  assert.equal(next.presence.proactive, false);
  assert.equal(next.senses.cameraIntervalSeconds, 0);
});

test('arrays are replaced wholesale, not merged element-wise', () => {
  const next = merge(CONFIG, { presence: { quietHours: [23, 7] } });
  assert.deepEqual(next.presence.quietHours, [23, 7]);
});

test('null clears a value, undefined leaves it alone', () => {
  assert.equal(merge(CONFIG, { presence: { quietHours: null } }).presence.quietHours, null);
  assert.deepEqual(merge(CONFIG, { presence: { quietHours: undefined } }).presence.quietHours, [1, 8]);
});

test('an unknown key from an older or newer build is preserved', () => {
  const withExtra = merge(CONFIG, { futureFeature: { enabled: true } }) as typeof CONFIG & {
    futureFeature: { enabled: boolean };
  };
  assert.equal(withExtra.futureFeature.enabled, true);
  assert.equal(withExtra.llm.provider, 'anthropic');
});

test('prototype pollution through a config file is refused', () => {
  const payload = JSON.parse('{"__proto__": {"polluted": true}}');
  merge(CONFIG, payload);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});
