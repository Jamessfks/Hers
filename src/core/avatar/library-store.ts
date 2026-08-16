/**
 * Where clip libraries live, and how one survives a restart.
 *
 * ## Layout
 *
 *     <root>/                          e.g. <userData>/avatar-clips
 *       <first 16 of sourceHash>/
 *         library.json                 the manifest
 *         source.jpg                   the photograph every clip was made from
 *         clips/
 *           idle.mp4
 *           nod.mp4
 *           ...
 *
 * ## Why the directory is named after the photograph
 *
 * The library is only valid for the image it was generated from, so the
 * question "is this library stale?" has to have an answer that cannot rot. A
 * `sourceImagePath` in config would go stale the moment the file was edited in
 * place; a `dirty` flag would go stale the moment anything forgot to set it —
 * and the failure is not a crash but a wrong face, half of one person and half
 * of another, which is the single most unsettling thing this feature can do.
 *
 * Hashing the bytes removes the question. A different photograph is a different
 * directory, so there is no invalidation step to forget, and — the part that
 * makes this cheap rather than merely safe — swapping back to a previous photo
 * finds its fully built library still sitting there. Regenerating nineteen
 * clips costs several dollars; a directory of stale video costs a few tens of
 * megabytes, which is why nothing here deletes on its own and {@link
 * ClipLibraryStore.remove} is something the user asks for.
 *
 * ## Why the writes are ordered the way they are
 *
 * Clip bytes are written **before** the manifest that mentions them, and the
 * manifest is written atomically through a temp file and a rename. Both choices
 * are about which failure you get if the process dies mid-write:
 *
 *  - bytes first means a crash leaves an orphan clip, which `reconcile` in
 *    clips.ts promotes back to `ready` on the next load. Nothing is lost.
 *  - manifest first would leave a manifest promising a file that does not
 *    exist — recoverable, but only by regenerating something already paid for.
 *  - a non-atomic manifest write can leave truncated JSON, which loses the
 *    index to the *whole* library at once. Every clip is still on disk, so
 *    `reconcile` would rebuild most of it, but durations and spend history are
 *    gone. A rename is one line and removes the case entirely.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  clipFileName,
  completeClip,
  createLibrary,
  parseLibrary,
  reconcile,
  type ClipLibrary,
  type ClipSlotName,
} from './clips.ts';

const MANIFEST = 'library.json';
const CLIPS_DIR = 'clips';

/**
 * Full sha-256 of the source image.
 *
 * The whole digest is kept in the manifest and only the first 16 hex characters
 * name the directory: 64 bits is far past collision territory for the handful
 * of photographs one person will ever use, and a 64-character directory name is
 * unreadable in a Finder window the user may well end up looking at.
 */
