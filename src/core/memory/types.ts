/**
 * Her memory.
 *
 * Continuity is the entire difference between a companion and a chat window.
 * A model with a 200k context window still forgets you completely the moment
 * the app restarts, and the thing people actually notice — the thing that makes
 * a relationship feel real — is being asked about the interview a week later
 * without having to bring it up first.
 *
 * Three stores, because they answer three different questions:
 *
 *   turns      What was literally said? Append-only, never edited. This is the
 *              record, and it is what everything else is derived from.
 *   facts      What is durably true about this person? Distilled from turns by
 *              a background pass, embedded, and retrieved by relevance.
 *   summaries  What has been happening lately? A rolling narrative so she can
 *              pick up a thread without replaying a month of transcript.
 */

export interface Turn {
  id: number;
  /** 'user' or 'her'. Her turns store spoken text with directives stripped. */
  speaker: 'user' | 'her';
  text: string;
  at: number;
  /** Groups turns that happened in one continuous stretch of talking. */
  sessionId: string;
}

export type FactKind =
  /** Stable biography: name, job, where they live, who matters to them. */
  | 'identity'
  /** Preferences and dislikes, including how they like being talked to. */
  | 'preference'
  /** An open thread she should follow up on. */
  | 'thread'
  /** Something that happened to them. */
  | 'event'
  /** A pattern she has noticed over time. */
  | 'pattern';

export interface Fact {
  id: number;
  kind: FactKind;
  /** One sentence, written in the third person: "He is dreading Thursday's demo." */
  text: string;
  /**
   * 0..1. Facts the user stated plainly score high; things she inferred from
   * a sensor read score low and are allowed to decay out of retrieval.
   */
  confidence: number;
  createdAt: number;
  lastSeenAt: number;
  /** How often this fact has been retrieved. Frequently used facts stay hot. */
  recallCount: number;
  /** Turn that produced it, for provenance in the memory inspector. */
  sourceTurnId: number | null;
  embedding: Float32Array | null;
}

export interface Summary {
  id: number;
  text: string;
  /** Range of turn ids this summary covers, inclusive. */
  fromTurnId: number;
  toTurnId: number;
  createdAt: number;
}

export interface RecallQuery {
  /** What she is about to respond to. Drives semantic retrieval. */
  text: string;
  limit?: number;
  kinds?: readonly FactKind[];
}

export interface RecalledFact extends Fact {
  /** Final ranking score, for debugging the memory inspector. */
  score: number;
}

/**
 * Turns text into a vector. Implementations must be deterministic for the same
 * input, because a fact's stored embedding and a query embedding have to live
 * in the same space across restarts.
 */
export interface Embedder {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * A one-shot text completion, used only to distil transcripts into facts.
 *
 * Narrow on purpose. Consolidation is the one place she needs a model that is
 * *not* the live conversation, and giving that job a two-method interface keeps
 * the whole of `memory/` testable without a network and without the Live API.
 */
/**
 * What a distiller pass came back with.
 *
 * `truncated` is here because the text alone cannot be trusted to be whole. The
 * output budget is shared with thinking, so a reply can stop mid-line, and a
 * half-written fact parses as a complete one — a memory kept for good that ends
 * in a comma. Only the model knows it ran out of room; this carries that answer
 * to the parser, which is the only place that can act on it.
 */
export interface Distillation {
  text: string;
  /** The model reached its output ceiling before it finished. */
  truncated: boolean;
}

export interface Distiller {
  distil(system: string, transcript: string): Promise<Distillation>;
}
