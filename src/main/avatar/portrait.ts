/**
 * The photograph, and the clips made from it.
 *
 * Main owns this because the renderer has no filesystem and no keys, and because
 * a library build is a sequence of paid jobs that has to survive the window
 * being closed halfway through. The renderer's entire relationship with it is:
 * hand over some bytes, ask what is ready, ask for a file.
 *
 * ## Why building stops on its own
 *
 * `build()` takes a ceiling and defaults it to one. That is not timidity, it is
 * the only sequencing that lets the first clip answer the questions the
 * remaining eighteen depend on:
 *
 *  - Does a silent driving track give a closed mouth, or an idling one?
 *  - Does the model return to the source pose closely enough for seam.ts to
 *    accept the loop, or does every clip need its cut point searched?
 *  - What does one clip actually cost? Hedra will not quote before ingest, so
 *    the first invoice is the first real number anyone has.
 *
 * Rendering all nineteen before looking at one would answer all three questions
 * nineteen times over and bill for the privilege.
 */

import { EventEmitter } from 'node:events';

import {
  BUILD_ORDER,
  IDLE_SLOT,
  attachJob,
  failClip,
  libraryProgress,
  pendingWork,
  resumableJobs,
  startGenerating,
  type ClipLibrary,
  type ClipSlotName,
} from '../../core/avatar/clips.ts';
import { sniffImage, type ImageInfo } from '../../core/avatar/image-info.ts';
import { ClipLibraryStore, hashSourceImage } from '../../core/avatar/library-store.ts';
import { buildClipPrompt } from '../../core/avatar/prompts.ts';
import {
  awaitClip,
  createVideoClipProvider,
  generateClip,
  VideoClipError,
  type VideoClipProvider,
} from '../../core/avatar/video-provider.ts';
import type { LibraryView, VideoProviderId } from '../../shared/protocol.ts';

/**
 * The largest photograph worth accepting.
 *
 * Hedra's own ceiling is 10.4 MB and it is the binding one; refusing here rather
 * than at submit means the message arrives while the user is still looking at
 * the file picker, instead of two uploads into a paid request.
 */
export const MAX_PORTRAIT_BYTES = 10 * 1024 * 1024;

/**
 * Below this, a face does not survive being animated.
 *
 * Generated clips are rendered at 540p to 1080p, so a source much smaller than
 * this is upscaled — and an upscaled face is the one artefact a viewer notices
 * immediately, because they are looking at it.
 */
export const MIN_PORTRAIT_EDGE = 512;

export type PortraitProblem =
  | { ok: false; reason: string };

export interface PortraitAccepted {
  ok: true;
  hash: string;
  info: ImageInfo;
  /** Present when the photograph is usable but something about it is worth saying. */
  note?: string;
}

export interface PortraitStoreOptions {
  store: ClipLibraryStore;
  providerId: VideoProviderId;
  /** Resolves the provider's key at call time, so a key set later is picked up. */
  apiKey: () => string | undefined;
  dropDir?: string;
}

export class PortraitLibrary extends EventEmitter {
  readonly #store: ClipLibraryStore;
  readonly #options: PortraitStoreOptions;
  #library: ClipLibrary | null = null;
  #building: ClipSlotName | null = null;
  /** Set while a build is running, so a second request does not double-spend. */
  #busy = false;

  constructor(options: PortraitStoreOptions) {
    super();
    this.#store = options.store;
    this.#options = options;
  }

  get library(): ClipLibrary | null {
    return this.#library;
  }

  /**
   * Checks a photograph before anything is written or spent.
   *
   * Separated from {@link adopt} so the picker can reject a file and say why
   * without side effects. Every rejection here is a rejection Hedra would have
   * made later, for money.
   */
  static inspect(bytes: Uint8Array): PortraitAccepted | PortraitProblem {
    if (bytes.length === 0) return { ok: false, reason: 'That file is empty.' };
    if (bytes.length > MAX_PORTRAIT_BYTES) {
      const mb = (bytes.length / 1024 / 1024).toFixed(1);
      return { ok: false, reason: `That photo is ${mb} MB. The limit is 10 MB.` };
    }

    const info = sniffImage(bytes);
    if (!info) {
      return {
        ok: false,
        reason: 'That is not a JPEG, PNG or WebP. A photo straight off an iPhone is HEIC — export it as JPEG first.',
      };
    }
    if (Math.min(info.width, info.height) < MIN_PORTRAIT_EDGE) {
      return {
        ok: false,
        reason: `That photo is ${info.width}x${info.height}. Her face gets upscaled below ${MIN_PORTRAIT_EDGE}px and it shows.`,
      };
    }

    const accepted: PortraitAccepted = { ok: true, hash: hashSourceImage(bytes), info };

    // Not a rejection — an extremely wide or tall crop is a legitimate choice —
    // but it decides the shape of every clip, so it is said out loud once.
    const ratio = info.width / info.height;
    if (ratio > 2 || ratio < 0.4) {
      accepted.note = `That is an unusual shape (${info.width}x${info.height}); every clip will be rendered to match it.`;
    }
    return accepted;
  }

  /** Stores the photograph and opens (or resumes) its clip library. */
  async adopt(bytes: Uint8Array): Promise<PortraitAccepted | PortraitProblem> {
    const inspected = PortraitLibrary.inspect(bytes);
    if (!inspected.ok) return inspected;

    this.#library = await this.#store.open(
      { bytes, mimeType: inspected.info.mimeType },
      { providerId: this.#options.providerId },
    );
    this.#emit();
    return inspected;
  }

