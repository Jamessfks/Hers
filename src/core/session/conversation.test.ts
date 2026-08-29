import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Brain } from './brain.ts';
import { Conversation } from './conversation.ts';
import type { Origin, Surface, SurfaceName } from './conversation.ts';
import { loadConfig } from '../../server/config.ts';
import { writeRhythm } from '../profile/profile.ts';
import { DEFAULT_RHYTHM } from '../sleep/rhythm.ts';
import type { LiveConnector, LiveSocket } from '../gemini/live.ts';
import type { LiveServerMessage } from '@google/genai';

class FakeSocket implements LiveSocket {
  readonly content: { turns?: unknown; turnComplete?: boolean }[] = [];
  /**
   * Recorded rather than discarded, since v2.0.1.
   *
   * This method used to be an empty body, and that is the whole reason a
   * release shipped in which she could not hear: the only thing that proves
   * microphone audio left the machine is that this was called, and nothing
   * asked. It records now, and three tests below ask.
   */
  readonly realtime: Record<string, unknown>[] = [];
  emit: (message: LiveServerMessage) => void = () => undefined;
  sendRealtimeInput(params: Record<string, unknown>): void {
    this.realtime.push(params);
  }
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
      if (who === 'her' && final) heard.push({ text, origin });
    },
  };
  return { surface, heard };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hers-conv-'));
  // Every test in this file is about routing between surfaces for a companion
  // who already exists. `rhythm.md` is what `isFirstRun` reads, so writing it
  // is how the fixture says "setup already happened" — without it, the first
  // `wake()` opens the interview instead of the session.
  await writeRhythm(path.join(root, 'profile'), DEFAULT_RHYTHM);
  const brain = await Brain.open(
    loadConfig({
      GEMINI_API_KEY: 'test-key',
      HERS_PROFILE: path.join(root, 'profile'),
      HERS_DATA: path.join(root, 'data'),
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
function sheSays(socket: FakeSocket, text: string): void {
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

  sheSays(f.socket(), 'Hey. You have gone quiet on me.');
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
  sheSays(f.socket(), 'Hey yourself.');
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

/*
 * The screen is switched on by a frame arriving, not by anybody asking.
 *
 * This used to press `Conversation.setSense`, which was the last caller it had
 * — the browser has had no sense switches since v2.0 and the screen share
 * announces itself in `Companion.see`. Testing through the frame is testing the
 * path that exists.
 */
test('one situation and one of her, whichever surface shows her a screen', async () => {
  const f = await fixture();
  await f.conversation.wake();
  assert.equal(f.conversation.situation?.senses.screen, false);

  f.conversation.see(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'screen', 'web');

  assert.equal(f.conversation.situation?.senses.screen, true, 'one situation, one of her');
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

  sheSays(f.socket(), 'Still here.');
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

// ---------------------------------------------------------------------------
// The senses, through the path production actually uses
// ---------------------------------------------------------------------------

/*
 * These three exist because v2.0.0 shipped unable to hear.
 *
 * `Conversation.#ensure` built a `Companion` with no `senses`, `Situation`
 * defaulted all three to false, and `Companion.hear` and `Companion.see` both
 * return early on that flag — so every microphone frame and every camera frame
 * was dropped, on every install, for the whole release.
 *
 * Nothing caught it. `companion.test.ts` constructs `Companion` directly and
 * hands it `senses: { hearing: true }`, so the suite proved the class worked
 * and never asked what the application did. The test above at "what the website
 * switched on" proves `setSense` plumbs through and likewise never asks what
 * the default is.
 *
 * So the rule these encode is narrower than "senses work": **the object
 * production builds, waking the way production wakes it, can hear.** They go
 * through `Conversation` for that reason and must not be rewritten to construct
 * a `Companion`.
 */

test('a wake through the conversation leaves her able to hear', async () => {
  const f = await fixture();
  await f.conversation.wake();

  f.conversation.hear(Buffer.from([1, 2, 3, 4]), 'web');

  const audio = f.socket().realtime.filter((frame) => 'audio' in frame);
  assert.equal(audio.length, 1, 'microphone audio never reached the session');
});

test('camera frames reach the session without anybody switching a sense on', async () => {
  const f = await fixture();
  await f.conversation.wake();

  f.conversation.see(Buffer.from([0xff, 0xd8, 0xff]), 'camera', 'web');

  const video = f.socket().realtime.filter((frame) => 'video' in frame);
  assert.equal(video.length, 1, 'a camera frame never reached the session');
});

test('sleeping takes the senses down with her', async () => {
  const f = await fixture();
  await f.conversation.wake();
  assert.equal(f.conversation.situation?.senses.hearing, true);

  await f.conversation.sleep();

  // Asleep means nothing at all, not a quieter mode. A microphone still open
  // while she is asleep is the camera-light problem in another form.
  assert.equal(f.conversation.situation, null, 'the companion goes with her');
});
