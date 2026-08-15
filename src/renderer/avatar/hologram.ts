/**
 * Anna's body: one photograph, and short clips generated from it.
 *
 * This replaces a three.js scene, a VRM humanoid rig, a procedural gesture
 * system and a three-layer motion compositor — about 1,300 lines — with an
 * `<img>` and two `<video>` elements. The reduction is the point, and it is
 * worth stating why it is not a downgrade.
 *
 * A rigged character is *always* animatable and never photoreal. A generated
 * clip is photoreal and only animatable where a clip exists. The bet this file
 * makes is that a real face doing one of nineteen things beats a synthetic face
 * doing anything, for a companion you glance at rather than direct.
 *
 * ## The one invariant everything rests on
 *
 * Every clip begins and ends on the source photograph. That is asked for in
 * prompts.ts and *verified* in seam.ts, and it is what lets this module cut
 * between any two clips, or between a clip and the still, with no transition at
 * all — no crossfade, no dissolve, no easing. A crossfade would be the obvious
 * defensive choice and it would be worse: dissolving between two frames that are
 * already identical adds a visible softening to a cut that was invisible.
 *
 * If the seam check fails for a clip, the fix belongs upstream — regenerate it,
 * or cut at the frame seam.ts found — not here in a fade.
 *
 * ## Two video elements
 *
 * A single `<video>` whose `src` is reassigned shows one black frame while the
 * new source loads. At 60fps that is a flash, and it happens on every gesture.
 * Two elements let the next clip be loaded and seeked to frame 0 *behind* the
 * current one, so the swap is a `hidden` toggle between two decoded frames.
 */

/** Slots this module knows how to ask for. Matches core/avatar/clips.ts. */
export type SlotName = string;

export interface HologramOptions {
  /** The element the still and the videos are appended to. */
  mount: HTMLElement;
  /** Fetches a clip's bytes. Null when that slot has not been generated. */
  loadClip: (slot: SlotName) => Promise<Uint8Array | null>;
  /** Reports something worth logging. Never user-facing. */
  report?: (event: string, detail?: Record<string, unknown>) => void;
}

export class Hologram {
  readonly #still: HTMLImageElement;
  readonly #videos: [HTMLVideoElement, HTMLVideoElement];
  readonly #options: HologramOptions;

  /** Blob URLs by slot. Clips are small and re-fetching one costs a frame. */
  readonly #cache = new Map<SlotName, string>();
  /** Slots known to be absent, so a missing gesture is asked for once. */
  readonly #missing = new Set<SlotName>();

  #front = 0;
  #playing: SlotName | null = null;
  /**
   * At most one. A queue would let a talkative turn bank six gestures and then
   * perform them in a row after she has stopped speaking, which reads as a
   * malfunction — the gesture is meant to land *with* the line.
   */
  #next: SlotName | null = null;
  #idle: SlotName | null = null;
  #disposed = false;

