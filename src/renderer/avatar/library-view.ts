/**
 * What the window does when the library changes, and which library it does it
 * for.
 *
 * A module of its own rather than two functions in main.ts because both of them
 * turn out to be about the same thing — *which photograph* the clips on screen
 * and the clips being measured belong to — and getting that wrong is silent in
 * both directions. The previous person's clip keeps looping over the new face,
 * and a verification pass started for one library writes its verdicts into
 * another. main.ts cannot be tested: it queries the DOM and builds the whole
 * window at module scope, so anything that matters has to live outside it.
 */

import type { LibraryView } from '../../shared/protocol.ts';

export interface PresenterDeps {
  /** The part of {@link import('./hologram.ts').Hologram} this drives. */
  hologram: {
    invalidate(): void;
    setAvailable(slots: readonly string[]): void;
    setIdle(slot: string | null): Promise<void>;
  };
  /**
   * Runs a verification pass, and stops when `abandoned` says the library it
   * was started for is no longer on screen.
   */
  verify: (slots: readonly string[], abandoned: () => boolean) => Promise<void>;
  /** Asks main what the library looks like *now*. */
  status: () => Promise<LibraryView>;
  /** Where `alive` goes. The panel styles itself off it. */
  alive: (alive: boolean) => void;
}

export class LibraryPresenter {
  readonly #deps: PresenterDeps;
  /** The photograph the window is showing clips for. */
  #shown: string | null = null;
  /** The photograph a verification pass is running against, if one is. */
  #verifying: string | null = null;

  constructor(deps: PresenterDeps) {
    this.#deps = deps;
  }

  async apply(view: LibraryView): Promise<void> {
    const swapped = this.#shown !== null && this.#shown !== view.portrait;
    this.#shown = view.portrait;

    // The cache has to be dropped before idle is re-checked: the hologram
    // records which slots are missing so it stops asking, and the whole point
    // of this call is that one of them may have just stopped being missing.
    this.#deps.hologram.invalidate();
    // Before `setIdle`, so a library that has just lost `idle` is not briefly
    // asked to play it.
    this.#deps.hologram.setAvailable(view.ready);
    /*
     * A different photograph is a different person, and what is looping belongs
     * to the previous one.
     *
     * `setIdle` treats the same slot *name* as nothing to reconcile, which is
     * right within one library and wrong across two: `idle` here is not `idle`
     * there. Without this the clip playing over the new face is the old face —
     * half of one person and half of another, which library-store.ts calls the
     * single most unsettling thing this feature can do.
     */
    if (swapped) await this.#deps.hologram.setIdle(null);
    await this.#deps.hologram.setIdle(view.ready.includes('idle') ? 'idle' : null);
    this.#deps.alive(view.alive);

    // Not awaited. Measuring is minutes of decoding on a good day and none of
    // it is on the path to her being on screen — the clips play unverified,
    // which is the whole reason `unverified` is a state rather than an error.
    void this.#verify(view);
  }

  /**
   * Measures any clip that has never been measured, one library at a time.
   *
   * One pass at a time, because a build emits several library events in a row
   * and each clip is a multi-megabyte decode on the thread that draws her.
   * Whatever a second pass would have found is still unverified when the first
   * finishes.
   */
  async #verify(view: LibraryView): Promise<void> {
    if (this.#verifying !== null || view.unverified.length === 0) return;

    const portrait = view.portrait;
    this.#verifying = portrait;
    try {
      await this.#deps.verify(view.unverified, () => this.#shown !== portrait);
    } finally {
      this.#verifying = null;
    }

    /*
     * A pass that abandoned itself leaves the library it abandoned *for*
     * unmeasured, and the event that would have started that pass was swallowed
     * by the guard above while this one was still running. Asking again is the
     * only thing that closes that gap; it recurses only when the photograph has
     * changed, so it cannot spin.
     */
    if (this.#shown !== portrait) await this.#verify(await this.#deps.status());
  }
}
