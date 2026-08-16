/**
 * Turn-level instrumentation, for auditing a real session.
 *
 * Off unless ANNA_DIAG=1. The point is to make a bug report into a measurement:
 * which turn, which model, how long to first token, how long to first audio,
 * how many clauses, and what exactly failed. Guessing at "it feels laggy" or
 * "it broke" costs far more than logging four numbers.
 *
 * Never logs a key, a prompt, or the content of a reply — only shape and
 * timing. A diagnostics file that contains someone's conversation is a
 * liability, and the timings are what actually diagnose anything.
 */

import { appendFileSync } from 'node:fs';

export interface TurnRecord {
  turn: number;
  /** 'user' for a reply, 'opener' when she spoke first. */
  kind: 'user' | 'opener';
  model: string;
  /** Characters in the user's message. Never the message. */
  promptChars: number;
  firstEventMs?: number;
  firstAudioMs?: number;
  clauses?: number;
  gestures?: number;
  totalMs?: number;
  error?: string;
}

export class Diagnostics {
  readonly enabled: boolean;
  readonly #path: string;
  #turn = 0;
  #current: (TurnRecord & { startedAt: number }) | null = null;

  constructor(path: string) {
    this.enabled = process.env['ANNA_DIAG'] === '1';
    this.#path = path;
    if (this.enabled) this.#write({ event: 'session-start', at: new Date().toISOString() });
  }

  startTurn(kind: TurnRecord['kind'], model: string, promptChars: number): void {
    if (!this.enabled) return;
    this.#turn += 1;
    this.#current = {
      turn: this.#turn,
      kind,
      model,
      promptChars,
      clauses: 0,
      gestures: 0,
      startedAt: Date.now(),
    };
  }

  noteEvent(kind: string): void {
    const current = this.#current;
    if (!current) return;
    if (current.firstEventMs === undefined) current.firstEventMs = Date.now() - current.startedAt;
    if (kind === 'say') current.clauses = (current.clauses ?? 0) + 1;
    if (kind === 'gesture') current.gestures = (current.gestures ?? 0) + 1;
  }

  noteAudio(): void {
    const current = this.#current;
    if (!current || current.firstAudioMs !== undefined) return;
    current.firstAudioMs = Date.now() - current.startedAt;
  }

  noteError(message: string): void {
    if (this.#current) this.#current.error = message;
    else this.#write({ event: 'error', message });
  }

  endTurn(): void {
    const current = this.#current;
    if (!current) return;
    const { startedAt, ...record } = current;
    this.#write({ event: 'turn', ...record, totalMs: Date.now() - startedAt });
    this.#current = null;
  }

  /** Abandons the current turn without recording it. */
  cancelTurn(): void {
    this.#current = null;
  }

  note(event: string, detail: Record<string, unknown> = {}): void {
    this.#write({ event, ...detail });
  }

  /**
   * A `detail` from somewhere that is not main, made safe to write down.
   *
   * The renderer can send anything on `anna:body:report`, and two things about
   * that reach further than they look. `#write` spreads the row over
   * `{ t, event }`, so a detail carrying its own `t` or `event` silently
   * rewrites the timestamp and the name of the row — forged evidence in the one
   * file someone reads when they are already confused. And the write is
   * `appendFileSync` on main's event loop, so an unbounded object is an
   * unbounded synchronous write, at whatever rate the window chooses to send.
   *
   * Values are flattened to primitives rather than deep-copied: a diagnostics
   * row is a handful of scalars by construction, and anything nested is either
   * a mistake or an attempt to make this expensive.
   */
  static summarise(detail: unknown, limit = 16): Record<string, unknown> {
    if (!detail || typeof detail !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
      if (Object.keys(out).length >= limit) break;
      if (key === 't' || key === 'event') continue;
      if (typeof value === 'string') out[key] = value.slice(0, 200);
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        out[key] = value;
      }
    }
    return out;
  }

  #write(row: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      appendFileSync(this.#path, `${JSON.stringify({ t: Date.now(), ...row })}\n`);
    } catch {
      // Diagnostics must never take down a conversation.
    }
  }
}
