/**
 * The memory facade: the only memory API the rest of she uses.
 *
 * Responsibilities, in the order they matter:
 *
 *  1. Record every turn. Cheap, synchronous, never blocks a reply.
 *  2. Retrieve the handful of facts worth putting in the next prompt.
 *  3. Consolidate, in the background: distil raw turns into durable facts and
 *     keep a rolling summary so old transcript can fall out of context without
 *     her losing the thread.
 *
 * Consolidation runs off the critical path deliberately. It costs a model call,
 * and a companion that pauses for two seconds every twelfth turn to think about
 * its filing system is a companion with a stutter.
 */

import { similarity } from './embedder.ts';
import { MemoryStore } from './store.ts';
import type { Distiller, Embedder, FactKind, RecalledFact } from './types.ts';

/** Above this cosine similarity two facts are the same fact. */
const DUPLICATE_THRESHOLD = 0.92;
/** Consolidate after this many new turns. */
const CONSOLIDATE_EVERY_TURNS = 12;
/** Turns replayed verbatim into the prompt; older context comes from summaries. */
const LIVE_TRANSCRIPT_TURNS = 24;

/**
 * A gap this long ends the conversation.
 *
 * `beginSession` existed and was never called by anything, so every turn since
 * install belonged to one endless session and the prompt replayed messages from
 * other days as the current conversation. Observed consequence: her telling
 * someone they were "looping" and had said the same thing "yesterday, and the
 * day before" — she was reading three separate test runs as one conversation.
 *
 * Forty-five minutes is long enough to survive lunch, a meeting or a restart
 * mid-thought, and short enough that tomorrow morning is plainly a new
 * conversation. What carries across the boundary is facts and the rolling
 * summary — which is exactly what a person carries across it too.
 */
const SESSION_GAP_MS = 45 * 60 * 1000;

const VALID_KINDS = new Set<FactKind>(['identity', 'preference', 'thread', 'event', 'pattern']);

export interface MemoryOptions {
  store: MemoryStore;
  embedder: Embedder;
  /**
   * Turns a transcript into facts. Omit and memory still records and recalls
   * everything — it simply never distils, which is the right behaviour when
   * there is no API key rather than a reason to fail.
   */
  distiller?: Distiller;
  /** Injectable for tests. */
  now?: () => number;
}

export class Memory {
  readonly #store: MemoryStore;
  readonly #embedder: Embedder;
  readonly #distiller: Distiller | undefined;
  readonly #now: () => number;
  #sessionId: string;
  #lastTurnAt: number;
  #turnsSinceConsolidation = 0;
  #consolidating: Promise<void> | null = null;

  constructor(options: MemoryOptions) {
    this.#store = options.store;
    this.#embedder = options.embedder;
    this.#distiller = options.distiller;
    this.#now = options.now ?? (() => Date.now());

    // Resume rather than always starting fresh: relaunching the app in the
    // middle of a conversation should continue it, not amnesia.
    const last = this.#store.lastTurn();
    const recent = last !== null && this.#now() - last.at < SESSION_GAP_MS;
    this.#sessionId = recent ? last.sessionId : crypto.randomUUID();
    this.#lastTurnAt = recent ? last.at : 0;
  }

  /**
   * Releases the database handle.
   *
   * Needed before the file can be deleted or reopened. Windows will not unlink
   * a file that is still open, so a reset that skipped this would leave the old
   * memory on disk on exactly one of the two platforms she is on.
   */
  dispose(): void {
    this.#store.close();
  }

  /** Starts a new continuous stretch of conversation. */
  beginSession(): void {
    this.#sessionId = crypto.randomUUID();
    this.#lastTurnAt = 0;
  }

  /** The conversation currently in progress. */
  get sessionId(): string {
    return this.#sessionId;
  }

