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
  const moved: string[] = [];
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
      move: (gesture) => moved.push(gesture),
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
    moved,
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
/** Long enough for a turn's transcript to go quiet. See live.ts SETTLE_MS. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 500));

test('waking builds a prompt that actually contains who she is', async () => {
  const f = await fixture();
  await f.companion.wake();

  const prompt = f.systemInstructions[0] ?? '';
  assert.match(prompt, /not an assistant/, 'her personality must reach the model');
  assert.match(
    prompt,
    /no face yet/,
    'with no photograph she must say so rather than invent a description',
  );
  assert.match(prompt, /Chinese-American/);
  assert.match(prompt, /⟦director⟧/, 'without this she answers a stage direction out loud');
  assert.match(prompt, /⟦context⟧/);
  assert.match(prompt, /you can hear them/, 'the senses that are on must be stated');
  assert.match(prompt, /988/, 'the crisis floor is not optional');
  await f.companion.sleep();
});

test('no picture of her is ever put into the conversation', async () => {
  /*
   * Measured against the live model, twice. With her photograph in the session
   * and asked "do I have a tan?", she answered from it — describing her own
   * body as the user's. Labelling the image "this is YOU, not the person you
   * are talking to" did not stop it. With the image gone she says "my camera's
   * off, so I'm seeing nothing right now", which is the truth.
   */
  const f = await fixture();
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000001900000021808060000001f15c489',
    'hex',
  );
  await f.brain.avatar.setSource(png, 'image/png');
  await f.companion.wake();
  await settle();

  const sent = f.socket().content.map((entry) => JSON.stringify(entry.turns));
  assert.ok(
    !sent.some((body) => body.includes('inlineData')),
    'an image of her in context is one a question about the user can land on',
  );

  const prompt = f.systemInstructions[0] ?? '';
  assert.match(prompt, /send them a picture/i, 'the capability moves to the show tool');
  assert.match(prompt, /cannot see them/i, 'and the honest answer when blind is stated');
  assert.ok(!/eye colour|hairstyle|body type/i.test(prompt), 'the prose description is back');
  await f.companion.sleep();
});

