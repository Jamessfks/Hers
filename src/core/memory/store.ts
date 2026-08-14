/**
 * SQLite-backed memory store.
 *
 * Uses `node:sqlite` from the standard library rather than `better-sqlite3`.
 * The reason is deployment, not taste: a native addon has to be rebuilt against
 * Electron's ABI on every Electron bump and on every architecture we ship, and
 * a companion app that fails to launch after an auto-update because a `.node`
 * file was built for the wrong V8 is a companion the user deletes. Electron 43
 * carries Node 24, where `node:sqlite` is built in, so the dependency is zero
 * and the ABI problem does not exist. See docs/adr/0002-memory-storage.md.
 *
 * Vector search is a brute-force scan. At the volume a single human generates —
 * a few thousand facts after years of use — a linear pass over normalised
 * Float32Arrays costs well under a millisecond, and an index would be pure
 * complexity. If this ever stops being true the interface is narrow enough to
 * swap.
 */

import { DatabaseSync } from 'node:sqlite';

import { similarity } from './embedder.ts';
import type { Fact, FactKind, RecalledFact, Summary, Turn } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  speaker    TEXT    NOT NULL CHECK (speaker IN ('user', 'anna')),
  text       TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  session_id TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_at ON turns (at DESC);
CREATE INDEX IF NOT EXISTS turns_session ON turns (session_id, id);

CREATE TABLE IF NOT EXISTS facts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT    NOT NULL,
  text           TEXT    NOT NULL,
  confidence     REAL    NOT NULL DEFAULT 0.6,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  recall_count   INTEGER NOT NULL DEFAULT 0,
  source_turn_id INTEGER,
  embedding      BLOB,
  embedder       TEXT
);
CREATE INDEX IF NOT EXISTS facts_kind ON facts (kind);
CREATE UNIQUE INDEX IF NOT EXISTS facts_text ON facts (text);

CREATE TABLE IF NOT EXISTS summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  text         TEXT    NOT NULL,
  from_turn_id INTEGER NOT NULL,
  to_turn_id   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Tunes how the four ranking signals trade off. They sum to 1. */
export const RECALL_WEIGHTS = {
  similarity: 0.62,
  recency: 0.18,
  confidence: 0.12,
  usage: 0.08,
} as const;

/** A fact stops getting a recency boost after this long. */
const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

export interface StoreOptions {
  /** Path to the database file, or ':memory:' for tests. */
  path: string;
}

export class MemoryStore {
  readonly #db: DatabaseSync;

  constructor(options: StoreOptions) {
    this.#db = new DatabaseSync(options.path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  // -- turns ---------------------------------------------------------------

  appendTurn(turn: Omit<Turn, 'id'>): Turn {
    const statement = this.#db.prepare(
      'INSERT INTO turns (speaker, text, at, session_id) VALUES (?, ?, ?, ?)',
    );
    const result = statement.run(turn.speaker, turn.text, turn.at, turn.sessionId);
    return { ...turn, id: Number(result.lastInsertRowid) };
  }

  /** Most recent turns, oldest first so they can be replayed as messages. */
  recentTurns(limit = 40): Turn[] {
    const rows = this.#db
      .prepare('SELECT * FROM turns ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as TurnRow[];
    return rows.reverse().map(toTurn);
  }

  /**
   * The turns belonging to one continuous stretch of talking.
   *
   * This is what "the current conversation" means. `recentTurns` spans the
   * whole history, which is right for consolidation and wrong for the prompt —
   * replaying last Tuesday's messages as if they were this conversation is how
   * a companion ends up accusing someone of repeating themselves.
   */
  turnsInSession(sessionId: string, limit = 40): Turn[] {
    const rows = this.#db
      .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit) as unknown as TurnRow[];
    return rows.reverse().map(toTurn);
  }

  /** The most recent turn of all, used to decide whether to resume a session. */
  lastTurn(): Turn | null {
    const row = this.#db
      .prepare('SELECT * FROM turns ORDER BY id DESC LIMIT 1')
      .get() as unknown as TurnRow | undefined;
    return row ? toTurn(row) : null;
  }