  constructor(options: HologramOptions) {
    this.#options = options;

    this.#still = document.createElement('img');
    this.#still.id = 'still';
    this.#still.alt = '';
    this.#still.decoding = 'sync';

    this.#videos = [document.createElement('video'), document.createElement('video')];
    for (const video of this.#videos) {
      video.muted = true; // Her voice comes from the TTS path, not the clip.
      video.playsInline = true;
      video.preload = 'auto';
      video.hidden = true;
      video.className = 'clip';
      video.addEventListener('ended', () => this.#onEnded(video));
    }

    options.mount.append(this.#still, ...this.#videos);
  }

  /** True once she is more than a photograph. */
  get animated(): boolean {
    return this.#idle !== null;
  }

  /** Sets the photograph. Everything else is drawn on top of this. */
  setPortrait(url: string | null): void {
    if (url) this.#still.src = url;
    this.#still.hidden = !url;
  }

  /**
   * Points at the clip that plays when nothing else is happening.
   *
   * Kept separate from {@link play} because idle is not a gesture: it loops, it
   * is never queued behind anything, and its absence is the difference between a
   * living panel and a photograph.
   */
  async setIdle(slot: SlotName | null): Promise<void> {
    this.#idle = slot;
    if (slot && !this.#playing) await this.play(slot);
  }

  /**
   * Plays a clip, or does nothing if it does not exist.
   *
   * Silence on a missing clip is deliberate. The model emits gesture directives
   * without knowing which have been rendered, so a missing one is the normal
   * case for most of a library's life. A missed `[wave]` costs nothing; a
   * visible error, or a frozen frame mid-sentence, costs the illusion.
   */
  async play(slot: SlotName): Promise<void> {
    if (this.#disposed || this.#missing.has(slot)) return;

    if (this.#playing && this.#playing !== this.#idle) {
      this.#next = slot;
      return;
    }

    const url = await this.#urlFor(slot);
    if (!url || this.#disposed) return;

    const back = this.#videos[this.#front === 0 ? 1 : 0]!;
    back.loop = slot === this.#idle;

    // Load and reach a decoded first frame *before* showing anything. `play()`
    // on a fresh src paints black until the first frame arrives.
    if (back.src !== url) {
      back.src = url;
      await once(back, 'loadeddata');
      if (this.#disposed) return;
    }
    back.currentTime = 0;

    try {
      await back.play();
    } catch {
      // Autoplay policy, or the element was swapped out from under us. Either
      // way the still is already behind it and correct.
      return;
    }

    const front = this.#videos[this.#front]!;
    back.hidden = false;
    // Hide the outgoing one *after* the incoming is visible. The other order
    // exposes the still for a frame, which is the flash this design exists to
    // avoid — even though the still is, by construction, the same image.
    if (front !== back) {
      front.hidden = true;
      front.pause();
    }
    this.#front = this.#front === 0 ? 1 : 0;
    this.#playing = slot;
  }

  /**
   * Stops whatever is playing and returns to the idle loop, or the still.
   *
   * Called on barge-in. A gesture that outlives the sentence it belonged to is
   * worse than no gesture.
   */
  silence(): void {
    this.#next = null;
    if (this.#playing && this.#playing !== this.#idle) void this.#returnToIdle();
  }

  dispose(): void {
    this.#disposed = true;
    for (const video of this.#videos) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
    for (const url of this.#cache.values()) URL.revokeObjectURL(url);
    this.#cache.clear();
    this.#still.remove();
  }

  #onEnded(video: HTMLVideoElement): void {
    if (video.loop || this.#disposed) return;
    const queued = this.#next;
    this.#next = null;
    void (queued ? this.#playAfter(queued) : this.#returnToIdle());
  }

  async #playAfter(slot: SlotName): Promise<void> {
    this.#playing = null;
    await this.play(slot);
  }

  async #returnToIdle(): Promise<void> {
    this.#playing = null;
    if (this.#idle) {
      await this.play(this.#idle);
      return;
    }
    // No idle clip: hide the video and let the photograph show through. The
    // last frame of the clip is the photograph, so this is not a visible cut.
    for (const video of this.#videos) {
      video.hidden = true;
      video.pause();
    }
  }

  async #urlFor(slot: SlotName): Promise<string | null> {
    const cached = this.#cache.get(slot);
    if (cached) return cached;

    const bytes = await this.#options.loadClip(slot);
    if (!bytes || bytes.length === 0) {
      this.#missing.add(slot);
      return null;
    }

    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'video/mp4' }));
    this.#cache.set(slot, url);
    this.#options.report?.('clip-loaded', { slot, bytes: bytes.length });
    return url;
  }

  /**
   * Forgets what it knows about the library.
   *
   * Called when a clip finishes rendering, because the interesting case is the
   * slot this module has already decided is missing — without this, the first
   * clip ever generated would not appear until the app was restarted.
   */
  invalidate(): void {
    for (const url of this.#cache.values()) URL.revokeObjectURL(url);
    this.#cache.clear();
    this.#missing.clear();
  }
}

function once(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve();
    target.addEventListener(event, done, { once: true });
    // A clip that will not decode must not hang the body forever. Two seconds
    // is far past a local file and far short of anything a user would wait for.
    setTimeout(done, 2000);
  });
}
