/**
 * Everything about her that outlives a conversation.
 *
 * Her memory, her mood, her profile and her gallery are one set of things, not
 * one set per transport. Somebody who tells her about their week on the phone
 * and then opens the browser should not meet a second her who has never heard
 * of it, and a mood knocked flat over Telegram should still be flat at the
 * desk. So this is a singleton the {@link Companion} instances borrow, and each
 * `Companion` owns only what is genuinely per-conversation: a live socket, a
 * clock, and whoever it is talking to.
 */

import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AvatarStudio } from '../avatar/studio.ts';
import { Gallery } from '../gallery/gallery.ts';
import { Intimacy } from '../intimacy/intimacy.ts';
import { createGeminiDistiller, generatePortrait } from '../gemini/text.ts';
import { createGoogleEmbedder, createLexicalEmbedder } from '../memory/embedder.ts';
import { Memory } from '../memory/memory.ts';
import { MemoryStore } from '../memory/store.ts';
import { Mood } from '../mood/mood.ts';
import { ensureProfile, loadProfile, loadVolatility, writeChosenName } from '../profile/profile.ts';
import { PLACEHOLDER_NAME, chooseName } from '../profile/naming.ts';
import type { Profile } from '../profile/types.ts';
import type { Config } from '../../server/config.ts';

interface Parts {
  profile: Profile;
  memory: Memory;
  mood: Mood;
  intimacy: Intimacy;
  gallery: Gallery;
  avatar: AvatarStudio;
}

export class Brain {
  #config: Config;
  readonly #options: { offline?: boolean };
  #parts: Parts;

  private constructor(config: Config, options: { offline?: boolean }, parts: Parts) {
    this.#config = config;
    this.#options = options;
    this.#parts = parts;
  }

  /**
   * `offline` keeps every network-backed part of memory out of the picture.
   *
   * Only tests pass it, and they need it: `assemble` is where the embedder and
   * the consolidation model are chosen, so without a seam here a test with a
   * fake API key makes real requests to Google and waits on them.
   */
  static async open(config: Config, options: { offline?: boolean } = {}): Promise<Brain> {
    return new Brain(config, options, await assemble(config, options));
  }

  /*
   * Everything below is a getter rather than a field.
   *
   * The parts are replaceable — a new API key changes which embedder memory
   * uses, and a reset replaces all of them at once — and a caller that had
   * captured `brain.memory` in a constructor would go on writing to a database
   * that had already been deleted. Reading through the brain every time is the
   * property that makes that impossible rather than merely unlikely.
   */
  get config(): Config {
    return this.#config;
  }

  get memory(): Memory {
    return this.#parts.memory;
  }

  get mood(): Mood {
    return this.#parts.mood;
  }

  /**
   * How close she is, and how long it took.
   *
   * Beside the mood rather than inside it, because they are different kinds of
   * thing: a mood is where she is this hour, and this is what the two of them
   * have built. One decays in twenty minutes; the other takes four years.
   */
  get intimacy(): Intimacy {
    return this.#parts.intimacy;
  }

  get gallery(): Gallery {
    return this.#parts.gallery;
  }

  get avatar(): AvatarStudio {
    return this.#parts.avatar;
  }

  get profile(): Profile {
    return this.#parts.profile;
  }

  /**
   * Rebuilds every part from disk, optionally under a new configuration.
   *
   * This is how a key pasted into the website takes effect without restarting
   * the process. It matters that it is a rebuild and not a field assignment:
   * whether memory embeds through Google or through the local lexical fallback
   * is decided when `Memory` is constructed, so a brain that merely learned a
   * new key would keep using the offline embedder forever.
   *
   * Deliberately does not consolidate on the way out. Consolidation costs a
   * model call, and the one moment you reload is the moment the key may be
   * absent or wrong — which is to say, the moment that call would fail.
   */
  async reload(config: Config = this.#config): Promise<void> {
    await this.#parts.mood.flush().catch(() => undefined);
    await this.#parts.intimacy.flush().catch(() => undefined);
    this.#parts.memory.dispose();
    this.#config = config;
    this.#parts = await assemble(config, this.#options);
  }

