/**
 * The Hedra adapter, against a fake transport.
 *
 * No network and no key: `fetch` is injected, so these tests assert the exact
 * bytes that would go over the wire. That matters more here than for most
 * adapters, because the failure mode this file exists to prevent is a request
 * that is *plausible* — right endpoint, right-looking fields, quietly wrong
 * shape — which type-checks, reads fine in review, and only fails against a
 * live account that charges for the attempt.
 *
 * Every expectation below was taken from `https://api.hedra.com/v3/openapi.json`
 * and, where noted, confirmed against the live service.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HEDRA_MODELS, createHedraProvider, silentWav } from './hedra-provider.ts';
import { VIDEO_PROVIDER_INFO, VideoClipError, type ClipRequest } from './video-provider.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch that records what it was asked and replies from a routing table.
 *
 * Keyed on a substring of the URL rather than the whole thing so a test can say
 * "the jobs endpoint" without restating the base URL and the job id.
 */
function transport(routes: Array<[string, () => { status?: number; json?: unknown; body?: string }]>): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];

  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    let body: unknown = init.body;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
    });

    const route = routes.find(([match]) => url.includes(match));
    if (!route) throw new Error(`No route for ${url}`);
    const reply = route[1]();
    const status = reply.status ?? 200;
    const text = reply.body ?? JSON.stringify(reply.json ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return text;
      },
      async json() {
        return JSON.parse(text);
      },
      async arrayBuffer() {
        return new Uint8Array([7, 7, 7]).buffer;
      },
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

const uploaded = { url: 'https://files.hedra.com/abc?sig=xyz', content_type: 'image/jpeg' };

/** Just enough JPEG for the sniffer: SOI, a JFIF segment, then SOF0. */
function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
}

function clipRequest(overrides: Partial<ClipRequest> = {}): ClipRequest {
  return {
    slot: 'nod',
    image: new Uint8Array([1, 2, 3]),
    imageMimeType: 'image/jpeg',
    prompt: 'She nods once, slowly.',
    avoid: 'camera movement, cuts',
    seconds: 4,
    ...overrides,
  };
}

const job = { providerId: 'hedra' as const, id: 'job_1', submittedAt: 0 };

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

test('submit uploads both files and references them by handle, not by bare string', async () => {
  const { fetch, calls } = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'job_9', status: 'IN_QUEUE' } })],
  ]);
  const provider = createHedraProvider({ apiKey: 'k:s', fetch });

  const handle = await provider.submit(clipRequest());

  assert.equal(handle.id, 'job_9');
  assert.equal(handle.providerId, 'hedra');

  const uploads = calls.filter((call) => call.url.endsWith('/files'));
  assert.equal(uploads.length, 2, 'the image and the driving audio are separate uploads');
  assert.ok(uploads.every((call) => call.method === 'POST'));

  const submit = calls.find((call) => call.url.includes('/models/'))!;
  const input = (submit.body as { input: Record<string, unknown> }).input;
  // The discriminated-union form is the whole point of this assertion: passing
  // the URL as a bare string type-checks and is rejected by the service.
  assert.deepEqual(input['start_image'], { source: 'url', url: uploaded.url });
  assert.deepEqual(input['audio'], { source: 'url', url: uploaded.url });
});

test('submit sends the documented auth header', async () => {
  const { fetch, calls } = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  await createHedraProvider({ apiKey: 'k_live_a:sk_b', fetch }).submit(clipRequest());

  for (const call of calls) {
    assert.equal(call.headers['authorization'], 'Key k_live_a:sk_b');
  }
});

test('the negative prompt is folded into the prompt rather than dropped', async () => {
  const { fetch, calls } = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  await createHedraProvider({ apiKey: 'k:s', fetch }).submit(clipRequest());

  const input = (calls.at(-1)!.body as { input: Record<string, string> }).input;
  assert.match(input['prompt']!, /She nods once/);
  assert.match(input['prompt']!, /Avoid: camera movement, cuts/);
});

