/**
 * Concurrency control for speech synthesis.
 *
 * Found in a real session, not in theory: Cartesia's entry plans cap concurrent
 * requests at 2, and the pipeline overlapped exactly 2 to keep clause N+1
 * synthesising while clause N plays. Sitting precisely on a provider's ceiling
 * means any straggler — a connection not yet closed, a turn that overlaps the
 * next — returns
 *
 *     429 Too many concurrent requests. Current limit: 2
 *
 * and that clause is simply never spoken. Anna keeps talking with a hole in the
 * middle of her sentence, which is worse than being slow.
 *
 * So concurrency is governed rather than assumed, and the limit is *learned*.
 * We start optimistic, and the first 429 is taken as the provider telling us
 * what it will actually allow. It never climbs back up on its own: a limit is a
 * property of someone's billing plan, not weather, and probing it repeatedly
 * just drops more audio.
 */

export interface GovernorOptions {
  /** Starting concurrency. Two overlaps synthesis with playback. */
  limit?: number;
  /** Never go below this. One still works; it is only slower between clauses. */
  floor?: number;
}

export class SynthesisGovernor {
  #limit: number;
  readonly #floor: number;
  #inFlight = 0;
  readonly #waiting: Array<() => void> = [];
  #rateLimited = false;

  constructor(options: GovernorOptions = {}) {
    this.#limit = Math.max(1, options.limit ?? 2);
    this.#floor = Math.max(1, options.floor ?? 1);
  }

  get limit(): number {
    return this.#limit;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  /** True once the provider has told us we were asking for too much. */
  get wasRateLimited(): boolean {
    return this.#rateLimited;
  }

  /**
   * Waits for a slot. Resolves with the function that releases it.
   *
   * The release is returned rather than exposed as a separate method so it
   * cannot be called for a slot that was never acquired — double-release is how
   * a semaphore quietly stops limiting anything.
   */
  async acquire(): Promise<() => void> {
    if (this.#inFlight >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#inFlight += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight -= 1;
      this.#waiting.shift()?.();
    };
  }

  /**
   * The provider said we were running too many at once. Believe it.
   *
   * Halving rather than decrementing gets out of the way in one step when the
   * gap is large, and one step is all we get — every request spent discovering
   * the limit is a clause the user did not hear.
   */
  reportRateLimit(): void {
    this.#rateLimited = true;
    const next = Math.max(this.#floor, Math.floor(this.#limit / 2));
    if (next < this.#limit) this.#limit = next;
    // Anything already queued is now over the new limit; it will drain as
    // in-flight requests release, which is exactly the desired behaviour.
  }
}

/** True when this error is a provider telling us to slow down. */
export function isRateLimit(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: number }).status;
  if (status === 429) return true;
  const message = (error as { message?: string }).message ?? '';
  return /\b429\b|too many|rate limit|concurren/i.test(message);
}
