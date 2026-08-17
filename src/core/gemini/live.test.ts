import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LiveConversation } from './live.ts';
import type { LiveConnector, LiveHandlers, LiveSocket, LiveState } from './live.ts';
import type { LiveConnectConfig, LiveServerMessage } from '@google/genai';

/**
 * A stand-in for the socket the SDK opens.
 *
 * The behaviour worth testing here is entirely about what happens when the
 * connection ends — which it does, in normal operation, every couple of minutes
 * on a session with video. None of that is reachable against the real API in a
 * test, and all of it is reachable here.
 */
class FakeSocket implements LiveSocket {
  readonly sent: Record<string, unknown>[] = [];
  readonly clientContent: { turns?: unknown; turnComplete?: boolean }[] = [];
  readonly toolResponses: unknown[] = [];
  closed = false;
  emit: (message: LiveServerMessage) => void = () => undefined;
  fail: (reason: string) => void = () => undefined;
  /** When true, every send throws the way the SDK does on a dead socket. */
  dead = false;

  sendRealtimeInput(params: Record<string, unknown>): void {
    if (this.dead) throw new Error('socket is closed');
    this.sent.push(params);
  }

  sendClientContent(params: { turns?: unknown; turnComplete?: boolean }): void {
    if (this.dead) throw new Error('socket is closed');
    this.clientContent.push(params);
  }

  sendToolResponse(params: { functionResponses: unknown }): void {
    if (this.dead) throw new Error('socket is closed');
    this.toolResponses.push(params.functionResponses);
  }

  close(): void {
    this.closed = true;
  }
}

