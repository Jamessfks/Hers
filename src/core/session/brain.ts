/**
 * Everything about Anna that outlives a conversation.
 *
 * Her memory, her mood, her profile and her gallery are one set of things, not
 * one set per transport. Somebody who tells her about their week on the phone
 * and then opens the browser should not meet a second Anna who has never heard
 * of it, and a mood knocked flat over Telegram should still be flat at the
 * desk. So this is a singleton the {@link Companion} instances borrow, and each
 * `Companion` owns only what is genuinely per-conversation: a live socket, a
 * clock, and whoever it is talking to.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { AvatarStudio } from '../avatar/studio.ts';
import { HedraClient } from '../avatar/hedra.ts';
import { Gallery } from '../gallery/gallery.ts';
import { createGeminiDistiller } from '../gemini/text.ts';
import { createGoogleEmbedder, createLexicalEmbedder } from '../memory/embedder.ts';
import { Memory } from '../memory/memory.ts';
import { MemoryStore } from '../memory/store.ts';
import { Mood } from '../mood/mood.ts';
import { ensureProfile, loadProfile, loadVolatility } from '../profile/profile.ts';
import type { Profile } from '../profile/types.ts';
import type { Config } from '../../server/config.ts';

export class Brain {
  readonly config: Config;
  readonly memory: Memory;
  readonly mood: Mood;
  readonly gallery: Gallery;
  readonly avatar: AvatarStudio;
  #profile: Profile;

  private constructor(parts: {
    config: Config;
    profile: Profile;
    memory: Memory;
    mood: Mood;
    gallery: Gallery;
    avatar: AvatarStudio;
  }) {
    this.config = parts.config;
    this.#profile = parts.profile;
    this.memory = parts.memory;
    this.mood = parts.mood;
    this.gallery = parts.gallery;
    this.avatar = parts.avatar;
  }

  /**
   * `offline` keeps every network-backed part of memory out of the picture.
   *
   * Only tests pass it, and they need it: `Brain.open` is where the embedder
   * and the consolidation model are chosen, so without a seam here a test with
   * a fake API key makes real requests to Google and waits on them.
   */
  static async open(config: Config, options: { offline?: boolean } = {}): Promise<Brain> {
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

    const avatar = new AvatarStudio({
      dir: path.join(config.profileDir, 'avatar'),
      client:
        config.hedra && !options.offline ? new HedraClient({ apiKey: config.hedra.apiKey }) : null,
      budgetUsd: config.hedra?.budgetUsd ?? 0,
    });
    await avatar.load();

    return new Brain({
      config,
      profile,
      memory,
      mood,
      gallery: new Gallery(path.join(config.profileDir, 'gallery')),
      avatar,
    });
  }

  get profile(): Profile {
    return this.#profile;
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
    this.#profile = await loadProfile(this.config.profileDir);
    return this.#profile;
  }

  /** True when the store already holds a conversation from before today. */
  get hasHistory(): boolean {
    return this.memory.turnCount() > 0 || Boolean(this.memory.runningSummary());
  }

  async close(): Promise<void> {
    await this.mood.flush();
  }
}
