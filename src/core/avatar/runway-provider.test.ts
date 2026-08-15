/**
 * The Runway adapter, against a fake transport.
 *
 * Same discipline as the Hedra tests and for the same reason: the failure this
 * file exists to catch is a request that looks right, type-checks, reads fine in
 * review, and is rejected by a live account that charges for the attempt.
 *
 * Expectations come from `https://docs.dev.runwayml.com/openapi.json` and the
 * pricing guide. The two that would be easiest to get wrong from memory, and are
 * asserted here explicitly, are the required `X-Runway-Version` header and the
 * 1000-code-unit cap on `promptText`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLIP_SLOT_NAMES } from './clips.ts';
import { buildClipPrompt } from './prompts.ts';
import {
  CREDITS_PER_SECOND,
  RUNWAY_COST,
  USD_PER_CREDIT,
  createRunwayProvider,
  promptFor,
} from './runway-provider.ts';
import { VideoClipError, estimateLibraryCost, type ClipRequest } from './video-provider.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

function transport(
  routes: Array<[string, () => { status?: number; json?: unknown; body?: string }]>,
): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];

  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
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
        return new Uint8Array([4, 2]).buffer;
      },
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

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
    image: jpegHeader(1024, 1024),
    imageMimeType: 'image/jpeg',
    prompt: 'She nods once, slowly.',
    avoid: 'camera movement, cuts',
    seconds: 5,
    ...overrides,
  };
}

const accepted = { id: '0f1e2d3c-4b5a-4968-8776-655443332211', estimatedCost: { credits: 25 } };
const job = { providerId: 'runway' as const, id: accepted.id, submittedAt: 0 };

const submitRoutes = (): Array<[string, () => { status?: number; json?: unknown }]> => [
  ['/v1/image_to_video', () => ({ json: accepted })],
];

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

test('submit sends the bearer key and the pinned API version', async () => {
  const { fetch, calls } = transport(submitRoutes());
  await createRunwayProvider({ apiKey: 'key_abc', fetch }).submit(clipRequest());

  const call = calls[0]!;
  assert.equal(call.method, 'POST');
  assert.ok(call.url.endsWith('/v1/image_to_video'));
  assert.equal(call.headers['authorization'], 'Bearer key_abc');
  // Runway declares this header as a required const. Omitting it is a 400 on
  // every request, which is a spectacular way to discover it in production.
  assert.equal(call.headers['X-Runway-Version'], '2024-11-06');
});

test('the photograph goes inline as a data URI, typed from its bytes', async () => {
  const { fetch, calls } = transport(submitRoutes());
  // Declared PNG, actually JPEG — the case the real source photograph is.
  await createRunwayProvider({ apiKey: 'k', fetch }).submit(
    clipRequest({ imageMimeType: 'image/png' }),
  );

  const image = String(calls[0]!.body!['promptImage']);
  assert.ok(image.startsWith('data:image/jpeg;base64,'), image.slice(0, 40));
  // Round-trips: a mangled base64 encoder produces something that still looks
  // like a data URI and decodes to nothing.
  const decoded = Uint8Array.from(atob(image.split(',')[1]!), (c) => c.charCodeAt(0));
  assert.deepEqual([...decoded.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0]);
});

test('the model and duration are what gen4_turbo accepts', async () => {
  const { fetch, calls } = transport(submitRoutes());
  await createRunwayProvider({ apiKey: 'k', fetch }).submit(clipRequest({ seconds: 5 }));

  const body = calls[0]!.body!;
  assert.equal(body['model'], 'gen4_turbo');
  assert.equal(body['duration'], 5);
  assert.equal(body['seed'], undefined, 'a repeated seed would repeat a drifted clip');
});

test('duration is clamped into the 2 to 10 second window, as an integer', async () => {
  for (const [asked, expected] of [
    [0.5, 2],
    [4.4, 4],
    [4.6, 5],
    [30, 10],
  ] as const) {
    const { fetch, calls } = transport(submitRoutes());
    await createRunwayProvider({ apiKey: 'k', fetch }).submit(clipRequest({ seconds: asked }));
    assert.equal(calls[0]!.body!['duration'], expected, `asked for ${asked}`);
  }
});

test('the output shape is the photograph’s, in Runway’s pixel-pair notation', async () => {
  for (const [image, expected] of [
    [jpegHeader(1024, 1024), '960:960'],
    [jpegHeader(1080, 1920), '720:1280'],
    [jpegHeader(1920, 1080), '1280:720'],
  ] as const) {
    const { fetch, calls } = transport(submitRoutes());
    await createRunwayProvider({ apiKey: 'k', fetch }).submit(clipRequest({ image }));
    assert.equal(calls[0]!.body!['ratio'], expected);
  }
});

test('an image too large to inline is refused before it is uploaded', async () => {
  const { fetch, calls } = transport(submitRoutes());
  const huge = new Uint8Array(4 * 1024 * 1024);
  huge.set(jpegHeader(1024, 1024));

  await assert.rejects(
    createRunwayProvider({ apiKey: 'k', fetch }).submit(clipRequest({ image: huge })),
    (error: VideoClipError) => {
      assert.match(error.message, /3\.7 MB/);
      assert.match(error.message, /Hedra/, 'the message should name the way out');
      return true;
    },
  );
  assert.equal(calls.length, 0, 'nothing should reach the network');
});

// ---------------------------------------------------------------------------
// The prompt budget
// ---------------------------------------------------------------------------

test('every real prompt fits Runway’s 1000-unit cap', () => {
  // Not hypothetical: prompt plus avoid runs 982-1164 across the library, so
  // without packing most of it would be rejected outright.
  for (const slot of CLIP_SLOT_NAMES) {
    const built = buildClipPrompt(slot);
    const text = promptFor({
      slot,
      image: new Uint8Array(),
      imageMimeType: 'image/jpeg',
      prompt: built.prompt,
      avoid: built.avoid,
      seconds: built.seconds,
    });
    assert.ok(text.length <= 1000, `${slot} produced ${text.length} units`);
    assert.ok(text.includes(built.prompt.trim()), `${slot} lost its actual instruction`);
  }
});

test('the negative list is packed by whole clauses, never cut mid-phrase', () => {
  const long = 'x'.repeat(940);
  const text = promptFor({
    slot: 'nod',
    image: new Uint8Array(),
    imageMimeType: 'image/jpeg',
    prompt: long,
    avoid: 'camera movement, extra limbs, distorted hands, watermark',
    seconds: 5,
  });

  assert.ok(text.length <= 1000);
  assert.ok(text.includes('camera movement'));
  // "extra limbs" would not fit, and a truncating implementation would leave
  // "extra" behind — which reads as a request for extras rather than a ban.
  assert.ok(!/extra$|extra l$|distorted h$/.test(text), text.slice(-40));
  assert.ok(text.endsWith('.'));
});

test('a prompt with no room at all for the negatives keeps the instruction', () => {
  const text = promptFor({
    slot: 'nod',
    image: new Uint8Array(),
    imageMimeType: 'image/jpeg',
    prompt: 'y'.repeat(998),
    avoid: 'camera movement',
    seconds: 5,
  });
  assert.equal(text, 'y'.repeat(998), 'a dangling "Avoid:" with nothing after it is worse');
});

// ---------------------------------------------------------------------------
// poll
// ---------------------------------------------------------------------------

test('the four non-terminal states map onto queued and running', async () => {
  for (const [status, expected, progress] of [
    ['PENDING', 'queued', null],
    ['THROTTLED', 'queued', null],
    ['RUNNING', 'running', 0.42],
  ] as const) {
    const { fetch } = transport([
      ['/v1/tasks/', () => ({ json: { id: job.id, status, progress: progress ?? undefined } })],
    ]);
    const state = await createRunwayProvider({ apiKey: 'k', fetch }).poll(job);
    assert.equal(state.status, expected, status);
    if (state.status === 'running' || state.status === 'queued') {
      assert.equal(state.progress, progress);
    }
  }
});

test('a succeeded task reports the charge in dollars, not credits', async () => {
  const { fetch } = transport([
    [
      '/v1/tasks/',
      () => ({
        json: {
          id: job.id,
          status: 'SUCCEEDED',
          output: ['https://cdn.runwayml.com/out.mp4'],
          cost: { credits: 25 },
        },
      }),
    ],
  ]);
  const state = await createRunwayProvider({ apiKey: 'k', fetch }).poll(job);

  assert.equal(state.status, 'succeeded');
  // 25 credits at a cent each. Nobody budgets in credits.
  assert.equal(state.status === 'succeeded' ? state.costUsd : null, 0.25);
  assert.equal(
    state.status === 'succeeded' ? state.seconds : 1,
    null,
    'Runway reports what was asked for, not what was rendered',
  );
});

test('a failed task carries Runway’s reason with context, and its code', async () => {
  const { fetch } = transport([
    [
      '/v1/tasks/',
      () => ({
        json: {
          id: job.id,
          status: 'FAILED',
          failure: 'The input image was rejected by content moderation.',
          failureCode: 'SAFETY.INPUT.IMAGE',
          cost: { credits: 0 },
        },
      }),
    ],
  ]);
  const state = await createRunwayProvider({ apiKey: 'k', fetch }).poll(job);

  assert.equal(state.status, 'failed');
  const reason = state.status === 'failed' ? state.reason : '';
  // Runway's spec says not to show `failure` raw. It is prefixed, not echoed.
  assert.match(reason, /Runway could not render this/);
  assert.match(reason, /content moderation/);
  assert.match(reason, /SAFETY\.INPUT\.IMAGE/);
  assert.equal(
    state.status === 'failed' ? state.retryable : true,
    false,
    'moderation refuses identically every time, and every attempt is billable',
  );
});

test('an internal failure is worth retrying; a rejection is not', async () => {
  const { fetch } = transport([
    [
      '/v1/tasks/',
      () => ({
        json: { id: job.id, status: 'FAILED', failure: 'boom', failureCode: 'INTERNAL.BAD_OUTPUT' },
      }),
    ],
  ]);
  const state = await createRunwayProvider({ apiKey: 'k', fetch }).poll(job);
  assert.equal(state.status === 'failed' ? state.retryable : false, true);
});

test('a task that succeeded with no output is a failure, not a crash later', async () => {
  const { fetch } = transport([
    ['/v1/tasks/', () => ({ json: { id: job.id, status: 'SUCCEEDED', output: [] } })],
  ]);
  assert.equal((await createRunwayProvider({ apiKey: 'k', fetch }).poll(job)).status, 'failed');
});

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

test('download re-reads the task, because output URLs expire in a day or two', async () => {
  let served = 0;
  const { fetch, calls } = transport([
    [
      '/v1/tasks/',
      () => {
        served += 1;
        return {
          json: {
            id: job.id,
            status: 'SUCCEEDED',
            output: [`https://cdn.runwayml.com/out.mp4?exp=${served}`],
          },
        };
      },
    ],
    ['cdn.runwayml.com', () => ({ json: {} })],
  ]);

  const bytes = await createRunwayProvider({ apiKey: 'k', fetch }).download(job, {
    status: 'succeeded',
    seconds: null,
    costUsd: 0.25,
  });

  assert.deepEqual(bytes, new Uint8Array([4, 2]));
  assert.ok(calls.at(-1)!.url.includes('exp=1'), 'a freshly-signed URL was used');
});

// ---------------------------------------------------------------------------
// validateKey
// ---------------------------------------------------------------------------

test('a funded account passes', async () => {
  const { fetch } = transport([['/v1/organization', () => ({ json: { creditBalance: 500 } })]]);
  assert.deepEqual(await createRunwayProvider({ apiKey: 'k', fetch }).validateKey(), { ok: true });
});

test('an account that cannot afford one clip fails, and says the price', async () => {
  const { fetch } = transport([['/v1/organization', () => ({ json: { creditBalance: 4 } })]]);
  const result = await createRunwayProvider({ apiKey: 'k', fetch }).validateKey();

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /4 credits/);
  assert.match(result.ok ? '' : result.reason, /costs 25/);
});

test('a rejected key says the key is wrong, not that the balance is', async () => {
  const { fetch } = transport([['/v1/organization', () => ({ status: 401, json: {} })]]);
  const result = await createRunwayProvider({ apiKey: 'nope', fetch }).validateKey();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /rejected that key/);
});

test('an unreachable service is not reported as a bad key', async () => {
  const fetch = (async () => {
    throw new TypeError('network error');
  }) as unknown as typeof globalThis.fetch;

  const result = await createRunwayProvider({ apiKey: 'k', fetch }).validateKey();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /reach Runway/);
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('the published rate gives a firm library price', () => {
  // 5 credits a second, a cent a credit, five-second clips: $0.25 each.
  assert.equal(USD_PER_CREDIT, 0.01);
  assert.equal(CREDITS_PER_SECOND, 5);
  assert.equal(RUNWAY_COST.usdPerClip, 0.25);
  assert.equal(RUNWAY_COST.basis, 'published');

  const estimate = estimateLibraryCost(RUNWAY_COST, CLIP_SLOT_NAMES.length);
  assert.equal(estimate.confident, true);
  assert.equal(estimate.low, 4.75);
  assert.equal(estimate.high, 4.75);
});
