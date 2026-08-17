import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Brain } from './brain.ts';
import { Conversation } from './conversation.ts';
import type { Origin, Surface, SurfaceName } from './conversation.ts';
import { loadConfig } from '../../server/config.ts';
import type { LiveConnector, LiveSocket } from '../gemini/live.ts';
import type { LiveServerMessage } from '@google/genai';

class FakeSocket implements LiveSocket {
  readonly content: { turns?: unknown; turnComplete?: boolean }[] = [];
  emit: (message: LiveServerMessage) => void = () => undefined;
  sendRealtimeInput(): void {}
  sendClientContent(params: { turns?: unknown; turnComplete?: boolean }): void {
    this.content.push(params);
  }
  sendToolResponse(): void {}
  close(): void {}
}

/** A surface that writes down what it was handed and who it was for. */
function recorder(name: SurfaceName) {
  const heard: { text: string; origin: Origin }[] = [];
  const surface: Surface = {
    name,
    transcript: (who, text, final, origin) => {
      if (who === 'anna' && final) heard.push({ text, origin });
    },
  };
  return { surface, heard };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'anna-conv-'));
  const brain = await Brain.open(
    loadConfig({
      GEMINI_API_KEY: 'test-key',
      ANNA_PROFILE: path.join(root, 'profile'),
      ANNA_DATA: path.join(root, 'data'),
    } as NodeJS.ProcessEnv),
    { offline: true },
  );

  const sockets: FakeSocket[] = [];
  const connect: LiveConnector = async ({ callbacks }) => {
    const socket = new FakeSocket();
    socket.emit = (message) => callbacks.onmessage(message);
    sockets.push(socket);
    return socket;
  };

  const conversation = new Conversation({ brain, connect });
  return { brain, conversation, sockets, socket: () => sockets.at(-1)! };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const settled = () => new Promise((resolve) => setTimeout(resolve, 500));

/** Puts words in her mouth and closes the turn, the way the API would. */
function annaSays(socket: FakeSocket, text: string): void {
  socket.emit({
    serverContent: { outputTranscription: { text }, turnComplete: true },
  } as unknown as LiveServerMessage);
}

// ---------------------------------------------------------------------------

test('two surfaces share one session, so there is one API call', async () => {
  const f = await fixture();
  const web = recorder('web');
  const telegram = recorder('telegram');
  f.conversation.attach(web.surface);
  f.conversation.attach(telegram.surface);

  // Both arrive at once, the way a browser opening while the bot is running does.
  await Promise.all([f.conversation.wake(), f.conversation.wake()]);

  assert.equal(f.sockets.length, 1, 'two surfaces must not mean two Gemini sessions');
  assert.deepEqual(f.conversation.attached.sort(), ['telegram', 'web']);
});

test('an opener reaches every surface, because she started it', async () => {
  /*
   * The requirement, stated plainly: when she talks first it should reach both
   * platforms rather than one having a conversation the other never sees. An
   * opener has no origin, so nobody is excluded.
   */
  const f = await fixture();
  const web = recorder('web');
  const telegram = recorder('telegram');
  f.conversation.attach(web.surface);
  f.conversation.attach(telegram.surface);
  await f.conversation.wake();

  annaSays(f.socket(), 'Hey. You have gone quiet on me.');
  await settled();

  assert.deepEqual(web.heard.map((h) => h.text), ['Hey. You have gone quiet on me.']);
  assert.deepEqual(telegram.heard.map((h) => h.text), ['Hey. You have gone quiet on me.']);
  assert.equal(web.heard[0]?.origin, null, 'no origin is what makes it everyone’s');
  assert.equal(telegram.heard[0]?.origin, null);
});

test('a reply carries the origin of the thing it answers', async () => {
  const f = await fixture();
  const web = recorder('web');
  const telegram = recorder('telegram');
  f.conversation.attach(web.surface);
  f.conversation.attach(telegram.surface);
  await f.conversation.wake();

  f.conversation.say('hey', 'telegram');
  annaSays(f.socket(), 'Hey yourself.');
  await settled();

  // Both are handed it — the browser is the view onto everything — but each is
  // told who it was for, which is how Telegram decides whether to deliver it.
  assert.equal(web.heard.at(-1)?.origin, 'telegram');
  assert.equal(telegram.heard.at(-1)?.origin, 'telegram');
});

test('the origin is cleared on the turn boundary, not on each sentence', async () => {
  /*
   * A turn can hold several utterances. Clearing after the first would leave the
   * second with no origin, which fans it out — and on a phone that is a buzz for
   * a conversation happening at somebody's desk.
   */
  const f = await fixture();
  const web = recorder('web');
  f.conversation.attach(web.surface);
  await f.conversation.wake();

  f.conversation.say('hey', 'web');
  f.socket().emit({
    serverContent: { outputTranscription: { text: 'First thing.' }, generationComplete: true },
  } as unknown as LiveServerMessage);
  await settled();
  f.socket().emit({
    serverContent: { outputTranscription: { text: 'Second thing.' }, generationComplete: true },
  } as unknown as LiveServerMessage);
  await settled();

  assert.deepEqual(
    web.heard.map((h) => h.origin),
    ['web', 'web'],
    'both halves of one answer belong to whoever asked',
  );
});

test('what the website switched on is what she has on Telegram too', async () => {
  const f = await fixture();
  await f.conversation.wake();

  f.conversation.setSense('screen', true);
  assert.equal(f.conversation.situation?.senses.screen, true, 'one situation, one Anna');
});

test('a surface leaving does not end a conversation somebody else is in', async () => {
  const f = await fixture();
  const web = recorder('web');
  const telegram = recorder('telegram');
  f.conversation.attach(web.surface);
  f.conversation.attach(telegram.surface);
  await f.conversation.wake();
  assert.ok(f.conversation.live);

  f.conversation.detach('web');
  assert.deepEqual(f.conversation.attached, ['telegram']);
  assert.ok(f.conversation.live, 'she is still reachable, so she is still awake');
});

test('a surface that throws does not silence the others', async () => {
  const f = await fixture();
  const telegram = recorder('telegram');
  f.conversation.attach({
    name: 'web',
    transcript: () => {
      throw new Error('this socket closed a moment ago');
    },
  });
  f.conversation.attach(telegram.surface);
  await f.conversation.wake();

  annaSays(f.socket(), 'Still here.');
  await settled();

  assert.deepEqual(telegram.heard.map((h) => h.text), ['Still here.']);
});

test('waking twice in a row is one session, not two', async () => {
  const f = await fixture();
  await f.conversation.wake();
  await f.conversation.wake();
  await settle();
  assert.equal(f.sockets.length, 1);
});

test('sleeping ends it, and the next word starts a fresh one', async () => {
  const f = await fixture();
  const web = recorder('web');
  f.conversation.attach(web.surface);
  await f.conversation.wake();
  await f.conversation.sleep();
  assert.equal(f.conversation.live, null);

  await f.conversation.wake();
  assert.equal(f.sockets.length, 2, 'a new conversation is a new session');
  assert.ok(f.conversation.live);
});
