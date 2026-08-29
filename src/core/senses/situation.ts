/**
 * What she currently knows about the person she is with, other than what they
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

import type { ScreenActivity, SenseName } from '../../shared/protocol.ts';
import { SCREEN_REPORT_INTERVAL_MS } from '../../shared/screen-change.ts';

export interface Presence {
  /** Seconds since the browser last saw a keystroke, click or scroll. */
  idleSeconds: number;
  /** False when the tab is in the background or the screen is locked. */
  tabVisible: boolean;
  /** When the browser last told us anything at all. */
  at: number;
}

/**
 * What their screen has been doing, as far as the browser can tell.
 *
 * Distinct from {@link Presence} on purpose. Presence is about the *tab* — the
 * only thing a web page can honestly report about a person — and this is about
 * the window they are actually working in. Someone reading a long document with
 * Her tab in the background is idle by one measure and busy by the other,
 * and those deserve different things said to them.
 */
export interface ScreenState {
  activity: ScreenActivity;
  /** Seconds the screen has looked unchanged. */
  stillSeconds: number;
  /** Milliseconds since they last moved to something else. Infinity if never. */
  sinceSwitchMs: number;
  /** When the browser last reported. 0 when it never has. */
  at: number;
}

export interface SituationSnapshot {
  senses: Record<SenseName, boolean>;
  presence: Presence;
  screen: ScreenState;
  /**
   * Whether pictures are actually arriving, per source.
   *
   * Deliberately not the same question as `senses`. A sense is a switch someone
   * flipped; this is whether anything has come through it lately. They come
   * apart constantly — a browser tab in the background, a call whose video
   * track has not started, a Telegram conversation with no camera at all — and
   * the gap between them is not academic. Told "you can see them" on the
   * strength of the switch alone, with no frame to look at, she reached for the
   * only labelled picture in the session and described her own photograph back
   * to the user as though they were wearing it.
   */
  seeing: { camera: boolean; screen: boolean };
  /** Milliseconds since the user last said or typed anything. Infinity if never. */
  sinceUserSpokeMs: number;
  /** Milliseconds since she last finished a turn. Infinity if never. */
  sinceHerSpokeMs: number;
  /** Turns exchanged in this conversation. */
  turns: number;
  /** Local hour, 0-23. */
  hour: number;
  /** Formatted for the prompt, e.g. "Friday 11:40pm". */
  localTime: string;
}

/** Past this with no report, the browser is not talking to us any more. */
const SCREEN_STALE_MS = SCREEN_REPORT_INTERVAL_MS * 3;

/**
 * How recently a frame must have arrived for her to still be looking at it.
 *
 * Frames come at one a second from a camera and one every two from a screen, so
 * anything inside this window means the picture is live. Outside it, whatever
 * she last saw has aged out of the model's context anyway.
 */
const FRAME_FRESH_MS = 15_000;

export class Situation {
  readonly #now: () => number;
  /*
   * Hearing and sight are on by default; the screen is not.
   *
   * All three were false until v2.0.1, from when they were user-facing
   * switches and nothing could be assumed. The switches went in v2.0 and the
   * default did not move with them, so the shipped application built a
   * `Companion` that dropped every microphone frame and every camera frame —
   * `hear()` and `see()` both return early on this map. She could not hear, for
   * a whole release.
   *
   * The default is the right place for the fix rather than a `senses` argument
   * threaded down from `Conversation`: an argument fixes one call site and
   * leaves the same trap for the next constructor. What is true of this product
   * is that hearing and sight come up with her, so that is what the field says.
   *
   * The screen stays off because it costs an operating-system picker to turn
   * on, and because `setSense('screen', false)` is still how a stale "still for
   * forty minutes" reading gets cleared when a share ends.
   */
  #senses: Record<SenseName, boolean> = { hearing: true, sight: true, screen: false };
  #presence: Presence = { idleSeconds: 0, tabVisible: true, at: 0 };
  #sawCameraAt = 0;
  #sawScreenAt = 0;
  #screenActivity: ScreenActivity = 'still';
  #screenStillSeconds = 0;
  #screenAt = 0;
  #switchedAt = 0;
  #userSpokeAt = 0;
  #herSpokeAt = 0;
  #turns = 0;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  setSense(sense: SenseName, on: boolean): void {
    this.#senses[sense] = on;
    // Nothing is known about a screen nobody is sharing, and "still for forty
    // minutes" is exactly the reading a stopped share would leave behind.
    if (sense === 'screen' && !on) {
      this.#screenActivity = 'still';
      this.#screenStillSeconds = 0;
      this.#screenAt = 0;
      this.#switchedAt = 0;
    }
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

