import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Companion } from './companion.ts';
import { Brain } from './brain.ts';
import { loadConfig } from '../../server/config.ts';
import type { LiveConnector, LiveSocket } from '../gemini/live.ts';
import type { LiveServerMessage } from '@google/genai';
import type { GalleryItem } from '../gallery/gallery.ts';
import type { ConnectionState, MoodReadout } from '../../shared/protocol.ts';

/**
 * A whole Anna, with the socket faked and nothing else.
 *
 * This is the test that answers "does the thing work", as opposed to "does the
 * part work" — memory, mood, the prompt, the tools and the live session all run
 * for real, and only the network is a stand-in.
 */
class FakeSocket implements LiveSocket {
  readonly realtime: Record<string, unknown>[] = [];
  readonly content: { turns?: unknown; turnComplete?: boolean }[] = [];
  readonly tools: unknown[] = [];
  emit: (message: LiveServerMessage) => void = () => undefined;

  sendRealtimeInput(params: Record<string, unknown>): void {
    this.realtime.push(params);
  }
  sendClientContent(params: { turns?: unknown; turnComplete?: boolean }): void {
    this.content.push(params);
  }
  sendToolResponse(params: { functionResponses: unknown }): void {
    this.tools.push(params.functionResponses);
  }
  close(): void {}
}

async function fixture(env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'anna-companion-'));
  const config = loadConfig({
    GEMINI_API_KEY: 'test-key',
    ANNA_PROFILE: path.join(root, 'profile'),
    ANNA_DATA: path.join(root, 'data'),
    ...env,
  } as NodeJS.ProcessEnv);

  const brain = await Brain.open(config, { offline: true });

  const sockets: FakeSocket[] = [];
  const systemInstructions: string[] = [];
  const connect: LiveConnector = async ({ config: liveConfig, callbacks }) => {
    systemInstructions.push(String(liveConfig.systemInstruction ?? ''));
    const socket = new FakeSocket();
    socket.emit = (message) => callbacks.onmessage(message);
    sockets.push(socket);
    return socket;
  };

  const audio: Buffer[] = [];
  const transcript: { who: string; text: string; final: boolean }[] = [];
  const states: ConnectionState[] = [];
  const moods: MoodReadout[] = [];
  const shown: GalleryItem[] = [];
  const troubles: string[] = [];

  const companion = new Companion({
    brain,
    channel: 'desktop',
    senses: { hearing: true },
    connect,
    sink: {
      audio: (pcm) => audio.push(pcm),
      transcript: (who, text, final) => transcript.push({ who, text, final }),
      state: (state) => states.push(state),
      mood: (mood) => moods.push(mood),
      interrupted: () => undefined,
      show: (item) => shown.push(item),
      trouble: (message) => troubles.push(message),
    },
  });

  return {
    root,
    brain,
    companion,
    sockets,
    systemInstructions,
    audio,
    transcript,
    states,
    moods,
    shown,
    troubles,
    socket: () => sockets.at(-1)!,
  };
}

