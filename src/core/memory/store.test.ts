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
