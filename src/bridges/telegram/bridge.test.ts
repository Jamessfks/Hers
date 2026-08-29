import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Brain } from '../../core/session/brain.ts';
import { loadConfig } from '../../server/config.ts';
import { TelegramBridge } from './bridge.ts';
import { Conversation } from '../../core/session/conversation.ts';
import type { BotCommand, TelegramClient, TelegramMessage, TelegramUpdate, UploadFile } from './api.ts';

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
  readonly voices: Array<{ chatId: number; bytes: number; seconds: number }> = [];
  commands: BotCommand[] = [];
  downloads: Record<string, Buffer | null> = {};
  #queue: TelegramUpdate[][] = [];

  queue(updates: TelegramUpdate[]): void {
    this.#queue.push(updates);
  }

  async getUpdates(): Promise<TelegramUpdate[]> {
    return this.#queue.shift() ?? [];
  }

  async setMyCommands(commands: BotCommand[]): Promise<void> {
    this.commands = commands;
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

  async sendVoice(chatId: number, file: UploadFile, seconds: number): Promise<void> {
    this.voices.push({ chatId, bytes: file.data.length, seconds });
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
  const root = await mkdtemp(path.join(tmpdir(), 'hers-telegram-'));
  const config = loadConfig({
    HERS_PROFILE: path.join(root, 'profile'),
    HERS_DATA: path.join(root, 'data'),
  } as NodeJS.ProcessEnv);

  const brain = await Brain.open(config, { offline: true });
  const api = new FakeTelegram();
  const conversation = new Conversation({ brain });
  const bridge = new TelegramBridge({ brain, conversation, token: 'fake', allowedChatIds, api });
  return { brain, api, bridge, conversation };
}

/**
 * Runs the poll loop long enough to drain every queued batch.
 *
 * The bridge sleeps 200ms between polls that returned updates, so a window
 * shorter than that consumes exactly one batch. An earlier version waited
 * 120ms, which made any test queuing two batches silently only ever see the
 * first — including one asserting that a *second* chat gets ignored, which
 * therefore passed without the second chat ever being polled for.
 */
async function pump(bridge: TelegramBridge, ms = 700): Promise<void> {
  bridge.start();
  await new Promise((resolve) => setTimeout(resolve, ms));
  bridge.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('the command menu is published on startup', async () => {
  const f = await fixture([100]);
  await pump(f.bridge);
  const names = f.api.commands.map((command) => command.command);
  assert.ok(names.includes('mood'));
  assert.ok(names.includes('bye'));
  assert.ok(names.includes('whoami'));
  assert.ok(names.includes('help'));
  for (const command of f.api.commands) {
    assert.match(command.command, /^[a-z0-9_]{1,32}$/, `${command.command} is not a legal name`);
    assert.ok(command.description.length >= 1 && command.description.length <= 256);
  }
});

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
  assert.match(text, /\/mood/);
});

test('a command addressed to the bot in a group still works', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/whoami@HersCompanionBot', 1)]);
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

test('the first chat to speak is reported, once, so setup can finish itself', async () => {
  /*
   * The only moment a bot can learn its owner's chat id: nothing in the Bot API
   * reveals one, so an update arriving is the whole mechanism. The bridge holds
   * the single `getUpdates` loop, which is why it reports rather than anyone else
   * polling — a second poller would be handed the updates and terminate this one.
   */
  const f = await fixture([]);
  const seen: number[] = [];
  const bridge = new TelegramBridge({
    brain: f.brain,
    conversation: f.conversation,
    token: 'test',
    allowedChatIds: [],
    api: f.api,
    onChatPinned: (chatId) => seen.push(chatId),
  });

  f.api.queue([textMessage(4242, 'hey', 1), textMessage(4242, 'still me', 2)]);
  await pump(bridge);
  assert.deepEqual(seen, [4242], 'reported on the first message and not again on the second');

  // A different chat afterwards is not a second candidate.
  f.api.queue([textMessage(9999, 'let me in', 3)]);
  await pump(bridge);
  assert.deepEqual(seen, [4242]);
});

test('a bridge with an allowlist never reports a chat', async () => {
  // The question has already been answered. Reporting here would let a stranger
  // messaging the bot overwrite the answer.
  const f = await fixture([100]);
  const seen: number[] = [];
  const bridge = new TelegramBridge({
    brain: f.brain,
    conversation: f.conversation,
    token: 'test',
    allowedChatIds: [100],
    api: f.api,
    onChatPinned: (chatId) => seen.push(chatId),
  });

  f.api.queue([textMessage(4242, 'hello?', 1), textMessage(100, 'hi', 2)]);
  await pump(bridge);
  assert.deepEqual(seen, []);
});

test('the commands she offers are the ones that still exist', async () => {
  const f = await fixture([100]);
  await pump(f.bridge);
  const names = f.api.commands.map((command) => command.command);
  for (const gone of ['me', 'photo', 'face', 'call']) {
    assert.ok(!names.includes(gone), `/${gone} was removed in v2.0`);
  }
});

/**
 * The v1 gate, asserted gone.
 *
 * It read `text.length <= 320 && (theySpoke || Math.random() < 0.25)`, so a
 * long answer was always text and a short one was text three times in four.
 * Reading the source is a blunt way to check a deletion, and it is the right
 * one here: the behaviour it guards is a branch that no longer exists, so
 * there is nothing left to drive a test through.
 */
test('nothing decides whether she speaks on a coin toss any more', () => {
  const source = readFileSync(new URL('./bridge.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Math\.random/);
  assert.doesNotMatch(source, /text\.length <= 320/);
  // The transcript that used to trail every voice note is gone too.
  assert.equal(source.split('sendMessage(chatId, text)').length - 1, 1);
});
