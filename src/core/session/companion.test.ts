import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Companion } from './companion.ts';
import { Brain } from './brain.ts';
import { loadConfig } from '../../server/config.ts';
import type { LiveConnector, LiveSocket } from '../gemini/live.ts';
import type { FunctionDeclaration, LiveServerMessage } from '@google/genai';
import type { GalleryItem } from '../gallery/gallery.ts';
import type { ConnectionState, MoodReadout } from '../../shared/protocol.ts';

/**
 * A whole companion, with the socket faked and nothing else.
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
  const root = await mkdtemp(path.join(tmpdir(), 'hers-companion-'));
  const config = loadConfig({
    GEMINI_API_KEY: 'test-key',
    HERS_PROFILE: path.join(root, 'profile'),
    HERS_DATA: path.join(root, 'data'),
    ...env,
  } as NodeJS.ProcessEnv);

  const brain = await Brain.open(config, { offline: true });

  const sockets: FakeSocket[] = [];
  const systemInstructions: string[] = [];
  /** What she was actually given to call, as opposed to what she was told about. */
  const declared: FunctionDeclaration[][] = [];
  const connect: LiveConnector = async ({ config: liveConfig, callbacks }) => {
    systemInstructions.push(String(liveConfig.systemInstruction ?? ''));
    declared.push(
      (liveConfig.tools ?? []).flatMap(
        (tool) => (tool as { functionDeclarations?: FunctionDeclaration[] }).functionDeclarations ?? [],
      ),
    );
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
  const names: string[] = [];
  const looks: string[] = [];

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
      named: (name) => names.push(name),
      look: (expression) => looks.push(expression),
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
    declared,
    audio,
    transcript,
    states,
    moods,
    shown,
    troubles,
    names,
    looks,
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
  assert.match(prompt, /never answer that question in words/i, 'the picture is the answer');
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
  assert.deepEqual(speakers, ['user', 'her']);
  assert.ok(f.transcript.some((line) => line.who === 'her' && line.final));
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

// -- the read path ----------------------------------------------------------

/**
 * The facts from the measurement that lost to OpenClaw, near enough.
 *
 * Cilantro is stored first and a shade less certain than the rest, which is what
 * puts it outside the eight facts the wake query picks: nothing here has anything
 * to do with "what matters to them", so with no semantic signal the ranking falls
 * back to recency and confidence, ten facts at 0.9 fill the budget, and the one
 * at 0.8 is eleventh. That is the arrangement the real failure had, reproduced
 * rather than described.
 */
async function seedNineFacts(brain: Awaited<ReturnType<typeof fixture>>['brain']): Promise<void> {
  await brain.memory.remember('preference', 'He hates cilantro.', { confidence: 0.8 });
  for (const text of [
    'His sister is called Mei.',
    'He is interviewing at a robotics startup on Thursday.',
    'He runs in the mornings before work.',
    'He grew up in Oakland, California.',
    'His mother had surgery in the spring.',
    'He is learning to play the guqin.',
    'He dislikes being asked how he slept.',
    'He lives on the fifth floor with no lift.',
    'His flatmate is moving out in August.',
    'He supports Arsenal and suffers for it.',
  ]) {
    await brain.memory.remember('event', text, { confidence: 0.9 });
  }
}

/** The facts one `recall` call handed back, if it handed back any. */
function recalled(socket: FakeSocket, index = 0): { facts?: string[]; note?: string; ok?: boolean } {
  const responses = socket.tools[index] as Array<{ response: Record<string, unknown> }>;
  return (responses[0]?.response ?? {}) as { facts?: string[]; note?: string; ok?: boolean };
}

function askToRecall(socket: FakeSocket, about: string, id = '1'): void {
  socket.emit({
    toolCall: { functionCalls: [{ id, name: 'recall', args: { about } }] },
  } as unknown as LiveServerMessage);
}

test('a fact outside the wake budget still reaches her, because she can go and get it', async () => {
  /*
   * The whole point of the read path, and the exact failure it is answering: she
   * said "I don't think you've ever mentioned food you hate" about cilantro,
   * which was in the database at 0.8 confidence. It was never a storage bug —
   * the eight facts in her prompt are chosen at wake, from a query built before
   * anybody has spoken, and there is no second look. Now there is.
   */
  const f = await fixture();
  await seedNineFacts(f.brain);
  await f.companion.wake();

  const prompt = f.systemInstructions.at(-1) ?? '';
  assert.doesNotMatch(prompt, /cilantro/i, 'the premise: the fact did not make the wake budget');

  askToRecall(f.socket(), 'food he hates');
  await settle();

  const answer = recalled(f.socket());
  assert.equal(answer.ok, true);
  assert.ok(
    (answer.facts ?? []).some((fact) => fact.includes('cilantro')),
    'a fact she owns and was not handed has to be reachable mid-conversation',
  );

  // Addressed to the call that asked, because that is what puts it in her context
  // for the rest of the turn. A response with the wrong id is dropped by the
  // session, and the fact would have been fetched and thrown away.
  const raw = f.socket().tools[0] as Array<{ id?: string; name?: string }>;
  assert.equal(raw[0]?.id, '1');
  assert.equal(raw[0]?.name, 'recall');
  await f.companion.sleep();
});

test('a question with nothing behind it comes back empty, not with the nearest fact', async () => {
  /*
   * The other half of the same measurement was a confabulation: she asserted a
   * coffee preference nobody had told her. `MemoryStore.recall` always returns
   * its top few facts however unrelated they are, so a read path that passed
   * them straight on would hand her his sister's name when asked about coffee —
   * and make that worse rather than better.
   */
  const f = await fixture();
  await seedNineFacts(f.brain);
  await f.companion.wake();

  askToRecall(f.socket(), 'his coffee order');
  await settle();

  const answer = recalled(f.socket());
  assert.equal(answer.ok, true, 'a lookup that found nothing still worked');
  assert.deepEqual(answer.facts, [], 'nothing in the store is about coffee');
  assert.match(
    String(answer.note ?? ''),
    /do not have it/i,
    'and she is told what to say, since the gap is where invention happens',
  );
  assert.doesNotMatch(JSON.stringify(answer), /Mei|Arsenal|guqin/, 'no consolation facts');
  await f.companion.sleep();
});

test('what comes back is a handful, not everything she knows', async () => {
  // The query is deliberately greedy — it names seven of the eleven facts — because
  // the cap is what is under test. The answer arrives while she is mid-turn, and a
  // dozen sentences landing there is a paragraph to read out, not a memory.
  const f = await fixture();
  await seedNineFacts(f.brain);
  await f.companion.wake();

  askToRecall(f.socket(), 'his sister, his mother, his flatmate, Arsenal, the guqin, Oakland, the interview');
  await settle();

  const facts = recalled(f.socket()).facts ?? [];
  assert.ok(facts.length > 1, 'it should have found several');
  assert.ok(facts.length <= 5, `handed back ${facts.length} facts`);
  await f.companion.sleep();
});

test('an empty lookup is refused rather than answered with the top of the store', async () => {
  const f = await fixture();
  await seedNineFacts(f.brain);
  await f.companion.wake();

  askToRecall(f.socket(), '   ');
  await settle();

  const answer = recalled(f.socket());
  assert.equal(answer.ok, false);
  assert.deepEqual(answer.facts, undefined, 'no query is not a query about everything');
  await f.companion.sleep();
});

test('she is given the recall tool and told to look before she answers', async () => {
  const f = await fixture();
  await f.companion.wake();

  const recall = f.declared.at(-1)?.find((tool) => tool.name === 'recall');
  assert.ok(recall, 'she cannot call a tool she was never handed');
  assert.deepEqual(
    Object.keys(recall?.parameters?.properties ?? {}),
    ['about'],
    'one parameter: what she is trying to remember, in her own words',
  );

  const prompt = f.systemInstructions.at(-1) ?? '';
  assert.match(prompt, /^recall /m, 'the tool list has to name it');
  assert.match(prompt, /Call `recall` first/, 'and looking has to be a rule, not an option');
  assert.match(
    prompt,
    /Not remembering is not the same as it not\s+being there/,
    'the sentence that separates a miss from an absence',
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
  const f = await fixture({ HERS_CAMERA_FPS: '1' });
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

test('saying hello does not cost a picture', async () => {
  /*
   * Every conversation used to open with a freshly generated portrait, fired on
   * the first thing the user said. It was a nice trick exactly once, and after
   * that it was a photograph arriving before the hello — every time, wanted or
   * not, at about four cents each. A picture is worth something when it is
   * chosen, so now it is only ever chosen: by her through `show`, or by them
   * asking.
   */
  const f = await fixture();
  await f.companion.wake();

  let generated = 0;
  f.brain.gallery.generate = async () => {
    generated += 1;
    return null;
  };

  f.companion.say('hey');
  f.companion.say('you there?');
  await settle();

  assert.equal(generated, 0, 'nothing was asked for and nothing should have been made');
  assert.equal(f.shown.length, 0);
  assert.equal(f.brain.memory.liveTranscript(5).at(-1)?.text, 'you there?', 'the turns still landed');
  await f.companion.sleep();
});

test('she can still send a picture when she reaches for one', async () => {
  const f = await fixture();
  // "a picture of you" is answered with the photograph itself rather than a
  // generation, so there has to be one on disk for there to be anything to send.
  await f.brain.avatar.setSource(facePng(), 'image/png');
  await f.companion.wake();

  f.socket().emit({
    toolCall: {
      functionCalls: [{ id: '1', name: 'show', args: { description: 'a picture of you' } }],
    },
  } as unknown as LiveServerMessage);
  await settle();

  assert.equal(f.shown.length, 1, 'the tool is how a picture is meant to arrive');
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
  const root = await mkdtemp(path.join(tmpdir(), 'hers-nokey-'));
  const config = loadConfig({
    HERS_PROFILE: path.join(root, 'profile'),
    HERS_DATA: path.join(root, 'data'),
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
      named: () => undefined,
      look: () => undefined,
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
      named: () => undefined,
      look: () => undefined,
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
  const f = await fixture({ HERS_MIN_SILENCE_MS: '1000', HERS_MAX_SILENCE_MS: '5000' });
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
  const f = await fixture({ HERS_MIN_SILENCE_MS: '1000', HERS_MAX_SILENCE_MS: '5000' });
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

test('asking to see her sends the photograph, without the model having to decide', async () => {
  /*
   * "What do you look like?" came back as "artist Maybe a little punk adjacent?
   * You tell me." — no picture, and invented, because she has no written
   * description of herself and the question demanded an answer anyway. A direct
   * request deserves a direct answer, so this one does not go through the model.
   */
  const f = await fixture();
  await f.brain.avatar.setSource(facePng(), 'image/png');
  await f.companion.wake();

  f.companion.say('What do you look like?');
  await settle();

  assert.equal(f.shown.length, 1, 'the photograph should have gone out');
  assert.equal(f.shown[0]?.name, 'source.png', 'and it is the one they uploaded, not a generation');

  // She is told it went, so she does not describe a face she cannot see.
  const told = f.socket().content.map((each) => JSON.stringify(each.turns)).join(' ');
  assert.match(told, /has just been sent to them/);
  await f.companion.sleep();
});

test('ordinary conversation does not trip the photograph', async () => {
  const f = await fixture();
  await f.brain.avatar.setSource(facePng(), 'image/png');
  await f.companion.wake();

  // Every word of "how are you" is in the vocabulary that names only her, which
  // is why the gallery's own classifier says yes to it and this one must not.
  for (const line of ['how are you', 'hey', 'I finished it!', 'and we can move on']) {
    f.companion.say(line);
  }
  await settle();

  assert.equal(f.shown.length, 0, 'a photograph arriving because they said hello is the old bug');
  await f.companion.sleep();
});

test('with no photograph yet, asking to see her sends nothing rather than something else', async () => {
  const f = await fixture();
  await f.companion.wake();

  f.companion.say('send me a picture of you');
  await settle();

  assert.equal(f.shown.length, 0);
  await f.companion.sleep();
});

test('one question does not get two identical photographs', async () => {
  /*
   * A request to see her is answered from code, and the model reasonably
   * reaches for `show` on the same turn because it was just asked. Both resolve
   * to the same file. Observed live: two copies of her photograph, seconds
   * apart, for one "what do you look like?".
   */
  const f = await fixture();
  await f.brain.avatar.setSource(facePng(), 'image/png');
  await f.companion.wake();

  f.companion.say('What do you look like?');
  await settle();
  assert.equal(f.shown.length, 1);

  f.socket().emit({
    toolCall: {
      functionCalls: [{ id: '1', name: 'show', args: { description: 'a picture of you' } }],
    },
  } as unknown as LiveServerMessage);
  await settle();

  assert.equal(f.shown.length, 1, 'the model asked for the one that had already gone');
  const answered = (f.socket().tools[0] as Array<{ response: { ok: boolean } }>)[0];
  assert.equal(answered?.response.ok, true, 'and she is told it worked, because it did');

  await f.companion.sleep();
});

test('a different picture is still sent while the photograph is fresh', async () => {
  const f = await fixture();
  await f.brain.avatar.setSource(facePng(), 'image/png');
  await writeFile(path.join(f.root, 'profile', 'gallery', 'at-the-window-rainy.jpg'), 'not a jpeg');
  await f.companion.wake();

  f.companion.say('What do you look like?');
  await settle();
  assert.equal(f.shown.length, 1);

  f.socket().emit({
    toolCall: {
      functionCalls: [
        { id: '1', name: 'show', args: { description: 'at the window watching the rain' } },
      ],
    },
  } as unknown as LiveServerMessage);
  await settle();

  assert.equal(f.shown.length, 2, 'a scene is a different picture, not a duplicate');
  assert.equal(f.shown[1]?.name, 'at-the-window-rainy.jpg');
  await f.companion.sleep();
});

// -- how close they are -----------------------------------------------------

test('she starts as a stranger and is told to behave like one', async () => {
  const f = await fixture();
  await f.companion.wake();

  const prompt = f.systemInstructions[0] ?? '';
  assert.match(prompt, /HOW CLOSE YOU TWO ARE/);
  assert.match(prompt, /stranger, 1%/, 'day one is 1%, as specified');
  assert.match(prompt, /have not earned/i);
  assert.match(prompt, /Never state the number/i, 'it is not a score to be shown off');
  await f.companion.sleep();
});

test('knowing things about someone is stated as not being close to them', async () => {
  /*
   * The creepiest thing this product could do: read a person's documents, learn
   * their sister's name and their fears, and then behave like an old friend on
   * the first day. Facts and closeness are separate systems, and the prompt has
   * to say so — a model handed a rich dossier will otherwise act on it.
   */
  const f = await fixture();
  await f.brain.memory.remember('identity', 'their sister is called Mei', { confidence: 0.9 });
  await f.companion.wake();

  const prompt = f.systemInstructions[0] ?? '';
  assert.match(prompt, /Knowing about someone is not the same as being close/i);
  assert.match(prompt, /worse than knowing nothing/i);
  assert.match(prompt, /stranger/, 'a dossier must not promote her');
  await f.companion.sleep();
});

test('talking to her counts toward the relationship, once per turn', async () => {
  const f = await fixture();
  await f.companion.wake();
  const before = f.brain.intimacy.state.turnsToday;

  f.companion.say('hey');
  f.companion.say('how was your day');
  await settle();

  assert.equal(f.brain.intimacy.state.turnsToday, before + 2);
  await f.companion.sleep();
});

test('being heard counts once, not once per audio chunk', async () => {
  const f = await fixture();
  await f.companion.wake();

  for (let i = 0; i < 50; i += 1) f.companion.hear(Buffer.alloc(640));
  assert.equal(f.brain.intimacy.state.sensesToday, true);

  // Fifty chunks is a second of speech. It must not be fifty writes.
  assert.equal(f.brain.intimacy.read().percent, 1, 'a second of audio is not a relationship');
  await f.companion.sleep();
});

test('a pinned closeness is what reaches the prompt', async () => {
  const f = await fixture();
  f.brain.intimacy.pin(0.7);
  await f.companion.wake();

  const prompt = f.systemInstructions[0] ?? '';
  assert.match(prompt, /partner, 70%/);
  assert.match(prompt, /shared life/i);
  await f.companion.sleep();
});

test('a name she chose during this wake reaches the page that watched her wake up', async () => {
  /*
   * The bug this closes, seen in a browser: she answered "Maya. What were you
   * thinking of going with?" under a header that still said Anna. `ready` is
   * sent when the socket opens, and she chooses during the first wake — which is
   * afterwards. A companion whose interface disagrees with the name she answers
   * to is two people.
   */
  const f = await fixture();
  const chosen = 'Mira';

  // `ensureNamed` is where the model call lives; the wiring under test is what
  // happens with its answer, so it is stubbed rather than paid for.
  f.brain.ensureNamed = async () => chosen;

  await f.companion.wake();
  assert.deepEqual(f.names, [chosen], 'told once, on the wake that decided it');

  // And not again on a later wake, because there is nothing left to decide.
  f.brain.ensureNamed = async () => null;
  await f.companion.sleep();
  await f.companion.wake();
  assert.deepEqual(f.names, [chosen]);
});

test('she can only ask for a face that exists, and a wrong name is refused', async () => {
  /*
   * The enum handed to the model only ever contains ready faces, so a bad name
   * should be impossible — which is exactly why it is checked. A tool call is a
   * string from a model, and believing this one puts a 404 in her portrait.
   */
  const f = await fixture();
  await f.companion.wake();
  const socket = f.socket();

  // No faces have been generated, so the tool is not even offered.
  const declared = f.systemInstructions.at(-1) ?? '';
  assert.doesNotMatch(declared, /^look /m, 'not offered when none exist');

  const ask = (expression: string) =>
    socket.emit({
      toolCall: { functionCalls: [{ id: '1', name: 'look', args: { expression } }] },
    } as unknown as LiveServerMessage);

  ask('sneering');
  await settle();
  assert.deepEqual(f.looks, [], 'a name that is not an expression changes nothing');

  ask('smiling');
  await settle();
  assert.deepEqual(f.looks, [], 'nor one that exists but has not been generated');
});
