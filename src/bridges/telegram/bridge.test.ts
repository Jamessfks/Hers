import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Brain } from '../../core/session/brain.ts';
import { loadConfig } from '../../server/config.ts';
import { TelegramBridge } from './bridge.ts';
import { Conversation } from '../../core/session/conversation.ts';
import type {
  BotCommand,
  TelegramClient,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
  UploadFile,
} from './api.ts';

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

/** A 400x400 PNG, which is what the studio validates rather than the claim. */
function pngBytes(width = 400, height = 400): Buffer {
  const header = Buffer.alloc(33);
  header.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

function photoMessage(
  chatId: number,
  sizes: TelegramPhotoSize[],
  options: { caption?: string; updateId?: number } = {},
): TelegramUpdate {
  const id = options.updateId ?? 1;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false },
      photo: sizes,
      ...(options.caption ? { caption: options.caption } : {}),
    },
  };
}

function size(width: number, height: number, fileId: string): TelegramPhotoSize {
  return { file_id: fileId, file_unique_id: fileId, width, height };
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

// -- the face ---------------------------------------------------------------

test('the command menu is published on startup', async () => {
  const f = await fixture([100]);
  await pump(f.bridge);
  const names = f.api.commands.map((command) => command.command);
  assert.ok(names.includes('face'), 'the whole point of a menu is that /face is in it');
  assert.ok(names.includes('render'));
  for (const command of f.api.commands) {
    assert.match(command.command, /^[a-z0-9_]{1,32}$/, `${command.command} is not a legal name`);
    assert.ok(command.description.length >= 1 && command.description.length <= 256);
  }
});

test('a photo captioned /face becomes her face', async () => {
  const f = await fixture([100]);
  f.api.downloads['big'] = pngBytes(512, 640);
  f.api.queue([
    photoMessage(100, [size(90, 90, 'small'), size(512, 640, 'big')], { caption: '/face' }),
  ]);
  await pump(f.bridge);

  assert.equal(f.brain.avatar.state().hasSource, true);
  assert.equal(f.brain.avatar.state().width, 512);
  assert.match(f.api.sent.map((m) => m.text).join(' '), /That's me now/);
});

test('/face then a photo becomes her face', async () => {
  const f = await fixture([100]);
  f.api.downloads['pic'] = pngBytes(400, 400);
  f.api.queue([textMessage(100, '/face', 1)]);
  f.api.queue([photoMessage(100, [size(400, 400, 'pic')], { updateId: 2 })]);
  await pump(f.bridge);

  assert.equal(f.brain.avatar.state().hasSource, true);
  assert.match(f.api.sent[0]?.text ?? '', /becomes my face/);
});

test('the largest rendition is used, whatever order they arrive in', async () => {
  const f = await fixture([100]);
  f.api.downloads['tiny'] = pngBytes(90, 90);
  f.api.downloads['huge'] = pngBytes(1280, 960);
  // Largest first — the Bot API documents no ordering, so this is legal.
  f.api.queue([
    photoMessage(100, [size(1280, 960, 'huge'), size(90, 90, 'tiny')], { caption: '/face' }),
  ]);
  await pump(f.bridge);

  assert.equal(f.brain.avatar.state().width, 1280, 'it took the thumbnail, not the photograph');
});

test('a photo with no /face is something she looks at, not her face', async () => {
  const f = await fixture([100]);
  f.api.downloads['pic'] = pngBytes(400, 400);
  f.api.queue([photoMessage(100, [size(400, 400, 'pic')])]);
  await pump(f.bridge);

  assert.equal(
    f.brain.avatar.state().hasSource,
    false,
    'sending her a picture must not silently replace her face',
  );
});

test('a picture that breaks the rules is refused, in words', async () => {
  const f = await fixture([100]);
  f.api.downloads['tiny'] = pngBytes(64, 64);
  f.api.queue([photoMessage(100, [size(64, 64, 'tiny')], { caption: '/face' })]);
  await pump(f.bridge);

  assert.match(f.api.sent.map((m) => m.text).join(' '), /256 pixels/);
  assert.equal(f.brain.avatar.state().hasSource, false);
});

test('replacing her face says what it cost', async () => {
  const f = await fixture([100]);
  f.api.downloads['a'] = pngBytes(400, 400);
  f.api.downloads['b'] = pngBytes(500, 500);
  f.api.queue([photoMessage(100, [size(400, 400, 'a')], { caption: '/face', updateId: 1 })]);
  await pump(f.bridge);
  f.api.sent.length = 0;

  f.api.queue([photoMessage(100, [size(500, 500, 'b')], { caption: '/face', updateId: 2 })]);
  await pump(f.bridge);
  assert.equal(f.brain.avatar.state().width, 500);
});

test('/me sends the photograph itself, not a generation', async () => {
  const f = await fixture([100]);
  f.api.downloads['pic'] = pngBytes(400, 400);
  f.api.queue([photoMessage(100, [size(400, 400, 'pic')], { caption: '/face', updateId: 1 })]);
  f.api.queue([textMessage(100, '/me', 2)]);
  await pump(f.bridge, 1200);

  assert.equal(f.api.photos.length, 1, 'it did not send a picture');
  assert.match(
    f.api.photos[0]?.name ?? '',
    /^source\./,
    `sent ${f.api.photos[0]?.name} instead of the source`,
  );
});

test('/me says so when there is no face yet', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/me', 1)]);
  await pump(f.bridge);
  assert.equal(f.api.photos.length, 0);
  assert.match(f.api.sent[0]?.text ?? '', /given me a face/);
});

test('/gestures asks for a face before offering to render one', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/gestures', 1)]);
  await pump(f.bridge);
  assert.match(f.api.sent[0]?.text ?? '', /Give me a face first/);
});

test('/render refuses a gesture that is not one', async () => {
  const f = await fixture([100]);
  f.api.queue([textMessage(100, '/render backflip', 1)]);
  await pump(f.bridge);
  assert.match(f.api.sent[0]?.text ?? '', /Which one\?/);
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
  assert.match(text, /\/call/);
  assert.match(text, /\/photo/);
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