export function hashSourceImage(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function libraryDirName(sourceHash: string): string {
  return sourceHash.slice(0, 16);
}

/** Extension for the stored copy of the photo. The bytes are never re-encoded. */
function sourceExtension(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  return 'bin';
}

export interface OpenLibraryOptions {
  providerId: string;
  mimeType?: string;
  now?: number;
}

export class ClipLibraryStore {
  readonly #root: string;

  constructor(options: { root: string }) {
    this.#root = options.root;
  }

  get root(): string {
    return this.#root;
  }

  dirFor(sourceHash: string): string {
    return join(this.#root, libraryDirName(sourceHash));
  }

  clipsDir(sourceHash: string): string {
    return join(this.dirFor(sourceHash), CLIPS_DIR);
  }

  sourcePath(library: ClipLibrary): string {
    return join(this.dirFor(library.sourceHash), library.sourceFile);
  }

  /** Absolute path of a slot's clip, or null when it has not been generated. */
  clipPath(library: ClipLibrary, slot: ClipSlotName): string | null {
    const file = library.clips[slot].file;
    return file ? join(this.clipsDir(library.sourceHash), file) : null;
  }

  /**
   * The one entry point. Hands back the library for this photograph, whatever
   * state the world is in.
   *
   * Three cases collapse into one call, which is the point: a first run creates
   * it, a restart mid-build resumes it, and a new photograph gets a new
   * directory and therefore a new library without anything having to notice
   * that the old one is now stale.
   */
  async open(
    image: { bytes: Uint8Array; mimeType?: string },
    options: OpenLibraryOptions,
  ): Promise<ClipLibrary> {
    const sourceHash = hashSourceImage(image.bytes);
    const dir = this.dirFor(sourceHash);
    await mkdir(join(dir, CLIPS_DIR), { recursive: true });

    const existing = await this.load(sourceHash);
    const mimeType = image.mimeType ?? options.mimeType ?? 'image/jpeg';
    const library =
      existing ??
      createLibrary({
        sourceHash,
        sourceFile: `source.${sourceExtension(mimeType)}`,
        providerId: options.providerId,
        ...(options.now !== undefined && { now: options.now }),
      });

    // Rewritten every time rather than only on create: the clips are worthless
    // without the still they fall back to, and it is the anchor frame for every
    // regeneration. The bytes hash to this directory's name, so this is always
    // idempotent.
    await writeFile(join(dir, library.sourceFile), image.bytes);

    if (!existing) await this.save(library);
    return library;
  }

  /** Reads a manifest and repairs it against what is actually on disk. */
  async load(sourceHash: string, now = Date.now()): Promise<ClipLibrary | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.dirFor(sourceHash), MANIFEST), 'utf8');
    } catch {
      return null;
    }

    let parsed: ClipLibrary | null = null;
    try {
      parsed = parseLibrary(JSON.parse(raw));
    } catch {
      // Unparseable JSON. Fall through to the rebuild below rather than
      // returning null: the clips are the expensive part and they are still
      // sitting in clips/, so a lost manifest must not read as a lost library.
      parsed = null;
    }

    const library =
      parsed ??
      createLibrary({
        sourceHash,
        sourceFile: await this.#findSourceFile(sourceHash),
        providerId: 'unknown',
        now,
      });

    return reconcile(library, await this.#clipFiles(sourceHash), now);
  }

  /**
   * Saves that are already running, per library. See {@link save}.
   *
   * Keyed by source hash rather than one chain for the store, because two
   * libraries are two files and serialising them against each other would be a
   * queue with no reason to exist.
   */
  readonly #saving = new Map<string, Promise<void>>();

  /**
   * Atomic manifest write. See the header for why this is not a plain write.
   *
   * Serialised per library, and the temporary file is uniquely named, because
   * "atomic" was only true against *other processes*. Within one process the
   * temporary path was `${target}.${pid}.tmp` — the same path for every save —
   * and callers reach this without awaiting: `notePlayed` is fired from an IPC
   * listener with `void`, and a gesture ending produces two of them in quick
   * succession (the gesture, then the return to idle). Two overlapping saves
   * therefore interleaved their writes into one file and then both renamed it,
   * which can put a truncated manifest over a real one. The manifest is the
   * index to several dollars of video, so "unlikely" is not the standard.
   *
   * What this orders is the *writes*, not their contents, and the difference is
   * a convention nothing here can enforce. Which library each write carries is
   * decided by its caller, and every caller in portrait.ts assigns
   * `this.#library` and awaits `save(this.#library)` on the next line. Two of
   * them interleaving between those two statements would queue the writes in
   * the right order carrying the wrong library, and the last one to land wins.
   * Keeping the assignment and the save adjacent is what makes that impossible;
   * it is written down because it looks like style and is not.
   */
  async save(library: ClipLibrary): Promise<void> {
    const key = library.sourceHash;
    // A previous save's *failure* must not cancel this one: every save writes
    // the whole manifest, so a later one supersedes an earlier one whatever
    // happened to it. The chain is one entry per library and is left in place;
    // a settled promise costs nothing to hold.
    const queued = (this.#saving.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.#writeManifest(library));
    this.#saving.set(key, queued.catch(() => {}));
    await queued;
  }

  async #writeManifest(library: ClipLibrary): Promise<void> {
    const dir = this.dirFor(library.sourceHash);
    await mkdir(join(dir, CLIPS_DIR), { recursive: true });
    const target = join(dir, MANIFEST);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(library, null, 2), 'utf8');
      await rename(temporary, target);
    } catch (error) {
      // A temporary left behind would be picked up by nothing — `#clipFiles`
      // reads the clips directory and the manifest is read by name — but it
      // would accumulate, and a directory of them is a puzzle for whoever
      // looks next.
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Store a finished clip and mark the slot ready.
   *
   * Does not save the manifest — the caller does, right after. Keeping the two
   * separate is what lets a build batch several clips into one manifest write
   * while still getting the bytes-before-manifest ordering the header argues
   * for on every single clip.
   */
  async writeClip(
    library: ClipLibrary,
    slot: ClipSlotName,
    bytes: Uint8Array,
    options: { extension?: string; durationMs: number; costUsd?: number; now?: number } = {
      durationMs: 0,
    },
  ): Promise<ClipLibrary> {
    const file = clipFileName(slot, options.extension ?? 'mp4');
    const dir = this.clipsDir(library.sourceHash);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), bytes);
    return completeClip(
      library,
      slot,
      {
        file,
        durationMs: options.durationMs,
        ...(options.costUsd !== undefined && { costUsd: options.costUsd }),
      },
      options.now ?? Date.now(),
    );
  }

  /** Every library on disk, newest first. For a "previous characters" list. */
  async listLibraries(): Promise<ClipLibrary[]> {
    let names: string[];
    try {
      names = await readdir(this.#root);
    } catch {
      return [];
    }

    const found: ClipLibrary[] = [];
    for (const name of names) {
      try {
        const raw = await readFile(join(this.#root, name, MANIFEST), 'utf8');
        const parsed = parseLibrary(JSON.parse(raw));
        if (parsed) found.push(parsed);
      } catch {
        // Not a library directory, or an unreadable one. Skip it quietly:
        // listing is a convenience and must never be the thing that fails.
      }
    }
    return found.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Deletes a library and its clips. Only ever called because a user asked. */
  async remove(sourceHash: string): Promise<void> {
    await rm(this.dirFor(sourceHash), { recursive: true, force: true });
  }

  async #clipFiles(sourceHash: string): Promise<Set<string>> {
    try {
      return new Set(await readdir(this.clipsDir(sourceHash)));
    } catch {
      return new Set();
    }
  }

  /** Recover the still's file name when the manifest that named it is gone. */
  async #findSourceFile(sourceHash: string): Promise<string> {
    try {
      const names = await readdir(this.dirFor(sourceHash));
      return names.find((name) => name.startsWith('source.')) ?? 'source.jpg';
    } catch {
      return 'source.jpg';
    }
  }
}
