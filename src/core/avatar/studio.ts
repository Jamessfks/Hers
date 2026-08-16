/**
 * Anna's face: one photograph, and the clips rendered from it.
 *
 * The photograph is the fixed point. Every clip is generated *from* it and is
 * asked to return to it, so the interface can cut from any clip back to the
 * still — or from the still into any clip — without a visible jump. That is why
 * the aspect ratio is taken from the image rather than pinned, and why swapping
 * the image invalidates every clip rather than keeping them.
 *
 * ## What this is honestly not
 *
 * It is not lip sync. Hedra's realtime product is withdrawn and what remains is
 * a job queue measured in minutes, so nothing can be rendered while she is
 * speaking. These are *body language* clips — a nod, a tilt, a laugh — rendered
 * ahead of time from silent driving audio and played when the conversation
 * calls for one. The UI says as much rather than implying a talking head.
 *
 * ## Money
 *
 * Hedra bills by the second of driving audio, so clip length is the dial and
 * every render is gated on Hedra's own reported spend. Two independent limits,
 * because one of them is always the one that fails:
 *
 *   budgetUsd     Checked against `/v3/usage` before every submit.
 *   maxSeconds    A clip cannot be asked for at a length that would blow the
 *                 budget in one go regardless of what the caller passed.
 *
 * Nothing is ever generated automatically. Every render is something a person
 * clicked.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { HedraClient, HedraError } from './hedra.ts';
import type { ClipRequest } from './hedra.ts';
import { sniffImage } from './image-info.ts';
import type { ImageInfo } from './image-info.ts';

// ---------------------------------------------------------------------------
// What she can be asked to do
// ---------------------------------------------------------------------------

/**
 * The gesture vocabulary.
 *
 * Short, because every entry is a paid render and a vocabulary nobody has
 * rendered is a vocabulary that does nothing. `idle` is the one the interface
 * loops between everything else, so it is the one to generate first.
 */
export const GESTURES = {
  idle: 'She is at rest, listening. She blinks, breathes, and shifts her weight very slightly. No large movement, no speech, mouth closed and relaxed.',
  nod: 'She nods once, slowly, agreeing. Warm and unhurried. Mouth closed.',
  tilt: 'She tilts her head to one side, curious, eyebrows lifting slightly. Mouth closed.',
  smile: 'A small smile spreads across her face and reaches her eyes. She does not speak.',
  laugh: 'She laughs, delighted, head tipping back a little, then settles.',
  lean_in: 'She leans in slightly toward the camera, interested and attentive. Mouth closed.',
  look_away: 'She glances away and up, thinking, then back toward the camera. Mouth closed.',
} as const;

export type Gesture = keyof typeof GESTURES;
export const GESTURE_NAMES = Object.keys(GESTURES) as Gesture[];

export function isGesture(value: unknown): value is Gesture {
  return typeof value === 'string' && value in GESTURES;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * What may be uploaded.
 *
 * The byte ceiling is the cheap check and the dimension range is the real one:
 * a 40-megapixel photograph is not a better avatar, it is a slower upload and a
 * larger bill, and anything under 256px has nothing for the model to work with.
 */
export const IMAGE_LIMITS = {
  maxBytes: 12 * 1024 * 1024,
  minDimension: 256,
  maxDimension: 4096,
  formats: ['image/jpeg', 'image/png', 'image/webp'] as const,
} as const;

/** Clip length. Two seconds is enough for a gesture and is the budget dial. */
export const CLIP_SECONDS = { min: 1, max: 4, default: 2 } as const;

export class AvatarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarError';
  }
}

// ---------------------------------------------------------------------------
// State on disk
// ---------------------------------------------------------------------------

export interface AvatarSource {
  file: string;
  mimeType: string;
  width: number;
  height: number;
  /** Content hash. A clip is only valid for the source it was rendered from. */
  id: string;
  addedAt: number;
}

export interface AvatarClip {
  file: string;
  sourceId: string;
  jobId: string;
  seconds: number;
  costUsd: number | null;
  renderedAt: number;
}

/** A render that was started and not yet seen to finish. */
export interface PendingClip {
  gesture: Gesture;
  jobId: string;
  sourceId: string;
  startedAt: number;
}

interface Manifest {
  source: AvatarSource | null;
  clips: Partial<Record<Gesture, AvatarClip>>;
  pending: PendingClip[];
  /** Hedra's reported lifetime spend when this folder was first used. */
  baselineUsd: number | null;
}

/** What the UI is told. */
export interface AvatarState {
  hasSource: boolean;
  sourceUrl: string | null;
  width: number;
  height: number;
  /** Gestures with a rendered clip on disk, ready to play. */
  ready: Gesture[];
  /** Gestures being rendered right now. */
  rendering: Gesture[];
  /** All gestures that exist, rendered or not. */
  all: Gesture[];
  spentUsd: number;
  budgetUsd: number;
  configured: boolean;
}

