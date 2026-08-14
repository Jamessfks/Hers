import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import type { AudioChunk, SynthesisRequest, TtsProvider } from '../speech/types.ts';
import type { BrainState, PerformanceEvent } from '../../shared/protocol.ts';
import type { CompletionRequest, LlmProvider } from '../llm/types.ts';
import { Attention, SituationTracker } from '../senses/attention.ts';
import { Memory } from '../memory/memory.ts';
import { MemoryStore } from '../memory/store.ts';
import { createLexicalEmbedder } from '../memory/embedder.ts';
import { Companion, type CompanionSinks } from './companion.ts';

/** A model that streams `reply` a few characters at a time, after a delay. */
function stubLlm(reply: string, options: { firstTokenMs?: number; perChunkMs?: number } = {}) {
  const seen: CompletionRequest[] = [];
  const provider: LlmProvider = {
    id: 'stub',
    label: 'stub',
    suggestedModels: ['stub-1'],
    async *stream(request) {
      seen.push(request);
      await delay(options.firstTokenMs ?? 0);
      for (let i = 0; i < reply.length; i += 6) {
        request.signal?.throwIfAborted();
        yield reply.slice(i, i + 6);
        if (options.perChunkMs) await delay(options.perChunkMs);
      }
    },
    async validateKey() {
      return { ok: true as const };
    },
  };
  return { provider, seen };
}

function stubTts(options: { firstByteMs?: number } = {}) {
  const requests: SynthesisRequest[] = [];
  let concurrent = 0;
  let peakConcurrent = 0;
  const provider: TtsProvider = {
    id: 'stub-voice',
    label: 'stub voice',
    typicalFirstByteMs: options.firstByteMs ?? 0,
    async *synthesize(request) {
      requests.push(request);
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      try {
        await delay(options.firstByteMs ?? 0);
        yield { pcm: new Float32Array(128), sampleRate: 44100 } satisfies AudioChunk;
        yield { pcm: new Float32Array(128), sampleRate: 44100 } satisfies AudioChunk;
      } finally {
        concurrent -= 1;
      }
    },
    async listVoices() {
      return [];
    },
  };
  return { provider, requests, peak: () => peakConcurrent };
}

function harness(llm: LlmProvider, tts: TtsProvider) {
  const performed: PerformanceEvent[] = [];
  const audio: Array<{ clauseId: number; end: boolean; at: number }> = [];
  const states: BrainState[] = [];
  const troubles: string[] = [];

  const sinks: CompanionSinks = {
    perform: (event) => performed.push(event),
    audio: (clauseId, chunk) =>
      audio.push({ clauseId, end: chunk === null, at: performance.now() }),
    state: (state) => states.push(state),
    trouble: (message) => troubles.push(message),
  };

  const store = new MemoryStore({ path: ':memory:' });
  const memory = new Memory({ store, embedder: createLexicalEmbedder(128) });
  const companion = new Companion({
    llm,
    tts,
    memory,
    attention: new Attention({ proactive: true, minMinutesBetweenOpeners: 20, quietHours: null }),
    situation: new SituationTracker(),
    sinks,
    model: 'stub-1',
    voiceId: 'voice-1',
  });

  return { companion, performed, audio, states, troubles, memory, store };
}

test('speaks, moves, and stores only the words', async () => {
  const llm = stubLlm('[gaze:user][warm] Hey. [tilt_head] You look wrecked.');
  const tts = stubTts();
  const h = harness(llm.provider, tts.provider);

  await h.companion.respondTo('hi');

  assert.deepEqual(
    h.performed.filter((e) => e.kind === 'gesture').map((e) => e.name),
    ['tilt_head'],
  );
  assert.ok(h.performed.some((e) => e.kind === 'expression' && e.name === 'warm'));
  assert.deepEqual(h.states, ['thinking', 'speaking', 'idle']);

  const stored = h.store.recentTurns(10);
  assert.deepEqual(
    stored.map((turn) => turn.text),
    ['hi', 'Hey. You look wrecked.'],
    'memory keeps spoken words, never directives',
  );
});

