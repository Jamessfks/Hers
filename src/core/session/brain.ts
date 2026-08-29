/**
 * Everything about her that outlives a conversation.
 *
 * Her memory, her mood and her profile are one set of things, not
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

import { Intimacy } from '../intimacy/intimacy.ts';
import { createGeminiDistiller } from '../gemini/text.ts';
import { createGoogleEmbedder, createLexicalEmbedder } from '../memory/embedder.ts';
import { Memory } from '../memory/memory.ts';
import { MemoryStore } from '../memory/store.ts';
import { Mood } from '../mood/mood.ts';
import {
  ensureProfile,
  loadProfile,
  loadRhythm,
  loadVolatility,
  writeChosenName,
} from '../profile/profile.ts';
import type { Rhythm } from '../sleep/rhythm.ts';
import { PLACEHOLDER_NAME, chooseName, isPlaceholderName } from '../profile/naming.ts';
import type { Profile } from '../profile/types.ts';
import type { Config } from '../../server/config.ts';

export interface BrainOptions {
  /** Keeps every network-backed part of memory out of the picture. Tests only. */
  offline?: boolean;
  /**
   * Asks her what she would like to be called.
   *
   * A seam for the same reason `Companion` takes its connector: the interesting
   * behaviour around this call is the read-write path and the guard against two
   * callers racing it, and none of that is testable if the only way to reach it
   * is a live model.
   */
  chooseName?: typeof chooseName;
}

interface Parts {
  profile: Profile;
  memory: Memory;
  mood: Mood;
  intimacy: Intimacy;
  rhythm: Rhythm;
}

export class Brain {
  #config: Config;
  readonly #options: BrainOptions;
  #parts: Parts;
  /**
   * The naming call, while it is in the air.
   *
   * Every caller reads `#parts.profile`, an in-memory snapshot that nothing
   * updates until the first write has been read back. So two callers that overlap
   * both see the placeholder and both spend a naming call. Observed: she announced
   * "Casey" to the browser and `identity.md` was written four seconds later saying
   * "Mei". The name she said was not the name she has, which is the one thing this
   * feature promises.
   *
   * Two callers can overlap, and it is worth being exact about which, because the
   * obvious pair is the wrong answer. The pair was
   * two wakes: `Companion#waking` guards one instance, and `Conversation.sleep`
   * drops the instance without waiting for a wake still parked in here, so the next
   * wake builds a second `Companion` and enters this a second time. On a fresh
   * profile the parking spot is this very naming call — seven seconds during which
   * the page shows nothing, which is about as long as somebody will look at a
   * button before pressing it again.
   *
   * Guarding the read is not enough, because the gap is the network call between
   * reading and writing. So the second caller waits on the first one's promise and
   * they agree by construction — whichever pair of callers it turns out to be.
   */
  #naming: Promise<string | null> | null = null;

  private constructor(config: Config, options: BrainOptions, parts: Parts) {
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
  static async open(config: Config, options: BrainOptions = {}): Promise<Brain> {
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

  get profile(): Profile {
    return this.#parts.profile;
  }

  /**
   * The hours she keeps.
   *
   * Read out of `rhythm.md`, which she wrote and nothing in the interface can
   * edit. It sits here rather than on `Profile` for that reason: `Profile` is
   * the thing the user used to be able to change, and putting her bedtime in it
   * would invite the next person to add a field for it.
   */
  get rhythm(): Rhythm {
    return this.#parts.rhythm;
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
   * memory, its write-ahead log, the mood on disk and the profile are all under
   * one of the two, and a list of things to delete is a list that grows a hole
   * every time something new is written. `assemble` puts the defaults back.
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
    // Whoever got here first is already asking. Two answers to "what is your
    // name" is worse than a slow one.
    this.#naming ??= this.#chooseAndRecordName();
    try {
      return await this.#naming;
    } finally {
      this.#naming = null;
    }
  }

  async #chooseAndRecordName(): Promise<string | null> {
    const identity = this.#parts.profile.identity;
    if (identity.named === 'self') return null;
    if (!isPlaceholderName(identity.name)) return null;
    if (!this.#config.geminiApiKey || this.#options.offline) return null;

    const ask = this.#options.chooseName ?? chooseName;
    const chosen = await ask(this.#config.geminiApiKey, {
      age: identity.age,
      gender: identity.gender,
      ethnicity: identity.ethnicity,
      from: identity.from,
      personality: this.#parts.profile.prose.personality ?? '',
    });
    if (!chosen) return null;

    let recorded: Profile;
    try {
      await writeChosenName(this.#config.profileDir, chosen.name, chosen.why);
      // Re-read rather than patch in place, so the name reaching the prompt is
      // the one that is actually on disk. If the write half-failed, she keeps
      // the placeholder rather than believing a name nobody recorded.
      recorded = await loadProfile(this.#config.profileDir);
      this.#parts.profile = recorded;
    } catch (error) {
      // A read-only profile folder, a full disk. Worth saying out loud, because
      // unlike a refusal this one will happen again every conversation — but not
      // worth losing the conversation over. This runs inside `wake()`.
      console.warn('  could not record her chosen name:', error);
      return null;
    }
    // The local read, not `#parts.profile`. The field is shared, so read through
    // it this line answers a question about whoever assigned last rather than
    // about this call: two bodies overlapping here, the second one's check saw the
    // first one's name, disagreed with its own, and returned null for a name that
    // was on disk — a name she has and never told anyone about, which is the half
    // of Casey-and-Mei that left only one line in the log. `#naming` is what stops
    // the two bodies; this makes the line true whether or not it holds.
    return recorded.identity.name === chosen.name ? chosen.name : null;
  }

  /**
   * True when the store holds anything at all from before this conversation.
   *
   * Delegated rather than assembled here: the question is entirely about what
   * is in memory, and it has to be asked of the whole store rather than of the
   * session about to start. `turnCount()` is session-scoped and a session has
   * no turns until somebody speaks, so at wake — the only moment this is read —
   * it was always zero. A returning user with no rolling summary yet was
   * therefore told "This is the beginning" in the same prompt that listed eight
   * facts about them. Found by measurement, on a store with twenty facts and no
   * summary. See {@link Memory.hasHistory}.
   */
  get hasHistory(): boolean {
    return this.memory.hasHistory;
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

  return {
    profile,
    memory,
    mood,
    intimacy,
    rhythm: await loadRhythm(config.profileDir),
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