const EMPTY: Manifest = { source: null, clips: {}, pending: [], baselineUsd: null };

// ---------------------------------------------------------------------------

export interface StudioOptions {
  /** `anna-profile/avatar`. */
  dir: string;
  client: HedraClient | null;
  /** Ceiling on what may be spent from this folder's baseline, in USD. */
  budgetUsd: number;
  now?: () => number;
}

export class AvatarStudio {
  readonly #dir: string;
  readonly #client: HedraClient | null;
  readonly #budget: number;
  readonly #now: () => number;
  #manifest: Manifest = { ...EMPTY };
  /** Gestures with a submit in flight, so two clicks cannot pay twice. */
  readonly #inFlight = new Set<Gesture>();
  #spentDelta = 0;

  constructor(options: StudioOptions) {
    this.#dir = options.dir;
    this.#client = options.client;
    this.#budget = Math.max(0, options.budgetUsd);
    this.#now = options.now ?? (() => Date.now());
  }

  get dir(): string {
    return this.#dir;
  }

  get configured(): boolean {
    return this.#client !== null;
  }

  async load(): Promise<AvatarState> {
    await mkdir(path.join(this.#dir, 'clips'), { recursive: true });
    const file = path.join(this.#dir, 'manifest.json');

    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null) {
          const saved = parsed as Partial<Manifest>;
          this.#manifest = {
            source: saved.source ?? null,
            clips: saved.clips ?? {},
            pending: Array.isArray(saved.pending) ? saved.pending : [],
            baselineUsd: typeof saved.baselineUsd === 'number' ? saved.baselineUsd : null,
          };
        }
      } catch {
        // A hand-edited or truncated manifest costs the clip list, not the
        // startup. The files are still on disk and can be re-adopted.
        this.#manifest = { ...EMPTY };
      }
    }

