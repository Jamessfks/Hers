import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SynthesisGovernor, isRateLimit } from './governor.ts';
import { TtsError } from './types.ts';

test('never runs more than the limit at once', async () => {
  const governor = new SynthesisGovernor({ limit: 2 });
  const a = await governor.acquire();
  const b = await governor.acquire();
  assert.equal(governor.inFlight, 2);

  let third = false;
  void governor.acquire().then(() => {
    third = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(third, false, 'a third request must wait');

  a();
  await new Promise((r) => setImmediate(r));
  assert.equal(third, true, 'releasing a slot admits the waiter');
  b();
});

test('a rate limit lowers the ceiling and it stays lowered', () => {
  // Observed against Cartesia: "Current limit: 2" while we ran exactly 2.
  const governor = new SynthesisGovernor({ limit: 4 });
  governor.reportRateLimit();
  assert.equal(governor.limit, 2);
  governor.reportRateLimit();
  assert.equal(governor.limit, 1);
  governor.reportRateLimit();
  assert.equal(governor.limit, 1, 'never below the floor');
  assert.equal(governor.wasRateLimited, true);
});

test('the limit never climbs back on its own', async () => {
  // A concurrency cap is a billing plan, not weather. Probing it again just
  // drops more audio.
  const governor = new SynthesisGovernor({ limit: 2 });
  governor.reportRateLimit();
  const release = await governor.acquire();
  release();
  assert.equal(governor.limit, 1);
});

test('releasing twice does not leak a slot', async () => {
  const governor = new SynthesisGovernor({ limit: 1 });
  const release = await governor.acquire();
  release();
  release();
  assert.equal(governor.inFlight, 0, 'double release must not go negative');
});

test('recognises the shapes a rate limit actually arrives in', () => {
  assert.equal(isRateLimit(new TtsError('nope', 429, 'cartesia')), true);
  assert.equal(
    isRateLimit(new Error('Cartesia returned 429: Too many concurrent requests')),
    true,
  );
  assert.equal(isRateLimit(new Error('Too many concurrent requests. Current limit: 2')), true);
  assert.equal(isRateLimit(new TtsError('bad key', 401)), false);
  assert.equal(isRateLimit(new Error('Invalid transcript')), false);
  assert.equal(isRateLimit(null), false);
});
