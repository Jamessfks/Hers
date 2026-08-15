/**
 * The Hedra generation path, exercised the way the app actually runs it.
 *
 * Every other test in this directory builds an adapter directly. These go
 * through `createVideoClipProvider`, because that is what the app does and
 * because two defects that billed the user twice lived in precisely the gap
 * between "the adapter is tested" and "the path is tested". See
 * docs/audits/hedra-generation.md.
 *
 * Nothing here touches the network. The transport refuses any host it was not
 * given, so a missed injection fails loudly instead of quietly spending money
 * on an API that charges on ingest.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAKE_KEY, fakeTransport, unreachableTransport } from './testing/transport.ts';
import {
  awaitClip,
  createVideoClipProvider,
  generateClip,
  VideoClipError,
  type ClipJobHandle,
  type ClipJobState,
  type ClipRequest,
  type VideoClipProvider,
} from './video-provider.ts';

/** A 1x1 JPEG, enough for `sniffImage` to recognise a shape. */
const PIXEL = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02,
  0x00, 0x02, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

const REQUEST: ClipRequest = {
  slot: 'wave',
  image: PIXEL,
  imageMimeType: 'image/jpeg',
  prompt: 'she raises a hand and waves once',
  avoid: 'the hand leaving frame',
  seconds: 4,
};

const NO_WAIT = { sleep: async (): Promise<void> => {}, pollIntervalMs: 1 };

function hedra(fetch: typeof globalThis.fetch): VideoClipProvider {
  return createVideoClipProvider('hedra', { apiKey: FAKE_KEY, fetch });
}

// ---------------------------------------------------------------------------
// The guard itself
// ---------------------------------------------------------------------------

test('the fake transport refuses a host it was not given', async () => {
  const transport = fakeTransport({ 'GET /x': { json: {} } }, { allowHosts: ['api.hedra.com'] });
  await assert.rejects(
    () => transport.fetch('https://example.com/x'),
    /Blocked a request to example\.com/,
  );
});

test('the fake transport refuses a route it does not have, rather than falling through', async () => {
  const transport = fakeTransport({});
  await assert.rejects(
    () => transport.fetch('https://api.hedra.com/v3/jobs/abc'),
    /No route for GET/,
  );
});

test('the registry passes an injected transport down to the adapter', async () => {
  // The regression this guards: `VideoProviderOptions` had no `fetch`, so the
  // adapter's seam existed and the app's path could not reach it.
  const transport = fakeTransport({
    'GET /balance': { json: { balance: 12.5 } },
  });
  const result = await hedra(transport.fetch).validateKey!();
  assert.equal(result.ok, true);
  assert.equal(transport.matching('/balance').length, 1);
});

// ---------------------------------------------------------------------------
// Finding 1 — a transient poll error must not discard a paid job
// ---------------------------------------------------------------------------

/** A provider whose `poll` fails a set number of times before succeeding. */
function flakyProvider(failures: number, error: () => unknown): VideoClipProvider & { polls: number } {
  const provider = {
    id: 'hedra' as const,
    label: 'Hedra',
    cost: { usdPerClip: null, assumedUsdPerClip: 0.25, pricingUrl: '', basis: 'unknown' as const, verified: false },
    timeoutMs: 60_000,
    polls: 0,
    async submit(): Promise<ClipJobHandle> {
      return { providerId: 'hedra', id: 'job-1', submittedAt: 0 };
    },
    async poll(): Promise<ClipJobState> {
      provider.polls += 1;
      if (provider.polls <= failures) throw error();
      return { status: 'succeeded', seconds: 4, costUsd: 0.25 };
    },
    async download(): Promise<Uint8Array> {
      return new Uint8Array([1, 2, 3]);
    },
    async validateKey() {
      return { ok: true as const };
    },
  };
  return provider;
}

test('a rate-limited status check is retried rather than abandoning the render', async () => {
  const provider = flakyProvider(3, () =>
    new VideoClipError('Hedra returned 429.', { status: 429, provider: 'hedra', retryable: true }),
  );

  const result = await awaitClip(provider, { providerId: 'hedra', id: 'job-1', submittedAt: 0 }, NO_WAIT);

  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.equal(provider.polls, 4, 'three failures then the real answer');
});

test('a dropped connection is retried — it is not the render failing', async () => {
  // `fetch` rejects with a TypeError for DNS and socket failures, and this is
  // the shape that used to mark a paid, still-running job as failed.
  const provider = flakyProvider(2, () => new TypeError('network is down'));
  const result = await awaitClip(provider, { providerId: 'hedra', id: 'job-1', submittedAt: 0 }, NO_WAIT);
  assert.equal(result.costUsd, 0.25);
});

