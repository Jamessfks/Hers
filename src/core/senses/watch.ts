/**
 * Noticing, as opposed to seeing.
 *
 * She could already see: `sendImage()` pushes a JPEG on the Live API's video
 * channel at up to one frame a second, and the model looks at it. What she
 * could not do is *notice* — the frames are turn-scoped, so she only ever
 * reacted to what was in front of her when somebody asked her to. A companion
 * who describes the room accurately when questioned and never once says "you've
 * cut your hair" is doing image classification, not living with you.
 *
 * `shared/screen-change.ts` already solves this for the screen, and cheaply: a
 * 32×18 luma signature diffed in the browser, producing one of three words.
 * That works because a screen changing is a change in pixels. A room is not —
 * a person standing up changes half the frame and means nothing, and a person
 * putting their head in their hands changes very little and means everything.
 * Luma cannot tell those apart and no threshold will make it.
 *
 * So the camera gets language instead. One `gemini-3.5-flash` caption every
 * twenty seconds, diffed against the previous caption as *text*, and only a
 * real change is injected as a `⟦context⟧` note. The cost is one small
 * multimodal call per interval — measured against the alternative, which is her
 * never mentioning anything she was not asked about.
 *
 * Wrapped by {@link untrusted} on the way in, like everything else derived from
 * what she saw: a caption is a description of a scene that may contain a
 * screen, a note, or somebody holding up a piece of paper.
 */

import { untrusted } from './untrusted.ts';

/** How often a frame is captioned, at most. */
export const CAPTION_INTERVAL_MS = 20_000;

/**
 * Words that are in almost every caption and carry no information.
 *
 * The diff is over content words, because two captions of an unchanged room
 * differ in their function words constantly — "a man sitting at a desk" and
 * "the man is sitting at his desk" are the same scene and share four of nine
 * tokens. Stripping these takes that pair to a perfect match.
 */
const FILLER = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'being', 'been', 'and', 'or',
  'of', 'in', 'on', 'at', 'to', 'with', 'his', 'her', 'their', 'its', 'this', 'that',
  'there', 'appears', 'seems', 'looks', 'image', 'shows', 'photo', 'frame', 'camera',
  'person', 'someone', 'visible', 'background', 'foreground',
]);

function content(caption: string): Set<string> {
  return new Set(
    caption
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 2 && !FILLER.has(word)),
  );
}

/**
 * How different two captions have to be before it is worth interrupting for.
 *
 * Jaccard distance over content words, and the number is measured rather than
 * chosen. Over five pairs written to bracket the decision: the same desk with a
 * mug added scores 0.29, the same scene reworded scores 0.38, the same person
 * at the same desk now typing scores 0.71, and having moved to the sofa scores
 * 0.90. Two thirds was the first guess and it fired on "now typing", which is
 * exactly the interruption nobody wants. Four fifths is the gap.
 *
 * What it misses at that threshold: the light going out scores 0.40, so she
 * will not remark on it. That is the cost of a text diff over a visual one, and
 * the frame itself still reaches the Live session — she can see the dark room,
 * she just will not be the one to bring it up.
 */
export const CHANGE_THRESHOLD = 0.8;

/** How far apart two captions are, 0 for identical and 1 for nothing in common. */
export function distance(before: string, after: string): number {
  const a = content(before);
  const b = content(after);
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : 1 - shared / union;
}

/** Turns a frame into a sentence. The seam the tests fake. */
export type Captioner = (frame: Buffer) => Promise<string>;

export interface WatchOptions {
  caption: Captioner;
  /** Told what she has just noticed, wrapped and ready for the session. */
  onChange: (note: string) => void;
  /** True while she must not be interrupted: asleep, or mid-sentence. */
  isBusy: () => boolean;
  now?: () => number;
}

/**
 * Watches the camera for something worth saying.
 *
 * Fed frames from wherever they already arrive — this does not capture
 * anything itself and does not hold a buffer, because the frames it looks at
 * are the same ones already being forwarded to the Live session and a second
 * copy of a camera feed is the sort of thing that ends up in a crash dump.
 */
export class CameraWatcher {
  #options: WatchOptions;
  #now: () => number;
  #last = '';
  #at = 0;
  #inFlight = false;

  constructor(options: WatchOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  /** The caption she is currently holding, for the prompt and for tests. */
  get caption(): string {
    return this.#last;
  }

  /**
   * Offer a frame. Most are dropped.
   *
   * Dropped rather than queued: a frame that arrived while the last caption was
   * still in flight is twenty seconds staler by the time it would be looked at,
   * and the newest frame is always the one worth captioning.
   */
  async see(frame: Buffer): Promise<void> {
    const now = this.#now();
    if (this.#inFlight) return;
    if (now - this.#at < CAPTION_INTERVAL_MS) return;
    if (this.#options.isBusy()) return;

    this.#inFlight = true;
    this.#at = now;
    try {
      const caption = (await this.#options.caption(frame)).trim();
      if (!caption) return;
      const first = this.#last === '';
      const moved = distance(this.#last, caption) >= CHANGE_THRESHOLD;
      this.#last = caption;
      // The first caption establishes the baseline and says nothing. Opening a
      // conversation with an unprompted description of the room is the failure
      // this class exists to avoid, inverted.
      if (first || !moved) return;
      if (this.#options.isBusy()) return;
      this.#options.onChange(
        `Something about them or the room has changed since you last looked. ` +
          `${untrusted('the camera', caption)}\nSay something about it, if it is worth ` +
          'saying. One line, the way you would if you had just glanced up. Not a ' +
          'description, and not every time.',
      );
    } catch {
      // A caption that failed is a caption that did not happen. The interval
      // has already been spent, which is the intended rate limit under a
      // failing key: this must not become a retry loop against a paid API.
    } finally {
      this.#inFlight = false;
    }
  }

  /** Forget what she was looking at. Called when the camera goes off or she sleeps. */
  reset(): void {
    this.#last = '';
    this.#at = 0;
  }
}
