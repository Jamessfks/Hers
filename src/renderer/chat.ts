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
 * That gets the anchoring right and the *motion* wrong. Every mutation that
 * changes the content's height goes through {@link Thread.#shift}, which either
 * slides the whole stack on one curve or holds the reader exactly where they
 * were. Three rules make that safe, and all three were learned by getting them
 * wrong:
 *
 *  - **One animation, retargeted.** Every mutation used to register its own
 *    frame loop with its own start time and distance. Five messages in quick
 *    succession put ten writers on `scrollTop` at once and the view yo-yoed
 *    away from the bottom four times before settling.
 *  - **Pinned is remembered, not re-derived.** Asking `scrollTop === 0` in the
 *    middle of a slide is asking a question whose answer is "no" by
 *    construction, which sent every message after the first down the
 *    hold-the-reader branch and left the newest bubble parked above the fold.
 *  - **The target is written unconditionally at the end.** The loop puts the
 *    scroll somewhere wrong on purpose and relies on later frames to correct
 *    it, so anything that stops frames arriving — a hidden tab, a long block —
 *    would otherwise strand the thread mid-slide with nothing to fix it.
 */

/** Who said it. */
export type Speaker = 'anna' | 'you';

export interface ThreadOptions {
  /** The scrolling element the bubbles live in. */
  mount: HTMLElement;
  /**
   * Where the jump-to-bottom control is appended. Defaults to the mount's
   * parent, because the mount itself scrolls and the control must not.
   */
  chrome?: HTMLElement;
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
 * Matched to `arrive` and `arrive-sent` in styles.css so the container and the
 * bubble are one motion. They were 260 and 220 for a while, which is close
 * enough to look deliberate and far enough apart to measure.
 */
const SLIDE_MS = 260;

/**
 * How close to the bottom still counts as being at the bottom.
 *
 * `scrollTop` is 0 at the bottom of a reversed list and negative above it, and
 * it is not always exactly 0 — a fractional device pixel ratio leaves it at
 * -0.5 and a strict check would then treat a pinned thread as a scrolled one
 * forever after.
 */
const AT_BOTTOM_PX = 2;

/**
 * The easing from styles.css, as a function.
 *
 * This has to be the same curve the bubbles use, not merely a similar one. It
 * was `1 - (1-t)³` for a round — a perfectly reasonable ease-out that is not
 * `cubic-bezier(0.22, 1, 0.36, 1)`, and the two ran up to 32 percentage points
 * apart in the middle of the same 260ms, which is visible as the stack and the
 * bubble arriving on subtly different schedules.
 */
const EASE = bezier(0.22, 1, 0.36, 1);

export class Thread {
  readonly #mount: HTMLElement;
  readonly #typing: HTMLDivElement;
  readonly #jump: HTMLButtonElement;
  readonly #limit: number;
  /** Someone who has asked the system for less motion gets none of it here. */
  readonly #reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  #last: { from: Speaker; at: number; el: HTMLDivElement } | null = null;

  /** The in-flight slide, if any. At most one ever exists. */
  #raf = 0;
  /** Where that slide is going. Written unconditionally if it is cut short. */
  #target = 0;
  /** True while this class is the one writing `scrollTop`. */
  #animating = false;
  /**
   * Whether the reader is watching the newest message.
   *
   * Remembered rather than measured, because the measurement is only valid
   * when nothing is moving and the interesting moments are all mid-motion.
   */
  #pinned = true;

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

