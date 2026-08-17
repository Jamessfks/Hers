import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MemoryStore } from './store.ts';
// -- the v1.0 speaker rename ------------------------------------------------

test('a database from before the rename keeps its history and accepts new turns', async () => {
  /*
   * The failure this exists to prevent: `CREATE TABLE IF NOT EXISTS` leaves an
   * old table alone, so a file written when she was called Anna still carries
   * `CHECK (speaker IN ('user', 'anna'))`. Without the rebuild, the first thing
   * she says after upgrading violates the constraint and the turn is lost.
   */
  const dir = await mkdtemp(path.join(tmpdir(), 'hers-migrate-'));
  const file = path.join(dir, 'memory.db');

  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE turns (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      speaker    TEXT    NOT NULL CHECK (speaker IN ('user', 'anna')),
      text       TEXT    NOT NULL,
      at         INTEGER NOT NULL,
      session_id TEXT    NOT NULL
    );
    INSERT INTO turns (speaker, text, at, session_id) VALUES
      ('user', 'my sister is called Mei', 1, 's1'),
      ('anna', 'the doctor in Boston?',   2, 's1');
  `);
  old.close();

  const store = new MemoryStore({ path: file });
  const turns = store.recentTurns(10);

  assert.equal(turns.length, 2, 'nothing was dropped on the way across');
  assert.deepEqual(
    turns.map((turn) => turn.speaker),
    ['user', 'her'],
    'her old turns are hers, under the name the code now uses',
  );
  assert.equal(turns[0]?.text, 'my sister is called Mei');
  assert.deepEqual(
    turns.map((turn) => turn.id),
    [1, 2],
    'ids are carried, or every fact pointing at a turn points at the wrong one',
  );

  // The whole point: the new value is now allowed.
  store.appendTurn({ speaker: 'her', text: 'she is, yes', at: 3, sessionId: 's2' });
  assert.equal(store.countTurns(), 3);

  // And running it again is a no-op rather than a second rebuild.
  store.close();
  const reopened = new MemoryStore({ path: file });
  assert.equal(reopened.countTurns(), 3);
  reopened.close();
});

test('a fresh database refuses a speaker that is neither of them', async () => {
  const store = new MemoryStore({ path: ':memory:' });
  assert.throws(
    () => store.appendTurn({ speaker: 'anna' as 'her', text: 'x', at: 1, sessionId: 's' }),
    /constraint/i,
    'the constraint is what makes the migration necessary; it has to be real',
  );
  store.close();
});

// -- one fact, said four ways -----------------------------------------------

/** A unit vector at `angle` radians in the first two dimensions. */
function at(angle: number): Float32Array {
  return new Float32Array([Math.cos(angle), Math.sin(angle), 0, 0]);
}

test('facts that restate each other do not take four slots in one prompt', () => {
  /*
   * From a real database. `upsertFact` dedupes on exact text, so the same
   * presentation was stored four times in three tenses — "coming up", "recently
   * completed", "last week that went very well" — and every recall handed the
   * model all four. It answered by inventing a continuity that fit them all.
   */
  const store = new MemoryStore({ path: ':memory:' });
  // Spaced so all three are above CROWDING_SIMILARITY against *each other*,
  // which is how the real four sat: 0.885 to 0.907 pairwise. A chain where only
  // adjacent pairs are close is a different case, and the one below it.
  const step = 0.2; // cos(0.2) = 0.980, cos(0.4) = 0.921
  const far = Math.acos(0.2);

  const add = (text: string, embedding: Float32Array, confidence = 0.9) =>
    store.upsertFact({
      kind: 'event',
      text,
      confidence,
      createdAt: 1,
      lastSeenAt: 1,
      sourceTurnId: null,
      embedding,
      embedderId: 'test',
    });

  add('they finished the presentation', at(0));
  add('they recently completed a major presentation', at(step));
  add('they had a presentation last week that went well', at(step * 2));
  add('their sister is a doctor in Chengdu', at(far));

  const recalled = store.recall(at(0), { limit: 8 });
  const texts = recalled.map((fact) => fact.text);

  assert.equal(recalled.length, 2, `one presentation, plus the sister: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes('presentation')), 'the best-scoring version survives');
  assert.ok(texts.includes('their sister is a doctor in Chengdu'), 'an unrelated fact is untouched');

  // Nothing was deleted. This is a crowding rule, not a merge.
  assert.equal(store.allFacts().length, 4, 'all four are still on disk and still in the UI');
  store.close();
});

test('a fact with no embedding is never crowded out by guesswork', () => {
  // Null embeddings happen: no API key at the time it was written, or a fact the
  // user typed in themselves. Similarity is unknowable, so it cannot be a reason
  // to drop one.
  const store = new MemoryStore({ path: ':memory:' });
  for (const text of ['typed by hand', 'also typed by hand']) {
    store.upsertFact({
      kind: 'identity',
      text,
      confidence: 0.9,
      createdAt: 1,
      lastSeenAt: 1,
      sourceTurnId: null,
      embedding: null,
      embedderId: undefined,
    });
  }

  assert.equal(store.recall(null, { limit: 8 }).length, 2);
  store.close();
});

test('crowding never returns more than asked for', () => {
  const store = new MemoryStore({ path: ':memory:' });
  for (let i = 0; i < 10; i += 1) {
    store.upsertFact({
      kind: 'event',
      text: `fact ${i}`,
      confidence: 0.9,
      createdAt: 1,
      lastSeenAt: 1,
      sourceTurnId: null,
      embedding: at(Math.acos(0.2) * i),
      embedderId: 'test',
    });
  }
  assert.equal(store.recall(at(0), { limit: 3 }).length, 3);
  store.close();
});

test('crowding is not transitive, because a chain is not a repetition', () => {
  /*
   * A is close to B, B is close to C, A is nothing like C. Suppressing C because
   * it resembles something already suppressed would throw away a fact nobody
   * ever said twice — so each candidate is compared only against what was kept.
   */
  const store = new MemoryStore({ path: ':memory:' });
  const step = Math.acos(0.86); // each neighbour just *below* the threshold
  ['a', 'b', 'c'].forEach((text, i) =>
    store.upsertFact({
      kind: 'event',
      text,
      confidence: 0.9,
      createdAt: 1,
      lastSeenAt: 1,
      sourceTurnId: null,
      embedding: at(step * i),
      embedderId: 'test',
    }),
  );

  assert.equal(store.recall(at(0), { limit: 8 }).length, 3, 'none of these restates another');
  store.close();
});
