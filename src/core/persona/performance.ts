/**
 * Streaming parser that turns a token stream from the language model into a
 * stream of {@link PerformanceEvent}s.
 *
 * ## Why this exists
 *
 * The failure mode of every avatar companion is the "dubbed puppet": the model
 * finishes a paragraph, the paragraph is sent to a TTS, the audio comes back,
 * and only then does the body move. The result reads as a recording because the
 * body is reacting to a decision that was made seconds ago.
 *
 * xAI's Ani avoids this by letting the model *choose* motions from a curated
 * library in the middle of a reply rather than playing idle loops at random.
 * We do the same thing, but streaming: the model writes inline directives, and
 * this parser peels them out of the text as the tokens arrive, so a `[lean_in]`
 * fires while the sentence around it is still being generated.
 *
 * ## The format
 *
 *   Hey. [smirk] You've been on that same file for three hours. [lean_in]
 *   What's it doing to you?
 *
 * Rules the parser enforces, because the model will break all of them:
 *   - Unknown tag names are dropped, not spoken. `[teleports behind you]` must
 *     never reach the TTS.
 *   - An unterminated `[` at the end of the stream is discarded.
 *   - Speech is emitted in clauses split on sentence punctuation, so the first
 *     audio request can be issued after a handful of tokens instead of after
 *     the full reply. This is the single biggest lever on time-to-first-audio.
 */

import {
  EXPRESSION_NAMES,
  GESTURE_NAMES,
  type ExpressionName,
  type GestureName,
  type PerformanceEvent,
} from '../../shared/protocol.ts';

const GESTURES = new Set<string>(GESTURE_NAMES);
const EXPRESSIONS = new Set<string>(EXPRESSION_NAMES);
const GAZE_TARGETS = new Set(['user', 'away', 'down', 'screen']);

/**
 * Every prefix of every directive name.
 *
 * Anna is a companion, not a chat window: she talks about brackets, arrays and
 * code, and a naive parser treats the `[` in "I saw a [ and kept going" as an
 * open tag and eats the rest of the sentence. Because the vocabulary is closed,
 * we can tell the difference after a single character — the moment the
 * fragment stops being a possible directive, it was never a directive.
 */
const DIRECTIVE_PREFIXES = new Set<string>(
  [...GESTURE_NAMES, ...EXPRESSION_NAMES, 'gaze'].flatMap((name) =>
    Array.from({ length: name.length + 1 }, (_, i) => name.slice(0, i)),
  ),
);

/** Characters legal in the argument half of a directive, e.g. `nod x0.4`. */
const LEGAL_ARG = /^[a-z0-9_.\s]*$/;

/**
 * Longest a `[...]` run may get before we conclude it is prose. The longest
 * real directive is `[reach_toward_user x0.8]`; 48 leaves generous headroom
 * while still rescuing a sentence that merely happens to contain a bracket.
 */
const MAX_TAG_LENGTH = 48;

/**
 * Could this partial tag body still become a valid directive?
 *
 * Used only at end-of-stream, to tell a genuinely truncated `[lean_i` (drop it)
 * from a bracket the user's sentence happened to contain (speak it).
 */
export function couldBeDirectivePrefix(fragment: string): boolean {
  const body = fragment.replace(/^\s+/, '').toLowerCase();
  const split = body.search(/[\s:]/);
  if (split === -1) return DIRECTIVE_PREFIXES.has(body);
  return DIRECTIVE_PREFIXES.has(body.slice(0, split)) && LEGAL_ARG.test(body.slice(split + 1));
}

/** Characters that end a clause and therefore flush a chunk to the voice. */
const CLAUSE_END = /[.!?…]|--|—/;
/** A soft break: used only once a clause has grown past {@link SOFT_BREAK_MIN}. */
const SOFT_BREAK = /[,;:]/;
const SOFT_BREAK_MIN = 60;
/** Hard ceiling; past this we flush at the next space no matter what. */
const HARD_BREAK_MAX = 180;

export interface PerformanceParserOptions {
  /**
   * Emit the first clause as soon as it reaches this many characters, even
   * without punctuation. Lower means faster first audio and choppier phrasing.
   * 24 is tuned to beat the 800ms first-audio budget on Cartesia.
   */
  firstClauseMinChars?: number;
}

/**
 * Feed it text, get back performance events. One instance per turn.
 *
 * The parser is a plain state machine rather than a regex over the whole
 * buffer: tags can be split across token boundaries (`"[le"` then `"an_in]"`),
 * which a whole-buffer regex handles only by rescanning, and rescanning is how
 * you end up emitting the same gesture twice.
 */
export class PerformanceParser {
  #speech = '';
  #tag: string | null = null;
  #clauseId = 0;
  #emittedFirstClause = false;
  readonly #firstClauseMinChars: number;

  constructor(options: PerformanceParserOptions = {}) {
    this.#firstClauseMinChars = options.firstClauseMinChars ?? 24;
  }

