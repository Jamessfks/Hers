import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CompletionRequest, LlmProvider } from '../llm/types.ts';
import { createLexicalEmbedder, similarity } from './embedder.ts';
import { Memory, parseExtraction } from './memory.ts';
import { MemoryStore } from './store.ts';

function fixture(options: { llm?: LlmProvider; now?: () => number } = {}) {
  const store = new MemoryStore({ path: ':memory:' });
  const memory = new Memory({
    store,
    embedder: createLexicalEmbedder(256),
    ...(options.llm && { llm: options.llm }),
    ...(options.now && { now: options.now }),
  });
  return { store, memory };
}

function stubLlm(reply: string): LlmProvider {
  return {
    id: 'stub',
    label: 'stub',
    suggestedModels: ['stub-1'],
    async *stream(_request: CompletionRequest) {
      yield reply;
    },
    async validateKey() {
      return { ok: true as const };
    },
  };
}

// -- embedder ---------------------------------------------------------------

test('lexical embedder scores related sentences above unrelated ones', async () => {
  const embedder = createLexicalEmbedder(512);
  const [interview, interviewAgain, dinner] = await embedder.embed([
    'He is nervous about the Google interview on Thursday.',
    'The interview at Google went badly.',
    'She makes excellent dumplings on Sundays.',
  ]);
  assert.ok(interview && interviewAgain && dinner);
  assert.ok(
    similarity(interview, interviewAgain) > similarity(interview, dinner),
    'topical overlap must beat unrelated text',
  );
});

test('embeddings are unit length and deterministic', async () => {
  const embedder = createLexicalEmbedder(128);
  const [a] = await embedder.embed(['the same sentence twice']);
  const [b] = await embedder.embed(['the same sentence twice']);
  assert.ok(a && b);
  assert.equal(similarity(a, b), similarity(a, a));
  assert.ok(Math.abs(similarity(a, a) - 1) < 1e-5, 'expected unit length');
});

// -- store ------------------------------------------------------------------

test('turns round-trip in order', () => {
  const { store } = fixture();
  store.appendTurn({ speaker: 'user', text: 'first', at: 1, sessionId: 's' });
  store.appendTurn({ speaker: 'anna', text: 'second', at: 2, sessionId: 's' });
  assert.deepEqual(
    store.recentTurns(10).map((turn) => turn.text),
    ['first', 'second'],
  );
});

test('embeddings survive a round-trip through the blob column', async () => {
  const { store } = fixture();
  const [vector] = await createLexicalEmbedder(64).embed(['his sister is called Mei']);
  assert.ok(vector);
  store.upsertFact({
    kind: 'identity',
    text: 'His sister is called Mei.',
    confidence: 0.9,
    createdAt: 1,
    lastSeenAt: 1,
    sourceTurnId: null,
    embedding: vector,
  });
  const [stored] = store.allFacts();
  assert.ok(stored?.embedding);
  assert.ok(Math.abs(similarity(vector, stored.embedding) - 1) < 1e-5, 'vector must survive intact');
});

test('recall prefers the topically relevant fact', async () => {
  const { store, memory } = fixture();
  await memory.remember('event', 'He has a Google interview on Thursday.', { confidence: 0.9 });
  await memory.remember('preference', 'He hates cilantro.', { confidence: 0.9 });
  const [top] = await memory.recallDetailed('how did the interview go', 2);
  assert.match(top?.text ?? '', /interview/i);
  assert.equal(store.allFacts().length, 2);
});

test('recall falls back to recency when nothing matches semantically', async () => {
  let clock = 1_000_000;
  const { memory } = fixture({ now: () => clock });
  await memory.remember('event', 'He adopted a cat named Pixel.');
  clock += 60 * 24 * 60 * 60 * 1000; // two months later
  await memory.remember('event', 'He started running in the mornings.');
  const hits = await memory.recallDetailed('unrelated query about quantum mechanics', 1);
  assert.match(hits[0]?.text ?? '', /running/, 'the fresher fact should win a semantic tie');
});

test('near-duplicate facts merge instead of accumulating', async () => {
  const { store, memory } = fixture();
  assert.equal(await memory.remember('event', 'He has a Google interview on Thursday.'), 'created');
  assert.equal(await memory.remember('event', 'He has a Google interview on Thursday.'), 'merged');
  assert.equal(store.allFacts().length, 1);
});

test('markRecalled raises usage without duplicating rows', async () => {
  const { store, memory } = fixture();
  await memory.remember('preference', 'He likes being left alone before noon.');
  await memory.recall('mornings');
  await memory.recall('mornings');
  const [fact] = store.allFacts();
  assert.equal(store.allFacts().length, 1);
  assert.ok((fact?.recallCount ?? 0) >= 2);
});

test('wipe removes everything', async () => {
  const { store, memory } = fixture();
  memory.record('user', 'hello');
  await memory.remember('identity', 'He is called Zicheng.');
  store.wipe();
  assert.equal(store.countTurns(), 0);
  assert.equal(store.allFacts().length, 0);
});

// -- extraction parsing -----------------------------------------------------

test('parses a well-formed extraction', () => {
  const { facts, summary } = parseExtraction(
    [
      'FACTS',
      'identity | 0.95 | His sister is called Mei.',
      'thread | 0.7 | He is waiting to hear back from Google.',
      '',
      'SUMMARY',
      'He interviewed at Google on Thursday and thinks it went badly.',
    ].join('\n'),
  );
  assert.equal(facts.length, 2);
  assert.deepEqual(facts[0], {
    kind: 'identity',
    confidence: 0.95,
    text: 'His sister is called Mei.',
  });
  assert.match(summary, /interviewed at Google/);
});

test('extraction tolerates fences, preamble and bulleted lines', () => {
  const { facts } = parseExtraction(
    [
      "Sure! Here's what I found:",
      '```',
      'FACTS',
      '- event | 0.8 | He adopted a cat.',
      'garbage line with no pipes',
      'nonsense | 0.5 | invalid kind is dropped',
      '```',
      'SUMMARY',
      'Quiet week.',
    ].join('\n'),
  );
  assert.deepEqual(facts, [{ kind: 'event', confidence: 0.8, text: 'He adopted a cat.' }]);
});

test('consolidation writes facts and a summary', async () => {
  const { store, memory } = fixture({
    llm: stubLlm(
      [
        'FACTS',
        'identity | 0.9 | He is called Zicheng.',
        'thread | 0.8 | He is waiting on a Google decision.',
        'SUMMARY',
        'Interview week. He is anxious and not sleeping much.',
      ].join('\n'),
    ),
  });

  memory.record('user', 'i have a google interview thursday');
  memory.record('anna', 'what are they going to make you do');
  await memory.consolidate();

  assert.equal(store.allFacts().length, 2);
  assert.match(store.latestSummary()?.text ?? '', /Interview week/);
  assert.equal(store.get('lastConsolidatedTurnId'), '2');
});

test('a failing consolidation never throws into the conversation', async () => {
  const failing: LlmProvider = {
    id: 'boom',
    label: 'boom',
    suggestedModels: ['x'],
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('network down');
    },
    async validateKey() {
      return { ok: true as const };
    },
  };
  const { memory } = fixture({ llm: failing });
  memory.record('user', 'hi');
  await assert.doesNotReject(() => memory.consolidate());
});
