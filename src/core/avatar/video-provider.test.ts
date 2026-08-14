/**
 * The submit / poll / download driver, the cost estimate, and the one adapter
 * that is actually wired.
 *
 * No network anywhere: the hosted adapters are stubs by design, and the driver
 * takes its `sleep` and its clock as parameters precisely so the polling loop —
 * including the timeout, which is otherwise a ten-minute test — can be run
 * against a fake in microseconds.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CLIP_SLOT_NAMES } from './clips.ts';
import { buildClipPrompt } from './prompts.ts';
import {
  CLIP_PRICE_ENVELOPE,
  VIDEO_PROVIDER_INFO,
  VideoClipError,
  awaitClip,
  createVideoClipProvider,
  estimateLibraryCost,
  generateClip,
  type ClipJobState,
  type ClipRequest,
  type VideoClipProvider,
} from './video-provider.ts';

const noSleep = async (): Promise<void> => {};

function request(overrides: Partial<ClipRequest> = {}): ClipRequest {
  const built = buildClipPrompt('nod');
  return {
    slot: 'nod',
    image: new Uint8Array([1, 2, 3]),
    imageMimeType: 'image/jpeg',
    prompt: built.prompt,
    avoid: built.avoid,
    seconds: built.seconds,
    ...overrides,
  };
}

/** A provider that walks a scripted list of states, one per poll. */
function fakeProvider(states: ClipJobState[], bytes = new Uint8Array([9, 9])): {
  provider: VideoClipProvider;
  calls: { submits: number; polls: number; downloads: number };
} {
  const calls = { submits: 0, polls: 0, downloads: 0 };
  let index = 0;

  const provider: VideoClipProvider = {
    id: 'manual',
    label: 'Fake',
    cost: { usdPerClip: 0.2, assumedUsdPerClip: 0.2, pricingUrl: null, verified: true },
    timeoutMs: 60_000,
    async submit() {
      calls.submits += 1;
      return { providerId: 'manual', id: 'job-1', submittedAt: 0 };
    },
    async poll() {
      calls.polls += 1;
      return states[Math.min(index++, states.length - 1)]!;
    },
    async download() {
      calls.downloads += 1;
      return bytes;
    },
    async validateKey() {
      return { ok: true as const };
    },
  };
  return { provider, calls };
}

// -- the driver -------------------------------------------------------------

test('a job is polled until it finishes, then downloaded once', async () => {
  const { provider, calls } = fakeProvider([
    { status: 'queued', progress: null },
    { status: 'running', progress: 0.5 },
    { status: 'succeeded', seconds: 5, costUsd: 0.2 },
  ]);

  const seen: ClipJobState[] = [];
  const result = await generateClip(provider, request(), {
    sleep: noSleep,
    onState: (state) => seen.push(state),
  });

  assert.deepEqual([...result.bytes], [9, 9]);
  assert.equal(result.seconds, 5);
  assert.equal(result.costUsd, 0.2);
  assert.equal(calls.submits, 1);
  assert.equal(calls.polls, 3);
  assert.equal(calls.downloads, 1);
  assert.deepEqual(
    seen.map((state) => state.status),
    ['queued', 'running', 'succeeded'],
  );
});

test('a job recovered from disk is awaited without paying again', async () => {
  // The whole reason ClipJobRef is persisted: after a restart there is a handle
  // and no submit.
  const { provider, calls } = fakeProvider([{ status: 'succeeded', seconds: 5, costUsd: null }]);
  const result = await awaitClip(
    provider,
    { providerId: 'manual', id: 'job-from-last-run', submittedAt: 0 },
    { sleep: noSleep },
  );

  assert.equal(calls.submits, 0, 'resuming must not re-submit');
  assert.equal(result.job.id, 'job-from-last-run');
});

test('a failed job reports whether trying again is worth it', async () => {
  const { provider } = fakeProvider([
    { status: 'failed', reason: 'safety filter refused the image', retryable: false },
  ]);

  await assert.rejects(
    () => generateClip(provider, request(), { sleep: noSleep }),
    (error: unknown) => {
      assert.ok(error instanceof VideoClipError);
      assert.equal(error.retryable, false);
      assert.match(error.message, /safety filter/);
      return true;
    },
  );
});

test('a job that never finishes times out, and stays retryable', async () => {
  // Retryable because the handle is still on disk: the next run re-polls it,
  // which is free, rather than submitting a second render.
  const { provider } = fakeProvider([{ status: 'running', progress: 0.1 }]);
  let clock = 0;

  await assert.rejects(
    () =>
      awaitClip(
        provider,
        { providerId: 'manual', id: 'slow', submittedAt: 0 },
        {
          sleep: async () => {
            clock += 5_000;
          },
          now: () => clock,
          timeoutMs: 20_000,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof VideoClipError);
      assert.equal(error.retryable, true);
      assert.match(error.message, /did not finish/);
      return true;
    },
  );
});