  /** Push a chunk of model output. Returns the events it produced. */
  push(chunk: string): PerformanceEvent[] {
    const events: PerformanceEvent[] = [];

    for (const char of chunk) {
      if (this.#tag !== null) {
        if (char === ']') {
          const event = toPerformanceEvent(this.#tag);
          if (event) events.push(event);
          this.#tag = null;
          continue;
        }

        const grown = this.#tag + char;
        if (grown.length <= MAX_TAG_LENGTH && char !== '\n') {
          this.#tag = grown;
          continue;
        }

        // Too long, or spanning a line: a directive is neither. Give the text
        // back to the speech buffer verbatim so we never silently eat a
        // sentence, and reprocess the current character as ordinary speech.
        this.#speech += `[${this.#tag}`;
        this.#tag = null;
        if (char === '[') {
          this.#tag = '';
          continue;
        }
        this.#speech += char;
        events.push(...this.#flushIfReady(false));
        continue;
      }

      if (char === '[') {
        // A tag boundary is also a breath point: flush what we have so the
        // gesture lands with the words around it rather than after them.
        events.push(...this.#flushIfReady(true));
        this.#tag = '';
        continue;
      }

      this.#speech += char;
      events.push(...this.#flushIfReady(false));
    }

    return events;
  }

  /** Call once the model stream ends. Flushes the tail. */
  end(): PerformanceEvent[] {
    if (this.#tag !== null) {
      // A truncated directive is dropped; anything else was prose all along.
      if (!couldBeDirectivePrefix(this.#tag)) this.#speech += `[${this.#tag}`;
      this.#tag = null;
    }
    const text = normalize(this.#speech);
    this.#speech = '';
    return isSpeakable(text) ? [{ kind: 'say', text, clauseId: this.#clauseId++ }] : [];
  }

  #flushIfReady(atTagBoundary: boolean): PerformanceEvent[] {
    const buf = this.#speech;
    if (!buf.trim()) {
      if (atTagBoundary) this.#speech = '';
      return [];
    }

    const last = buf.at(-1) ?? '';
    const long = buf.length >= HARD_BREAK_MAX;
    const ready =
      atTagBoundary ||
      CLAUSE_END.test(last) ||
      (buf.length >= SOFT_BREAK_MIN && SOFT_BREAK.test(last)) ||
      (long && last === ' ') ||
      (!this.#emittedFirstClause && buf.length >= this.#firstClauseMinChars && last === ' ');

    if (!ready) return [];

    const text = normalize(buf);
    this.#speech = '';
    if (!isSpeakable(text)) return [];
    this.#emittedFirstClause = true;
    return [{ kind: 'say', text, clauseId: this.#clauseId++ }];
  }
}

/**
 * Map a raw tag body to an event, or `null` if the model invented something.
 *
 * Accepted forms: `gesture`, `expression`, `gaze:user`, `nod x0.4`.
 */
export function toPerformanceEvent(raw: string): PerformanceEvent | null {
  const body = raw.trim().toLowerCase();
  if (!body) return null;

  const [head, ...rest] = body.split(/[\s:]+/);
  if (!head) return null;
  const name = head.replace(/[^a-z_]/g, '');
  const arg = rest.join(' ');

  if (name === 'gaze') {
    return GAZE_TARGETS.has(arg) ? { kind: 'gaze', target: arg as 'user' } : null;
  }

  const intensity = parseIntensity(arg);

  if (GESTURES.has(name)) {
    return { kind: 'gesture', name: name as GestureName, ...(intensity !== null && { intensity }) };
  }
  if (EXPRESSIONS.has(name)) {
    return {
      kind: 'expression',
      name: name as ExpressionName,
      ...(intensity !== null && { weight: intensity }),
    };
  }
  return null;
}

function parseIntensity(arg: string): number | null {
  const match = /x?(0?\.\d+|1(?:\.0+)?)/.exec(arg);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

/** Collapse the whitespace that tag removal leaves behind. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Is there anything here worth saying out loud?
 *
 * Removing a directive can leave a clause that is nothing but punctuation — a
 * lone full stop after `[nod].`, or an ellipsis where she trails off. Cartesia
 * rejects those outright:
 *
 *     400 Invalid transcript: Your transcript is empty or contains only
 *         punctuation.
 *
 * and the whole clause is lost. They are equally useless as subtitles, so they
 * are dropped at the parser rather than special-cased in every voice adapter.
 */
export function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Convenience wrapper for tests and for non-streaming providers: parse a whole
 * string at once.
 */
export function parsePerformance(
  text: string,
  options?: PerformanceParserOptions,
): PerformanceEvent[] {
  const parser = new PerformanceParser(options);
  return [...parser.push(text), ...parser.end()];
}

/** The plain words, with every directive stripped. Used for the memory log. */
export function spokenText(events: readonly PerformanceEvent[]): string {
  return events
    .filter((e): e is Extract<PerformanceEvent, { kind: 'say' }> => e.kind === 'say')
    .map((e) => e.text)
    .join(' ');
}
