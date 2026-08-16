/**
 * The pictures and clips Anna can send.
 *
 * Backed by a plain folder, because that is the interface a person already
 * knows: drop files in, name them like captions, done. No database, no import
 * step, no manifest to corrupt. The folder is scanned on demand and cached for
 * a few seconds, so a file dropped in while she is talking is available in the
 * same conversation.
 *
 * Matching a description to a file is done with the same hashed bag-of-words
 * embedder memory uses for its offline fallback. That is a deliberate choice
 * over an embedding API call: picking a photo has to be fast enough to happen
 * inside a sentence, the corpus is a few dozen short filenames, and the overlap
 * that matters is almost always literal — "rain" matching `at-the-window-rainy`.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createLexicalEmbedder, lexicalTokens, similarity } from '../memory/embedder.ts';
import { generatePortrait } from '../gemini/text.ts';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const CLIP_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);

/** Below this the best match is not a match, and inventing one is worse than none. */
const MATCH_FLOOR = 0.18;
/** How long a directory listing is trusted. */
const CACHE_MS = 5000;

export interface GalleryItem {
  /** File name only. Never a path — this is what reaches URLs and Telegram. */
  name: string;
  absolutePath: string;
  kind: 'image' | 'clip';
  /** From `captions.json` if present, otherwise derived from the file name. */
  caption: string;
  /** Epoch millis, for "the newest one" and for eviction. */
  modifiedAt: number;
}

export interface PickOptions {
  /** Make a new picture when nothing on disk is close enough. */
  allowNew?: boolean;
  /** Her appearance, verbatim from the profile. Only used when generating. */
  appearance?: string;
  apiKey?: string;
  /**
   * The picture the new one should look like.
   *
   * Overrides "the newest thing in the gallery", which is the right default
   * for a follow-up but the wrong one for a greeting: the avatar photograph is
   * the face the user actually chose, and every generated picture should be of
   * *her* rather than of whatever was made last.
   */
  reference?: { data: Buffer; mimeType: string };
}

