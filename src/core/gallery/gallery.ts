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
   * Generate from this picture instead of from her avatar photograph.
   *
   * Almost nothing should pass this. The default is the photograph the user
   * uploaded, which is the only image that is reliably *her*; an override
   * exists so a caller with a better reference in hand can say so, and so tests
   * can generate without a face on disk.
   */
  reference?: { data: Buffer; mimeType: string };
}

/**
 * Where her actual face lives, if it has been uploaded.
 *
 * Injected rather than imported so the gallery does not depend on the avatar
 * studio, and synchronous because it is consulted on every request for a
 * picture and returns metadata the studio already holds in memory.
 */
export type FaceProvider = () => {
  name: string;
  absolutePath: string;
  mimeType: string;
  addedAt: number;
} | null;

export interface GalleryOptions {
  face?: FaceProvider;
  /**
   * Injected by tests, so asserting what the model is asked for costs nothing.
   *
   * Which reference reaches the image model is the whole of this file's
   * correctness and cannot be checked from the outside — a wrong one produces a
   * plausible picture of the wrong woman.
   */
  generator?: typeof generatePortrait;
}

export class Gallery {
  readonly #dir: string;
  readonly #embedder = createLexicalEmbedder(256);
  readonly #face: FaceProvider | null;
  readonly #generator: typeof generatePortrait;
  #cache: { at: number; items: GalleryItem[] } | null = null;
  #generating: Promise<GalleryItem | null> | null = null;

  constructor(dir: string, options: GalleryOptions = {}) {
    this.#dir = dir;
    this.#face = options.face ?? null;
    this.#generator = options.generator ?? generatePortrait;
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
    // Her photograph is not in this folder but is servable by name, because
    // `pick` can return it and the web fetches whatever `pick` returned from
    // `/gallery/<name>`. Checked first, so a file in the gallery that happens to
    // share its name cannot shadow her actual face.
    const face = this.face();
    if (face && face.name === wanted) return face;

    const items = await this.list();
    return items.find((item) => item.name === wanted) ?? null;
  }

  /**
   * Her avatar photograph as something sendable, or null if there is none.
   *
   * Not part of {@link list}: the folder is a folder, and putting a file in the
   * listing that is not in the directory would make every other thing here —
   * caching, captions, eviction — lie about itself.
   */
  face(): GalleryItem | null {
    const face = this.#face?.();
    if (!face) return null;
    return {
      name: face.name,
      absolutePath: face.absolutePath,
      kind: 'image',
      caption: 'me',
      modifiedAt: face.addedAt,
    };
  }

  /**
   * The best thing she has for `description`, or a new one if allowed.
   *
   * Never throws. The worst outcome of a picture failing to arrive is that no
   * picture arrives, and that must not interrupt a sentence.
   *
   * ## "Can I see your picture?" is answered with her picture
   *
   * A request that names only *her* — "a picture of you", "what do you look
   * like", "your face" — is answered with the photograph the user uploaded,
   * before the folder is searched and before anything is generated. It is the
   * same image the web shows as her face and the same one every clip is
   * rendered from, so all three agree.
   *
   * The alternative, generating a new one, was what this used to do, and it is
   * wrong for this case specifically: every generation is a re-draw, and a
   * re-draw of a person is a similar person. That is an acceptable price for
   * "you at the window watching the rain", which cannot be answered any other
   * way, and no price at all worth paying for "show me you", which can.
   *
   * So: named a scene, generate from her face. Named only her, send her face.
   */
  async pick(description: string, options: PickOptions = {}): Promise<GalleryItem | null> {
    if (wantsHerFace(description)) {
      const face = this.face();
      if (face) return face;
    }

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
        const generated = await this.#generator({
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

  /**
   * The picture a new one is generated from: her photograph, always.
   *
   * This used to be "the newest image in the gallery", and that is a feedback
   * loop rather than a policy. Generated pictures are written into this same
   * folder, so each generation referenced the previous generation: the second
   * picture was of the first, the third was of the second, and after a handful
   * of steps nothing in the folder was of the woman in the photograph any more.
   * A fixed reference cannot drift, because there is nothing for it to drift
   * from.
   *
   * The newest gallery image is kept only as the fallback for a profile that
   * has no photograph at all, where some consistency beats none.
   */
  async #reference(): Promise<{ data: Buffer; mimeType: string } | null> {
    const face = this.#face?.();
    if (face) {
      try {
        return { data: await readFile(face.absolutePath), mimeType: face.mimeType };
      } catch {
        // A photograph the manifest claims and the disk does not have falls
        // through to the gallery rather than losing the picture entirely.
      }
    }

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

/**
 * Words that ask for her and nothing else.
 *
 * The test is subtractive on purpose, and that is what makes it safe: strike
 * out every word that only means "a picture of you", and if anything at all is
 * left then a scene was described and the answer is not a plain photograph.
 * "you" and "you laughing in the kitchen" are then decided by the presence of
 * "laughing" and "kitchen" rather than by a list of phrasings somebody has to
 * keep guessing at.
 */
const ONLY_HER = new Set([
  'a', 'an', 'the', 'of', 'in', 'it', 'is', 'this', 'that',
  'i', 'me', 'my', 'we', 'us', 'can', 'could', 'please', 'do', 'does',
  'you', 'your', 'yours', 'yourself', 'her', 'herself', 'she', 'anna',
  'picture', 'pictures', 'pic', 'photo', 'photos', 'photograph', 'image',
  'selfie', 'portrait', 'face', 'look', 'looks', 'like', 'see', 'show',
  'send', 'sent', 'give', 'want', 'real', 'actual', 'actually', 'really',
  'now', 'right', 'today', 'current', 'currently', 'again', 'what',
  'who', 'how', 'and', 'to', 'for', 'at', 'be', 'am', 'are', 'here',
]);

/**
 * True when the description names her and no scene.
 *
 * Deliberately not a model call. This runs inside a sentence, it decides
 * between two files rather than between two meanings, and a classifier that is
 * right 97% of the time would be wrong about "show me you" often enough to be
 * the bug this replaced.
 */
export function wantsHerFace(description: string): boolean {
  const words = description.toLowerCase().match(/[a-z']+/g);
  if (!words || words.length === 0) return false;
  return words.every((word) => ONLY_HER.has(word));
}

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