test('first audio arrives inside the 800ms budget', async () => {
  // Deliberately pessimistic stand-ins: a slow model and a slow voice.
  const llm = stubLlm(
    'I have been thinking about what you said last night and I am still not sure you were wrong.',
    { firstTokenMs: 120, perChunkMs: 12 },
  );
  const tts = stubTts({ firstByteMs: 150 });
  const h = harness(llm.provider, tts.provider);

  const start = performance.now();
  const turn = h.companion.respondTo('you awake?');
  // Poll rather than awaiting the turn: the point is when audio *starts*.
  while (h.audio.length === 0) await delay(5);
  const firstAudioMs = h.audio[0]!.at - start;
  await turn;

  assert.ok(
    firstAudioMs < 800,
    `first audio took ${Math.round(firstAudioMs)}ms, budget is 800ms`,
  );
});

test('clause audio is emitted in order even when synthesis overlaps', async () => {
  const llm = stubLlm('One thing here. Two things here. Three things here. Four things here.');
  const tts = stubTts({ firstByteMs: 20 });
  const h = harness(llm.provider, tts.provider);

  await h.companion.respondTo('go');

  const order = h.audio.filter((entry) => entry.end).map((entry) => entry.clauseId);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'clauses must not overtake each other');
  assert.ok(order.length >= 3, 'expected several clauses');
});

test('synthesis runs ahead but stays capped', async () => {
  const llm = stubLlm('One. Two. Three. Four. Five. Six. Seven. Eight.');
  const tts = stubTts({ firstByteMs: 30 });
  const h = harness(llm.provider, tts.provider);

  await h.companion.respondTo('go');

  assert.ok(tts.peak() > 1, 'requests should overlap, or every clause pays full latency');
  assert.ok(tts.peak() <= 2, `lookahead cap exceeded: ${tts.peak()} concurrent requests`);
});

test('barge-in stops the turn and reports it to the body', async () => {
  const llm = stubLlm('This is a long reply. It keeps going. And going. And going.', {
    perChunkMs: 25,
  });
  const tts = stubTts({ firstByteMs: 10 });
  const h = harness(llm.provider, tts.provider);

  const turn = h.companion.respondTo('talk to me');
  await delay(60);
  const spokenBefore = h.performed.filter((e) => e.kind === 'say').length;
  h.companion.bargeIn();
  await turn;
  await delay(60);

  assert.ok(h.performed.some((e) => e.kind === 'barge-in'));
  const spokenAfter = h.performed.filter((e) => e.kind === 'say').length;
  assert.equal(spokenAfter, spokenBefore, 'nothing may be spoken after an interruption');
  assert.equal(h.store.recentTurns(10).at(-1)?.text, 'talk to me', 'an aborted turn is not stored');
});

test('a model failure surfaces as trouble, not as a crash', async () => {
  const failing: LlmProvider = {
    id: 'boom',
    label: 'boom',
    suggestedModels: ['x'],
    async *stream() {
      throw new Error('connection reset');
      yield '';
    },
    async validateKey() {
      return { ok: true as const };
    },
  };
  const h = harness(failing, stubTts().provider);
  await assert.doesNotReject(() => h.companion.respondTo('hi'));
  assert.deepEqual(h.troubles, ['connection reset']);
  assert.equal(h.states.at(-1), 'idle');
});

test('an opener is prompted as speaking first, not as a reply', async () => {
  const llm = stubLlm('[gaze:user] You have been in there a while.');
  const tracker = new SituationTracker();
  tracker.observe({
    kind: 'activity',
    app: 'Xcode',
    windowTitle: 'x.swift',
    idleSeconds: 0,
    at: Date.now() - 60 * 60 * 1000,
  });

  const companion = new Companion({
    llm: llm.provider,
    tts: stubTts().provider,
    memory: new Memory({
      store: new MemoryStore({ path: ':memory:' }),
      embedder: createLexicalEmbedder(128),
    }),
    attention: new Attention({ proactive: true, minMinutesBetweenOpeners: 0, quietHours: null }),
    situation: tracker,
    sinks: {
      perform: () => {},
      audio: () => {},
      state: () => {},
      trouble: () => {},
    },
    model: 'stub-1',
    voiceId: 'v',
  });

  const opened = await companion.tick();
  assert.equal(opened, true, 'an hour in one app should be worth speaking up about');
  assert.match(llm.seen.at(-1)?.system ?? '', /YOU ARE SPEAKING FIRST/);
  assert.match(llm.seen.at(-1)?.system ?? '', /Xcode/);
});