export class Gallery {
  readonly #dir: string;
  readonly #embedder = createLexicalEmbedder(256);
  #cache: { at: number; items: GalleryItem[] } | null = null;
  #generating: Promise<GalleryItem | null> | null = null;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get dir(): string {
    return this.#dir;
  }

  async list(): Promise<GalleryItem[]> {
    const now = Date.now();
    if (this.#cache && now - this.#cache.at < CACHE_MS) return this.#cache.items;

    const captions = await this.#captions();
    const items: GalleryItem[] = [];

    try {
      const entries = await readdir(this.#dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        const kind = IMAGE_EXTENSIONS.has(extension)
          ? ('image' as const)
          : CLIP_EXTENSIONS.has(extension)
            ? ('clip' as const)
            : null;
        if (!kind) continue;

        const absolutePath = path.join(this.#dir, entry.name);
        let modifiedAt = 0;
        try {
          const { mtimeMs } = await (await import('node:fs/promises')).stat(absolutePath);
          modifiedAt = mtimeMs;
        } catch {
          // A file that vanished between readdir and stat is simply not there.
          continue;
        }

        items.push({
          name: entry.name,
          absolutePath,
          kind,
          caption: captions[entry.name] ?? captionFromName(entry.name),
          modifiedAt,
        });
      }
    } catch {
      // No gallery folder is an empty gallery, not an error.
    }

    items.sort((a, b) => b.modifiedAt - a.modifiedAt);
    this.#cache = { at: now, items };
    return items;
  }

  /**
   * Resolves a name that came from outside the process to a real file.
   *
   * Everything user- or model-supplied goes through here before it becomes a
   * read. `path.basename` strips any traversal, and the result is checked to be
   * a file the listing already knows about, so a `show` call naming
   * `../../.env` finds nothing rather than finding something.
   */
  async resolve(name: string): Promise<GalleryItem | null> {
    const wanted = path.basename(name);
    const items = await this.list();
    return items.find((item) => item.name === wanted) ?? null;
  }

  /**
   * The best thing she has for `description`, or a new one if allowed.
   *
   * Never throws. The worst outcome of a picture failing to arrive is that no
   * picture arrives, and that must not interrupt a sentence.
   */
  async pick(description: string, options: PickOptions = {}): Promise<GalleryItem | null> {
    const items = await this.list();
    const best = await this.#bestMatch(description, items);
    if (best) return best;

    if (!options.allowNew || !options.apiKey) return null;
    return this.generate(description, options);
  }

  /**
   * Makes a new picture, whether or not one already fits.
   *
   * Separate from {@link pick} because a greeting is not a search: the point is
   * that it is new, so falling back to something on disk would defeat it.
   */
  async generate(description: string, options: PickOptions): Promise<GalleryItem | null> {
    if (!options.apiKey) return null;
    return this.#generate(
      description,
      options.apiKey,
      options.appearance ?? '',
      options.reference,
    );
  }

  async #bestMatch(description: string, items: GalleryItem[]): Promise<GalleryItem | null> {
    if (items.length === 0) return null;
    const descriptions = items.map(
      (item) => `${item.caption} ${item.name.replace(/[-_.]/g, ' ')}`,
    );
    const [query, ...vectors] = await this.#embedder.embed([description, ...descriptions]);
    if (!query) return null;

    let winner: GalleryItem | null = null;
    let bestScore = MATCH_FLOOR;
    for (const [index, vector] of vectors.entries()) {
      const item = items[index];
      const candidate = descriptions[index];
      if (!vector || !item || candidate === undefined) continue;
      const score = Math.max(similarity(query, vector), stemOverlap(description, candidate));
      if (score > bestScore) {
        bestScore = score;
        winner = item;
      }
    }
    return winner;
  }

  /**
   * Generation is serialised and never awaited by a conversation.
   *
   * One at a time because these cost money and a model that decides to
   * illustrate three sentences in a row should produce one picture, not three
   * simultaneous bills.
   */
  async #generate(
    description: string,
    apiKey: string,
    appearance: string,
    override?: { data: Buffer; mimeType: string },
  ): Promise<GalleryItem | null> {
    if (this.#generating) return this.#generating;

    this.#generating = (async () => {
      try {
        const reference = override ?? (await this.#reference());
        const generated = await generatePortrait({
          apiKey,
          description,
          appearance,
          ...(reference ? { reference } : {}),
        });
        if (!generated) return null;

        const name = `${slug(description)}-${Date.now()}${extensionFor(generated.mimeType)}`;
        await writeFile(path.join(this.#dir, name), generated.data);
        this.#cache = null;
        return this.resolve(name);
      } catch {
        return null;
      } finally {
        this.#generating = null;
      }
    })();

    return this.#generating;
  }

  /** The most recent picture of her, used to keep her face the same face. */
  async #reference(): Promise<{ data: Buffer; mimeType: string } | null> {
    const items = await this.list();
    const newest = items.find((item) => item.kind === 'image');
    if (!newest) return null;
    try {
      return {
        data: await readFile(newest.absolutePath),
        mimeType: mimeFor(path.extname(newest.name)),
      };
    } catch {
      return null;
    }
  }

  async #captions(): Promise<Record<string, string>> {
    const file = path.join(this.#dir, 'captions.json');
    if (!existsSync(file)) return {};
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[path.basename(key)] = value;
      }
      return out;
    } catch {
      return {};
    }
  }
}

// ---------------------------------------------------------------------------

/** Below this many characters a shared prefix is a coincidence, not a match. */
const PREFIX_FLOOR = 4;

/**
 * The fraction of the description's words that the file name nearly has.
 *
 * The embedder alone is not enough here, and the case that showed it is
 * ordinary: "watching the rain" against `at-the-window-rainy.jpg`. The stemmer
 * turns neither "rain" nor "rainy" into the other, so the hashed features do
 * not collide at all and a picture that obviously fits scores zero.
 *
 * A prefix match closes that without pretending to be semantic. It is
 * deliberately only combined by `Math.max` rather than blended — this is a
 * second opinion for the case the vectors miss, not a weighting of them.
 */
function stemOverlap(description: string, candidate: string): number {
  const wanted = lexicalTokens(description);
  if (wanted.length === 0) return 0;
  const have = lexicalTokens(candidate);

  let hits = 0;
  for (const token of wanted) {
    const matched = have.some(
      (other) =>
        other === token ||
        (Math.min(other.length, token.length) >= PREFIX_FLOOR &&
          (other.startsWith(token) || token.startsWith(other))),
    );
    if (matched) hits += 1;
  }
  return hits / wanted.length;
}

/** `at-the-window-rainy.jpg` -> `at the window rainy`. */
function captionFromName(name: string): string {
  return path
    .basename(name, path.extname(name))
    .replace(/[-_]+/g, ' ')
    .replace(/\b\d{6,}\b/g, '')
    .trim();
}

function slug(description: string): string {
  return (
    description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'anna'
  );
}

export function mimeFor(extension: string): string {
  switch (extension.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    default:
      return 'image/jpeg';
  }
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('webp')) return '.webp';
  return '.jpg';
}