function fixture(
  overrides: Partial<LiveHandlers> = {},
  options: { failFirst?: number } = {},
) {
  const sockets: FakeSocket[] = [];
  const configs: LiveConnectConfig[] = [];
  const states: LiveState[] = [];
  const audio: Buffer[] = [];
  const userText: { text: string; final: boolean }[] = [];
  const annaText: { text: string; final: boolean }[] = [];
  const troubles: string[] = [];
  let turns = 0;
  let interruptions = 0;
  let attempts = 0;

  const connect: LiveConnector = async ({ config, callbacks }) => {
    configs.push(config);
    attempts += 1;
    if (attempts <= (options.failFirst ?? 0)) throw new Error('connect refused');

    const socket = new FakeSocket();
    socket.emit = (message) => callbacks.onmessage(message);
    socket.fail = (reason) => callbacks.onerror?.(new Error(reason));
    sockets.push(socket);
    return socket;
  };

  const live = new LiveConversation({
    apiKey: 'test',
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    voice: 'Aoede',
    systemInstruction: () => `system v${configs.length}`,
    connect,
    handlers: {
      onAudio: (pcm) => audio.push(pcm),
      onUserText: (text, final) => userText.push({ text, final }),
      onAnnaText: (text, final) => annaText.push({ text, final }),
      onTurnComplete: () => (turns += 1),
      onInterrupted: () => (interruptions += 1),
      onToolCall: async () => ({ ok: true }),
      onState: (state) => states.push(state),
      onTrouble: (message) => troubles.push(message),
      ...overrides,
    },
  });

  return {
    live,
    sockets,
    configs,
    states,
    audio,
    userText,
    annaText,
    troubles,
    get turns() {
      return turns;
    },
    get interruptions() {
      return interruptions;
    },
    latest: () => sockets.at(-1)!,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
/**
 * Long enough for the transcript to go quiet.
 *
 * Finished lines are emitted once transcription stops arriving rather than the
 * instant a completion flag lands, because Google documents no ordering between
 * the two — so a test that asserts immediately is asserting before the turn is
 * over.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 500));

// -- setup ------------------------------------------------------------------

test('the setup asks for everything a long conversation needs', async () => {
  const f = fixture();
  await f.live.start();

  const config = f.configs[0]!;
  assert.deepEqual(config.responseModalities, ['AUDIO']);
  assert.equal(config.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName, 'Aoede');
  assert.ok(config.inputAudioTranscription, 'transcription in is what memory is written from');
  assert.ok(config.outputAudioTranscription, 'transcription out is what Telegram sends');
  assert.ok(config.sessionResumption, 'without this a reconnect meets a stranger');
  assert.ok(
    config.contextWindowCompression?.slidingWindow,
    'without this the session is capped at two minutes with video',
  );
  assert.equal(config.enableAffectiveDialog, true, 'the 2.5 native-audio model supports it');
});

test('a model without affective dialog is not sent it', async () => {
  const configs: LiveConnectConfig[] = [];
  const live = new LiveConversation({
    apiKey: 'test',
    model: 'gemini-3.1-flash-live-preview',
    voice: 'Kore',
    systemInstruction: () => 'system',
    connect: async ({ config }) => {
      configs.push(config);
      return new FakeSocket();
    },
    handlers: {
      onAudio: () => undefined,
      onUserText: () => undefined,
      onAnnaText: () => undefined,
      onTurnComplete: () => undefined,
      onInterrupted: () => undefined,
      onToolCall: async () => ({}),
      onState: () => undefined,
      onTrouble: () => undefined,
    },
  });

  await live.start();
  assert.equal(configs[0]?.enableAffectiveDialog, undefined);
});

test('an unknown model gets the conservative config rather than an optimistic one', async () => {
  const configs: LiveConnectConfig[] = [];
  const live = new LiveConversation({
    apiKey: 'test',
    model: 'gemini-9-whatever-comes-next',
    voice: 'Kore',
    systemInstruction: () => 'system',
    connect: async ({ config }) => {
      configs.push(config);
      return new FakeSocket();
    },
    handlers: {
      onAudio: () => undefined,
      onUserText: () => undefined,
      onAnnaText: () => undefined,
      onTurnComplete: () => undefined,
      onInterrupted: () => undefined,
      onToolCall: async () => ({}),
      onState: () => undefined,
      onTrouble: () => undefined,
    },
  });

  await live.start();
  assert.equal(configs[0]?.enableAffectiveDialog, undefined);
});

// -- sending ----------------------------------------------------------------

test('audio and images go out on the realtime channel', async () => {
  const f = fixture();
  await f.live.start();

  f.live.sendAudio(Buffer.from([1, 2, 3, 4]));
  f.live.sendImage(Buffer.from([5, 6]), 'image/png');

  const [audio, image] = f.latest().sent;
  assert.equal((audio?.audio as { mimeType: string }).mimeType, 'audio/pcm;rate=16000');
  assert.equal((image?.video as { mimeType: string }).mimeType, 'image/png');
});

test('empty media is not sent at all', async () => {
  const f = fixture();
  await f.live.start();
  f.live.sendAudio(Buffer.alloc(0));
  f.live.sendImage(Buffer.alloc(0));
  assert.equal(f.latest().sent.length, 0);
});

test('a context injection does not ask her to say anything', async () => {
  const f = fixture();
  await f.live.start();
  f.live.inject('Your mood has shifted.');

  const sent = f.latest().clientContent[0]!;
  assert.equal(sent.turnComplete, false, 'turnComplete true here makes her answer a stage direction');
  assert.match(JSON.stringify(sent.turns), /⟦context⟧/);
});

test('a director cue does ask her to speak', async () => {
  const f = fixture();
  await f.live.start();
  f.live.prompt('They have gone quiet.');

  const sent = f.latest().clientContent[0]!;
  assert.equal(sent.turnComplete, true);
  assert.match(JSON.stringify(sent.turns), /⟦director⟧/);
});

test('media is dropped rather than queued while there is no socket', async () => {
  const f = fixture();
  await f.live.start();
  const first = f.latest();

  first.fail('network gone');
  await settle();

  f.live.sendAudio(Buffer.from([9, 9]));
  assert.equal(first.sent.length, 0, 'stale audio must not reach the dead socket');
  assert.equal(f.live.isLive, false);
});

// -- receiving --------------------------------------------------------------

test('audio parts become audio and transcripts accumulate until the turn closes', async () => {
  const f = fixture();
  await f.live.start();
  const socket = f.latest();

  socket.emit({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { data: Buffer.from('hi').toString('base64'), mimeType: 'audio/pcm' } }],
      },
      outputTranscription: { text: 'You are up ' },
    },
  } as unknown as LiveServerMessage);
  socket.emit({
    serverContent: { outputTranscription: { text: 'early.' }, turnComplete: true },
  } as unknown as LiveServerMessage);
  await settled();

  assert.equal(f.audio.length, 1);
  assert.equal(f.audio[0]?.toString(), 'hi');
  assert.deepEqual(f.annaText.at(-1), { text: 'You are up early.', final: true });
  assert.equal(f.turns, 1);
});

test('two generations in one turn are two utterances, not one run-on', async () => {
  const f = fixture();
  await f.live.start();
  const socket = f.latest();

  // She answers, the initiative makes her carry on, and only then does the
  // turn close. Observed in a real Telegram message as "What's up?You know,".
  socket.emit({
    serverContent: { outputTranscription: { text: "Great, huh? What's up?" }, generationComplete: true },
  } as unknown as LiveServerMessage);
  await settled();
  socket.emit({
    serverContent: { outputTranscription: { text: 'You know, you could use a friend.' } },
  } as unknown as LiveServerMessage);
  socket.emit({ serverContent: { turnComplete: true } } as unknown as LiveServerMessage);
  await settled();

  const finals = f.annaText.filter((line) => line.final).map((line) => line.text);
  assert.deepEqual(finals, ["Great, huh? What's up?", 'You know, you could use a friend.']);
  assert.equal(f.turns, 1, 'it is still one turn');
});

test('a generation and its turn arriving together emit once, not twice', async () => {
  const f = fixture();
  await f.live.start();
  f.latest().emit({
    serverContent: {
      outputTranscription: { text: 'Just the one thing.' },
      generationComplete: true,
      turnComplete: true,
    },
  } as unknown as LiveServerMessage);
  await settled();

  const finals = f.annaText.filter((line) => line.final);
  assert.equal(finals.length, 1, 'the usual case must not double up');
  assert.equal(finals[0]?.text, 'Just the one thing.');
});

test('the transcript buffer resets between turns', async () => {
  const f = fixture();
  await f.live.start();
  const socket = f.latest();

  socket.emit({
    serverContent: { outputTranscription: { text: 'first' }, turnComplete: true },
  } as unknown as LiveServerMessage);
  socket.emit({
    serverContent: { outputTranscription: { text: 'second' }, turnComplete: true },
  } as unknown as LiveServerMessage);
  await settled();

  assert.equal(f.annaText.at(-1)?.text, 'second', 'a turn must not inherit the last one');
});

test('being interrupted clears what she was going to say', async () => {
  const f = fixture();
  await f.live.start();
  const socket = f.latest();

  socket.emit({
    serverContent: { outputTranscription: { text: 'I was going to say' } },
  } as unknown as LiveServerMessage);
  socket.emit({ serverContent: { interrupted: true } } as unknown as LiveServerMessage);
  socket.emit({
    serverContent: { outputTranscription: { text: 'Sorry.' }, turnComplete: true },
  } as unknown as LiveServerMessage);
  await settled();

  assert.equal(f.interruptions, 1);
  assert.equal(
    f.annaText.at(-1)?.text,
    'Sorry.',
    'the abandoned half-sentence must not be prepended to the next one',
  );
});

// -- tools ------------------------------------------------------------------

test('every tool call gets a response, including one that throws', async () => {
  const f = fixture({
    onToolCall: async (name) => {
      if (name === 'boom') throw new Error('handler exploded');
      return { ok: true };
    },
  });
  await f.live.start();

  f.latest().emit({
    toolCall: {
      functionCalls: [
        { id: 'a', name: 'feel', args: {} },
        { id: 'b', name: 'boom', args: {} },
      ],
    },
  } as unknown as LiveServerMessage);
  await settle();

  const responses = f.latest().toolResponses[0] as Array<{ id: string; response: unknown }>;
  assert.equal(responses.length, 2, 'a model waiting on a response that never comes goes silent');
  assert.deepEqual(responses[0]?.response, { ok: true });
  assert.match(JSON.stringify(responses[1]?.response), /handler exploded/);
});

test('a non-object tool result is still a valid response', async () => {
  const f = fixture({ onToolCall: async () => 'just a string' });
  await f.live.start();
  f.latest().emit({
    toolCall: { functionCalls: [{ id: 'a', name: 'show', args: {} }] },
  } as unknown as LiveServerMessage);
  await settle();

  const responses = f.latest().toolResponses[0] as Array<{ response: unknown }>;
  assert.deepEqual(responses[0]?.response, { result: 'just a string' });
});

// -- the connection ending, which is the whole point ------------------------

test('a resumption handle is carried into the reconnect', async () => {
  const f = fixture();
  await f.live.start();

  f.latest().emit({
    sessionResumptionUpdate: { resumable: true, newHandle: 'handle-one' },
  } as unknown as LiveServerMessage);
  f.latest().emit({
    sessionResumptionUpdate: { resumable: true, newHandle: 'handle-two' },
  } as unknown as LiveServerMessage);

  f.latest().fail('dropped');
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(f.configs.length, 2, 'it did not reconnect');
  assert.equal(
    f.configs[1]?.sessionResumption?.handle,
    'handle-two',
    'the newest handle is the conversation; an older one loses everything since',
  );
});

test('a handle marked unresumable is not kept', async () => {
  const f = fixture();
  await f.live.start();
  f.latest().emit({
    sessionResumptionUpdate: { resumable: false, newHandle: 'do-not-use' },
  } as unknown as LiveServerMessage);

  f.latest().fail('dropped');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(f.configs[1]?.sessionResumption?.handle, undefined);
});

test('goAway rebuilds before the socket dies, not after', async () => {
  const f = fixture();
  await f.live.start();
  const first = f.latest();

  first.emit({ goAway: { timeLeft: '5s' } } as unknown as LiveServerMessage);
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.equal(f.configs.length, 2, 'a goAway must be acted on rather than waited out');
  assert.ok(first.closed, 'the old socket should be released once the new one is up');
  assert.equal(f.live.isLive, true, 'the rebuild must not leave her offline');
});

test('the system instruction is rebuilt on reconnect, not replayed', async () => {
  const f = fixture();
  await f.live.start();
  f.latest().fail('dropped');
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.notEqual(
    f.configs[0]?.systemInstruction,
    f.configs[1]?.systemInstruction,
    'a reconnect has to pick up her current mood and senses',
  );
});

test('a send that throws is treated as a reconnect, not an exception', async () => {
  const f = fixture();
  await f.live.start();
  const socket = f.latest();
  socket.dead = true;

  assert.doesNotThrow(() => f.live.sendAudio(Buffer.from([1, 2])));
  await settle();
  assert.equal(f.live.state, 'reconnecting');
});

test('repeated failures back off and eventually say something to the user', async () => {
  const f = fixture({}, { failFirst: 3 });
  await f.live.start();
  await new Promise((resolve) => setTimeout(resolve, 2500));

  assert.ok(f.configs.length >= 3, `expected retries, saw ${f.configs.length}`);
  assert.ok(f.troubles.length >= 1, 'a connection that will not come back is worth a word');
  assert.match(f.troubles[0] ?? '', /Gemini/);
});

test('closing stops the retries', async () => {
  const f = fixture();
  await f.live.start();
  f.latest().fail('dropped');
  await f.live.close();

  const before = f.configs.length;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(f.configs.length, before, 'a closed conversation must not keep dialling');
  assert.equal(f.live.state, 'closed');
});

test('a message from a socket that has been replaced is ignored', async () => {
  const f = fixture();
  await f.live.start();
  const first = f.latest();

  first.emit({ goAway: { timeLeft: '1s' } } as unknown as LiveServerMessage);
  await new Promise((resolve) => setTimeout(resolve, 700));

  // The old socket is still capable of emitting; nothing it says counts.
  first.emit({
    serverContent: { outputTranscription: { text: 'ghost' }, turnComplete: true },
  } as unknown as LiveServerMessage);

  assert.equal(f.annaText.length, 0, 'a superseded socket spoke into the live conversation');
});

test('a tool answer that arrives after a reconnect is dropped, not sent to a stranger', async () => {
  /*
   * From a real transcript, glued to the front of the sentence she said:
   *
   *     "response:feel{now:calm,ok:true…"
   *
   * That is a tool *response*, read out loud. Responses are matched to calls by
   * id, and an id only means something to the session that issued it. `show`
   * can take seconds — it reads a directory and may generate a picture — and a
   * session carrying video is capped at about two minutes, so the window
   * between a call and its answer routinely contains a reconnect. Delivered to
   * the new socket, the answer belonged to no call it had ever made.
   */
  let release: (value: unknown) => void = () => undefined;
  const slow = new Promise((resolve) => {
    release = resolve;
  });

  const f = fixture({
    onToolCall: async () => {
      await slow;
      return { ok: true, sent: 'a picture of you' };
    },
  });
  await f.live.start();

  const first = f.latest();
  first.emit({
    toolCall: { functionCalls: [{ id: 'fc_1', name: 'show', args: {} }] },
  } as unknown as LiveServerMessage);

  // The connection dies while the gallery is still working.
  first.fail('socket closed mid-render');
  await settle();
  await f.live.start();
  const second = f.latest();
  assert.notEqual(second, first, 'the test needs a genuinely new socket');

  release(undefined);
  await settle();

  assert.equal(second.toolResponses.length, 0, 'the new session never asked this question');
  assert.equal(first.toolResponses.length, 0, 'and the old one is gone');
});

