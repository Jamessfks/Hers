/**
 * The memory facade: the only memory API the rest of Anna uses.
 *
 * Responsibilities, in the order they matter:
 *
 *  1. Record every turn. Cheap, synchronous, never blocks a reply.
 *  2. Retrieve the handful of facts worth putting in the next prompt.
 *  3. Consolidate, in the background: distil raw turns into durable facts and
 *     keep a rolling summary so old transcript can fall out of context without
 *     Anna losing the thread.
 *
 * Consolidation runs off the critical path deliberately. It costs a model call,
 * and a companion that pauses for two seconds every twelfth turn to think about
 * its filing system is a companion with a stutter.
 */

import type { LlmProvider } from '../llm/types.ts';
import { similarity } from './embedder.ts';
import { MemoryStore } from './store.ts';
import type { Embedder, FactKind, RecalledFact } from './types.ts';

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
 * other days as the current conversation. Observed consequence: Anna telling
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
  /** Model used for consolidation. Cheap and fast beats smart here. */
  llm?: LlmProvider;
  consolidationModel?: string;
  /** Injectable for tests. */
  now?: () => number;
}

export class Memory {
  readonly #store: MemoryStore;
  readonly #embedder: Embedder;
  readonly #llm: LlmProvider | undefined;
  readonly #model: string;
  readonly #now: () => number;
  #sessionId: string;
  #lastTurnAt: number;
  #turnsSinceConsolidation = 0;
  #consolidating: Promise<void> | null = null;

  constructor(options: MemoryOptions) {
    this.#store = options.store;
    this.#embedder = options.embedder;
    this.#llm = options.llm;
    this.#model = options.consolidationModel ?? options.llm?.suggestedModels[0] ?? '';
    this.#now = options.now ?? (() => Date.now());

    // Resume rather than always starting fresh: relaunching the app in the
    // middle of a conversation should continue it, not amnesia.
    const last = this.#store.lastTurn();
    const recent = last !== null && this.#now() - last.at < SESSION_GAP_MS;
    this.#sessionId = recent ? last.sessionId : crypto.randomUUID();
    this.#lastTurnAt = recent ? last.at : 0;
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

  record(speaker: 'user' | 'anna', text: string): void {
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
   * The facts worth showing Anna before she answers `text`.
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
   * something Anna should obviously keep ("my sister's name is Mei").
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
    const llm = this.#llm;
    if (!llm) return;

    const lastConsolidated = Number(this.#store.get('lastConsolidatedTurnId') ?? '0');
    const turns = this.#store.turnsSince(lastConsolidated);
    if (turns.length === 0) return;

    const transcript = turns
      .map((turn) => `${turn.speaker === 'user' ? 'Them' : 'Anna'}: ${turn.text}`)
      .join('\n');

    try {
      const raw = await collect(
        llm.stream({
          model: this.#model,
          maxTokens: 700,
          temperature: 0.2,
          system: EXTRACTION_PROMPT,
          messages: [{ role: 'user', content: transcript }],
        }),
      );

      const parsed = parseExtraction(raw);
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
You maintain the long-term memory of a companion named Anna. You are reading a
transcript between Anna and the person she lives with.

Return exactly two sections and nothing else.

FACTS
One fact per line, formatted: kind | confidence | sentence
  kind is one of: identity, preference, thread, event, pattern
  confidence is 0.0 to 1.0
  sentence is one short third-person sentence about the person, not about Anna

Record only things that will still matter in a month. A durable fact is their
sister's name, the job they are interviewing for, that they hate being asked how
they slept. Not "they said hello", not "they seem tired today", and never
anything Anna said about herself.

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
 * different separator. None of that should cost us a memory, so the parser
 * takes anything that has the right shape and ignores everything else.
 */
export function parseExtraction(raw: string): { facts: ExtractedFact[]; summary: string } {
  const text = raw.replace(/```[a-z]*\n?/gi, '');
  const factsStart = text.search(/^\s*FACTS\s*$/im);
  const summaryStart = text.search(/^\s*SUMMARY\s*$/im);

  const factBlock = text.slice(
    factsStart === -1 ? 0 : factsStart,
    summaryStart === -1 ? undefined : summaryStart,
  );
  const summary =
    summaryStart === -1 ? '' : text.slice(summaryStart).replace(/^\s*SUMMARY\s*$/im, '').trim();

  const facts: ExtractedFact[] = [];
  for (const line of factBlock.split('\n')) {
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
  }

  return { facts, summary };
}

/** Keeps the summary bounded: the newest narrative wins, the old tail survives. */
function mergeSummaries(previous: string, next: string): string {
  const merged = `${next.trim()}\n\nBefore that: ${previous.trim()}`;
  return merged.length > 1600 ? `${merged.slice(0, 1600).trimEnd()}…` : merged;
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let output = '';
  for await (const chunk of stream) output += chunk;
  return output;
}