test('submit is idempotent per slot and prompt, so a retried submit cannot double-charge', async () => {
  const keys: string[] = [];
  const { fetch } = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  const provider = createHedraProvider({ apiKey: 'k:s', fetch });

  const capture = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  const second = createHedraProvider({ apiKey: 'k:s', fetch: capture.fetch });

  await provider.submit(clipRequest());
  await second.submit(clipRequest());
  keys.push(
    String((capture.calls.at(-1)!.body as { idempotency_key: string }).idempotency_key),
  );

  const third = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  await createHedraProvider({ apiKey: 'k:s', fetch: third.fetch }).submit(clipRequest());
  keys.push(String((third.calls.at(-1)!.body as { idempotency_key: string }).idempotency_key));

  assert.equal(keys[0], keys[1], 'the same clip requested twice reuses one key');

  const different = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  await createHedraProvider({ apiKey: 'k:s', fetch: different.fetch }).submit(
    clipRequest({ slot: 'lean_in', prompt: 'She leans in.' }),
  );
  const other = String(
    (different.calls.at(-1)!.body as { idempotency_key: string }).idempotency_key,
  );
  assert.notEqual(other, keys[0], 'a different clip must not replay the first one');
});

test('omnihuman is clamped to the only aspect ratio it accepts, and gets no duration', async () => {
  const { fetch, calls } = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  await createHedraProvider({
    apiKey: 'k:s',
    fetch,
    model: 'omnihuman-15',
    aspectRatio: '9:16',
  }).submit(clipRequest());

  const submit = calls.at(-1)!;
  assert.ok(submit.url.endsWith('/models/omnihuman-15'));
  const input = (submit.body as { input: Record<string, unknown> }).input;
  assert.equal(input['aspect_ratio'], '16:9', 'asking for portrait would be a 422');
  assert.equal(input['duration_ms'], undefined, 'omnihuman has no duration field');
});

test('character-3 pins the length', async () => {
  const { fetch, calls } = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  await createHedraProvider({ apiKey: 'k:s', fetch }).submit(clipRequest({ seconds: 3.5 }));

  const input = (calls.at(-1)!.body as { input: Record<string, unknown> }).input;
  assert.equal(input['duration_ms'], 3500);
});

test('the output ratio is taken from the photograph, not from a default', async () => {
  const shapes: Array<[Uint8Array, string]> = [
    [jpegHeader(1024, 1024), '1:1'],
    [jpegHeader(1080, 1920), '9:16'],
    [jpegHeader(1920, 1080), '16:9'],
  ];

  for (const [image, expected] of shapes) {
    const { fetch, calls } = transport([
      ['/files', () => ({ status: 201, json: uploaded })],
      ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
    ]);
    await createHedraProvider({ apiKey: 'k:s', fetch }).submit(clipRequest({ image }));

    const input = (calls.at(-1)!.body as { input: Record<string, string> }).input;
    assert.equal(input['aspect_ratio'], expected, `${expected} source`);
  }
});

test('an explicit ratio still wins over the photograph', async () => {
  const { fetch, calls } = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  await createHedraProvider({ apiKey: 'k:s', fetch, aspectRatio: '4:3' }).submit(
    clipRequest({ image: jpegHeader(1024, 1024) }),
  );

  const input = (calls.at(-1)!.body as { input: Record<string, string> }).input;
  assert.equal(input['aspect_ratio'], '4:3');
});

test('a photograph named .png but holding JPEG bytes is uploaded as JPEG', async () => {
  // Not hypothetical: this is exactly the file Anna's avatar is built from.
  let uploadedType: string | null = null;
  const { fetch } = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  const spy = (async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith('/files') && init.body instanceof FormData) {
      const file = init.body.get('file');
      if (file instanceof Blob && file.type.startsWith('image/')) uploadedType = file.type;
    }
    return fetch(url as never, init as never);
  }) as unknown as typeof globalThis.fetch;

  await createHedraProvider({ apiKey: 'k:s', fetch: spy }).submit(
    clipRequest({ image: jpegHeader(1024, 1024), imageMimeType: 'image/png' }),
  );

  assert.equal(uploadedType, 'image/jpeg', 'the bytes decide, not the caller');
});