  record(speaker: 'user' | 'her', text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const at = this.#now();

    // A long silence ends the conversation and starts a new one.
    if (this.#lastTurnAt > 0 && at - this.#lastTurnAt > SESSION_GAP_MS) this.beginSession();
    this.#lastTurnAt = at;

    this.#store.appendTurn({
      speaker,
      text: trimmed,
      at,
      sessionId: this.#sessionId,
    });
    this.#turnsSinceConsolidation += 1;
  }

  /**
   * Turns to replay verbatim into the next prompt, oldest first.
   *
   * Scoped to the current session. Everything older reaches her through facts
   * and the rolling summary, which is the difference between remembering a
   * conversation and re-reading it.
   */
  liveTranscript(limit = LIVE_TRANSCRIPT_TURNS) {
    return this.#store.turnsInSession(this.#sessionId, limit);
  }

  /**
   * Turns in the current conversation.
   *
   * Counted from the store rather than from `liveTranscript().length`, which is
   * capped at 24 — so the prompt used to claim "24 turns" forever once a
   * conversation got long, and ran a second full query to say it.
   */
  turnCount(): number {
    return this.#store.countTurnsInSession(this.#sessionId);
  }

  runningSummary(): string | undefined {
    return this.#store.latestSummary()?.text;
  }

  /**
   * The facts worth showing her before she answers `text`.
   *
   * Returns plain sentences rather than structured facts: the prompt reads
   * better, and every attempt to give a model a schema for its own memories has
   * ended with it reciting the schema out loud.
   */
  async recall(text: string, limit = 8): Promise<string[]> {
    const [query] = await this.#embedQuietly([text]);
    const hits = this.#store.recall(query ?? null, { limit, now: this.#now() });
    this.#store.markRecalled(hits.map((hit) => hit.id));
    return hits.map((hit) => hit.text);
  }

  /** Same as {@link recall} but keeps the scores, for the memory inspector. */
  async recallDetailed(text: string, limit = 8): Promise<RecalledFact[]> {
    const [query] = await this.#embedQuietly([text]);
    return this.#store.recall(query ?? null, { limit, now: this.#now() });
  }

  /**
   * Writes a fact directly. Used by consolidation and by the user saying
   * something she should obviously keep ("my sister's name is Mei").
   *
   * Near-duplicates are merged rather than accumulated. Without this, a person
   * who mentions their job three times ends up with three nearly identical
   * facts, all of which get retrieved together, crowding out everything else.
   */
  async remember(
    kind: FactKind,
    text: string,
    options: { confidence?: number; sourceTurnId?: number } = {},
  ): Promise<'created' | 'merged'> {
    const clean = text.trim();
    if (!clean) return 'merged';
    const now = this.#now();
    const [embedding] = await this.#embedQuietly([clean]);

    if (embedding) {
      for (const existing of this.#store.allFacts()) {
        if (!existing.embedding) continue;
        if (similarity(embedding, existing.embedding) >= DUPLICATE_THRESHOLD) {
          this.#store.upsertFact({
            ...existing,
            lastSeenAt: now,
            confidence: Math.max(existing.confidence, options.confidence ?? 0.6),
          });
          return 'merged';
        }
      }
    }

    this.#store.upsertFact({
      kind,
      text: clean,
      confidence: options.confidence ?? 0.6,
      createdAt: now,
      lastSeenAt: now,
      sourceTurnId: options.sourceTurnId ?? null,
      embedding: embedding ?? null,
      embedderId: this.#embedder.id,
    });
    return 'created';
  }

  /**
   * Everything she remembers, newest first.
   *
   * For the editor, not for the prompt — recall picks what is relevant, this
   * shows what exists. OpenClaw states the principle first and states it
   * plainly: "No hidden state. Every memory surface is inspectable and editable
   * with a text editor." A SQLite store does not get that for free, so it has
   * to be handed out deliberately.
   */
  allFacts() {
    return this.#store.allFacts().sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Rewrites one fact. Re-embedded, so recall follows the new wording. */
  async reword(id: number, text: string): Promise<boolean> {
    const clean = text.trim();
    if (!clean) return false;
    const existing = this.#store.allFacts().find((fact) => fact.id === id);
    if (!existing) return false;

    const [embedding] = await this.#embedQuietly([clean]);
    this.#store.forgetFact(id);
    this.#store.upsertFact({
      kind: existing.kind,
      text: clean,
      // Edited by hand, so it is now as certain as anything gets.
      confidence: Math.max(existing.confidence, 0.9),
      createdAt: existing.createdAt,
      lastSeenAt: this.#now(),
      sourceTurnId: existing.sourceTurnId,
      embedding: embedding ?? null,
      embedderId: this.#embedder.id,
    });
    return true;
  }

  /** Makes her forget one thing, permanently. */
  forget(id: number): void {
    this.#store.forgetFact(id);
  }

  /** True when enough has happened to justify a consolidation pass. */
  get needsConsolidation(): boolean {
    return this.#turnsSinceConsolidation >= CONSOLIDATE_EVERY_TURNS;
  }

  /**
   * Distils recent turns into facts and refreshes the rolling summary.
   *
   * Safe to call at any time; concurrent calls collapse into one. Never throws:
   * a failed consolidation must not take down a conversation.
   */
  async consolidate(): Promise<void> {
    if (this.#consolidating) return this.#consolidating;
    this.#consolidating = this.#runConsolidation().finally(() => {
      this.#consolidating = null;
    });
    return this.#consolidating;
  }

  async #runConsolidation(): Promise<void> {
    const distiller = this.#distiller;
    if (!distiller) return;

    const lastConsolidated = Number(this.#store.get('lastConsolidatedTurnId') ?? '0');
    const turns = this.#store.turnsSince(lastConsolidated);
    if (turns.length === 0) return;

    // Labelled by role, not by name. She chooses her own name on the first
    // conversation, and a transcript that called her Anna while she is called
    // something else would be asking the distiller to reason about two people.
    const transcript = turns
      .map((turn) => `${turn.speaker === 'user' ? 'Them' : 'Her'}: ${turn.text}`)
      .join('\n');

    try {
      const { text: raw, truncated } = await distiller.distil(EXTRACTION_PROMPT, transcript);
      if (truncated) {
        // Said out loud because the remedy is a bigger budget, and from the
        // outside a dropped fact is indistinguishable from a quiet conversation.
        console.warn('  consolidation ran out of output budget; the last fact was dropped');
      }
      const parsed = parseExtraction(raw, { truncated });
      for (const fact of parsed.facts) {
        await this.remember(fact.kind, fact.text, { confidence: fact.confidence });
      }

      if (parsed.summary) {
        const previous = this.#store.latestSummary();
        this.#store.appendSummary({
          text: previous ? mergeSummaries(previous.text, parsed.summary) : parsed.summary,
          fromTurnId: turns[0]?.id ?? 0,
          toTurnId: turns.at(-1)?.id ?? 0,
          createdAt: this.#now(),
        });
      }

      this.#store.set('lastConsolidatedTurnId', String(turns.at(-1)?.id ?? lastConsolidated));
      this.#turnsSinceConsolidation = 0;
    } catch {
      // Leave the watermark alone so the next pass retries the same window.
      this.#turnsSinceConsolidation = 0;
    }
  }

  /** Embedding failures degrade recall; they must never break a conversation. */
  async #embedQuietly(texts: readonly string[]): Promise<(Float32Array | undefined)[]> {
    try {
      return await this.#embedder.embed(texts);
    } catch {
      return texts.map(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Consolidation prompt and parsing
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `
You maintain the long-term memory of an AI companion. You are reading a
transcript between her, marked "Her", and the person she lives with, marked
"Them".

Return exactly two sections and nothing else.

FACTS
One fact per line, formatted: kind | confidence | sentence
  kind is one of: identity, preference, thread, event, pattern
  confidence is 0.0 to 1.0
  sentence is one short third-person sentence about the person, not about her

Record only things that will still matter in a month. A durable fact is their
sister's name, the job they are interviewing for, that they hate being asked how
they slept. Not "they said hello", not "they seem tired today", and never
anything the companion said about herself.

Prefer no facts over weak facts. Zero lines is a valid answer.

SUMMARY
Two or three sentences on what has been going on for this person lately, written
so that someone who missed the conversation could pick the thread back up.
`.trim();

export interface ExtractedFact {
  kind: FactKind;
  confidence: number;
  text: string;
}

/**
 * Parses the extraction output defensively.
 *
 * Models add preamble, wrap things in markdown fences, and occasionally use a
 * different separator. None of that should cost us a memory, so the parser takes
 * anything that has the right shape and ignores everything else.
 *
 * ## What `truncated` is for
 *
 * A reply that ran out of output budget stops mid-line, and a half-written fact
 * has exactly the shape of a whole one. A real example, kept for good:
 *
 *     preference | 0.8 | they have a deep interest in liminal spaces and analog horror,
 *
 * Raising the ceiling does not fix this — it had already been raised once for the
 * same reason, and there is always a longer answer. Whether the reply finished is
 * a fact the model reports, so it is passed in and acted on here.
 *
 * Which line to distrust follows from where the cut landed, and the `SUMMARY`
 * heading says where that was. If it is present, the model finished the fact
 * block and moved on, so every fact is whole and only the summary is cut.
 *
 * If it is absent, the cut was inside the fact block — but that still does not
 * mean the last *fact* is damaged, and assuming it did threw away good ones. From
 * a real reply cut at 1100 tokens:
 *
 *     …
 *     pattern | high | The user builds iOS apps.
 *     identity | high |
 *
 * The cut landed in the next line's prefix. That line yields no sentence and is
 * skipped anyway, and the fact above it finished — the newline after it is the
 * proof. So the test is narrower: the last fact is dropped only when it came from
 * the final line *and* that line was never terminated. Cut at 700 tokens the same
 * reply ended `pattern | high | The user writes horror fiction`, with nothing
 * after it, and that one is a fragment.
 */
export function parseExtraction(
  raw: string,
  options: { truncated?: boolean } = {},
): { facts: ExtractedFact[]; summary: string } {
  const text = raw.replace(/```[a-z]*\n?/gi, '');
  const factsStart = text.search(/^\s*FACTS\s*$/im);
  const summaryStart = text.search(/^\s*SUMMARY\s*$/im);

  const factBlock = text.slice(
    factsStart === -1 ? 0 : factsStart,
    summaryStart === -1 ? undefined : summaryStart,
  );
  let summary =
    summaryStart === -1 ? '' : text.slice(summaryStart).replace(/^\s*SUMMARY\s*$/im, '').trim();

  // A summary cut mid-sentence is merged into the rolling narrative and carried
  // forward for weeks, so it is trimmed back to the last sentence that finished.
  // Nothing survives only if nothing had finished, which is the honest outcome.
  if (options.truncated && summaryStart !== -1) {
    const lastEnd = Math.max(summary.lastIndexOf('.'), summary.lastIndexOf('!'), summary.lastIndexOf('?'));
    summary = lastEnd === -1 ? '' : summary.slice(0, lastEnd + 1);
  }

  const lines = factBlock.split('\n');
  const facts: ExtractedFact[] = [];
  // Which line each fact came from, so a cut one can be identified rather than
  // guessed at. Kept beside the facts rather than on them: the line number is an
  // artefact of this parse and no caller has any use for it.
  const from: number[] = [];

  for (const [index, line] of lines.entries()) {
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length < 3) continue;
    const kind = parts[0]?.replace(/^[-*\s]+/, '').toLowerCase() as FactKind;
    if (!VALID_KINDS.has(kind)) continue;
    const confidence = Number.parseFloat(parts[1] ?? '');
    const sentence = parts.slice(2).join(' | ').trim();
    if (!sentence) continue;
    facts.push({
      kind,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
      text: sentence,
    });
    from.push(index);
  }

  // `split` puts the text after the final newline in the last element, so a block
  // that ended cleanly has '' there. A non-empty last element is a line the model
  // never finished writing — and it only costs a fact if a fact came from it.
  const unterminated = (lines.at(-1) ?? '').trim() !== '';
  if (options.truncated && summaryStart === -1 && unterminated && from.at(-1) === lines.length - 1) {
    facts.pop();
  }

  return { facts, summary };
}

/** Keeps the summary bounded: the newest narrative wins, the old tail survives. */
function mergeSummaries(previous: string, next: string): string {
  const merged = `${next.trim()}\n\nBefore that: ${previous.trim()}`;
  return merged.length > 1600 ? `${merged.slice(0, 1600).trimEnd()}…` : merged;
}
