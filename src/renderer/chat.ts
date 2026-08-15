/**
 * The thread.
 *
 * Anna's body used to show one line of subtitle that faded out a couple of
 * seconds after she stopped talking, which is the right interface for something
 * you glance at and the wrong one for something you talk to: there was no way
 * to re-read what she just said, and typing at her produced no record that you
 * had. This keeps the whole turn on screen as a stack of bubbles.
 *
 * ## One clause, one bubble
 *
 * `say` events arrive already chunked at breath points by the speech governor,
 * because that is what the TTS path needs. That chunking turns out to be exactly
 * the chat rhythm too — a companion sends four short messages, not one
 * paragraph — so a clause becomes a bubble and nothing has to be re-segmented.
 *
 * ## Bottom-anchored, and the scroll is not left to the browser
 *
 * The list is `flex-direction: column-reverse`, so the browser keeps it pinned
 * to the bottom for free and only lets go when the user deliberately scrolls up.
 * The cost is that the DOM runs newest-first, which is why everything here
 * prepends.
 *
 * That gets the anchoring right and the *motion* wrong, which is a subtler
 * failure and the one that made this feel unlike a messaging app. Three things
 * were true of it before {@link Thread.#shift} existed:
 *
 *  - Pinned at the bottom, a new bubble teleported the entire transcript up by
 *    its own height in a single frame, and then the bubble faded in separately.
 *    Two unrelated motions where iMessage has one.
 *  - Scrolled up, `scrollTop` in a reversed list is measured from the bottom of
 *    the content, so growing the bottom slid the paragraph you were reading —
 *    no yank, but a shift, which is not much better.
 *  - Sending your own message while scrolled up left it below the fold with no
 *    indication it had gone anywhere.
 *
 * So every mutation that changes the content's height goes through `#shift`,
 * which measures the height on both sides of the change and then either slides
 * the stack over one animation or holds the reader exactly where they were.
 */

/** Who said it. */
export type Speaker = 'anna' | 'you';

export interface ThreadOptions {
  /** The scrolling element the bubbles live in. */
  mount: HTMLElement;
  /** How many bubbles to keep. Older ones are dropped from the DOM. */
  limit?: number;
}

/**
 * How long a gap between two of her clauses still counts as one utterance.
 *
 * Under this, a new clause extends the bubble that is already there instead of
 * starting a new one. Without it a comma-heavy sentence arrives as five
 * two-word bubbles, which reads as a stutter rather than as a rhythm.
 */
const SAME_BREATH_MS = 900;

/**
 * How long the stack takes to slide when something is added to it.
 *
 * Matched to the bubble's own arrival so the two are one motion rather than a
 * jump followed by a fade.
 */
const SLIDE_MS = 260;

/** The arrival easing, shared with `@keyframes arrive` in styles.css. */
const EASE = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * How close to the bottom still counts as being at the bottom.
 *
 * `scrollTop` is 0 at the bottom of a reversed list and negative above it, and
 * it is not always exactly 0 — a fractional device pixel ratio leaves it at
 * -0.5 and a strict check would then treat a pinned thread as a scrolled one
 * forever after.
 */
const AT_BOTTOM_PX = 2;

export class Thread {
  readonly #mount: HTMLElement;
  readonly #typing: HTMLDivElement;
  readonly #limit: number;
  /** Someone who has asked the system for less motion gets none of it here. */
  readonly #reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  #last: { from: Speaker; at: number; el: HTMLDivElement } | null = null;

  constructor(options: ThreadOptions) {
    this.#mount = options.mount;
    this.#limit = options.limit ?? 200;

    /*
     * First child in a column-reverse list is the bottom of the stack, which is
     * where her thinking belongs — under the last thing either of you said.
     *
     * Two elements rather than one because it has to open and close rather than
     * appear and disappear. The outer one is a grid whose single row animates
     * from `0fr` to `1fr`; the inner one is the bubble. Putting the bubble's own
     * padding on the animating box instead would leave a padding-tall lozenge
     * on screen at zero height.
     */
    this.#typing = document.createElement('div');
    this.#typing.id = 'typing';
    this.#typing.setAttribute('aria-hidden', 'true');
    const dots = document.createElement('div');
    dots.className = 'dots';
    for (let i = 0; i < 3; i += 1) dots.append(document.createElement('i'));
    this.#typing.append(dots);
    this.#mount.prepend(this.#typing);
  }

