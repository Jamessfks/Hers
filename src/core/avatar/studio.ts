/**
 * Her face: one photograph, and what is known about it.
 *
 * The photograph is the fixed point. Everything that needs to produce *her* —
 * the `show` tool, `/photo` on Telegram, the gallery — starts from this file
 * rather than from a written description, so there is one answer to what she
 * looks like instead of one per caller.
 *
 * Small on purpose. The manifest records the dimensions, when it arrived, and
 * the content hash the URL is busted with — the dimensions because the interface
 * draws whatever shape was uploaded rather than a pinned one, and cropping her
 * to fit a layout would be changing her face.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { sniffImage } from './image-info.ts';
import type { ImageInfo } from './image-info.ts';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * What may be uploaded.
 *
 * The byte ceiling is the cheap check and the dimension range is the real one:
 * a 40-megapixel photograph is not a better avatar, it is a slower upload and a
 * larger bill on every generated picture, and anything under 256px has nothing
 * for the model to work with.
 */
export const IMAGE_LIMITS = {
  maxBytes: 12 * 1024 * 1024,
  minDimension: 256,
  maxDimension: 4096,
  formats: ['image/jpeg', 'image/png', 'image/webp'] as const,
} as const;

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
  /** Content hash, so replacing the photograph busts every cached copy of it. */
  id: string;
  addedAt: number;
}

interface Manifest {
  source: AvatarSource | null;
}

/** What the UI is told. */
export interface AvatarState {
  hasSource: boolean;
  sourceUrl: string | null;
  width: number;
  height: number;
}

const EMPTY: Manifest = { source: null };

// ---------------------------------------------------------------------------

export interface StudioOptions {
  /** `hers-profile/avatar`. */
  dir: string;
  now?: () => number;
}

export class AvatarStudio {
  readonly #dir: string;
  readonly #now: () => number;
  #manifest: Manifest = { ...EMPTY };

  constructor(options: StudioOptions) {
    this.#dir = options.dir;
    this.#now = options.now ?? (() => Date.now());
  }

  get dir(): string {
    return this.#dir;
  }

  async load(): Promise<AvatarState> {
    await mkdir(this.#dir, { recursive: true });
    const file = path.join(this.#dir, 'manifest.json');

    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null) {
          const saved = parsed as Partial<Manifest>;
          this.#manifest = { source: saved.source ?? null };
        }
      } catch {
        // A hand-edited or truncated manifest costs the record of the
        // photograph, not the startup. Uploading it again is the fix.
        this.#manifest = { ...EMPTY };
      }
    }

    await this.#save();
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

    const id = createHash('sha256').update(bytes).digest('hex');
    const file = `source${extensionFor(info.mimeType)}`;

    // Written to a temporary name and moved into place, so a failed write
    // cannot leave a half-image that the manifest claims is the source.
    const target = path.join(this.#dir, file);
    const temporary = `${target}.incoming`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);

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
    await this.#save();
    await this.#dropOtherSources(file);
    return this.state();
  }

  /**
   * Removes any earlier photograph left beside the current one.
   *
   * A `.jpg` upload followed by a `.png` one writes a second file rather than
   * replacing the first, and the loser has no owner — it is not the source and
   * never will be, but it is still a picture of somebody sitting in the
   * profile folder.
   */
  async #dropOtherSources(keep: string): Promise<void> {
    try {
      const entries = await readdir(this.#dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/^source\.(jpe?g|png|webp)$/i.test(entry.name)) continue;
        if (entry.name === keep) continue;
        await rm(path.join(this.#dir, entry.name), { force: true });
      }
    } catch {
      // Nothing to tidy.
    }
  }

  /**
   * The photograph itself, for anything that needs to generate *her*.
   *
   * Null when none has been uploaded, in which case a generated picture falls
   * back to the written description — a consistent stranger rather than an
   * inconsistent her.
   */
  async sourceImage(): Promise<{ data: Buffer; mimeType: string } | null> {
    const file = this.sourcePath();
    if (!file) return null;
    try {
      return { data: await readFile(file), mimeType: this.sourceMimeType() };
    } catch {
      return null;
    }
  }

  sourcePath(): string | null {
    const source = this.#manifest.source;
    return source ? path.join(this.#dir, source.file) : null;
  }

  /**
   * The photograph as a file, for anything that needs to *send* her rather than
   * generate her.
   *
   * Deliberately metadata only and synchronous: this is consulted on every
   * request for a picture, and reading a multi-megabyte photograph off disk to
   * decide whether it is the right answer is a cost paid for nothing. Callers
   * that need the bytes read `absolutePath`, or use {@link sourceImage}.
   */
  face(): { name: string; absolutePath: string; mimeType: string; addedAt: number } | null {
    const source = this.#manifest.source;
    if (!source) return null;
    return {
      name: source.file,
      absolutePath: path.join(this.#dir, source.file),
      mimeType: source.mimeType,
      addedAt: source.addedAt,
    };
  }

  sourceMimeType(): string {
    return this.#manifest.source?.mimeType ?? 'image/jpeg';
  }

  async #save(): Promise<void> {
    const file = path.join(this.#dir, 'manifest.json');
    await writeFile(`${file}.incoming`, JSON.stringify(this.#manifest, null, 2), 'utf8');
    await rename(`${file}.incoming`, file);
  }
}

// ---------------------------------------------------------------------------

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