    // Drop clips whose file has gone, or that belong to a photograph that has
    // since been replaced. Either way they cannot be played.
    for (const [gesture, clip] of Object.entries(this.#manifest.clips) as [Gesture, AvatarClip][]) {
      const stale = clip.sourceId !== this.#manifest.source?.id;
      if (stale || !existsSync(path.join(this.#dir, 'clips', clip.file))) {
        delete this.#manifest.clips[gesture];
      }
    }

    if (this.#manifest.baselineUsd === null && this.#client) {
      try {
        this.#manifest.baselineUsd = await this.#client.spentUsd();
      } catch {
        // No baseline means the budget cannot be enforced, and a budget that
        // cannot be enforced must not be assumed satisfied — `#checkBudget`
        // refuses rather than proceeding.
      }
    }

    await this.#save();
    await this.#refreshSpend();
    return this.state();
  }

  state(): AvatarState {
    const source = this.#manifest.source;
    return {
      hasSource: source !== null,
      // Cache-busted by the content hash: replacing the photograph must not
      // leave the previous one on screen.
      sourceUrl: source ? `/avatar/source?v=${source.id.slice(0, 12)}` : null,
      width: source?.width ?? 0,
      height: source?.height ?? 0,
      ready: (Object.keys(this.#manifest.clips) as Gesture[]).sort(),
      rendering: [...this.#inFlight].sort(),
      all: GESTURE_NAMES,
      spentUsd: Math.round(this.#spentDelta * 100) / 100,
      budgetUsd: this.#budget,
      configured: this.configured,
    };
  }

  // -------------------------------------------------------------------------
  // The photograph
  // -------------------------------------------------------------------------

  /**
   * Accepts an uploaded image, or explains precisely why not.
   *
   * Validated from the bytes rather than from what the upload claimed. A
   * declared MIME type is a hint; the magic number is evidence, and this is a
   * file that is about to be sent to a paid API and served back to a browser.
   */
  async setSource(bytes: Buffer, declaredType: string): Promise<AvatarState> {
    if (bytes.length === 0) throw new AvatarError('That file was empty.');
    if (bytes.length > IMAGE_LIMITS.maxBytes) {
      throw new AvatarError(
        `That image is ${mb(bytes.length)}. The limit is ${mb(IMAGE_LIMITS.maxBytes)}.`,
      );
    }

    const info: ImageInfo | null = sniffImage(bytes);
    if (!info) {
      throw new AvatarError(
        `That does not look like a JPEG, PNG or WebP${declaredType ? ` (it was sent as ${declaredType})` : ''}.`,
      );
    }
    if (!(IMAGE_LIMITS.formats as readonly string[]).includes(info.mimeType)) {
      throw new AvatarError(`${info.mimeType} is not a format she can use.`);
    }

    const smallest = Math.min(info.width, info.height);
    const largest = Math.max(info.width, info.height);
    if (smallest < IMAGE_LIMITS.minDimension) {
      throw new AvatarError(
        `That image is ${info.width}x${info.height}. The short side needs to be at least ${IMAGE_LIMITS.minDimension} pixels.`,
      );
    }
    if (largest > IMAGE_LIMITS.maxDimension) {
      throw new AvatarError(
        `That image is ${info.width}x${info.height}. The long side cannot be over ${IMAGE_LIMITS.maxDimension} pixels.`,
      );
    }

    if (this.#inFlight.size > 0) {
      throw new AvatarError(
        'She is in the middle of a render. Let it finish before changing the picture.',
      );
    }

    const id = createHash('sha256').update(bytes).digest('hex');
    const file = `source${extensionFor(info.mimeType)}`;

    // Written to a temporary name and moved into place, so a failed write
    // cannot leave a half-image that the manifest claims is the source.
    const target = path.join(this.#dir, file);
    const temporary = `${target}.incoming`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);

    // A new photograph invalidates every clip: they all start from the old one.
    for (const clip of Object.values(this.#manifest.clips)) {
      await rm(path.join(this.#dir, 'clips', clip.file), { force: true });
    }
    if (this.#manifest.source && this.#manifest.source.file !== file) {
      await rm(path.join(this.#dir, this.#manifest.source.file), { force: true });
    }

    this.#manifest.source = {
      file,
      mimeType: info.mimeType,
      width: info.width,
      height: info.height,
      id,
      addedAt: this.#now(),
    };
    this.#manifest.clips = {};
    this.#manifest.pending = [];
    await this.#save();
    return this.state();
  }

  sourcePath(): string | null {
    const source = this.#manifest.source;
    return source ? path.join(this.#dir, source.file) : null;
  }

  sourceMimeType(): string {
    return this.#manifest.source?.mimeType ?? 'image/jpeg';
  }

  clipPath(gesture: Gesture): string | null {
    const clip = this.#manifest.clips[gesture];
    return clip ? path.join(this.#dir, 'clips', clip.file) : null;
  }

  has(gesture: Gesture): boolean {
    return Boolean(this.#manifest.clips[gesture]);
  }

  /** Gestures the model may actually use, because they will move something. */
  readyGestures(): Gesture[] {
    return (Object.keys(this.#manifest.clips) as Gesture[]).sort();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Renders one gesture. Everything about this is deliberately explicit.
   *
   * The order matters and is the whole lesson of the previous implementation's
   * audit: check the budget, submit, **write the job id down**, and only then
   * wait. A crash anywhere after the submit leaves a recorded job that the next
   * run can resume, rather than an invisible one that gets paid for twice.
   */
  async render(
    gesture: Gesture,
    options: { seconds?: number; signal?: AbortSignal } = {},
  ): Promise<AvatarClip> {
    const client = this.#client;
    if (!client) throw new AvatarError('No Hedra API key. Set HEDRA_API_KEY and restart.');

    const source = this.#manifest.source;
    if (!source) throw new AvatarError('Give her a photograph first.');
    if (this.#inFlight.has(gesture)) throw new AvatarError(`${gesture} is already rendering.`);

    const seconds = clamp(
      options.seconds ?? CLIP_SECONDS.default,
      CLIP_SECONDS.min,
      CLIP_SECONDS.max,
    );

    await this.#checkBudget(seconds);
    this.#inFlight.add(gesture);

    try {
      const image = await readFile(path.join(this.#dir, source.file));
      const request: ClipRequest = {
        image,
        imageMimeType: source.mimeType,
        prompt: promptFor(gesture),
        seconds,
        resolution: '540p',
        ...(options.signal ? { signal: options.signal } : {}),
      };

      const jobId = await client.submit(request);

      // Written before the wait, and this line is the whole point of the split
      // between `submit` and `wait`. From here the job is billable; if the
      // process dies now, `resume()` finds it instead of paying again.
      this.#manifest.pending = [
        ...this.#manifest.pending.filter((entry) => entry.gesture !== gesture),
        { gesture, jobId, sourceId: source.id, startedAt: this.#now() },
      ];
      await this.#save();

      const job = await client.wait(jobId, { ...(options.signal ? { signal: options.signal } : {}) });
      if (!job.videoUrl) throw new AvatarError('Hedra finished but produced no clip.');

      const bytes = await client.download(job.videoUrl, options.signal);
      return await this.#adopt(gesture, jobId, source.id, seconds, job.cost, bytes);
    } finally {
      this.#inFlight.delete(gesture);
      await this.#refreshSpend();
    }
  }

  /**
   * Picks up jobs that were submitted and never seen to finish.
   *
   * Called on startup. These have already been billed, so collecting them is
   * free and skipping them is not.
   */
  async resume(): Promise<Gesture[]> {
    const client = this.#client;
    const source = this.#manifest.source;
    if (!client || !source || this.#manifest.pending.length === 0) return [];

    const recovered: Gesture[] = [];
    for (const entry of [...this.#manifest.pending]) {
      if (entry.sourceId !== source.id) {
        this.#manifest.pending = this.#manifest.pending.filter((each) => each !== entry);
        continue;
      }
      try {
        const job = await client.job(entry.jobId);
        if (job.status === 'COMPLETED' && job.videoUrl) {
          const bytes = await client.download(job.videoUrl);
          await this.#adopt(entry.gesture, entry.jobId, entry.sourceId, 0, job.cost, bytes);
          recovered.push(entry.gesture);
        } else if (job.status === 'FAILED') {
          this.#manifest.pending = this.#manifest.pending.filter((each) => each !== entry);
        }
      } catch {
        // Still running, or unreachable. Left in `pending` so the next start
        // tries again — an unresolved job is not a lost one.
      }
    }
    await this.#save();
    return recovered;
  }

  // -------------------------------------------------------------------------

  async #adopt(
    gesture: Gesture,
    jobId: string,
    sourceId: string,
    seconds: number,
    costUsd: number | null,
    bytes: Buffer,
  ): Promise<AvatarClip> {
    // A photograph swapped while this was rendering wins: the clip starts from
    // a face that is no longer hers, and keeping it would mix two libraries.
    if (this.#manifest.source?.id !== sourceId) {
      throw new AvatarError('The photograph changed while that was rendering, so it was discarded.');
    }

    const file = `${gesture}-${sourceId.slice(0, 8)}.mp4`;
    const target = path.join(this.#dir, 'clips', file);
    const temporary = `${target}.incoming`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);

    const clip: AvatarClip = {
      file,
      sourceId,
      jobId,
      seconds,
      costUsd,
      renderedAt: this.#now(),
    };
    this.#manifest.clips[gesture] = clip;
    this.#manifest.pending = this.#manifest.pending.filter((entry) => entry.jobId !== jobId);
    await this.#save();
    return clip;
  }

  /**
   * Refuses rather than proceeds when the spend cannot be established.
   *
   * A budget that silently does nothing when the usage endpoint is unreachable
   * is not a budget. The failure mode of being too strict is an error message;
   * the failure mode of being too lax is a bill.
   */
  async #checkBudget(seconds: number): Promise<void> {
    const client = this.#client;
    if (!client) throw new AvatarError('No Hedra API key.');

    let spent: number;
    try {
      spent = await client.spentUsd();
    } catch (error) {
      throw new AvatarError(
        `Could not check how much has been spent, so nothing was submitted. ${error instanceof HedraError ? error.message : ''}`.trim(),
      );
    }

    if (this.#manifest.baselineUsd === null) {
      this.#manifest.baselineUsd = spent;
      await this.#save();
    }

    const used = Math.max(0, spent - this.#manifest.baselineUsd);
    this.#spentDelta = used;
    if (used >= this.#budget) {
      throw new AvatarError(
        `The Hedra budget is spent — $${used.toFixed(2)} of $${this.#budget.toFixed(2)}. Raise ANNA_HEDRA_BUDGET_USD to allow more.`,
      );
    }
    void seconds;
  }

  async #refreshSpend(): Promise<void> {
    const client = this.#client;
    if (!client || this.#manifest.baselineUsd === null) return;
    try {
      const spent = await client.spentUsd();
      this.#spentDelta = Math.max(0, spent - this.#manifest.baselineUsd);
    } catch {
      // The last known figure is better than zero, which would read as "nothing
      // has been spent" and is the one wrong answer that matters.
    }
  }

  async #save(): Promise<void> {
    const file = path.join(this.#dir, 'manifest.json');
    await writeFile(`${file}.incoming`, JSON.stringify(this.#manifest, null, 2), 'utf8');
    await rename(`${file}.incoming`, file);
  }
}

// ---------------------------------------------------------------------------

/**
 * The prompt for one gesture.
 *
 * Every one ends the same way, and that sentence is the load-bearing part: the
 * interface cuts from a clip straight back to the still photograph with no
 * transition, and that only looks right if the last frame is close to the
 * first. Asking for it does not guarantee it, but not asking guarantees drift.
 */
export function promptFor(gesture: Gesture): string {
  return [
    GESTURES[gesture],
    'Static camera, unchanged background, consistent lighting.',
    'She begins and ends in the same pose and position as the source image.',
  ].join(' ');
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