  /**
   * The browser's read on the shared screen.
   *
   * `switched` is stamped rather than stored: "they just changed windows" is
   * only interesting for about a minute, and a flag would still be true an hour
   * later. Reports are ignored once the screen sense is off, so switching it
   * off cannot leave a stale reading behind for her to reason about.
   */
  noteScreen(activity: ScreenActivity, stillSeconds: number): void {
    if (!this.#senses.screen) return;
    const now = this.#now();
    this.#screenActivity = activity;
    this.#screenStillSeconds = Number.isFinite(stillSeconds) ? Math.max(0, stillSeconds) : 0;
    this.#screenAt = now;
    if (activity === 'switched') this.#switchedAt = now;
  }

  /** A picture actually arrived and went to the model. */
  noteFrame(kind: 'camera' | 'screen'): void {
    if (kind === 'camera') this.#sawCameraAt = this.#now();
    else this.#sawScreenAt = this.#now();
  }

  noteUserSpoke(): void {
    this.#userSpokeAt = this.#now();
    this.#turns += 1;
  }

  noteHerSpoke(): void {
    this.#herSpokeAt = this.#now();
    this.#turns += 1;
  }

  /**
   * Stillness, carried forward between reports.
   *
   * The browser only speaks up when the answer changes or every
   * {@link SCREEN_REPORT_INTERVAL_MS}, so the stored figure is a reading taken
   * up to that long ago. Left alone it would tick in thirty-second steps, and
   * "nothing has changed in fifteen minutes" would fire late. Carried forward
   * only while reports are still arriving: once the browser stops talking to us
   * we know nothing, and a frozen tab must not read as deep concentration.
   */
  #stillSeconds(now: number): number {
    if (this.#screenAt === 0 || this.#screenActivity !== 'still') return this.#screenStillSeconds;
    const since = now - this.#screenAt;
    if (since > SCREEN_STALE_MS) return this.#screenStillSeconds;
    return this.#screenStillSeconds + Math.round(since / 1000);
  }

  /** A new conversation. Turn count resets; presence does not. */
  reset(): void {
    this.#turns = 0;
    this.#userSpokeAt = 0;
    this.#herSpokeAt = 0;
  }

  snapshot(): SituationSnapshot {
    const now = this.#now();
    const when = new Date(now);
    return {
      senses: this.senses,
      presence: { ...this.#presence },
      screen: {
        activity: this.#screenActivity,
        stillSeconds: this.#stillSeconds(now),
        sinceSwitchMs: this.#switchedAt ? now - this.#switchedAt : Number.POSITIVE_INFINITY,
        at: this.#screenAt,
      },
      seeing: {
        camera: this.#senses.sight && fresh(this.#sawCameraAt, now),
        screen: this.#senses.screen && fresh(this.#sawScreenAt, now),
      },
      sinceUserSpokeMs: this.#userSpokeAt ? now - this.#userSpokeAt : Number.POSITIVE_INFINITY,
      sinceHerSpokeMs: this.#herSpokeAt ? now - this.#herSpokeAt : Number.POSITIVE_INFINITY,
      turns: this.#turns,
      hour: when.getHours(),
      localTime: formatLocalTime(when),
    };
  }
}

function fresh(at: number, now: number): boolean {
  return at > 0 && now - at <= FRAME_FRESH_MS;
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

/** True in the small hours, when she should be gentler and lower-energy. */
export function isLateNight(hour: number): boolean {
  return hour >= 1 && hour < 5;
}