  /**
   * Adds a clause from Anna, or extends the bubble she is mid-sentence in.
   *
   * @param text One clause, already chunked by the governor.
   */
  say(text: string): void {
    const now = Date.now();
    const open =
      this.#last?.from === 'anna' && now - this.#last.at < SAME_BREATH_MS ? this.#last : null;

    if (open) {
      // A clause landing in an open bubble grows it, which moves everything
      // above it just as surely as a new bubble does — and this is the common
      // case, two to four times a turn, not the rare one.
      this.#shift(() => {
        open.el.textContent = `${open.el.textContent} ${text}`.trim();
      });
      open.at = now;
      return;
    }
    this.#add('anna', text, now);
  }

  /**
   * Adds something the user typed or said out loud.
   *
   * Always returns the view to the bottom, even if they had scrolled up to
   * re-read something. Every messaging app does this unconditionally, and the
   * reason is that a message you just sent going somewhere you cannot see it is
   * indistinguishable from a message that failed to send.
   */
  said(text: string): void {
    this.#add('you', text, Date.now());
    this.#toBottom();
  }

  /**
   * Closes the current bubble so the next clause starts a new one.
   *
   * Called at the end of her turn. Without it the first clause of her *next*
   * turn would be glued onto the last clause of this one whenever she answers
   * inside the same-breath window.
   */
  seal(): void {
    this.#last = null;
  }

  /** Empties the thread, keeping the typing indicator. */
  clear(): void {
    for (const el of [...this.#mount.querySelectorAll('.msg')]) el.remove();
    this.#last = null;
  }

  #add(from: Speaker, text: string, at: number): void {
    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset['from'] = from;
    el.textContent = text;

    this.#shift(() => {
      // After the typing indicator, so her dots stay at the very bottom of the
      // stack while a bubble is landing above them.
      this.#typing.after(el);
      this.#trim();
    });

    this.#last = { from, at, el };
  }

  /**
   * Runs a mutation that changes the thread's height, and moves the scroll to
   * match rather than letting the browser jump it.
   *
   * Two cases, and they want opposite things. Pinned at the bottom, the reader
   * is watching the newest message, so the stack should *slide* by exactly the
   * height that was added — the scroll is put back where it was and then
   * animated to the bottom, which moves every bubble on one curve instead of
   * teleporting them and fading the new one in separately. Scrolled up, the
   * reader is looking at something specific and the only correct behaviour is
   * for it not to move at all, which needs the opposite correction applied and
   * no animation whatsoever.
   */
  #shift(mutate: () => void): void {
    const mount = this.#mount;
    const pinned = Math.abs(mount.scrollTop) <= AT_BOTTOM_PX;
    const before = mount.scrollHeight;

    mutate();

    const delta = mount.scrollHeight - before;
    if (delta <= 0) return;

    if (!pinned) {
      // Hold the reader's place. `scrollTop` is negative above the bottom in a
      // reversed list, so growing the content moves their view unless this
      // takes the growth back out.
      mount.scrollTop -= delta;
      return;
    }

    if (this.#reduced.matches) return;

    // Put the view back where it was, then walk it to the bottom. Written as a
    // frame loop rather than `scrollTo({behavior:'smooth'})` because the smooth
    // behaviour's duration is the browser's to choose and this one has to match
    // the bubble's arrival exactly, or the two motions visibly disagree.
    mount.scrollTop = -delta;
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / SLIDE_MS);
      mount.scrollTop = -delta * (1 - EASE(t));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Returns the view to the newest message, animated. */
  #toBottom(): void {
    const mount = this.#mount;
    const from = mount.scrollTop;
    if (from >= -AT_BOTTOM_PX) return;
    if (this.#reduced.matches) {
      mount.scrollTop = 0;
      return;
    }

    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / SLIDE_MS);
      mount.scrollTop = from * (1 - EASE(t));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  #trim(): void {
    const all = this.#mount.querySelectorAll('.msg');
    for (let i = this.#limit; i < all.length; i += 1) all[i]?.remove();
  }
}
