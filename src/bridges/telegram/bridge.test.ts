import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Brain } from '../../core/session/brain.ts';
import { loadConfig } from '../../server/config.ts';
import { TelegramBridge } from './bridge.ts';
import type { TelegramClient, TelegramMessage, TelegramUpdate, UploadFile } from './api.ts';

/**
 * The allowlist is the only thing standing between one person's private life
 * and anyone who finds the bot, and a bot token is a bearer credential on a
 * public endpoint. It cannot be exercised over the real network, so the client
 * is faked and the routing is real.
 */
class FakeTelegram implements TelegramClient {
  readonly sent: Array<{ chatId: number; text: string }> = [];
  readonly photos: Array<{ chatId: number; name: string }> = [];
  readonly actions: number[] = [];
  downloads: Record<string, Buffer | null> = {};
  #queue: TelegramUpdate[][] = [];

  queue(updates: TelegramUpdate[]): void {
    this.#queue.push(updates);
  }

  async getUpdates(): Promise<TelegramUpdate[]> {
    return this.#queue.shift() ?? [];
  }

  async sendMessage(chatId: number, text: string): Promise<TelegramMessage | null> {
    this.sent.push({ chatId, text });
    return null;
  }

  async sendChatAction(chatId: number): Promise<void> {
    this.actions.push(chatId);
  }

  async sendPhoto(chatId: number, file: UploadFile): Promise<void> {
    this.photos.push({ chatId, name: file.name });
  }

  async sendVideo(chatId: number, file: UploadFile): Promise<void> {
    this.photos.push({ chatId, name: file.name });
  }

  async download(fileId: string): Promise<Buffer | null> {
    return this.downloads[fileId] ?? null;
  }
}

function textMessage(chatId: number, text: string, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false },
      text,
    },
  };
}

async function fixture(allowedChatIds: number[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'anna-telegram-'));
  const config = loadConfig({
    ANNA_PROFILE: path.join(root, 'profile'),
    ANNA_DATA: path.join(root, 'data'),
  } as NodeJS.ProcessEnv);

  const brain = await Brain.open(config, { offline: true });
  const api = new FakeTelegram();
  const bridge = new TelegramBridge({ brain, token: 'fake', allowedChatIds, api });
  return { brain, api, bridge };
}

/** Runs the poll loop for long enough to drain the queued updates. */
async function pump(bridge: TelegramBridge): Promise<void> {
  bridge.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  bridge.stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test('with an allowlist, only those chats are answered', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/whoami', 1), textMessage(999, '/whoami', 2)]);
  await pump(f.bridge);

  const chats = new Set(f.api.sent.map((message) => message.chatId));
  assert.ok(chats.has(100), 'the allowed chat was not answered');
  assert.ok(!chats.has(999), 'an unlisted chat was answered');
});

test('with no allowlist she pins to the first chat and ignores the rest', async () => {
  const f = await fixture([]);
  f.api.queue([textMessage(500, '/whoami', 1), textMessage(600, '/whoami', 2)]);
  await pump(f.bridge);

  const chats = f.api.sent.map((message) => message.chatId);
  assert.ok(chats.includes(500), 'the first chat should be answered');
  assert.ok(!chats.includes(600), 'a second chat must not inherit the first one’s access');
});

test('the pin survives across polls', async () => {
  const f = await fixture([]);
  f.api.queue([textMessage(500, '/whoami', 1)]);
  f.api.queue([textMessage(600, '/whoami', 2)]);
  await pump(f.bridge);

  assert.ok(!f.api.sent.some((message) => message.chatId === 600));
});

test('other bots are ignored', async () => {
  const f = await fixture([100]);
  const update = textMessage(100, '/whoami', 1);
  update.message!.from!.is_bot = true;
  f.api.queue([update]);
  await pump(f.bridge);

  assert.equal(f.api.sent.length, 0, 'a bot got a reply');
});

test('/whoami tells you the number to put in the allowlist', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/whoami', 1)]);
  await pump(f.bridge);
  assert.match(f.api.sent[0]?.text ?? '', /100/);
});

test('/help lists what she does, in her own name', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/help', 1)]);
  await pump(f.bridge);

  const text = f.api.sent[0]?.text ?? '';
  assert.match(text, /Anna/);
  assert.match(text, /\/call/);
  assert.match(text, /\/photo/);
});

test('a command addressed to the bot in a group still works', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/whoami@AnnaCompanionBot', 1)]);
  await pump(f.bridge);
  assert.match(f.api.sent[0]?.text ?? '', /100/);
});

test('/mood answers in words, never in numbers', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/mood', 1)]);
  await pump(f.bridge);

  const text = f.api.sent[0]?.text ?? '';
  assert.ok(text.length > 0);
  assert.ok(!/-?\d+\.\d+/.test(text), `the mood leaked a number: ${text}`);
});

test('/call without LiveKit says so rather than failing silently', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/call', 1)]);
  await pump(f.bridge);
  assert.match(f.api.sent[0]?.text ?? '', /LiveKit is not configured/);
});

test('an unknown command is answered rather than ignored', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/teleport', 1)]);
  await pump(f.bridge);
  assert.match(f.api.sent[0]?.text ?? '', /don't know/);
});

test('an unlisted chat gets nothing at all, not even an error', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(42, 'hello?', 1), textMessage(42, '/help', 2)]);
  await pump(f.bridge);

  assert.equal(f.api.sent.length, 0);
  assert.equal(f.api.actions.length, 0, 'even a typing indicator confirms the bot is live');
});
