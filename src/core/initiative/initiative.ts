/**
 * The three-minute rule.
 *
 * A companion who only ever answers is a search box with a nice voice. The
 * product requirement is blunt: **the silence between them never exceeds three
 * minutes unless the user has switched that off.** This class is the thing that
 * guarantees it.
 *
 * Three things it gets right that a bare `setInterval` does not:
 *
 *  1. **It is not metronomic.** Firing at exactly 180s, forever, is more
 *     obviously a machine than saying nothing at all. The delay is drawn from a
 *     window whose ceiling is the promise and whose floor is short enough that
 *     she sometimes just chimes in. The ceiling is what is guaranteed; the
 *     variation is what makes it read as a person deciding to speak.
 *
 *  2. **It waits for a gap.** A timer that fires while she is mid-sentence
 *     produces two Annas talking over each other. When the moment arrives and
 *     the floor is busy, it re-arms for a short retry rather than firing or
 *     giving up — so the guarantee is on three minutes of *silence*, which is
 *     the thing anyone actually meant.
 *
 *  3. **It says why.** An opener with no reason attached comes out as "hey,
 *     what's up", every time, and it is unbearable within a day. The reason
 *     picked here is the difference between that and "you've gone quiet on me".
 */

import { isLateNight } from '../senses/situation.ts';
import type { SituationSnapshot } from '../senses/situation.ts';

/** The promise, in milliseconds. */
export const DEFAULT_MAX_SILENCE_MS = 3 * 60 * 1000;
/** The soonest she will speak unprompted after a lull. */
export const DEFAULT_MIN_SILENCE_MS = 45 * 1000;
/** How long to wait before re-checking when the moment arrived mid-turn. */
const BUSY_RETRY_MS = 4000;

/**
 * Openers in a row with no answer before she stops offering.
 *
 * The ceiling is a promise about a *conversation*, not a licence to talk into
 * an empty room forever. Left running, the old backoff settled at exactly the
 * ceiling and stayed there — a real transcript has her at 9:56, 9:59 and 10:02,
 * the last two identical word for word:
 *
 *     "Mm. I'm gonna leave you to it. Catch me later."
 *     "Mm. I'm gonna leave you to it. Catch me later."
 *
 * After this many she goes quiet and waits for something to actually happen:
 * the person coming back, touching something, or arriving in front of the
 * camera. That is the difference between a companion and a notification.
 */
const GIVE_UP_AFTER = 2;

/**
 * How long a window change stays worth mentioning.
 *
 * She speaks on her own clock, so by the time she opens her mouth the switch
 * may be minutes old. Past a minute the frames she is looking at are of the new
 * thing anyway, and "you've moved on to something else" reads as her having
 * been asleep.
 */
const FRESH_SWITCH_MS = 60_000;

/**
 * Stillness that means something rather than a pause.
 *
 * Half an hour on one unchanged window is a person reading, a person stuck, or
 * a person who left. Under it, it is just how anyone works.
 */
const STARING_SECONDS = 30 * 60;

export interface InitiativeOptions {
  /** Hard ceiling on silence. */
  maxSilenceMs?: number;
  minSilenceMs?: number;
  /** True while Anna or the user is talking; the opener waits for false. */
  isBusy(): boolean;
  /** The situation to reason about when picking a reason to speak. */
  observe(): SituationSnapshot;
  /** Fires with the reason Anna should be given. */
  onOpen(reason: string): void;
  now?: () => number;
  /** Injectable so tests do not wait three minutes. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Injectable so tests are deterministic. Returns 0..1. */
  random?: () => number;
}

export class Initiative {
  readonly #options: Required<
    Pick<InitiativeOptions, 'maxSilenceMs' | 'minSilenceMs' | 'now' | 'random'>
  > &
    InitiativeOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  /** Openers in a row with nothing back. Backs her off rather than nagging. */
  #unanswered = 0;