/**
 * Lets a tool call finish.
 *
 * A timer rather than `setImmediate`: `show` reads a directory and stats every
 * file in it, which is several event-loop turns, and a one-tick wait made the
 * gallery look empty when it was not.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('waking builds a prompt that actually contains who she is', async () => {
  const f = await fixture();
  await f.companion.wake();

  const prompt = f.systemInstructions[0] ?? '';
  assert.match(prompt, /not an assistant/, 'her personality must reach the model');
  assert.match(prompt, /dark brown/, 'her eye colour is in the prompt for a reason');
  assert.match(prompt, /5 ft 6 in/, 'and her height');
  assert.match(prompt, /Chinese-American/);
  assert.match(prompt, /⟦director⟧/, 'without this she answers a stage direction out loud');
  assert.match(prompt, /⟦context⟧/);
  assert.match(prompt, /you can hear them/, 'the senses that are on must be stated');
  assert.match(prompt, /988/, 'the crisis floor is not optional');
  await f.companion.sleep();
});

test('a finished user turn is written to memory and lifts her mood', async () => {
  const f = await fixture();
  await f.companion.wake();
  const before = f.brain.mood.read().current.valence;

  f.socket().emit({
    serverContent: { inputTranscription: { text: 'my sister is called Mei' }, turnComplete: true },
  } as unknown as LiveServerMessage);

  const turns = f.brain.memory.liveTranscript(10);
  assert.equal(turns.at(-1)?.text, 'my sister is called Mei');
  assert.equal(turns.at(-1)?.speaker, 'user');
  assert.ok(f.brain.mood.read().current.valence > before, 'being talked to should register');
  await f.companion.sleep();
});

test('both halves of a turn reach the transcript and memory', async () => {
  const f = await fixture();
  await f.companion.wake();

  f.socket().emit({
    serverContent: {
      inputTranscription: { text: 'hey' },
      outputTranscription: { text: 'Hey yourself.' },
      turnComplete: true,
    },
  } as unknown as LiveServerMessage);

  const speakers = f.brain.memory.liveTranscript(10).map((turn) => turn.speaker);
  assert.deepEqual(speakers, ['user', 'anna']);
  assert.ok(f.transcript.some((line) => line.who === 'anna' && line.final));
  await f.companion.sleep();
});

test('the feel tool moves her mood and tells the UI', async () => {
  const f = await fixture();
  await f.companion.wake();
  const before = f.brain.mood.read().current.warmth;

  f.socket().emit({
    toolCall: {
      functionCalls: [
        { id: '1', name: 'feel', args: { warmth: 0.6, valence: 0.4, why: 'that was kind' } },
      ],
    },
  } as unknown as LiveServerMessage);
  await settle();

  assert.ok(f.brain.mood.read().current.warmth > before);
  assert.ok(f.moods.length > 0, 'the UI has to hear about it');
  await f.companion.sleep();
});

test('the remember tool writes a fact, and a bad kind does not lose it', async () => {
  const f = await fixture();
  await f.companion.wake();

  f.socket().emit({
    toolCall: {
      functionCalls: [
        { id: '1', name: 'remember', args: { kind: 'nonsense', text: 'He is dreading Thursday.' } },
      ],
    },
  } as unknown as LiveServerMessage);
  await settle();

  const recalled = await f.brain.memory.recall('Thursday');
  assert.ok(
    recalled.some((fact) => fact.includes('dreading Thursday')),
    'an invalid kind must not throw the fact away',
  );
  await f.companion.sleep();
});

test('the show tool sends what is in the gallery and never invents one', async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.brain.gallery.dir, 'at-the-window-rainy.jpg'),
    Buffer.from([0xff, 0xd8, 0xff]),
  );
  await f.companion.wake();

  f.socket().emit({
    toolCall: {
      functionCalls: [{ id: '1', name: 'show', args: { description: 'watching the rain' } }],
    },
  } as unknown as LiveServerMessage);
  await settle();

  assert.equal(f.shown.at(0)?.name, 'at-the-window-rainy.jpg');

  f.socket().emit({
    toolCall: {
      functionCalls: [{ id: '2', name: 'show', args: { description: 'riding a motorbike on mars' } }],
    },
  } as unknown as LiveServerMessage);
  await settle();

  assert.equal(f.shown.length, 1, 'a bad match is worse than no picture');
  await f.companion.sleep();
});

test('an unknown tool is answered rather than left hanging', async () => {
  const f = await fixture();
  await f.companion.wake();
  f.socket().emit({
    toolCall: { functionCalls: [{ id: '1', name: 'launch_missiles', args: {} }] },
  } as unknown as LiveServerMessage);
  await settle();

  const responses = f.socket().tools[0] as Array<{ response: { ok: boolean } }>;
  assert.equal(responses[0]?.response.ok, false);
  await f.companion.sleep();
});

test('a sense being switched off is told to her, quietly', async () => {
  const f = await fixture();
  await f.companion.wake();
  f.companion.setSense('sight', true);

  const injected = f.socket().content.at(-1);
  assert.equal(injected?.turnComplete, false, 'she must not answer a sense toggle out loud');
  assert.match(JSON.stringify(injected?.turns), /camera is on/);
  await f.companion.sleep();
});

test('frames are dropped when a sense is off, and rate-limited when it is on', async () => {
  const f = await fixture({ ANNA_CAMERA_FPS: '1' });
  await f.companion.wake();

  f.companion.see(Buffer.from([1]), 'camera');
  assert.equal(f.socket().realtime.length, 0, 'a frame arrived for a sense that is off');

  f.companion.setSense('sight', true);
  f.companion.see(Buffer.from([1]), 'camera');
  f.companion.see(Buffer.from([2]), 'camera');
  f.companion.see(Buffer.from([3]), 'camera');

  const frames = f.socket().realtime.filter((each) => 'video' in each);
  assert.equal(frames.length, 1, 'the server-side budget must hold regardless of the client');
  await f.companion.sleep();
});

test('a photo they sent is looked at even though no sense is on', async () => {
  const f = await fixture();
  await f.companion.wake();
  f.companion.look(Buffer.from([0xff, 0xd8]), 'image/jpeg');

  const frames = f.socket().realtime.filter((each) => 'video' in each);
  assert.equal(frames.length, 1, 'being handed a picture is a request to look at it');
  await f.companion.sleep();
});

test('audio only flows while hearing is on', async () => {
  const f = await fixture();
  await f.companion.wake();

  f.companion.hear(Buffer.from([1, 2]));
  assert.equal(f.socket().realtime.filter((each) => 'audio' in each).length, 1);

  f.companion.setSense('hearing', false);
  f.companion.hear(Buffer.from([3, 4]));
  assert.equal(
    f.socket().realtime.filter((each) => 'audio' in each).length,
    1,
    'a muted microphone must actually be muted',
  );
  await f.companion.sleep();
});

test('typing to her records the turn and reaches the model', async () => {
  const f = await fixture();
  await f.companion.wake();
  f.companion.say('are you there');

  assert.equal(f.brain.memory.liveTranscript(5).at(-1)?.text, 'are you there');
  assert.ok(f.socket().realtime.some((each) => each.text === 'are you there'));
  await f.companion.sleep();
});

test('no API key is said plainly rather than thrown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'anna-nokey-'));
  const config = loadConfig({
    ANNA_PROFILE: path.join(root, 'profile'),
    ANNA_DATA: path.join(root, 'data'),
  } as NodeJS.ProcessEnv);
  const brain = await Brain.open(config, { offline: true });

  const troubles: string[] = [];
  const companion = new Companion({
    brain,
    channel: 'desktop',
    sink: {
      audio: () => undefined,
      transcript: () => undefined,
      state: () => undefined,
      mood: () => undefined,
      interrupted: () => undefined,
      show: () => undefined,
      trouble: (message) => troubles.push(message),
    },
  });

  await assert.doesNotReject(() => companion.wake());
  assert.match(troubles[0] ?? '', /GEMINI_API_KEY/);
});

test('memory carries between two conversations', async () => {
  const f = await fixture();
  await f.companion.wake();
  f.socket().emit({
    toolCall: {
      functionCalls: [
        { id: '1', name: 'remember', args: { kind: 'identity', text: 'His sister is Mei.' } },
      ],
    },
  } as unknown as LiveServerMessage);
  await settle();
  await f.companion.sleep();

  const second = new Companion({
    brain: f.brain,
    channel: 'phone',
    connect: async ({ config, callbacks }) => {
      f.systemInstructions.push(String(config.systemInstruction ?? ''));
      const socket = new FakeSocket();
      socket.emit = (message) => callbacks.onmessage(message);
      return socket;
    },
    sink: {
      audio: () => undefined,
      transcript: () => undefined,
      state: () => undefined,
      mood: () => undefined,
      interrupted: () => undefined,
      show: () => undefined,
      trouble: () => undefined,
    },
  });

  await second.wake();
  assert.match(
    f.systemInstructions.at(-1) ?? '',
    /Mei/,
    'a second conversation must not meet a stranger',
  );
  assert.match(f.systemInstructions.at(-1) ?? '', /called you from their phone/);
  await second.sleep();
});