test('a finished user turn is written to memory and lifts her mood', async () => {
  const f = await fixture();
  await f.companion.wake();
  const before = f.brain.mood.read().current.valence;

  f.socket().emit({
    serverContent: { inputTranscription: { text: 'my sister is called Mei' }, turnComplete: true },
  } as unknown as LiveServerMessage);
  await settled();

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
  await settled();

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

/** A real PNG header — enough for the studio, which reads the bytes not the name. */
function png(width: number, height: number): Buffer {
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

/**
 * The bug this is here for, end to end: asked for her picture on Telegram she
 * sent a generated drawing of somebody else, while the web showed the uploaded
 * photograph as her face. Both go through this tool call, so both are fixed by
 * it answering with the photograph.
 */
test('asked for her picture, the show tool sends the photograph that was uploaded', async () => {
  const f = await fixture();
  await f.brain.avatar.setSource(png(512, 640), 'image/png');
  // A previous generation sitting in the gallery, which is what used to win.
  await writeFile(
    path.join(f.brain.gallery.dir, 'a-picture-of-you-right-now-1786883162943.jpg'),
    Buffer.from([0xff, 0xd8, 0xff]),
  );
  await f.companion.wake();

  f.socket().emit({
    toolCall: {
      functionCalls: [{ id: '1', name: 'show', args: { description: 'a picture of you right now' } }],
    },
  } as unknown as LiveServerMessage);
  await settle();

  assert.equal(f.shown.at(0)?.name, 'source.png', 'she has a face; she should send that face');
  assert.equal(f.shown.at(0)?.absolutePath, f.brain.avatar.sourcePath());
  await f.companion.sleep();
});

test('a scene she is asked for is not answered with the bare photograph', async () => {
  const f = await fixture();
  await f.brain.avatar.setSource(png(512, 640), 'image/png');
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

test('the first thing said opens with a freshly generated picture', async () => {
  const f = await fixture();
  await f.companion.wake();

  // A real generation is a network call and a bill, so the gallery's generator
  // is replaced — what is under test is *when* it fires and *what it is asked
  // for*, not Nano Banana.
  const asked: string[] = [];
  f.brain.gallery.generate = async (description) => {
    asked.push(description);
    return {
      name: 'greeting.jpg',
      absolutePath: '/tmp/greeting.jpg',
      kind: 'image' as const,
      caption: 'greeting',
      label: '',
      modifiedAt: Date.now(),
    };
  };

  f.companion.say('hey');
  f.companion.say('you there?');
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(asked.length, 1, 'one picture per conversation, not one per message');
  assert.match(asked[0] ?? '', /looking at the camera/);
  assert.equal(f.shown.at(0)?.name, 'greeting.jpg');
  await f.companion.sleep();
});

test('the greeting picture can be switched off', async () => {
  const f = await fixture({ ANNA_GREETING_IMAGE: '0' });
  await f.companion.wake();

  let called = 0;
  f.brain.gallery.generate = async () => {
    called += 1;
    return null;
  };

  f.companion.say('hey');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(called, 0);
  await f.companion.sleep();
});

test('a greeting that fails costs a picture, not the conversation', async () => {
  const f = await fixture();
  await f.companion.wake();
  f.brain.gallery.generate = async () => {
    throw new Error('the image model refused');
  };

  f.companion.say('hey');
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(f.shown.length, 0);
  assert.equal(f.brain.memory.liveTranscript(5).at(-1)?.text, 'hey', 'the turn still landed');
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
      move: () => undefined,
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
      move: () => undefined,
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

test('the screen watcher reaches her, and only while she is sharing a screen', async () => {
  const f = await fixture();

  // The browser can be reporting before the sense is on — the share dialog is
  // open, the track is live, the switch has not been sent yet. A reading from
  // a screen she is not being shown must not become something she talks about.
  f.companion.noteScreen('working', 0);
  assert.equal(f.companion.situation.snapshot().screen.at, 0);

  f.companion.setSense('screen', true);
  f.companion.noteScreen('switched', 0);

  const screen = f.companion.situation.snapshot().screen;
  assert.equal(screen.activity, 'switched');
  assert.ok(screen.at > 0, 'the reading arrived');
  assert.ok(screen.sinceSwitchMs < 1000, 'and it was just now');

  f.companion.noteScreen('still', 900);
  assert.ok(f.companion.situation.snapshot().screen.stillSeconds >= 900);
});

test('when she speaks first she looks at the screen as it is now, not as it was', async () => {
  // A real opener, on a real timer, wound down to seconds.
  const f = await fixture({ ANNA_MIN_SILENCE_MS: '1000', ANNA_MAX_SILENCE_MS: '5000' });
  await f.companion.wake();
  f.companion.setSense('screen', true);

  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x41, 0x4e, 0x4e, 0x41, 0xff, 0xd9]);
  f.companion.see(frame, 'screen');

  const deadline = Date.now() + 9000;
  let director = -1;
  while (Date.now() < deadline && director < 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    director = f.socket().content.findIndex((each) =>
      JSON.stringify(each.turns).includes('⟦director⟧'),
    );
  }
  assert.ok(director >= 0, 'she never spoke first');

  const looked = f
    .socket()
    .content.findIndex((each) => JSON.stringify(each.turns).includes('inlineData'));
  assert.ok(looked >= 0, 'she opened without looking at anything');
  assert.ok(looked < director, 'the picture has to be in front of her before she is told to speak');

  const note = JSON.stringify(f.socket().content[looked]?.turns);
  assert.match(note, /right now, this second/, 'and she has to know it is current');
  assert.ok(note.includes(frame.toString('base64')), 'it should be the frame that just arrived');

  await f.companion.sleep();
});

test('a frame from a sense that has since been switched off is not used', async () => {
  const f = await fixture({ ANNA_MIN_SILENCE_MS: '1000', ANNA_MAX_SILENCE_MS: '5000' });
  await f.companion.wake();
  f.companion.setSense('screen', true);
  f.companion.see(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'screen');
  f.companion.setSense('screen', false);

  const deadline = Date.now() + 9000;
  let director = -1;
  while (Date.now() < deadline && director < 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    director = f.socket().content.findIndex((each) =>
      JSON.stringify(each.turns).includes('⟦director⟧'),
    );
  }
  assert.ok(director >= 0, 'she never spoke first');
  assert.ok(
    !f.socket().content.some((each) => JSON.stringify(each.turns).includes('inlineData')),
    'the share is over; that picture is no longer of anything',
  );

  await f.companion.sleep();
});

test('the prompt gives her one honest source for how somebody looks', async () => {
  const f = await fixture();
  await f.brain.avatar.setSource(facePng(), 'image/png');
  await f.companion.wake();

  const prompt = f.systemInstructions.at(-1) ?? '';
  assert.match(prompt, /comes from what your camera or/i);
  assert.match(prompt, /never something borrowed from a picture of yourself/i);
  await f.companion.sleep();
});

/** A PNG header the studio will accept — dimensions are read from IHDR. */
function facePng(width = 512, height = 640): Buffer {
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
