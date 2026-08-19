import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Distiller } from './types.ts';
import { createLexicalEmbedder, similarity } from './embedder.ts';
import { Memory, parseExtraction, saysSomething } from './memory.ts';
import { RECALL_WEIGHTS } from './store.ts';
import { MemoryStore } from './store.ts';

function fixture(options: { distiller?: Distiller; now?: () => number } = {}) {
  const store = new MemoryStore({ path: ':memory:' });
  const memory = new Memory({
    store,
    embedder: createLexicalEmbedder(256),
    ...(options.distiller && { distiller: options.distiller }),
    ...(options.now && { now: options.now }),
  });
  return { store, memory };
}

function stubDistiller(reply: string, truncated = false): Distiller {
  return {
    async distil() {
      return { text: reply, truncated };
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
  store.appendTurn({ speaker: 'her', text: 'second', at: 2, sessionId: 's' });
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
    distiller: stubDistiller(
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
  memory.record('her', 'what are they going to make you do');
  await memory.consolidate();

  assert.equal(store.allFacts().length, 2);
  assert.match(store.latestSummary()?.text ?? '', /Interview week/);
  assert.equal(store.get('lastConsolidatedTurnId'), '2');
});

test('a failing consolidation never throws into the conversation', async () => {
  const failing: Distiller = {
    async distil() {
      throw new Error('network down');
    },
  };
  const { memory } = fixture({ distiller: failing });
  memory.record('user', 'hi');
  await assert.doesNotReject(() => memory.consolidate());
});

test('retrieval does not pin a fact at the top of recall forever', async () => {
  // Regression guard. `markRecalled` used to refresh `last_seen_at`, which made
  // recency self-reinforcing: a retrieved fact reset its own recency to 1.0,
  // which guaranteed it was retrieved again. The first facts learned would sit
  // at the top of every recall for the life of the install, and nothing learned
  // later could displace them.
  let clock = 1_000_000;
  const { store, memory } = fixture({ now: () => clock });

  await memory.remember('event', 'He adopted a cat named Pixel.', { confidence: 0.6 });

  // Two weeks of being retrieved every single turn.
  for (let turn = 0; turn < 40; turn += 1) {
    await memory.recall('anything at all');
    clock += 8 * 60 * 60 * 1000;
  }

  const [old] = store.allFacts();
  assert.ok((old?.recallCount ?? 0) >= 40, 'usage should still be counted');
  assert.equal(old?.lastSeenAt, 1_000_000, 'retrieval must not refresh last_seen_at');

  // Something new, said today, on an unrelated topic.
  await memory.remember('event', 'He is moving to Seattle in March.', { confidence: 0.6 });
  const hits = await memory.recallDetailed('unrelated query about the weather', 2);
  assert.match(hits[0]?.text ?? '', /Seattle/, 'a fresh fact must be able to outrank a stale one');
});

test('usage is damped so a few incumbents cannot crowd out everything', async () => {
  let clock = 1_000_000;
  const { store, memory } = fixture({ now: () => clock });
  await memory.remember('event', 'He adopted a cat named Pixel.');
  await memory.remember('event', 'He is moving to Seattle in March.');

  // Hammer the first fact's recall count far above the second's.
  const [first] = store.allFacts();
  store.markRecalled(Array.from({ length: 500 }, () => first!.id));

  const hits = store.recall(null, { limit: 2, now: clock });
  const spread = (hits[0]?.score ?? 0) - (hits[1]?.score ?? 0);
  assert.ok(spread < 0.1, `usage should be damped, but it opened a ${spread.toFixed(3)} gap`);
});

test('the transcript is one conversation, not every conversation', async () => {
  // beginSession existed and nothing ever called it, so the prompt replayed
  // messages from other days as the current conversation. she told a user they
  // were "looping" because she was reading three separate runs as one.
  let clock = 1_000_000;
  const { store, memory } = fixture({ now: () => clock });

  memory.record('user', 'monday thing');
  memory.record('her', 'monday reply');

  clock += 3 * 60 * 60 * 1000; // three hours later
  memory.record('user', 'tuesday thing');

  assert.deepEqual(
    memory.liveTranscript().map((turn) => turn.text),
    ['tuesday thing'],
    'a new session must not replay the old one',
  );
  assert.equal(store.countTurns(), 3, 'but nothing is lost from the record');
});

test('a short gap continues the same conversation', () => {
  let clock = 1_000_000;
  const { memory } = fixture({ now: () => clock });
  memory.record('user', 'first');
  clock += 5 * 60 * 1000; // five minutes
  memory.record('user', 'second');
  assert.equal(memory.liveTranscript().length, 2);
});

test('relaunching mid-conversation resumes it rather than forgetting', () => {
  let clock = 1_000_000;
  const store = new MemoryStore({ path: ':memory:' });
  const first = new Memory({ store, embedder: createLexicalEmbedder(128), now: () => clock });
  first.record('user', 'before the restart');

  clock += 60_000; // a minute later, app relaunches
  const second = new Memory({ store, embedder: createLexicalEmbedder(128), now: () => clock });
  assert.equal(second.sessionId, first.sessionId, 'should resume the live session');
  assert.deepEqual(
    second.liveTranscript().map((t) => t.text),
    ['before the restart'],
  );

  clock += 3 * 60 * 60 * 1000; // relaunch tomorrow
  const third = new Memory({ store, embedder: createLexicalEmbedder(128), now: () => clock });
  assert.notEqual(third.sessionId, first.sessionId, 'a long gap starts a new conversation');
  assert.deepEqual(third.liveTranscript(), []);
});

test('a gap long enough to start a new session does not make her a stranger', () => {
  /*
   * The bug this is here for: `hasHistory` counted turns in the *current*
   * session, which at wake — before anybody has spoken — is zero by
   * construction. So the conversation after a long gap was "the beginning", in
   * the same prompt that listed eight facts about the person.
   */
  let clock = 1_000_000;
  const store = new MemoryStore({ path: ':memory:' });
  const first = new Memory({ store, embedder: createLexicalEmbedder(128), now: () => clock });
  first.record('user', 'my sister is called Mei');
  first.record('her', 'Mei. I will remember that.');
  assert.equal(first.hasHistory, true);

  clock += 60 * 24 * 60 * 60 * 1000; // two months later
  const second = new Memory({ store, embedder: createLexicalEmbedder(128), now: () => clock });

  assert.equal(second.turnCount(), 0, 'the session about to start really is empty');
  assert.equal(second.runningSummary(), undefined, 'and consolidation never produced a summary');
  assert.equal(second.hasHistory, true, 'but they have met, and she must be told so');
});

test('facts alone are enough to have met, with the transcript gone', async () => {
  const { store, memory } = fixture();
  assert.equal(memory.hasHistory, false, 'an empty store is a stranger, and should say so');

  await memory.remember('identity', 'Their sister is called Mei.');

  assert.equal(store.countTurns(), 0, 'nothing was ever said in front of this store');
  assert.equal(memory.hasHistory, true, 'and she still knows something about them');
});

// -- a reply that ran out of room -------------------------------------------

test('a fact cut off mid-sentence is not kept', () => {
  /*
   * The line at the bottom is what actually happened, on a real scan: the reply
   * hit its output ceiling and the last fact ended at a comma. It parsed as a
   * complete fact and was stored for good.
   */
  const raw = [
    'FACTS',
    'identity | 0.8 | they are a computer science student',
    'thread | 0.8 | they are applying for AI/ML co-op roles for Spring 2027',
    'preference | 0.8 | they have a deep interest in liminal spaces and analog horror,',
  ].join('\n');

  const whole = parseExtraction(raw);
  assert.equal(whole.facts.length, 3, 'told nothing about the budget, it keeps all three');

  const cut = parseExtraction(raw, { truncated: true });
  assert.deepEqual(
    cut.facts.map((fact) => fact.text),
    ['they are a computer science student', 'they are applying for AI/ML co-op roles for Spring 2027'],
    'the fragment goes and the two complete facts before it stay',
  );
});

test('a truncated reply that reached SUMMARY has whole facts', () => {
  // The heading is the evidence: to write it, the model had finished the facts.
  // Dropping one here would throw away something complete.
  const raw = [
    'FACTS',
    'identity | 0.9 | their sister is called Mei',
    'event | 0.8 | they finished a presentation on Monday',
    'SUMMARY',
    'They had a hard week and it is over. They are wondering whether to',
  ].join('\n');

  const cut = parseExtraction(raw, { truncated: true });
  assert.equal(cut.facts.length, 2, 'both facts were finished before the cut');
  assert.equal(
    cut.summary,
    'They had a hard week and it is over.',
    'the half sentence goes; this text gets merged forward for weeks',
  );
});

test('a truncated summary with no finished sentence is no summary', () => {
  const cut = parseExtraction(['FACTS', 'SUMMARY', 'They have been'].join('\n'), {
    truncated: true,
  });
  assert.equal(cut.summary, '', 'better nothing than a fragment carried forward');
});

test('one fact, cut, leaves none rather than half of one', () => {
  const cut = parseExtraction(['FACTS', 'identity | 0.8 | they are a computer scien'].join('\n'), {
    truncated: true,
  });
  assert.deepEqual(cut.facts, []);
});

test('nothing is dropped from a reply that finished', () => {
  const raw = ['FACTS', 'identity | 0.9 | their sister is called Mei', 'SUMMARY', 'A quiet week.'].join('\n');
  const whole = parseExtraction(raw, { truncated: false });
  assert.equal(whole.facts.length, 1);
  assert.equal(whole.summary, 'A quiet week.');
});

test('a truncated consolidation stores the complete facts and drops the fragment', async () => {
  // End to end through `Memory`, because the parser being right is only half of
  // it — the flag has to survive the trip from the distiller to the parser.
  const { memory } = fixture({
    distiller: stubDistiller(
      [
        'FACTS',
        'identity | 0.9 | their sister is called Mei',
        'preference | 0.8 | they are interested in liminal spaces and',
      ].join('\n'),
      true,
    ),
  });

  memory.record('user', 'my sister is called Mei');
  await memory.consolidate();

  assert.deepEqual(
    memory.allFacts().map((fact) => fact.text),
    ['their sister is called Mei'],
  );
});

test('a cut that lands in the next line does not cost the fact above it', () => {
  /*
   * Verbatim shape of a real reply cut at 1100 tokens. `identity | high |` has no
   * sentence, so it is skipped regardless; the fact above it ends with a newline,
   * which is the evidence that it finished. An earlier version of this rule popped
   * it anyway and lost a good memory on every truncated reply.
   */
  const raw = [
    'FACTS',
    'identity | high | The user studies CS at Northeastern University.',
    'pattern | high | The user builds iOS apps.',
    'identity | high |',
  ].join('\n');

  const cut = parseExtraction(raw, { truncated: true });
  assert.deepEqual(
    cut.facts.map((fact) => fact.text),
    ['The user studies CS at Northeastern University.', 'The user builds iOS apps.'],
  );
});

test('a trailing newline is proof the last fact finished', () => {
  const raw = 'FACTS\nidentity | 0.9 | their sister is called Mei\n';
  assert.equal(parseExtraction(raw, { truncated: true }).facts.length, 1);
});

test('a confidence the model wrote in words still yields a fact', () => {
  // Seen live: `pattern | high | …`. Unparseable numbers fall back rather than
  // dropping the sentence, which is the older half of this parser's job.
  const [fact] = parseExtraction('FACTS\npattern | high | they run most days.\n').facts;
  assert.equal(fact?.text, 'they run most days.');
  assert.equal(fact?.confidence, 0.6);
});

// -- a fact has to say something --------------------------------------------

test('a fragment that names a subject and says nothing is not stored', async () => {
  /*
   * From a real store: `"The user"`, written by a truncation bug, with six
   * recalls. It was not inert — a two-word fact embeds near everything, so it
   * ranked highly on every question, and `markRecalled` pushed it higher each
   * time. It held the top slot of an eight-fact budget against facts that
   * answered the question.
   */
  assert.equal(saysSomething('The user'), false);
  assert.equal(saysSomething('They'), false);
  assert.equal(saysSomething('   '), false);

  assert.equal(saysSomething('Their younger sister is named Mei-Lin.'), true);
  assert.equal(saysSomething('They hate cilantro.'), true, 'short but complete');
  // Not claimed: a three-word fragment that happens to be long enough. Nothing
  // short of parsing separates "the person recently" from the line above it.

  const { memory } = fixture();
  await memory.remember('pattern', 'The user');
  await memory.remember('identity', 'Their younger sister is named Mei-Lin.');
  assert.deepEqual(
    memory.allFacts().map((f) => f.text),
    ['Their younger sister is named Mei-Lin.'],
  );
});

test('recall no longer rewards a fact for having been recalled', () => {
  // `markRecalled` increments the count that `usage` read, so being chosen made a
  // fact more likely to be chosen again with nothing pulling the other way — the
  // same feedback loop `markRecalled`'s own docstring explains it avoids for
  // recency. Measured, it let a two-word fact outrank the answer.
  assert.equal(RECALL_WEIGHTS.usage, 0);
  const total =
    RECALL_WEIGHTS.similarity + RECALL_WEIGHTS.recency + RECALL_WEIGHTS.confidence + RECALL_WEIGHTS.usage;
  assert.ok(Math.abs(total - 1) < 1e-9, `weights must still sum to 1, got ${total}`);
});
