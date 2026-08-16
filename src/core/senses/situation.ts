/**
 * What Anna currently knows about the person she is with, other than what they
 * have said.
 *
 * This is a small amount of state, and the temptation is to make it a large
 * amount. Resist it. The senses that matter are already going straight to
 * Gemini as audio and as pictures — the model sees the screen, so it does not
 * need a summary of the screen. What this tracks is the handful of facts that
 * are *not* in any frame: how long it has been quiet, whether anyone is there,
 * what time it is where they are, and which senses are switched on.
 *
 * Those are the facts the initiative loop reasons about, and they are the only
 * ones it needs.
 */

import type { SenseName } from '../../shared/protocol.ts';

export interface Presence {
  /** Seconds since the browser last saw a keystroke, click or scroll. */
  idleSeconds: number;
  /** False when the tab is in the background or the screen is locked. */
  tabVisible: boolean;
  /** When the browser last told us anything at all. */
  at: number;
}

export interface SituationSnapshot {
  senses: Record<SenseName, boolean>;
  presence: Presence;
  /** Milliseconds since the user last said or typed anything. Infinity if never. */
  sinceUserSpokeMs: number;
  /** Milliseconds since Anna last finished a turn. Infinity if never. */
  sinceAnnaSpokeMs: number;
  /** Turns exchanged in this conversation. */
  turns: number;
  /** Local hour, 0-23. */
  hour: number;
  /** Formatted for the prompt, e.g. "Friday 11:40pm". */
  localTime: string;
}

export class Situation {
  readonly #now: () => number;
  #senses: Record<SenseName, boolean> = { hearing: false, sight: false, screen: false };
  #presence: Presence = { idleSeconds: 0, tabVisible: true, at: 0 };
  #userSpokeAt = 0;
  #annaSpokeAt = 0;
  #turns = 0;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  setSense(sense: SenseName, on: boolean): void {
    this.#senses[sense] = on;
  }

  get senses(): Record<SenseName, boolean> {
    return { ...this.#senses };
  }

  get anySense(): boolean {
    return this.#senses.hearing || this.#senses.sight || this.#senses.screen;
  }

  notePresence(idleSeconds: number, tabVisible: boolean): void {
    this.#presence = {
      idleSeconds: Number.isFinite(idleSeconds) ? Math.max(0, idleSeconds) : 0,
      tabVisible,
      at: this.#now(),
    };
  }

  noteUserSpoke(): void {
    this.#userSpokeAt = this.#now();
    this.#turns += 1;
  }

  noteAnnaSpoke(): void {
    this.#annaSpokeAt = this.#now();
    this.#turns += 1;
  }

  /** A new conversation. Turn count resets; presence does not. */
  reset(): void {
    this.#turns = 0;
    this.#userSpokeAt = 0;
    this.#annaSpokeAt = 0;
  }

  snapshot(): SituationSnapshot {
    const now = this.#now();
    const when = new Date(now);
    return {
      senses: this.senses,
      presence: { ...this.#presence },
      sinceUserSpokeMs: this.#userSpokeAt ? now - this.#userSpokeAt : Number.POSITIVE_INFINITY,
      sinceAnnaSpokeMs: this.#annaSpokeAt ? now - this.#annaSpokeAt : Number.POSITIVE_INFINITY,
      turns: this.#turns,
      hour: when.getHours(),
      localTime: formatLocalTime(when),
    };
  }
}

/**
 * "Friday 11:40pm", not an ISO string.
 *
 * A model handed `2026-08-16T23:40:00Z` will occasionally read the timestamp
 * out loud, and will more often reason about it as data rather than as the
 * time of day. The phrasing a person would use gets the behaviour a person
 * would have.
 */
export function formatLocalTime(when: Date): string {
  const day = when.toLocaleDateString('en-US', { weekday: 'long' });
  const hour24 = when.getHours();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const minutes = String(when.getMinutes()).padStart(2, '0');
  return `${day} ${hour12}:${minutes}${hour24 < 12 ? 'am' : 'pm'}`;
}

/** True in the small hours, when Anna should be gentler and lower-energy. */
export function isLateNight(hour: number): boolean {
  return hour >= 1 && hour < 5;
}
