/**
 * Provider adapter tests, against mocked vendor responses.
 *
 * Every one of these uses an injected `fetch` rather than the network. That is
 * the only way to test the half of each adapter that matters: the failure
 * shapes. No live account will produce a 429 on demand, or a malformed frame,
 * or the specific 401 body a vendor emits — and those paths are exactly where
 * a companion goes silently wrong.
 *
 * The recorded payloads below are the real response shapes, trimmed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAnthropicProvider } from './anthropic.ts';
import { createGoogleProvider } from './google.ts';
import { createOpenAiProvider } from './openai.ts';
import type { FetchLike } from './types.ts';

// ---------------------------------------------------------------------------
// Mock plumbing
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers from a routing table and records every call. */
function mockFetch(routes: Array<{ match: RegExp; reply: () => Response }>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    const route = routes.find((entry) => entry.match.test(url));
    if (!route) throw new Error(`no mock route for ${url}`);
    return route.reply();
  }) as FetchLike;

  return { fetch, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Builds an SSE body from a list of `event`/`data` pairs. */
function sse(frames: Array<{ event?: string; data: string }>): Response {
  const text = frames
    .map((frame) => `${frame.event ? `event: ${frame.event}\n` : ''}data: ${frame.data}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

const TURN = { system: 'be anna', messages: [{ role: 'user' as const, content: 'hi' }] };

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

test('anthropic: streams text deltas and keeps the system prompt out of messages', async () => {
  const { fetch, calls } = mockFetch([
    {
      match: /v1\/messages/,
      reply: () =>
        sse([
          { event: 'message_start', data: '{"type":"message_start"}' },
          {
            event: 'content_block_delta',
            data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hey. "}}',
          },
          {
            event: 'content_block_delta',
            data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"You ok?"}}',
          },
          { event: 'message_stop', data: '{"type":"message_stop"}' },
        ]),
    },
  ]);

  const provider = createAnthropicProvider('sk-ant-test', { fetch });
  assert.equal(await collect(provider.stream({ ...TURN, model: 'claude-sonnet-5' })), 'Hey. You ok?');

  const call = calls[0]!;
  assert.equal(call.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  const body = call.body as { system?: Array<{ text: string }>; messages?: unknown[] };
  assert.equal(body.system?.[0]?.text, 'be anna', 'system is a top-level field, not a message');
  assert.equal(body.messages?.length, 1, 'and it must not be duplicated into the turn list');
});

test('anthropic: a mid-stream error event throws rather than ending silently', async () => {
  // The dangerous shape: HTTP 200 is already sent, so a status check passes and
  // the reply is simply empty. Anna would stand there saying nothing.
  const { fetch } = mockFetch([
    {
      match: /v1\/messages/,
      reply: () =>
        sse([
          { event: 'error', data: '{"type":"error","error":{"message":"overloaded_error"}}' },
        ]),
    },
  ]);
  const provider = createAnthropicProvider('sk-ant-test', { fetch });
  await assert.rejects(
    () => collect(provider.stream({ ...TURN, model: 'claude-sonnet-5' })),
    /overloaded_error/,
  );
});

test('anthropic: validateKey uses a free GET, not a billed completion', async () => {
  const { fetch, calls } = mockFetch([{ match: /v1\/models/, reply: () => json({ data: [] }) }]);
  assert.deepEqual(await createAnthropicProvider('sk-ant-test', { fetch }).validateKey(), {
    ok: true,
  });
  assert.equal(calls[0]?.method, 'GET');
  assert.match(calls[0]!.url, /v1\/models/);
});

test('anthropic: a rejected key explains itself in plain language', async () => {
  const { fetch } = mockFetch([
    {
      match: /v1\/models/,
      reply: () => json({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401),
    },
  ]);
  const result = await createAnthropicProvider('nope', { fetch }).validateKey();
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /rejected/i);
});

test('anthropic: listModels prefers display names and drops non-chat models', async () => {
  const { fetch } = mockFetch([
    {
      match: /v1\/models/,
      reply: () =>
        json({
          data: [
            { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
            { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
            { id: 'text-embedding-v1', display_name: 'Embeddings' },
          ],
        }),
    },
  ]);
  const models = await createAnthropicProvider('sk-ant-test', { fetch }).listModels();
  assert.deepEqual(
    models.map((model) => model.id),
    ['claude-sonnet-5', 'claude-opus-5'],
    'catalogue order first, embeddings dropped',
  );
  assert.equal(models[0]?.label, 'Claude Sonnet 5');
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

test('openai: the [DONE] sentinel ends the stream instead of throwing', async () => {
  // `data: [DONE]` is not JSON. A parser that calls JSON.parse unconditionally
  // throws on the final frame of every *successful* request.
  const { fetch, calls } = mockFetch([
    {
      match: /chat\/completions/,
      reply: () =>
        sse([
          { data: '{"choices":[{"delta":{"content":"Hey."}}]}' },
          { data: '{"choices":[{"delta":{"content":" You ok?"}}]}' },
          { data: '[DONE]' },
        ]),
    },
  ]);

  const provider = createOpenAiProvider('sk-test', { fetch });
  assert.equal(await collect(provider.stream({ ...TURN, model: 'gpt-4.1' })), 'Hey. You ok?');

  const body = calls[0]!.body as { messages: Array<{ role: string; content: string }> };
  assert.equal(body.messages[0]?.role, 'system', 'system is an ordinary message here');
  assert.equal(body.messages[0]?.content, 'be anna');
});

test('openai: an empty delta is not treated as end of stream', async () => {
  const { fetch } = mockFetch([
    {
      match: /chat\/completions/,
      reply: () =>
        sse([
          { data: '{"choices":[{"delta":{"content":""}}]}' },
          { data: '{"choices":[{"delta":{"content":"still here"}}]}' },
          { data: '[DONE]' },
        ]),
    },
  ]);
  const provider = createOpenAiProvider('sk-test', { fetch });
  assert.equal(await collect(provider.stream({ ...TURN, model: 'gpt-4.1' })), 'still here');
});

test('openai: listModels strips the non-chat half of the catalogue', async () => {
  const { fetch } = mockFetch([
    {
      match: /\/models/,
      reply: () =>
        json({
          data: [
            { id: 'text-embedding-3-small' },
            { id: 'dall-e-3' },
            { id: 'whisper-1' },
            { id: 'gpt-4o' },
            { id: 'gpt-4.1' },
            { id: 'babbage-002' },
          ],
        }),
    },
  ]);
  const models = await createOpenAiProvider('sk-test', { fetch }).listModels();
  assert.deepEqual(models.map((model) => model.id), ['gpt-4.1', 'gpt-4o']);
});

test('openai: baseUrl override points at a compatible gateway', async () => {
  const { fetch, calls } = mockFetch([{ match: /.*/, reply: () => json({ data: [] }) }]);
  await createOpenAiProvider('sk-test', { fetch, baseUrl: 'https://gateway.local/v1/' }).validateKey();
  assert.equal(calls[0]?.url, 'https://gateway.local/v1/models', 'trailing slash normalised');
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

test('google: streams parts and spells the assistant role "model"', async () => {
  const { fetch, calls } = mockFetch([
    {
      match: /streamGenerateContent/,
      reply: () =>
        sse([
          { data: '{"candidates":[{"content":{"parts":[{"text":"Hey. "}]}}]}' },
          { data: '{"candidates":[{"content":{"parts":[{"text":"You ok?"}]}}]}' },
        ]),
    },
  ]);

  const provider = createGoogleProvider('AIza-test', { fetch });
  const text = await collect(
    provider.stream({
      system: 'be anna',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hey' },
        { role: 'user', content: 'ok?' },
      ],
      model: 'gemini-2.5-flash',
    }),
  );
  assert.equal(text, 'Hey. You ok?');

  const body = calls[0]!.body as {
    contents: Array<{ role: string }>;
    systemInstruction: { parts: Array<{ text: string }> };
  };
  assert.deepEqual(body.contents.map((entry) => entry.role), ['user', 'model', 'user']);
  assert.equal(body.systemInstruction.parts[0]?.text, 'be anna');
  assert.match(calls[0]!.url, /alt=sse/, 'without alt=sse the whole reply lands at once');
});

test('google: a safety block is surfaced instead of looking like an empty reply', async () => {
  const { fetch } = mockFetch([
    {
      match: /streamGenerateContent/,
      reply: () => sse([{ data: '{"promptFeedback":{"blockReason":"SAFETY"}}' }]),
    },
  ]);
  const provider = createGoogleProvider('AIza-test', { fetch });
  await assert.rejects(
    () => collect(provider.stream({ ...TURN, model: 'gemini-2.5-flash' })),
    /SAFETY/,
  );
});

test('google: a 200 with no candidates is an error, not silence', async () => {
  const { fetch } = mockFetch([
    { match: /streamGenerateContent/, reply: () => sse([{ data: '{"candidates":[]}' }]) },
  ]);
  const provider = createGoogleProvider('AIza-test', { fetch });
  await assert.rejects(
    () => collect(provider.stream({ ...TURN, model: 'gemini-2.5-flash' })),
    /empty/i,
  );
});

test('google: listModels strips the models/ prefix and filters by capability', async () => {
  const { fetch } = mockFetch([
    {
      match: /models\?pageSize/,
      reply: () =>
        json({
          models: [
            {
              name: 'models/gemini-2.5-flash',
              displayName: 'Gemini 2.5 Flash',
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
            {
              name: 'models/text-embedding-004',
              displayName: 'Embedding 004',
              supportedGenerationMethods: ['embedContent'],
            },
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
    },
  ]);
  const models = await createGoogleProvider('AIza-test', { fetch }).listModels();
  assert.deepEqual(models.map((model) => model.id), ['gemini-2.5-flash', 'gemini-2.5-pro']);
  assert.equal(models[0]?.label, 'Gemini 2.5 Flash');
});

// ---------------------------------------------------------------------------
// Shared contract
// ---------------------------------------------------------------------------

test('every provider degrades to an empty list rather than throwing', async () => {
  const dead: FetchLike = (async () => {
    throw new TypeError('fetch failed');
  }) as FetchLike;

  for (const provider of [
    createAnthropicProvider('k', { fetch: dead }),
    createOpenAiProvider('k', { fetch: dead }),
    createGoogleProvider('k', { fetch: dead }),
  ]) {
    assert.deepEqual(await provider.listModels(), [], `${provider.id} should degrade quietly`);
  }
});

test('every provider reports rate limiting as retryable and says so plainly', async () => {
  for (const [make, route] of [
    [createAnthropicProvider, /v1\/models/],
    [createOpenAiProvider, /\/models/],
    [createGoogleProvider, /models/],
  ] as const) {
    const { fetch } = mockFetch([{ match: route, reply: () => json({ error: {} }, 429) }]);
    const result = await make('k', { fetch }).validateKey();
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.reason : '',
      /rate limit|limited|credit/i,
      'a 429 should not read as a bad key',
    );
  }
});

test('a network failure during validation is reported, not swallowed', async () => {
  const dead: FetchLike = (async () => {
    throw new TypeError('fetch failed');
  }) as FetchLike;
  // validateKey deliberately does not catch: the settings window needs to tell
  // "your key is wrong" apart from "you are offline", and it does that by
  // catching the throw itself.
  await assert.rejects(() => createOpenAiProvider('k', { fetch: dead }).validateKey());
});

test('anthropic caches the system prompt, which is identical every turn', async () => {
  // The persona is ~4kB and unchanged between turns. Re-reading it is most of
  // the measured time-to-first-token, and it is billed at full rate.
  const { fetch, calls } = mockFetch([
    { match: /v1\/messages/, reply: () => sse([{ data: '{"type":"message_stop"}' }]) },
  ]);
  const provider = createAnthropicProvider('sk-ant-test', { fetch });
  await collect(provider.stream({ ...TURN, model: 'claude-haiku-4-5-20251001' }));

  const body = calls[0]!.body as {
    system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    messages: unknown[];
  };
  assert.equal(body.system[0]?.type, 'text');
  assert.equal(body.system[0]?.text, 'be anna');
  assert.deepEqual(body.system[0]?.cache_control, { type: 'ephemeral' });
});
