/**
 * The Telegram half of setup, against a stubbed `fetch`.
 *
 * Everything here is checkable without a network because the Bot API is plain
 * HTTP with a documented envelope: every method is `bot<token>/METHOD`, and every
 * reply is `{ ok, result?, description? }`.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { applyBotToken, botLink, checkBotToken, rememberChatId } from './setup.ts';

/** Replaces `fetch` for one call and returns what URL it was given. */
function stubFetch(reply: unknown, status = 200): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

test('a working token comes back with the bot behind it', async () => {
  const stub = stubFetch({
    ok: true,
    result: { id: 1, is_bot: true, first_name: 'Hers', username: 'hers_test_bot' },
  });
  try {
    const check = await checkBotToken('  123:ABC  ');
    assert.deepEqual(check, { ok: true, username: 'hers_test_bot', name: 'Hers' });

    // `getMe` is the documented no-parameter method, under bot<token>/.
    assert.match(stub.calls[0] ?? '', /^https:\/\/api\.telegram\.org\/bot123%3AABC\/getMe$/);
  } finally {
    stub.restore();
  }
});

test("Telegram's own words are what the user is shown", async () => {
  // What a wrong token actually gets. "Unauthorized" does not explain itself, so
  // the reason says what it means about the string they just pasted.
  const stub = stubFetch({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
  try {
    const check = await checkBotToken('123:nope');
    assert.equal(check.ok, false);
    assert.match(check.reason ?? '', /Telegram says: Unauthorized/);
    assert.match(check.reason ?? '', /token is wrong/);
  } finally {
    stub.restore();
  }
});

test('a user token is refused even though the call succeeds', async () => {
  // `getMe` answers happily for a token that is not a bot's. The docs put
  // `is_bot` on the User for exactly this reason.
  const stub = stubFetch({ ok: true, result: { id: 2, is_bot: false, first_name: 'A Person' } });
  try {
    const check = await checkBotToken('123:person');
    assert.equal(check.ok, false);
    assert.match(check.reason ?? '', /belongs to a person, not a bot/);
  } finally {
    stub.restore();
  }
});

test('an empty token never reaches the network', async () => {
  const stub = stubFetch({ ok: true });
  try {
    assert.deepEqual(await checkBotToken('   '), { ok: false, reason: 'No token.' });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('the deep link is the documented form', () => {
  // `https://t.me/<bot_username>?start=<payload>`, payload within A-Z a-z 0-9 _ -
  // and at most 64 characters.
  const link = botLink('hers_test_bot');
  assert.equal(link, 'https://t.me/hers_test_bot?start=hers');

  const payload = new URL(link).searchParams.get('start') ?? '';
  assert.match(payload, /^[A-Za-z0-9_-]{1,64}$/);
});

test('a saved token reaches the file, the environment and the config together', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hers-bot-'));
  const file = path.join(dir, '.env');
  const before = process.env.TELEGRAM_BOT_TOKEN;
  const beforeKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'k';
    const config = await applyBotToken('  987:XYZ  ', file);

    assert.match(await readFile(file, 'utf8'), /^TELEGRAM_BOT_TOKEN=987:XYZ$/m, 'trimmed, and on disk');
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, '987:XYZ', 'and in the environment');
    assert.equal(config.telegram?.token, '987:XYZ', 'and in the config the server reads');
  } finally {
    if (before === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = before;
    if (beforeKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = beforeKey;
  }
});

test('the chat that spoke is written down as the only one allowed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hers-bot-'));
  const file = path.join(dir, '.env');
  const before = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  const beforeToken = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = '987:XYZ';
    const config = await rememberChatId(8836261192, file);

    assert.match(await readFile(file, 'utf8'), /^TELEGRAM_ALLOWED_CHAT_IDS=8836261192$/m);
    assert.deepEqual(config.telegram?.allowedChatIds, [8836261192]);
    assert.equal(
      config.warnings.some((w) => /TELEGRAM_ALLOWED_CHAT_IDS is not set/.test(w)),
      false,
      'and the warning about an open bot is gone, because it no longer applies',
    );
  } finally {
    if (before === undefined) delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    else process.env.TELEGRAM_ALLOWED_CHAT_IDS = before;
    if (beforeToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = beforeToken;
  }
});