    /*
     * The way back down.
     *
     * Anna speaks unprompted, and the hold-the-reader branch is silent by
     * design — so without this, scrolling up to re-read something and then
     * receiving three messages gives you no indication anything arrived and no
     * control to get back except scrolling through all of it by hand.
     */
    this.#jump = document.createElement('button');
    this.#jump.id = 'jump';
    this.#jump.type = 'button';
    this.#jump.hidden = true;
    this.#jump.title = 'Jump to the newest message';
    this.#jump.setAttribute('aria-label', 'Jump to the newest message');
    this.#jump.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M6 10l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round" /></svg>';
    this.#jump.addEventListener('click', () => this.toBottom());
    (options.chrome ?? this.#mount.parentElement ?? this.#mount).append(this.#jump);

    this.#mount.addEventListener('scroll', this.#onScroll, { passive: true });
    // A tab that stops getting frames must not leave the thread mid-slide.
    document.addEventListener('visibilitychange', this.#settle);
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
    const wasPinned = this.#pinned;
    this.#add('you', text, Date.now());
    if (!wasPinned) this.toBottom();
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
    this.#pinned = true;
    this.#showJump(false);
  }

  /**
   * Returns the view to the newest message.
   *
   * Never animates more than one screenful. Coming back from the top of a long
   * history is otherwise three thousand pixels in a quarter of a second — about
   * 290 per frame at 120Hz, which is not motion the eye can follow, it is a
   * smear. Jumping most of the way and animating the last screen is what the
   * apps this is drawn from do.
   */
  toBottom(): void {
    const from = this.#mount.scrollTop;
    if (from >= -AT_BOTTOM_PX) {
      this.#pinned = true;
      this.#showJump(false);
      return;
    }
    if (this.#reduced.matches) {
      this.#land(0);
      return;
    }
    const near = Math.max(from, -this.#mount.clientHeight);
    this.#mount.scrollTop = near;
    this.#animateTo(0, near);
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
   * Two cases, and they want opposite things. Watching the newest message, the
   * stack should *slide* by exactly the height that was added — the scroll is
   * put back where it was and animated to the bottom, which moves every bubble
   * on one curve instead of teleporting them and fading the new one in
   * separately. Scrolled up, the reader is looking at something specific and
   * the only correct behaviour is for it not to move at all.
   */
  #shift(mutate: () => void): void {
    const mount = this.#mount;
    const pinned = this.#pinned;
    const before = mount.scrollHeight;

    mutate();

    const delta = mount.scrollHeight - before;
    if (delta <= 0) return;

    if (!pinned) {
      // Hold the reader's place. `scrollTop` is negative above the bottom in a
      // reversed list, so growing the content moves their view unless this
      // takes the growth back out.
      mount.scrollTop -= delta;
      this.#showJump(true);
      return;
    }

    if (this.#reduced.matches) {
      this.#land(0);
      return;
    }

    // Take the new height back out of the current position — mid-slide or not —
    // and animate to the bottom from there. A burst retargets the one loop
    // rather than starting a second.
    this.#animateTo(0, mount.scrollTop - delta);
  }

  #animateTo(target: number, from: number): void {
    cancelAnimationFrame(this.#raf);
    this.#mount.scrollTop = from;
    this.#target = target;
    this.#animating = true;

    const span = target - from;
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / SLIDE_MS);
      this.#mount.scrollTop = from + span * EASE(t);
      if (t < 1) {
        this.#raf = requestAnimationFrame(step);
        return;
      }
      this.#land(target);
    };
    this.#raf = requestAnimationFrame(step);
  }

  /** Ends any slide exactly on its target. Safe to call at any time. */
  #land(target: number): void {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#mount.scrollTop = target;
    this.#animating = false;
    this.#pinned = Math.abs(target) <= AT_BOTTOM_PX;
    this.#showJump(!this.#pinned);
  }

  #settle = (): void => {
    if (this.#raf) this.#land(this.#target);
  };

  #onScroll = (): void => {
    // Our own writes are not the user changing their mind.
    if (this.#animating) return;
    this.#pinned = Math.abs(this.#mount.scrollTop) <= AT_BOTTOM_PX;
    this.#showJump(!this.#pinned);
  };

  #showJump(show: boolean): void {
    this.#jump.hidden = !show;
  }

  #trim(): void {
    const all = this.#mount.querySelectorAll('.msg');
    for (let i = this.#limit; i < all.length; i += 1) all[i]?.remove();
  }
}

/**
 * A CSS `cubic-bezier(x1, y1, x2, y2)` as a function of t.
 *
 * Newton-Raphson on the x polynomial, falling back to bisection where the
 * derivative is too flat for it to converge — which is exactly what happens
 * near t=0 on the curves worth using, so the fallback is the common path rather
 * than a defensive afterthought.
 */
function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const a = (p: number, q: number): number => 1 - 3 * q + 3 * p;
  const b = (p: number, q: number): number => 3 * q - 6 * p;
  const c = (p: number): number => 3 * p;
  const curve = (t: number, p: number, q: number): number =>
    ((a(p, q) * t + b(p, q)) * t + c(p)) * t;
  const slope = (t: number, p: number, q: number): number =>
    3 * a(p, q) * t * t + 2 * b(p, q) * t + c(p);

  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;

    let guess = t;
    for (let i = 0; i < 4; i += 1) {
      const d = slope(guess, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      guess -= (curve(guess, x1, x2) - t) / d;
    }

    let low = 0;
    let high = 1;
    let mid = guess;
    if (mid < low || mid > high) {
      mid = (low + high) / 2;
      for (let i = 0; i < 20; i += 1) {
        const x = curve(mid, x1, x2);
        if (Math.abs(x - t) < 1e-5) break;
        if (x > t) high = mid;
        else low = mid;
        mid = (low + high) / 2;
      }
    }
    return curve(mid, y1, y2);
  };
}
