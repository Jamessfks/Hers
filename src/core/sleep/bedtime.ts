/**
 * The thing that actually puts her to bed.
 *
 * v2.0 shipped `rhythm.md`, `isAsleep()` and a README paragraph promising she
 * goes quiet at an hour she chose — and nothing that ever looked at the clock.
 * `isAsleep` had exactly one caller, inside `#doWake`, so the only moment her
 * bedtime mattered was a moment the user had already started. Left alone she
 * went on firing three-minute openers straight through it. This is the missing
 * half.
 *
 * ## A re-arming check, not one long timer
 *
 * The obvious implementation is `setTimeout` until the next boundary. It is
 * wrong three ways, and all three happen on a laptop: a timer scheduled nine
 * hours out does not fire correctly across a suspend, it is an hour off after a
 * daylight-saving change, and it is simply wrong if the user moves the clock.
 * Reading `new Date().getHours()` fresh on a sixty-second tick is right in all
 * three cases and costs one comparison a minute.
 *
 * ## The falling edge, and why it is not a level
 *
 * She is put to bed on the *transition* into her sleep window, never merely
 * because the clock is inside it. Acting on the level would mean the user
 * waking her at 3am and being cut off sixty seconds later, over and over — and
 * `rhythm.ts` is explicit that waking her is always theirs. So the previous
 * tick's answer is remembered, and only `awake → asleep` does anything.
 *
 * The consequence is deliberate: once she has been woken inside her own night
 * she stays up until the user is done. She does not sneak back to bed.
 */

import type { Rhythm } from './rhythm.ts';
import { isAsleep } from './rhythm.ts';

/**
 * How often the clock is read.
 *
 * A minute. The boundary it is watching for is an hour wide, so the worst case
 * is that she goes quiet up to fifty-nine seconds late — which nobody can
 * perceive — and the cost is one `Date` construction and one comparison.
 */
export const TICK_MS = 60_000;

export interface BedtimeOptions {
  /**
   * Read fresh on every tick rather than captured once.
   *
   * `rhythm.md` is rewritten when setup finishes, and a scheduler holding the
   * default from before that would put her to bed at the wrong hour for the
   * whole first evening.
   */
  rhythm: () => Rhythm;
  /** Nothing to do if she is already asleep. */
  isAwake: () => boolean;
  /** Called once, on the transition into her sleep window. */
  onBedtime: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class Bedtime {
  #options: BedtimeOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * What the clock said last time, so the edge can be detected.
   *
   * Starts null rather than false: on the very first tick there is no previous
   * answer, and treating "no answer" as "she was awake" would put her to bed
   * the instant the program starts inside her sleep window — which is a
   * companion who cannot be run at midnight.
   */
  #wasAsleep: boolean | null = null;

  constructor(options: BedtimeOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer) return;
    /*
     * Read the clock once immediately, to establish the baseline.
     *
     * With no previous answer there is no edge, so this only records — which is
     * exactly what starting up inside her sleep window should do. Without it
     * the first real tick a minute later would be the first answer, and a
     * program started at 22:59 would miss its own boundary.
     */
    this.tick();
    this.#arm();
  }

  stop(): void {
    if (!this.#timer) return;
    (this.#options.clearTimer ?? clearTimeout)(this.#timer);
    this.#timer = null;
  }

  /** Exposed so a test can step the clock without waiting a minute. */
  tick(): void {
    const now = new Date(this.#options.now?.() ?? Date.now());
    const asleep = isAsleep(this.#options.rhythm(), now.getHours());
    const was = this.#wasAsleep;
    this.#wasAsleep = asleep;

    // The edge, and only the edge. `was === null` is the first tick and is
    // deliberately not an edge — see the note on the field.
    if (was === false && asleep && this.#options.isAwake()) {
      this.#options.onBedtime();
    }
  }

  #arm(): void {
    const timer = this.#options.setTimer ?? setTimeout;
    this.#timer = timer(() => {
      this.tick();
      this.#timer = null;
      this.#arm();
    }, TICK_MS);
    // A companion who is asleep should not be the reason a process cannot exit.
    this.#timer?.unref?.();
  }
}