test('supplied audio is used instead of generated silence', async () => {
  const { fetch } = transport([
    ['/files', () => ({ status: 201, json: uploaded })],
    ['/models/', () => ({ status: 202, json: { job_id: 'j', status: 'IN_QUEUE' } })],
  ]);
  const speech = new Uint8Array([5, 5, 5, 5]);
  // Recorded through the Blob rather than the call log, because FormData bodies
  // are opaque in the log — this asserts the bytes that were actually wrapped.
  let wrapped: number | null = null;
  const spy = (async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith('/files') && init.body instanceof FormData) {
      const file = init.body.get('file');
      if (file instanceof Blob && file.type === 'audio/mpeg') wrapped = file.size;
    }
    return fetch(url as never, init as never);
  }) as unknown as typeof globalThis.fetch;

  await createHedraProvider({ apiKey: 'k:s', fetch: spy }).submit(
    clipRequest({ audio: { bytes: speech, mimeType: 'audio/mpeg' } }),
  );

  assert.equal(wrapped, speech.length, 'the caller’s own audio went up, not silence');
});

// ---------------------------------------------------------------------------
// poll
// ---------------------------------------------------------------------------

test('a running job costs one cheap status call, not the full envelope', async () => {
  const { fetch, calls } = transport([
    ['/status', () => ({ json: { job_id: 'job_1', status: 'IN_PROGRESS', progress: 0.4 } })],
  ]);
  const state = await createHedraProvider({ apiKey: 'k:s', fetch }).poll(job);

  assert.deepEqual(state, { status: 'running', progress: 0.4 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.endsWith('/jobs/job_1/status'));
});

test('a queued job with no progress yet reports null rather than a fake zero', async () => {
  const { fetch } = transport([
    ['/status', () => ({ json: { job_id: 'job_1', status: 'IN_QUEUE', progress: null } })],
  ]);
  assert.deepEqual(await createHedraProvider({ apiKey: 'k:s', fetch }).poll(job), {
    status: 'queued',
    progress: null,
  });
});

test('a completed job reports the measured duration and the charged cost', async () => {
  const { fetch, calls } = transport([
    ['/status', () => ({ json: { job_id: 'job_1', status: 'COMPLETED' } })],
    [
      '/jobs/job_1',
      () => ({
        json: {
          job_id: 'job_1',
          status: 'COMPLETED',
          cost: 0.14,
          currency: 'USD',
          outputs: [{ url: 'https://cdn.hedra.com/out.mp4', duration_ms: 4120 }],
        },
      }),
    ],
  ]);
  const state = await createHedraProvider({ apiKey: 'k:s', fetch }).poll(job);

  assert.deepEqual(state, { status: 'succeeded', seconds: 4.12, costUsd: 0.14 });
  assert.equal(calls.length, 2, 'the envelope is fetched once, at the end');
});

test('a job that reports success with no video is a failure, not a crash later', async () => {
  const { fetch } = transport([
    ['/status', () => ({ json: { job_id: 'job_1', status: 'COMPLETED' } })],
    [
      '/jobs/job_1',
      () => ({ json: { job_id: 'job_1', status: 'COMPLETED', outputs: [{ url: null }] } }),
    ],
  ]);
  const state = await createHedraProvider({ apiKey: 'k:s', fetch }).poll(job);

  assert.equal(state.status, 'failed');
});

test('a failed job carries Hedra’s own reason through', async () => {
  const { fetch } = transport([
    ['/status', () => ({ json: { job_id: 'job_1', status: 'FAILED' } })],
    [
      '/jobs/job_1',
      () => ({
        json: {
          job_id: 'job_1',
          status: 'FAILED',
          error: { message: 'No face detected in the start image.' },
        },
      }),
    ],
  ]);
  const state = await createHedraProvider({ apiKey: 'k:s', fetch }).poll(job);

  assert.equal(state.status, 'failed');
  assert.equal(
    state.status === 'failed' ? state.reason : '',
    'No face detected in the start image.',
  );
  assert.equal(
    state.status === 'failed' ? state.retryable : true,
    false,
    'retrying a rejected prompt spends money to repeat a mistake',
  );
});

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

test('download re-reads the envelope, because the URL from poll may have expired', async () => {
  let served = 0;
  const { fetch, calls } = transport([
    [
      '/jobs/job_1',
      () => {
        served += 1;
        return {
          json: {
            job_id: 'job_1',
            status: 'COMPLETED',
            outputs: [{ url: `https://cdn.hedra.com/out.mp4?sig=fresh${served}` }],
          },
        };
      },
    ],
    ['cdn.hedra.com', () => ({ json: {} })],
  ]);

  const bytes = await createHedraProvider({ apiKey: 'k:s', fetch }).download(job, {
    status: 'succeeded',
    seconds: 4,
    costUsd: 0.1,
  });

  assert.deepEqual(bytes, new Uint8Array([7, 7, 7]));
  assert.ok(calls.at(-1)!.url.includes('sig=fresh1'), 'the signed URL was fetched fresh');
});

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

test('Hedra’s own retryable flag beats guessing from the status code', async () => {
  const { fetch } = transport([
    [
      '/status',
      () => ({
        status: 400,
        json: { error: { code: 'INVALID_ARGUMENT', message: 'Bad input.', retryable: false } },
      }),
    ],
  ]);

  await assert.rejects(
    createHedraProvider({ apiKey: 'k:s', fetch }).poll(job),
    (error: VideoClipError) => {
      assert.equal(error.retryable, false);
      assert.match(error.message, /Bad input\./);
      return true;
    },
  );
});

test('a 500 the service calls retryable is retryable', async () => {
  const { fetch } = transport([
    ['/status', () => ({ status: 503, json: { error: { message: 'Upstream busy.', retryable: true } } })],
  ]);
  await assert.rejects(
    createHedraProvider({ apiKey: 'k:s', fetch }).poll(job),
    (error: VideoClipError) => error.retryable === true,
  );
});

test('a retired endpoint says so, rather than reporting a generic 410', async () => {
  const { fetch } = transport([
    ['/status', () => ({ status: 410, body: '{"message":"no longer available"}' })],
  ]);
  await assert.rejects(
    createHedraProvider({ apiKey: 'k:s', fetch }).poll(job),
    (error: VideoClipError) => /retired/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// validateKey
// ---------------------------------------------------------------------------

test('an empty balance fails the check, with the fix in the message', async () => {
  // This is the live response from the user's key at the time of writing.
  const { fetch } = transport([
    ['/balance', () => ({ json: { balance: 0.0, spent: null, currency: 'USD' } })],
  ]);
  const result = await createHedraProvider({ apiKey: 'k:s', fetch }).validateKey();

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /no credit/);
  assert.match(result.ok ? '' : result.reason, /[Tt]op it up/);
});

test('a funded key passes', async () => {
  const { fetch } = transport([['/balance', () => ({ json: { balance: 12.5, currency: 'USD' } })]]);
  assert.deepEqual(await createHedraProvider({ apiKey: 'k:s', fetch }).validateKey(), { ok: true });
});

test('a rejected key says the key is wrong, not that the balance is', async () => {
  const { fetch } = transport([['/balance', () => ({ status: 401, json: {} })]]);
  const result = await createHedraProvider({ apiKey: 'bad', fetch }).validateKey();

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /rejected that key/);
});

test('an unreachable service is not reported as a bad key', async () => {
  const fetch = (async () => {
    throw new TypeError('network error');
  }) as unknown as typeof globalThis.fetch;

  const result = await createHedraProvider({ apiKey: 'k:s', fetch }).validateKey();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /reach Hedra/);
});

// ---------------------------------------------------------------------------
// silence
// ---------------------------------------------------------------------------

test('the generated silence is a real WAV of the requested length', () => {
  const wav = silentWav(4);
  const text = new TextDecoder().decode(wav.subarray(0, 4));
  assert.equal(text, 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(4, true), wav.length - 8, 'the RIFF size field counts the rest');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16_000);
  // 4s at 16kHz, 16-bit mono, plus the 44-byte header.
  assert.equal(wav.length, 44 + 4 * 16_000 * 2);
  assert.ok(wav.subarray(44).every((byte) => byte === 0), 'and it is actually silent');
});

test('silence never falls under Hedra’s half-second floor', () => {
  assert.equal(silentWav(0.1).length, 44 + 8000 * 2);
  assert.equal(silentWav(0).length, 44 + 8000 * 2);
  assert.equal(silentWav(-5).length, 44 + 8000 * 2);
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test('the registry lists Hedra as wired', () => {
  const wired = VIDEO_PROVIDER_INFO.filter((entry) => entry.status === 'wired').map(
    (entry) => entry.id,
  );
  assert.ok(wired.includes('hedra'));
});

test('every model in the capability table advertises at least one ratio and resolution', () => {
  for (const [id, capability] of Object.entries(HEDRA_MODELS)) {
    assert.ok(capability.aspectRatios.length > 0, `${id} has no aspect ratio`);
    assert.ok(capability.resolutions.length > 0, `${id} has no resolution`);
  }
});