test('a tool answer on a socket that is still current is sent as normal', async () => {
  const f = fixture({ onToolCall: async () => ({ ok: true, now: 'calm' }) });
  await f.live.start();
  const socket = f.latest();

  socket.emit({
    toolCall: { functionCalls: [{ id: 'fc_1', name: 'feel', args: {} }] },
  } as unknown as LiveServerMessage);
  await settle();

  const responses = socket.toolResponses[0] as Array<{ id: string; response: unknown }>;
  assert.equal(responses?.length, 1);
  assert.equal(responses[0]?.id, 'fc_1', 'the id is how the answer finds its question');
  assert.deepEqual(responses[0]?.response, { ok: true, now: 'calm' });
});

test('a function response glued to the front of a sentence never reaches memory', async () => {
  // Verbatim from a real transcript, and the reason it matters is that whatever
  // comes out of a turn is written down permanently.
  const f = fixture();
  await f.live.start();
  f.latest().emit({
    serverContent: {
      outputTranscription: {
        text: 'response:feel{now:calm,ok:trueThe one across your chest from that sports bra.',
      },
      turnComplete: true,
    },
  } as unknown as LiveServerMessage);
  await settled();

  assert.equal(f.annaText.at(-1)?.text, 'The one across your chest from that sports bra.');
});

test('she is still allowed to talk about code', async () => {
  const f = fixture();
  await f.live.start();
  for (const line of [
    'The fix is `{ ok: true }` and nothing else.',
    'Try width: {100} in the config.',
    'ok: sure, I will look.',
  ]) {
    f.latest().emit({
      serverContent: { outputTranscription: { text: line }, turnComplete: true },
    } as unknown as LiveServerMessage);
    await settled();
    assert.equal(f.annaText.at(-1)?.text, line, line);
  }
});
