/**
 * Telling "they are working" apart from "they have stopped".
 *
 * She already *sees* the screen — frames stream to Gemini and she will happily
 * say "I see that Google page". What she could not tell was whether anything
 * had happened, and that is the difference between a companion who looks up at
 * the right moment and one who interrupts on a timer.
 *
 * This is deliberately not image understanding. It is a coarse signature per
 * frame and a distance between consecutive ones — enough to answer three
 * questions and nothing more:
 *
 *   Has the screen been still for a long time?   They may have walked away, or
 *                                                they may be reading. Both are
 *                                                worth noticing; neither is
 *                                                worth guessing between.
 *   Did it just change completely?               They switched to something
 *                                                else. That is a moment.
 *   Is it ticking over?                          They are working. Leave them.
 *
 * It runs in the browser on a canvas that already exists, costs no bandwidth
 * and no tokens, and the arithmetic is here rather than in `web/` so it can be
 * tested without one.
 */

/** Signature resolution. 32x18 is 576 cells — coarse enough to ignore a cursor. */
export const SIGNATURE_WIDTH = 32;
export const SIGNATURE_HEIGHT = 18;

/**
 * Below this, nothing meaningful moved.
 *
 * A blinking caret, a clock, an animated favicon and video-call thumbnails all
 * land under it; scrolling a page or switching a window all land above.
 */
export const STILL_THRESHOLD = 0.02;

/** Above this, they are looking at something else entirely. */
export const SWITCH_THRESHOLD = 0.35;

/**
 * How often the browser reports, at the very least.
 *
 * The answer is the same most of the time — a control message every two seconds
 * saying "still nothing" is a lot of nothing — so reports go out when the answer
 * changes and otherwise on this tick. It lives here rather than in `web/`
 * because the server extrapolates across the gaps, and the two ends disagreeing
 * about how long a silence is normal would be a bug nobody could see.
 */
export const SCREEN_REPORT_INTERVAL_MS = 30_000;

/**
 * A frame reduced to one number per cell.
 *
 * Luma rather than colour, because a theme change is not an event and a
 * different window is. The coefficients are the usual Rec. 601 weights.
 */
export function signature(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const cells = new Uint8Array(SIGNATURE_WIDTH * SIGNATURE_HEIGHT);
  if (width < 1 || height < 1) return cells;

  const cellWidth = width / SIGNATURE_WIDTH;
  const cellHeight = height / SIGNATURE_HEIGHT;

  for (let cy = 0; cy < SIGNATURE_HEIGHT; cy += 1) {
    for (let cx = 0; cx < SIGNATURE_WIDTH; cx += 1) {
      const x0 = Math.floor(cx * cellWidth);
      const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cellWidth));
      const y0 = Math.floor(cy * cellHeight);
      const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * cellHeight));

      let total = 0;
      let counted = 0;
      // Sampled rather than averaged over every pixel: at this cell size the
      // difference is invisible and the cost is not.
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      for (let y = y0; y < y1 && y < height; y += stepY) {
        for (let x = x0; x < x1 && x < width; x += stepX) {
          const at = (y * width + x) * 4;
          total +=
            0.299 * (rgba[at] ?? 0) + 0.587 * (rgba[at + 1] ?? 0) + 0.114 * (rgba[at + 2] ?? 0);
          counted += 1;
        }
      }
      cells[cy * SIGNATURE_WIDTH + cx] = counted > 0 ? Math.round(total / counted) : 0;
    }
  }
  return cells;
}

/**
 * How different two signatures are, 0 to 1.
 *
 * Mean absolute difference per cell. A proportion rather than a count of
 * changed cells, so a small window moving and a whole screen changing are
 * different numbers rather than both being "something changed".
 */
export function difference(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || a.length !== b.length) return 1;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return total / (a.length * 255);
}

export type ScreenActivity = 'still' | 'working' | 'switched';

export function classify(delta: number): ScreenActivity {
  if (delta >= SWITCH_THRESHOLD) return 'switched';
  if (delta <= STILL_THRESHOLD) return 'still';
  return 'working';
}

/**
 * Tracks what the screen has been doing over time.
 *
 * Stateful on purpose: the useful facts are durations, and a duration needs
 * somewhere to live. Fed one signature per captured frame.
 */
export class ScreenWatcher {
  #previous: Uint8Array | null = null;
  #stillSince = 0;
  #lastAt = 0;

  /**
   * Returns what just happened, having folded it into the running state.
   *
   * There is deliberately no latch for "a switch happened recently". A switch
   * is reported the moment it is seen, and how long ago it was is a question
   * the server answers from its own clock — two places both remembering the
   * same moment is two places that can disagree about it.
   */
  observe(next: Uint8Array, at: number): ScreenActivity {
    const previous = this.#previous;
    this.#previous = next;
    this.#lastAt = at;

    if (!previous) {
      this.#stillSince = at;
      return 'still';
    }

    const activity = classify(difference(previous, next));
    if (activity !== 'still') this.#stillSince = at;
    else if (this.#stillSince === 0) this.#stillSince = at;
    return activity;
  }

  /** Seconds the screen has looked the same. Zero when it has not been seen. */
  stillSeconds(now = this.#lastAt): number {
    if (this.#stillSince === 0 || this.#lastAt === 0) return 0;
    return Math.max(0, Math.round((now - this.#stillSince) / 1000));
  }

  reset(): void {
    this.#previous = null;
    this.#stillSince = 0;
    this.#lastAt = 0;
  }
}