test('a rejection the provider calls final is believed immediately', async () => {
  // The opposite direction matters just as much: a 401 will still be a 401 on
  // the tenth attempt, and retrying it wastes the user's time.
  const provider = flakyProvider(1, () =>
    new VideoClipError('Hedra rejected that key.', { status: 401, provider: 'hedra', retryable: false }),
  );

  await assert.rejects(
    () => awaitClip(provider, { providerId: 'hedra', id: 'job-1', submittedAt: 0 }, NO_WAIT),
    /rejected that key/,
  );
  assert.equal(provider.polls, 1, 'not retried');
});

test('a status check that never recovers eventually gives up', async () => {
  const provider = flakyProvider(Number.MAX_SAFE_INTEGER, () => new TypeError('network is down'));
  await assert.rejects(
    () => awaitClip(provider, { providerId: 'hedra', id: 'job-1', submittedAt: 0 }, NO_WAIT),
    /network is down/,
  );
  assert.ok(provider.polls > 1 && provider.polls <= 8, `bounded retries, saw ${provider.polls}`);
});

// ---------------------------------------------------------------------------
// Finding 2 — the handle must be durable before the wait starts
// ---------------------------------------------------------------------------

test('the job handle is reported before the first poll, not after the last', async () => {
  const order: string[] = [];
  const provider = {
    ...flakyProvider(0, () => new Error('unused')),
    async poll(): Promise<ClipJobState> {
      order.push('poll');
      return { status: 'succeeded', seconds: 4, costUsd: 0.25 };
    },
  };

  await generateClip(provider, REQUEST, {
    ...NO_WAIT,
    onSubmit: async (job) => {
      assert.equal(job.id, 'job-1');
      order.push('persist');
    },
  });

  assert.deepEqual(order, ['persist', 'poll'], 'the handle is written down before it is waited on');
});

test('generateClip waits for the handle to be stored before polling', async () => {
  // Awaited, not fired and forgotten: an async write that has not landed is the
  // same as no write at all if the process dies in the meantime.
  let stored = false;
  const provider = {
    ...flakyProvider(0, () => new Error('unused')),
    async poll(): Promise<ClipJobState> {
      assert.equal(stored, true, 'polling began before the handle was durable');
      return { status: 'succeeded', seconds: 4, costUsd: 0.25 };
    },
  };

  await generateClip(provider, REQUEST, {
    ...NO_WAIT,
    onSubmit: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      stored = true;
    },
  });
});

// ---------------------------------------------------------------------------
// The adapter's own failure branches, through the registry
// ---------------------------------------------------------------------------

test('an auth rejection is reported as a key problem and is not retryable', async () => {
  const transport = fakeTransport({
    'POST /files': { status: 401, json: { error: { message: 'bad key', retryable: false } } },
  });

  await assert.rejects(
    () => hedra(transport.fetch).submit(REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof VideoClipError);
      assert.match(error.message, /rejected that key/);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('a 402 is reported as an empty account rather than a generic failure', async () => {
  const transport = fakeTransport({
    'POST /files': { status: 402, json: { error: { message: 'no credit' } } },
  });
  await assert.rejects(() => hedra(transport.fetch).submit(REQUEST), /out of credit/);
});

test("a 429 carries the vendor's own retryable flag", async () => {
  const transport = fakeTransport({
    'POST /files': { status: 429, json: { error: { message: 'slow down', retryable: true } } },
  });
  await assert.rejects(
    () => hedra(transport.fetch).submit(REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof VideoClipError);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test('a completed job that produced no output is a failure, not a success', async () => {
  const transport = fakeTransport({
    'GET /jobs/job-1/status': { json: { status: 'COMPLETED' } },
    'GET /jobs/job-1': { json: { job_id: 'job-1', status: 'COMPLETED', outputs: [] } },
  });

  const state = await hedra(transport.fetch).poll({ providerId: 'hedra', id: 'job-1', submittedAt: 0 });
  assert.equal(state.status, 'failed');
  assert.match(state.status === 'failed' ? state.reason : '', /no video/);
});

test('a malformed envelope does not read as success', async () => {
  const transport = fakeTransport({
    'GET /jobs/job-1/status': { json: { status: 'COMPLETED' } },
    'GET /jobs/job-1': { body: 'not json at all' },
  });
  await assert.rejects(() =>
    hedra(transport.fetch).poll({ providerId: 'hedra', id: 'job-1', submittedAt: 0 }),
  );
});

test('an unreachable service throws rather than resolving to anything', async () => {
  const provider = createVideoClipProvider('hedra', {
    apiKey: FAKE_KEY,
    fetch: unreachableTransport(),
  });
  await assert.rejects(() => provider.submit(REQUEST), /network is down/);
});

test('validateKey refuses a key whose account has no credit', async () => {
  const transport = fakeTransport({ 'GET /balance': { json: { balance: 0 } } });
  const result = await hedra(transport.fetch).validateKey!();
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /no credit/);
});