  /**
   * Forgets everything and starts again as a stranger.
   *
   * Deletes both directories outright rather than emptying them file by file:
   * memory, its write-ahead log, the mood on disk, the profile, the gallery and
   * the photograph are all under one of the two, and a list of things to delete
   * is a list that grows a hole every time something new is written. `assemble`
   * puts the defaults back.
   *
   * What survives is `.env` — the keys are the user's, not hers.
   */
  async wipe(): Promise<void> {
    const dirs = [this.#config.dataDir, this.#config.profileDir];
    // Both are checked before either is touched. Checking inside the loop would
    // mean a refusal on the second one left her with no memory and a profile —
    // half a person, and the half nobody asked for.
    for (const dir of dirs) {
      if (safeToDelete(dir)) continue;
      throw new Error(
        `Refusing to delete ${dir}. Point HERS_DATA and HERS_PROFILE at folders of their own.`,
      );
    }

    this.#parts.memory.dispose();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    this.#parts = await assemble(this.#config, this.#options);
  }

  /**
   * Picks up edits to the profile folder.
   *
   * Returns the new profile so callers can decide what to do about it. Nothing
   * is applied to a conversation already in flight: a Live session's system
   * instruction is fixed at setup, so a change of character takes effect on the
   * next reconnect, and pretending otherwise would be a lie in the UI.
   */
  async reloadProfile(): Promise<Profile> {
    this.#parts.profile = await loadProfile(this.#config.profileDir);
    return this.#parts.profile;
  }

  /**
   * Makes sure she has a name of her own before she says anything.
   *
   * Runs at most once in the life of a profile. The condition is deliberately
   * two things and not one: no `named` marker *and* the name still being the
   * placeholder the project ships with. Either alone would be wrong — a user who
   * typed their own choice into `identity.md` must not have it overwritten, and a
   * marker alone would let a re-roll happen if the file were ever hand-edited.
   *
   * Awaited before the first system instruction is built, because a companion who
   * introduces herself as the placeholder and is called something else a minute later has
   * not chosen a name, she has had two.
   *
   * Failure is silent and repeatable. No key, a refusal, a timeout: the
   * placeholder stays and the next conversation asks again, which is a far
   * smaller problem than committing a bad name for good.
   */
  async ensureNamed(): Promise<string | null> {
    const identity = this.#parts.profile.identity;
    if (identity.named === 'self') return null;
    if (identity.name !== PLACEHOLDER_NAME) return null;
    if (!this.#config.geminiApiKey || this.#options.offline) return null;

    const chosen = await chooseName(this.#config.geminiApiKey, {
      age: identity.age,
      gender: identity.gender,
      ethnicity: identity.ethnicity,
      from: identity.from,
      personality: this.#parts.profile.prose.personality ?? '',
    });
    if (!chosen) return null;

    try {
      await writeChosenName(this.#config.profileDir, chosen.name, chosen.why);
      // Re-read rather than patch in place, so the name reaching the prompt is
      // the one that is actually on disk. If the write half-failed, she keeps
      // the placeholder rather than believing a name nobody recorded.
      this.#parts.profile = await loadProfile(this.#config.profileDir);
    } catch (error) {
      // A read-only profile folder, a full disk. Worth saying out loud, because
      // unlike a refusal this one will happen again every conversation — but not
      // worth losing the conversation over. This runs inside `wake()`.
      console.warn('  could not record her chosen name:', error);
      return null;
    }
    return this.#parts.profile.identity.name === chosen.name ? chosen.name : null;
  }

  /** True when the store already holds a conversation from before today. */
  get hasHistory(): boolean {
    return this.memory.turnCount() > 0 || Boolean(this.memory.runningSummary());
  }

  /**
   * Shuts down without losing the conversation that just happened.
   *
   * Consolidation is fired and not awaited everywhere else, deliberately — it
   * costs a model call and a companion that pauses to think about its filing
   * system has a stutter. But at shutdown there is nothing left to be slow for,
   * and *not* waiting here means quitting right after a conversation throws
   * away every fact it contained. Found by the live audit: a fact stated in one
   * session was missing from the next, because the process had moved on before
   * the distillation finished.
   */
  async close(): Promise<void> {
    await Promise.allSettled([
      this.memory.consolidate(),
      this.mood.flush(),
      this.intimacy.flush(),
    ]);
  }
}

// ---------------------------------------------------------------------------

/** Reads the profile folder and the database, and builds everything from them. */
async function assemble(config: Config, options: { offline?: boolean }): Promise<Parts> {
  await mkdir(config.dataDir, { recursive: true });
  const profile = await ensureProfile(config.profileDir);

  const remote = Boolean(config.geminiApiKey) && !options.offline;
  const store = new MemoryStore({ path: path.join(config.dataDir, 'memory.db') });
  const memory = new Memory({
    store,
    // Without a key there is no network and no live session either, so the
    // lexical embedder is what keeps every offline path — tests, the doctor
    // command, a first run before setup — working rather than half-working.
    embedder: remote ? createGoogleEmbedder(config.geminiApiKey) : createLexicalEmbedder(),
    ...(remote ? { distiller: createGeminiDistiller(config.geminiApiKey) } : {}),
  });

  const mood = new Mood({
    anchor: profile.moodBaseline,
    volatility: await loadVolatility(config.profileDir),
    dir: config.profileDir,
  });
  await mood.restore();

  const intimacy = new Intimacy({ dir: config.profileDir });
  await intimacy.restore();

  /*
   * The painter is the seam. Without a key the studio still holds her
   * photograph — it simply cannot make a new face, which `makeFace` says in as
   * many words rather than failing obscurely.
   */
  const avatar = new AvatarStudio({
    dir: path.join(config.profileDir, 'avatar'),
    ...(remote
      ? {
          paint: (prompt, reference) =>
            generatePortrait({ apiKey: config.geminiApiKey, prompt, reference }),
        }
      : {}),
  });
  await avatar.load();

  return {
    profile,
    memory,
    mood,
    intimacy,
    // The gallery is told where her face is rather than each caller remembering
    // to pass it. "A generated picture is of the woman in the photograph" is a
    // property of the gallery, and a property that depends on every call site
    // getting an argument right is not a property.
    gallery: new Gallery(path.join(config.profileDir, 'gallery'), { face: () => avatar.face() }),
    avatar,
  };
}

/**
 * Whether a directory is one this program is allowed to delete outright.
 *
 * The reset button hands a path from configuration to `rm -r`, and the whole
 * question is what happens when that path is wrong. `HERS_PROFILE=~` is a
 * plausible typo and an unrecoverable one, so the rule is deliberately blunt:
 * it must be a real, absolute, nested path, and it must not contain the place
 * this program is running from or the account it is running as.
 */
export function safeToDelete(dir: string, cwd = process.cwd(), home = os.homedir()): boolean {
  if (!dir || !path.isAbsolute(dir)) return false;

  const target = path.resolve(dir);
  const { root } = path.parse(target);
  if (target === root) return false;
  // One level under the root is `/data` or `C:\hers` — a directory somebody
  // could plausibly mean, but not one worth being wrong about.
  if (path.dirname(target) === root) return false;
  if (target === path.resolve(home)) return false;

  // Deleting the directory you are running inside takes the program with it.
  const inside = (parent: string, child: string) =>
    child === parent || child.startsWith(parent + path.sep);
  if (inside(target, path.resolve(cwd))) return false;

  return true;
}