test('an abort stops the loop', async () => {
  const { provider } = fakeProvider([{ status: 'running', progress: null }]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => awaitClip(provider, { providerId: 'manual', id: 'x', submittedAt: 0 }, {
      sleep: noSleep,
      signal: controller.signal,
    }),
  );
});

// -- cost -------------------------------------------------------------------

test('a verified price gives a firm number', () => {
  const estimate = estimateLibraryCost(
    { usdPerClip: 0.25, assumedUsdPerClip: 0.25, pricingUrl: null, verified: true },
    CLIP_SLOT_NAMES.length,
  );
  assert.equal(estimate.low, estimate.high);
  assert.equal(estimate.confident, true);
  assert.equal(estimate.low, 4.75);
});

test('an unverified price gives a range and says so', () => {
  const estimate = estimateLibraryCost(
    { usdPerClip: null, assumedUsdPerClip: 0.3, pricingUrl: null, verified: false },
    19,
  );
  assert.equal(estimate.confident, false);
  // Rounded to cents: 0.1 * 19 is 1.9000000000000001 in binary floating point,
  // and a warning dialogue that quotes that number is a warning nobody trusts.
  assert.equal(estimate.low, 1.9);
  assert.equal(estimate.high, 9.5);
  assert.ok(estimate.low >= CLIP_PRICE_ENVELOPE.low * 19 - 0.01);
  assert.ok(estimate.high > estimate.low);
});

test('bringing your own clips costs nothing here', () => {
  const provider = createVideoClipProvider('manual', { dropDir: '/tmp/nowhere' });
  const estimate = estimateLibraryCost(provider.cost, 19);
  assert.equal(estimate.high, 0);
  assert.equal(estimate.confident, true);
});

// -- the registry -----------------------------------------------------------

test('the unwired adapters fail where the fix is obvious', async () => {
  for (const id of ['runway', 'luma', 'kling'] as const) {
    const provider = createVideoClipProvider(id, { apiKey: 'not-a-real-key' });
    await assert.rejects(
      () => provider.submit(request()),
      /not wired up/,
      `${id} should refuse rather than call an unverified endpoint`,
    );
    const check = await provider.validateKey();
    assert.equal(check.ok, false);
    assert.equal(provider.cost.verified, false, `${id} must not claim a verified price`);
  }
});

test('the provider table matches the registry, and admits what is a stub', () => {
  for (const info of VIDEO_PROVIDER_INFO) {
    const provider = createVideoClipProvider(info.id, { dropDir: '/tmp/nowhere' });
    assert.equal(provider.id, info.id);
    assert.ok(info.why.length > 20, `${info.id} needs a reason to exist`);
  }
  assert.deepEqual(
    VIDEO_PROVIDER_INFO.filter((info) => info.status === 'wired').map((info) => info.id),
    ['manual'],
  );
});

test('an unknown provider id is refused', () => {
  assert.throws(
    // @ts-expect-error — exactly what a stale config value looks like at runtime.
    () => createVideoClipProvider('sora', {}),
    /Unknown video provider/,
  );
});

// -- the manual provider ----------------------------------------------------

test('the manual provider hands out the prompt and picks the clip back up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anna-drop-'));
  try {
    const provider = createVideoClipProvider('manual', { dropDir: dir });
    const job = await provider.submit(request({ slot: 'wave', ...buildRequestFor('wave') }));
    assert.equal(job.id, 'wave');

    // The instruction sheet is the point of submit: these prompts are useless
    // locked inside a process the user cannot see into.
    const sheet = await readFile(join(dir, 'wave.txt'), 'utf8');
    assert.match(sheet, /waves twice from the wrist/);
    assert.match(sheet, /Negative prompt/);

    assert.deepEqual(await provider.poll(job), { status: 'running', progress: null });

    await writeFile(join(dir, 'wave.webm'), new Uint8Array([4, 5, 6]));
    const state = await provider.poll(job);
    assert.equal(state.status, 'succeeded');

    assert.ok(state.status === 'succeeded');
    const bytes = await provider.download(job, state);
    assert.deepEqual([...bytes], [4, 5, 6]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the manual provider refuses to work without a folder', async () => {
  const provider = createVideoClipProvider('manual', {});
  await assert.rejects(() => provider.submit(request()), /No folder is set/);
  assert.equal((await provider.validateKey()).ok, false);
});

function buildRequestFor(slot: 'wave'): Partial<ClipRequest> {
  const built = buildClipPrompt(slot);
  return { prompt: built.prompt, avoid: built.avoid, seconds: built.seconds };
}