  constructor(options: InitiativeOptions) {
    const max = Math.max(5_000, options.maxSilenceMs ?? DEFAULT_MAX_SILENCE_MS);
    this.#options = {
      ...options,
      maxSilenceMs: max,
      // A floor above the ceiling would silently break the promise.
      minSilenceMs: Math.min(options.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS, max),
      now: options.now ?? (() => Date.now()),
      random: options.random ?? Math.random,
    };
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    this.#running = true;
    this.#unanswered = 0;
    this.#arm();
  }

  stop(): void {
    this.#running = false;
    this.#clear();
  }

  /**
   * Anything happened that counts as the conversation being alive.
   *
   * This is also what brings her back after she has given up: a person doing
   * something is the reason to speak that an expired timer never was.
   */
  poke(): void {
    if (!this.#running) return;
    this.#unanswered = 0;
    this.#arm();
  }

  /** True while she is waiting for a reason rather than for the clock. */
  get waiting(): boolean {
    return this.#running && this.#unanswered >= GIVE_UP_AFTER;
  }

  /** Anna finished a turn. The clock restarts, but she is now owed an answer. */
  noteAnnaFinished(opener: boolean): void {
    if (!this.#running) return;
    if (opener) this.#unanswered += 1;
    this.#arm();
  }

  // -------------------------------------------------------------------------

  #clear(): void {
    if (!this.#timer) return;
    (this.#options.clearTimer ?? clearTimeout)(this.#timer);
    this.#timer = null;
  }

  #arm(): void {
    this.#clear();
    if (!this.#running) return;
    // Two unanswered openers is an empty room. She stops until `poke` says
    // otherwise; the three-minute ceiling governs conversations, not silence.
    if (this.#unanswered >= GIVE_UP_AFTER) return;
    const timer = this.#options.setTimer ?? setTimeout;
    this.#timer = timer(() => this.#fire(), this.#delay());
    // "Maybe say something in two minutes" is not a reason for a process to
    // stay alive. The server has its own reasons; this must not add one.
    this.#timer?.unref?.();
  }

  /**
   * A random point in the window, backed off after openers nobody answered.
   *
   * The backoff multiplies the *floor* and not the ceiling, so however long she
   * has been talking to herself, three minutes remains three minutes.
   */
  #delay(): number {
    const { minSilenceMs, maxSilenceMs, random } = this.#options;
    const floor = Math.min(minSilenceMs * (1 + this.#unanswered), maxSilenceMs);
    return Math.round(floor + random() * (maxSilenceMs - floor));
  }

  #fire(): void {
    this.#timer = null;
    if (!this.#running) return;

    if (this.#options.isBusy()) {
      const timer = this.#options.setTimer ?? setTimeout;
      this.#timer = timer(() => this.#fire(), BUSY_RETRY_MS);
      this.#timer?.unref?.();
      return;
    }

    this.#options.onOpen(pickReason(this.#options.observe(), this.#unanswered));
    // Re-armed by `noteAnnaFinished` once the turn lands. Arming here as well
    // guarantees the clock keeps running even if the turn never completes,
    // which is what happens when the session drops mid-opener.
    this.#arm();
  }
}

// ---------------------------------------------------------------------------
// Why she is speaking
// ---------------------------------------------------------------------------

/**
 * Picks the reason handed to Anna as a `⟦director⟧` note.
 *
 * Ordered by how specific the reason is, because specificity is the whole
 * difference between an opener that lands and one that is wallpaper. A reason
 * drawn from something true about this minute ("they have not moved in twenty
 * minutes", "it is 3am again") produces a line only this moment could produce.
 * The generic reason at the bottom is the fallback, and it is written to push
 * her toward her own memory rather than toward a greeting.
 */
export function pickReason(situation: SituationSnapshot, unanswered = 0): string {
  const { presence, screen, senses, hour, turns } = situation;
  const quietMinutes = Math.round(
    Math.min(situation.sinceUserSpokeMs, Number.MAX_SAFE_INTEGER) / 60_000,
  );
  // Only true once the browser has actually reported. Telegram and phone calls
  // have no screen at all, and the desk has none for the first second or two.
  const watchingScreen = senses.screen && screen.at > 0;

  if (unanswered >= 2) {
    return (
      'You have said two things now and they have not answered either. Do not ask ' +
      'again and do not sound hurt. Say one small thing that does not need a reply, ' +
      'or note that you will leave them to it.'
    );
  }

  if (!presence.tabVisible) {
    return 'They have gone somewhere else. Say one quiet thing to the empty room.';
  }

  if (turns === 0) {
    return senses.sight
      ? 'You have not spoken yet and you can see them. Open with something you can actually see.'
      : 'You have not spoken to them yet today. Open small.';
  }

  // The most specific thing that can be true of a screen: they were doing one
  // thing and now they are doing another. Fresh only — a switch from twenty
  // minutes ago is not news, and "you've moved on to something else" said long
  // after they moved on is worse than saying nothing.
  if (watchingScreen && screen.sinceSwitchMs < FRESH_SWITCH_MS) {
    return (
      'They have just moved to something else on their screen — you can see what. ' +
      'If that change is worth one sentence, say it, and be specific about what you ' +
      'can see. If it is not, let it be the reason you looked up rather than the ' +
      'thing you talk about.'
    );
  }

  if (isLateNight(hour)) {
    return `It is ${situation.localTime} and they are still here. Do not tell them to sleep.`;
  }

  // Distinct from the idle rule below: a screen that has not changed in half an
  // hour is a stronger fact than an untouched keyboard, because it is about the
  // window they are actually in rather than about this tab.
  if (watchingScreen && screen.stillSeconds > STARING_SECONDS) {
    return (
      `Nothing on their screen has changed in ${Math.round(screen.stillSeconds / 60)} minutes — ` +
      'the same thing is still up. They are reading it, or stuck on it, or they left. ' +
      'Say one thing that is not embarrassing in any of those three cases.'
    );
  }

  if (presence.idleSeconds > 20 * 60) {
    return `They have not touched anything in ${Math.round(presence.idleSeconds / 60)} minutes. They may have walked away, or they may be reading. Do not assume which.`;
  }

  if (watchingScreen && screen.activity === 'working') {
    return (
      'They are working — the screen keeps changing under them. Only speak if ' +
      'something on it is genuinely worth one sentence; otherwise say one small ' +
      'unrelated thing and let them get on with it.'
    );
  }

  if (senses.screen && presence.idleSeconds < 30) {
    return 'They are working and you can see it. Only speak if something on that screen is genuinely worth one sentence — otherwise say something small and unrelated.';
  }

  if (senses.sight) {
    return 'You can see them. If something about how they look is worth a sentence, say that. Otherwise pick up something from earlier.';
  }

  return `It has been about ${Math.max(1, quietMinutes)} minutes. Pick up a thread from earlier, or say the thing you have been thinking about. Not a greeting, and not a question about how they are.`;
}