  turnsSince(turnId: number, limit = 500): Turn[] {
    const rows = this.#db
      .prepare('SELECT * FROM turns WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(turnId, limit) as unknown as TurnRow[];
    return rows.map(toTurn);
  }

  countTurns(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM turns').get() as unknown as { n: number };
    return row.n;
  }

  // -- facts ---------------------------------------------------------------

  /**
   * Inserts a fact, or refreshes the existing one if the exact text is already
   * known. Near-duplicate detection is the caller's job — it needs embeddings,
   * and the store deliberately does not make network calls.
   */
  upsertFact(fact: Omit<Fact, 'id' | 'recallCount'> & { embedderId?: string }): number {
    const existing = this.#db.prepare('SELECT id FROM facts WHERE text = ?').get(fact.text) as unknown as
      | { id: number }
      | undefined;

    if (existing) {
      this.#db
        .prepare(
          `UPDATE facts
             SET last_seen_at = ?,
                 confidence = MAX(confidence, ?),
                 recall_count = recall_count + 1
           WHERE id = ?`,
        )
        .run(fact.lastSeenAt, fact.confidence, existing.id);
      return existing.id;
    }

    const result = this.#db
      .prepare(
        `INSERT INTO facts
           (kind, text, confidence, created_at, last_seen_at, source_turn_id, embedding, embedder)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.kind,
        fact.text,
        fact.confidence,
        fact.createdAt,
        fact.lastSeenAt,
        fact.sourceTurnId,
        fact.embedding ? toBlob(fact.embedding) : null,
        fact.embedderId ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  allFacts(kinds?: readonly FactKind[]): Fact[] {
    const rows = (
      kinds?.length
        ? this.#db
            .prepare(
              `SELECT * FROM facts WHERE kind IN (${kinds.map(() => '?').join(',')})`,
            )
            .all(...kinds)
        : this.#db.prepare('SELECT * FROM facts').all()
    ) as unknown as FactRow[];
    return rows.map(toFact);
  }

  /**
   * Ranks facts against a query vector.
   *
   * Similarity alone retrieves things that are topically close but stale, which
   * is how a companion ends up asking about a job you left last year. Recency,
   * stated confidence and how often a fact has proved useful are all folded in.
   */
  recall(
    queryEmbedding: Float32Array | null,
    options: { limit?: number; kinds?: readonly FactKind[]; now?: number } = {},
  ): RecalledFact[] {
    const now = options.now ?? Date.now();
    const limit = options.limit ?? 8;
    const facts = this.allFacts(options.kinds);
    if (facts.length === 0) return [];

    const maxRecall = Math.max(1, ...facts.map((fact) => fact.recallCount));

    const scored = facts.map((fact): RecalledFact => {
      const semantic =
        queryEmbedding && fact.embedding ? Math.max(0, similarity(queryEmbedding, fact.embedding)) : 0;
      const age = Math.max(0, now - fact.lastSeenAt);
      const recency = Math.exp((-Math.LN2 * age) / RECENCY_HALF_LIFE_MS);
      // Log-damped: the difference between 1 and 10 recalls should matter,
      // the difference between 100 and 1000 should not.
      const usage = Math.log1p(fact.recallCount) / Math.log1p(maxRecall);
      const score =
        RECALL_WEIGHTS.similarity * semantic +
        RECALL_WEIGHTS.recency * recency +
        RECALL_WEIGHTS.confidence * fact.confidence +
        RECALL_WEIGHTS.usage * usage;
      return { ...fact, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Notes that these facts were used in a turn.
   *
   * Deliberately does *not* touch `last_seen_at`. That column means "the last
   * time the world confirmed this", and only {@link upsertFact} may write it.
   * Refreshing it on retrieval creates a feedback loop that is invisible until
   * it has ruined the product: a retrieved fact resets its own recency to 1.0,
   * which guarantees it is retrieved again, which resets it again. The first
   * facts learned would be pinned to the top of every recall forever, and
   * nothing learned later could displace them.
   */
  markRecalled(ids: readonly number[]): void {
    if (ids.length === 0) return;
    const statement = this.#db.prepare(
      'UPDATE facts SET recall_count = recall_count + 1 WHERE id = ?',
    );
    for (const id of ids) statement.run(id);
  }

  forgetFact(id: number): void {
    this.#db.prepare('DELETE FROM facts WHERE id = ?').run(id);
  }

  // -- summaries -----------------------------------------------------------

  appendSummary(summary: Omit<Summary, 'id'>): number {
    const result = this.#db
      .prepare(
        'INSERT INTO summaries (text, from_turn_id, to_turn_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(summary.text, summary.fromTurnId, summary.toTurnId, summary.createdAt);
    return Number(result.lastInsertRowid);
  }

  latestSummary(): Summary | null {
    const row = this.#db.prepare('SELECT * FROM summaries ORDER BY id DESC LIMIT 1').get() as unknown as
      | SummaryRow
      | undefined;
    return row
      ? {
          id: row.id,
          text: row.text,
          fromTurnId: row.from_turn_id,
          toTurnId: row.to_turn_id,
          createdAt: row.created_at,
        }
      : null;
  }

  // -- meta ----------------------------------------------------------------

  get(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.#db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, value, value);
  }

  /**
   * Deletes everything.
   *
   * A companion that cannot be made to forget is a liability rather than a
   * comfort, so this exists and is tested. It has no caller yet: the settings
   * window that should own the button is not built. Until then, deleting
   * `memory.db` from the app's data directory is the supported route.
   */
  wipe(): void {
    this.#db.exec('DELETE FROM turns; DELETE FROM facts; DELETE FROM summaries; DELETE FROM meta;');
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface TurnRow {
  id: number;
  speaker: 'user' | 'anna';
  text: string;
  at: number;
  session_id: string;
}

interface FactRow {
  id: number;
  kind: string;
  text: string;
  confidence: number;
  created_at: number;
  last_seen_at: number;
  recall_count: number;
  source_turn_id: number | null;
  embedding: Uint8Array | null;
}

interface SummaryRow {
  id: number;
  text: string;
  from_turn_id: number;
  to_turn_id: number;
  created_at: number;
}

function toTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    speaker: row.speaker,
    text: row.text,
    at: row.at,
    sessionId: row.session_id,
  };
}

function toFact(row: FactRow): Fact {
  return {
    id: row.id,
    kind: row.kind as FactKind,
    text: row.text,
    confidence: row.confidence,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    recallCount: row.recall_count,
    sourceTurnId: row.source_turn_id,
    embedding: row.embedding ? fromBlob(row.embedding) : null,
  };
}

function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(0) as ArrayBuffer);
}

function fromBlob(blob: Uint8Array): Float32Array {
  // The blob may be a view into a larger buffer and may not be 4-byte aligned,
  // so copy rather than wrapping in place.
  const copy = new Uint8Array(blob.length);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