  /** Loads whatever library belongs to this hash. Null when there is none. */
  async resume(portraitHash: string): Promise<ClipLibrary | null> {
    if (!portraitHash) return null;
    this.#library = await this.#store.load(portraitHash);
    if (this.#library) this.#emit();
    return this.#library;
  }

  /** The photograph's bytes, for the renderer to display. */
  async portraitBytes(): Promise<Uint8Array | null> {
    if (!this.#library) return null;
    const { readFile } = await import('node:fs/promises');
    try {
      return await readFile(this.#store.sourcePath(this.#library));
    } catch {
      return null;
    }
  }

  /** One clip's bytes, or null when that slot has not been generated. */
  async clipBytes(slot: ClipSlotName): Promise<Uint8Array | null> {
    if (!this.#library) return null;
    const path = this.#store.clipPath(this.#library, slot);
    if (!path) return null;
    const { readFile } = await import('node:fs/promises');
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  }

  /**
   * Renders up to `max` clips, in build order, and stops.
   *
   * Resumable jobs come first: a clip already submitted has already been paid
   * for, so re-polling it is free and re-submitting it is not.
   */
  async build(max = 1): Promise<LibraryView> {
    if (!this.#library) throw new Error('No photograph has been chosen.');
    if (this.#busy) return this.view();
    this.#busy = true;

    try {
      const provider = this.#provider();
      let done = 0;

      for (const { slot, job } of resumableJobs(this.#library)) {
        if (done >= max) break;
        await this.#finish(provider, slot, () =>
          awaitClip(provider, { providerId: job.providerId as VideoProviderId, id: job.id, submittedAt: job.submittedAt }),
        );
        done += 1;
      }

      const queue = pendingWork(this.#library).sort(
        (a, b) => BUILD_ORDER.indexOf(a) - BUILD_ORDER.indexOf(b),
      );

      for (const slot of queue) {
        if (done >= max) break;
        const built = buildClipPrompt(slot);
        const bytes = await this.portraitBytes();
        if (!bytes) throw new Error('The source photograph is missing from disk.');
        const info = sniffImage(bytes);

        await this.#finish(provider, slot, () =>
          generateClip(
            provider,
            {
              slot,
              image: bytes,
              imageMimeType: info?.mimeType ?? 'image/jpeg',
              prompt: built.prompt,
              avoid: built.avoid,
              seconds: built.seconds,
            },
            {
              onState: (state) => {
                this.emit('progress', { slot, state });
              },
            },
          ),
        );
        done += 1;
      }

      return this.view();
    } finally {
      this.#busy = false;
      this.#building = null;
      this.#emit();
    }
  }

  /**
   * Runs one clip through the state machine, whichever way it was started.
   *
   * The manifest is written after every transition rather than at the end. A
   * build is minutes long and paid for, so a crash between two clips must cost
   * the manifest entry and nothing else — the bytes are already on disk and
   * `reconcile` will find them.
   */
  async #finish(
    provider: VideoClipProvider,
    slot: ClipSlotName,
    run: () => Promise<{ bytes: Uint8Array; seconds: number | null; costUsd: number | null; job: { id: string; submittedAt: number } }>,
  ): Promise<void> {
    const library = this.#library!;
    this.#building = slot;
    this.#emit();

    try {
      if (library.clips[slot].status === 'pending') {
        this.#library = startGenerating(library, slot);
        await this.#store.save(this.#library);
      }

      const result = await run();

      this.#library = attachJob(this.#library!, slot, {
        providerId: provider.id,
        id: result.job.id,
        submittedAt: result.job.submittedAt,
      });

      // Bytes first, manifest second. A crash between the two leaves a clip on
      // disk that `reconcile` finds and promotes; the other order leaves a
      // manifest pointing at a file that was paid for and never written.
      //
      // The seam is deliberately not set here. Measuring it needs a video
      // decoder, which only the renderer has, so the clip lands playable but
      // unverified and the renderer reports back — see completeClip on what
      // that distinction costs.
      this.#library = await this.#store.writeClip(this.#library!, slot, result.bytes, {
        durationMs: Math.round((result.seconds ?? 0) * 1000),
        costUsd: result.costUsd ?? 0,
      });
      await this.#store.save(this.#library);
    } catch (error) {
      const reason =
        error instanceof VideoClipError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'That clip did not render.';
      this.#library = failClip(this.#library!, slot, reason);
      await this.#store.save(this.#library);
      this.emit('trouble', reason);
    } finally {
      this.#building = null;
      this.#emit();
    }
  }

  #provider(): VideoClipProvider {
    const key = this.#options.apiKey();
    const id = this.#options.providerId;
    if (id !== 'manual' && !key) {
      throw new VideoClipError(`No ${id} key is set, so nothing can be rendered.`, { provider: id });
    }
    return createVideoClipProvider(id, {
      ...(key !== undefined && { apiKey: key }),
      ...(this.#options.dropDir !== undefined && { dropDir: this.#options.dropDir }),
    });
  }

  view(): LibraryView {
    const library = this.#library;
    if (!library) {
      return { portrait: '', ready: [], building: null, failed: [], total: 0, alive: false, spentUsd: 0 };
    }

    const progress = libraryProgress(library);
    const ready: string[] = [];
    const failed: string[] = [];
    for (const [slot, entry] of Object.entries(library.clips)) {
      if (entry.status === 'ready') ready.push(slot);
      else if (entry.status === 'failed') failed.push(slot);
    }

    return {
      portrait: library.sourceHash,
      ready,
      building: this.#building,
      failed,
      total: BUILD_ORDER.length,
      alive: library.clips[IDLE_SLOT].status === 'ready',
      spentUsd: progress.spentUsd,
    };
  }

  #emit(): void {
    this.emit('changed', this.view());
  }
}
