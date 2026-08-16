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
 * ## The invariant everything rests on, and how much of it is true
 *
 * Every clip is supposed to begin *and end* on the source photograph. That is
 * asked for in prompts.ts and measured in seam.ts, and it is what would let
 * this module cut between any two clips, or between a clip and the still, with
 * no transition at all — no crossfade, no dissolve, no easing. A crossfade
 * would be the obvious defensive choice and it would be worse: dissolving
 * between two frames that are already identical adds a visible softening to a
 * cut that was invisible.
 *
 * Half of it holds. Measured against the three real clips (see
 * docs/audits/hedra-generation.md), every clip's *first* frame is the same
 * frame to within the noise of the encoder — two different clips' openings
 * differ by 0.0027 where a just-noticeable difference is 0.02 — so cutting
 * *into* a clip is genuinely invisible, which is what this design claimed.
 * Every clip's *last* frame is not: they leave the source pose in the first
 * second and hold somewhere else, three to six times over threshold. So the
 * exit from every clip is a visible jump, and on the idle loop it repeats every
 * few seconds.
 *
 * That is a defect in the clips, not in this file, and the fix belongs
 * upstream — regenerate them, or cut at the frame seam.ts finds — not here in
 * a fade. It is written down here because the rest of this file reads as if the
 * seam were already solved, and it is not.
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
  /**
   * URLs dropped from {@link #cache} that something may still be reading.
   *
   * {@link invalidate} cannot revoke a URL an element is sourced from, or one a
   * load has already been handed — see its note. It used to answer that by
   * keeping the whole cache *entry*, which is the opposite of what it wanted:
   * the stale URL was then handed out again on every later request. A gesture
   * recovered on the next `invalidate`, because `#playing` had moved on by
   * then; `#playing` names the idle loop permanently, so idle's bytes could
   * never be replaced at all. The entry goes now and only the revoke waits
   * here, until no element points at the URL.
   */
  readonly #stale = new Map<string, SlotName>();
  /** Slots known to be absent, so a missing gesture is asked for once. */
  readonly #missing = new Set<SlotName>();
  /**
   * Slots a {@link Hologram.play} has taken a URL for and not yet finished with.
   *
   * Exists for {@link invalidate}, which revokes blob URLs and used to revoke
   * them out from under a load already in progress: `#urlFor` hands back a URL,
   * a library event arrives, the URL is revoked, and the assignment to `src` a
   * moment later loads nothing. There is no error to catch — the element simply
   * never fires `loadeddata`, so it waits out `once()`'s two-second timeout and
   * then fails silently. A build emits several library events in a row, so this
   * raced every gesture during the one period when it was most likely to
   * happen.
   */
  readonly #loading = new Set<SlotName>();
  /**
   * What the library says exists. Null until it has said anything.
   *
   * `#missing` learns the same thing the expensive way — by asking for a clip
   * and being handed nothing — and that is one round trip too late. A gesture
   * that cannot play still reaches {@link play}, and if something is already
   * playing it takes the single queue slot, displacing whatever was in it. In a
   * live run `[nod]` was queued and then thrown away by `[lean_in]` a
   * millisecond later; `nod` had a clip, `lean_in` did not, and the turn ended
   * with no gesture at all where it could have had one.
   *
   * `#missing` stays as the backstop for the case this cannot see: the manifest
   * says ready and the bytes will not load.
   */
  #available: ReadonlySet<SlotName> | null = null;

  #front = 0;
  #playing: SlotName | null = null;
  /**
   * Whether the clip on screen loops.
   *
   * This used to be inferred by comparing `#playing` against `#idle`, and the
   * inference was wrong in the one state that mattered. `#idle` is a *setting* —
   * it changes whenever the library changes — while `#looping` is a fact about
   * the element that is currently playing, and the two came apart the moment
   * `setIdle(null)` was called with the idle clip still on screen: `#playing`
   * then differed from `#idle`, so `play()` read a loop as "a gesture is in
   * progress", queued behind it, and waited for an `ended` event that a looping
   * video never fires. Every gesture for the rest of the session was silently
   * swallowed — no error, no log, just a woman who stopped moving.
   */
  #looping = false;
  /**
   * At most one. A queue would let a talkative turn bank six gestures and then
   * perform them in a row after she has stopped speaking, which reads as a
   * malfunction — the gesture is meant to land *with* the line.
   */
  #next: SlotName | null = null;
  #idle: SlotName | null = null;
  #disposed = false;
  /**
   * Which `play()` call owns the swap.
   *
   * `play()` awaits a decode and then mutates `#front`, and two directives
   * emitted in the same breath — `[lean_in][nod]`, which performance.ts parses
   * without a gap — both pass the queue check before either has recorded itself
   * as playing. Both then drove the *same* back element and both flipped
   * `#front`, so it flipped twice and ended up pointing at the hidden video.
   * From there every subsequent swap reassigned `src` on the element that was
   * on screen, which is exactly the black-frame flash two elements exist to
   * avoid. A later call supersedes an earlier one rather than racing it.
   */
  #generation = 0;

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
      video.addEventListener('ended', () => this.#onStopped(video, 'ended'));
      video.addEventListener('error', () => this.#onStopped(video, 'error'));
    }

    options.mount.append(this.#still, ...this.#videos);
  }

  /**
   * True once she is more than a photograph.
   *
   * Asks what is on screen rather than what has been *configured*. `#idle`
   * being set says only that a slot was named; the clip behind it can be
   * missing, in which case she is a still and this used to say otherwise.
   */
  get animated(): boolean {
    return this.#playing !== null;
  }

  /**
   * Tells this module which slots the library actually holds.
   *
   * The model writes gesture directives without knowing what has been
   * rendered — that is by design, the vocabulary is advisory — so most of what
   * arrives here names a clip that does not exist. Knowing which is which
   * before {@link play} commits to anything is what stops an unrenderable
   * gesture from taking the queue slot off a renderable one.
   */
  setAvailable(slots: readonly SlotName[]): void {
    this.#available = new Set(slots);
  }

  /**
   * The source photograph as pixels, scaled to the size asked for.
   *
   * Here rather than in verify.ts because this class already owns the decoded
   * still — it is the element behind every clip — and decoding the same image a
   * second time to measure against it would be doing the work twice and risking
   * the two copies disagreeing.
   *
   * The caller passes the clip's render size; see `VerifyDeps.sourceFrame` for
   * why that cannot be decided here.
   */
  async sourceFrame(width: number, height: number): Promise<ImageData | null> {
    const still = this.#still;
    if (!still?.src || !still.naturalWidth) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    // Stretched to the clip's frame rather than letterboxed into it: the clip
    // was generated *from* this image, so the two are the same picture at
    // whatever resolution the vendor chose, and any padding here would be
    // measured as a difference that is not there.
    context.drawImage(still, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }

  /**
   * The photograph's pixel dimensions, once it has decoded. Null before that.
   *
   * Exposed because the panel is sized to fit her rather than the other way
   * round, and this is the only place those numbers exist in the renderer.
   */
  get shape(): { width: number; height: number } | null {
    const { naturalWidth: width, naturalHeight: height } = this.#still;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  /**
   * Sets the photograph. Everything else is drawn on top of this.
   *
   * Resolves once the image has actually decoded, so a caller that needs
   * {@link shape} — to size the window, say — is not reading zeros.
   */
  async setPortrait(url: string | null): Promise<void> {
    this.#still.hidden = !url;
    if (!url) return;
    this.#still.src = url;
    if (this.#still.complete) return;
    await once(this.#still, 'load');
  }

  /**
   * Points at the clip that plays when nothing else is happening.
   *
   * Kept separate from {@link play} because idle is not a gesture: it loops, it
   * is never queued behind anything, and its absence is the difference between a
   * living panel and a photograph.
   */
  async setIdle(slot: SlotName | null): Promise<void> {
    const previous = this.#idle;
    if (slot === previous) {
      // The common call by a long way: `applyLibrary` runs on every library
      // event and almost always names the same slot. Nothing to reconcile.
      if (slot && !this.#playing) await this.#start(slot);
      return;
    }
    this.#idle = slot;

    /*
     * Changing the idle clip has to change what is on screen, not just the
     * books.
     *
     * The library can stop offering `idle`, or offer a different one — it is
     * evicted, its file goes missing, a new photograph replaces it — while the
     * old one is still looping. Leaving it running showed a clip the library no
     * longer claims to have, and left `#playing` naming a slot `#idle` no
     * longer did, which is the state that used to jam the gesture queue for
     * good.
     *
     * The generation bump is the other half, and it is not optional: a
     * `#start` already in flight chose its `loop` flag against the *old*
     * `#idle`, so letting it land puts a retracted clip on screen — looping
     * forever, if it happened to be mid-load with `loop` already true.
     */
    this.#generation += 1;
    if (this.#looping || this.#playing === previous || this.#playing === null) {
      await this.#returnToIdle();
    }
    // A gesture in progress is left alone. It will return to whatever `#idle`
    // now is when it ends, which is the right moment to change the loop.
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
    if (this.#available && !this.#available.has(slot)) return;

    // A gesture in progress gets to finish; the next one waits for it to stop.
    // A looping clip is asked about rather than inferred — see `#looping`.
    if (this.#playing !== null && !this.#looping) {
      this.#next = slot;
      return;
    }

    await this.#start(slot);
  }

  /**
   * Puts a clip on screen. The only place `#front` and `#playing` move.
   *
   * Reports which of three things happened, because two of them look identical
   * from outside and must not be treated alike. `superseded` means a newer call
   * took over — the caller must do nothing at all, or it will undo the newer
   * call's work; `failed` means nothing reached the screen and nothing else is
   * coming, which is the case a caller may want to fall back from. Collapsing
   * the two into "did `#playing` change" cost two gestures in a row: a queued
   * clip bailing out because a fresh directive had superseded it was read as
   * "the queued clip is missing", and the fallback to idle then superseded the
   * fresh directive in turn.
   */
  async #start(slot: SlotName): Promise<'shown' | 'superseded' | 'failed'> {
    if (this.#disposed) return 'failed';
    const generation = ++this.#generation;
    const superseded = (): boolean => this.#disposed || generation !== this.#generation;

    this.#loading.add(slot);
    let url: string | null;
    try {
      url = await this.#urlFor(slot);
    } finally {
      this.#loading.delete(slot);
    }
    if (superseded()) return 'superseded';
    if (!url) return 'failed';

    const back = this.#videos[this.#front === 0 ? 1 : 0]!;
    back.loop = slot === this.#idle;

    // Load and reach a decoded first frame *before* showing anything. `play()`
    // on a fresh src paints black until the first frame arrives.
    if (back.src !== url) {
      back.src = url;
      await once(back, 'loadeddata');
      if (superseded()) return 'superseded';
    }
    back.currentTime = 0;

    try {
      await back.play();
    } catch {
      // Autoplay policy, or the element was swapped out from under us. Either
      // way the still is already behind it and correct.
      return superseded() ? 'superseded' : 'failed';
    }
    if (superseded()) return 'superseded';

    /*
     * `front` and `back` are always the two different elements, and it is worth
     * saying why since the line below pauses one of them.
     *
     * `back` was read from `#front` before two awaits, so in principle `#front`
     * could have moved underneath it — and if it had, this would pause the clip
     * it has just started. It cannot: `#front` is only assigned below, inside a
     * `#start` holding the highest generation, and every await above is
     * followed by a `superseded()` check. So any call that could have flipped
     * it has already sent this one home.
     */
    const front = this.#videos[this.#front]!;
    back.hidden = false;
    // Hide the outgoing one *after* the incoming is visible. The other order
    // exposes the still for a frame, which is the flash this design exists to
    // avoid.
    front.hidden = true;
    front.pause();
    this.#front = this.#front === 0 ? 1 : 0;
    this.#playing = slot;
    this.#looping = back.loop;
    // An element has just changed source, which is the event that frees
    // whatever URL it was holding for `invalidate`.
    this.#sweepStale();
    // Here rather than at the top, because everything above this line is a way
    // for a start to end without anything reaching the screen. Main treats this
    // as the record of what she actually used.
    this.#options.report?.('clip-played', { slot, looping: back.loop });
    return 'shown';
  }

  /**
   * Stops whatever is playing and returns to the idle loop, or the still.
   *
   * Called on barge-in. A gesture that outlives the sentence it belonged to is
   * worse than no gesture.
   */
  silence(): void {
    this.#next = null;

    /*
     * The bump comes first, and it is what makes this a barge-in rather than a
     * note in a ledger.
     *
     * A gesture that is still loading when the user starts talking has not
     * recorded itself yet — `#playing` still names the idle loop — so every
     * test this method could make about `#playing` says "nothing to stop", and
     * the gesture lands a moment later and plays out over them. Cancelling
     * whatever is in flight is the only thing that reaches it.
     */
    this.#generation += 1;

    // The idle loop is already on screen: the thing just cancelled was a
    // gesture on its way in, and there is nothing to stop or restore.
    if (this.#looping) return;

    // Stopped now, not when the replacement has finished decoding. Freezing on
    // a frame for the length of a load is a worse look than a cut, but a
    // gesture that outlives the sentence it belonged to is worse than both.
    if (this.#playing !== null) this.#videos[this.#front]!.pause();
    // Unconditional, because `#playing` can also be null here — the cancelled
    // start may have been the idle clip's own, in which case she is a
    // photograph and needs putting back.
    void this.#returnToIdle();
  }

  dispose(): void {
    this.#disposed = true;
    // Anything in flight is sent home as well as blocked: `#disposed` is
    // checked at every await, and the bump covers the one place it is not — a
    // `#start` between its last check and its assignment to `#front`.
    this.#generation += 1;
    this.#playing = null;
    this.#looping = false;
    this.#next = null;
    for (const video of this.#videos) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
    for (const url of this.#cache.values()) URL.revokeObjectURL(url);
    this.#cache.clear();
    // Unconditionally, unlike the sweep: the elements have just been emptied
    // and nothing is going to ask about these again.
    for (const url of this.#stale.keys()) URL.revokeObjectURL(url);
    this.#stale.clear();
    this.#loading.clear();
    this.#still.remove();
  }

  /**
   * A clip stopped: it ended, or it failed.
   *
   * `error` matters as much as `ended` and used not to be listened for at all.
   * `#next` is drained here and nowhere else, so a video that stops any other
   * way — a decode failure, a blob URL revoked out from under it — left
   * `#playing` set forever and every subsequent gesture was filed behind a clip
   * that was never going to finish. That is the same wedge, reached by a
   * different door.
   */
  #onStopped(video: HTMLVideoElement, reason: 'ended' | 'error'): void {
    if (this.#disposed) return;
    // A looping clip reaching its end is not a clip stopping.
    if (reason === 'ended' && video.loop) return;
    // An element that is not on screen is one that was swapped out; whatever it
    // has to say about itself is about a clip nobody is watching.
    if (video !== this.#videos[this.#front]) return;

    const queued = this.#next;
    this.#next = null;
    void (queued ? this.#playAfter(queued) : this.#returnToIdle());
  }

  async #playAfter(slot: SlotName): Promise<void> {
    this.#playing = null;
    this.#looping = false;
    /*
     * Only `failed` falls back. A queued clip that turns out not to exist must
     * not leave her frozen — `#start` is deliberately silent about a missing
     * slot, which is right at the top of a turn where the still is already
     * behind it, and wrong here where the last frame of the gesture that just
     * ended is what is on screen. But `superseded` means a *newer* clip is on
     * its way, and returning to idle then would cancel it.
     */
    if ((await this.#start(slot)) === 'failed') await this.#returnToIdle();
  }

  async #returnToIdle(): Promise<void> {
    this.#playing = null;
    this.#looping = false;
    if (this.#idle) {
      // Only fall through on `failed`: the idle slot can name a clip that has
      // since been evicted, and the photograph is better than the last frame of
      // the gesture that just ended. `superseded` is somebody else's clip
      // arriving, and must be left alone.
      if ((await this.#start(this.#idle)) !== 'failed') return;
    }
    /*
     * Nothing left to play: hide the videos and let the photograph show.
     *
     * This used to say the cut was invisible because the last frame of a clip
     * *is* the photograph. Measured against the three real clips, it is not —
     * they leave the source pose in the first second and hold somewhere else
     * (see docs/audits/hedra-generation.md). So this is a visible cut, and the
     * honest thing is to say so here rather than to keep asserting an invariant
     * the vendor does not deliver.
     */
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
   *
   * Every entry goes. Two of the *revokes* are deferred, and the deferral is
   * not tidiness: revoking the URL an element is currently sourced from is
   * legal but the element's behaviour afterwards is not something to rely on,
   * and revoking one a load has already been handed is simply a broken load
   * with no error attached. Those URLs move to {@link #stale} and are revoked
   * once nothing points at them — see {@link #sweepStale}.
   */
  invalidate(): void {
    for (const [slot, url] of this.#cache) {
      this.#cache.delete(slot);
      if (slot === this.#playing || this.#loading.has(slot)) this.#stale.set(url, slot);
      else URL.revokeObjectURL(url);
    }
    this.#missing.clear();
    this.#sweepStale();
  }

  /**
   * Revokes what {@link invalidate} could not, once it is safe to.
   *
   * "Safe" is no element sourced from it and no load holding it. A clip stays
   * as some element's `src` until that element is reused, which is one or two
   * clips later, so at most a couple of blobs outlive their entry — and
   * {@link dispose} revokes whatever is left whatever it is pointing at.
   */
  #sweepStale(): void {
    for (const [url, slot] of this.#stale) {
      if (this.#loading.has(slot)) continue;
      if (this.#videos.some((video) => video.src === url)) continue;
      URL.revokeObjectURL(url);
      this.#stale.delete(url);
    }
  }
}

function once(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Both sides are torn down whichever wins. Neither leak was serious on its
    // own — a listener on an element about to be reused, a timer that fires
    // into a resolved promise — but a clip load happens on every gesture, and
    // the timer alone kept the process from settling for two seconds after the
    // last one.
    const done = (): void => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      resolve();
    };
    target.addEventListener(event, done, { once: true });
    // A clip that will not decode must not hang the body forever. Two seconds
    // is far past a local file and far short of anything a user would wait for.
    timer = setTimeout(done, 2000);
  });
}
