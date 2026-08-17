/**
 * Everything Hers needs to know before she can start, read from the environment
 * and from `.env`.
 *
 * One rule the rest of the server depends on: **a bad value never throws
 * here.** Anything unparseable falls back to the default and is reported in
 * `warnings`, which the doctor command and the UI both surface. The one thing
 * that is genuinely fatal — no Gemini key — is not thrown either; the server
 * still starts and serves a setup page saying exactly what to do, because a
 * process that exits with a stack trace teaches a first-time user nothing.
 */

import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_LIVE_MODEL } from '../core/gemini/models.ts';
import {
  DEFAULT_MAX_SILENCE_MS,
  DEFAULT_MIN_SILENCE_MS,
} from '../core/initiative/initiative.ts';

export interface Config {
  geminiApiKey: string;
  model: string;
  /** Where the personalization folder lives. */
  profileDir: string;
  /** Where the memory database lives. */
  dataDir: string;
  host: string;
  port: number;
  /** Ceiling on silence before she speaks first, in milliseconds. */
  maxSilenceMs: number;
  minSilenceMs: number;
  /** Frames per second sent to Gemini. The API accepts at most one. */
  cameraFps: number;
  screenFps: number;
  /** Avatar rendering. Null when there is no key; the still image still works. */
  hedra: { apiKey: string; budgetUsd: number } | null;
  telegram: { token: string; allowedChatIds: number[] } | null;
  livekit: { url: string; apiKey: string; apiSecret: string; callPageUrl: string } | null;
  warnings: string[];
}

/** Where the profile folder lives unless told otherwise. */
export const PROFILE_DIR = 'hers-profile';

/** What it was called before the project was renamed to Hers. */
export const FORMER_PROFILE_DIR = 'anna-profile';

/**
 * Moves a pre-v1.0 profile folder to its new name, once.
 *
 * The folder holds her face, her character, her mood and how close she is, so an
 * upgrade that leaves it behind deletes somebody's companion in effect if not on
 * disk.
 *
 * A rename, not a lookup. The first thing I wrote instead was a fallback — read
 * `anna-profile` when `hers-profile` is absent — and it was wrong in a way worth
 * recording: it made the answer depend on the order things had run in, and one
 * stray `hers-profile` created by any command in this directory silently
 * orphaned the real install. `rename` is atomic, runs only when the destination
 * does not exist, and leaves exactly one folder behind, so there is nothing left
 * to be ambiguous about afterwards.
 *
 * Returns what happened, for the caller to print. A failure is not fatal: the
 * old folder is then read where it is, which is worse cosmetically and correct
 * in every other way.
 */
export function migrateProfileDir(env: NodeJS.ProcessEnv = process.env): {
  from?: string;
  to?: string;
  error?: string;
} {
  // Whoever set the variable has already said where it lives.
  if (env.HERS_PROFILE?.trim() || env.ANNA_PROFILE?.trim()) return {};
  if (!existsSync(FORMER_PROFILE_DIR) || existsSync(PROFILE_DIR)) return {};

  try {
    renameSync(FORMER_PROFILE_DIR, PROFILE_DIR);
    return { from: FORMER_PROFILE_DIR, to: PROFILE_DIR };
  } catch (error) {
    return { from: FORMER_PROFILE_DIR, error: String(error) };
  }
}

/**
 * Which folder to read her from when nobody has said.
 *
 * {@link migrateProfileDir} normally makes this a question with one answer, by
 * leaving one folder behind. This covers the case where it could not: a rename
 * that failed on permissions still has to find her.
 */
function defaultProfileDir(): string {
  if (existsSync(PROFILE_DIR)) return PROFILE_DIR;
  if (existsSync(FORMER_PROFILE_DIR)) return FORMER_PROFILE_DIR;
  return PROFILE_DIR;
}

/**
 * One setting, read under its current name or the one this project used to use.
 *
 * Every knob is `HERS_…`. Until v1.0 they were `ANNA_…`, and somebody's working
 * `.env` should not stop working because the project was renamed — so the old
 * name is still read, and the value is reported under whichever name was
 * actually set so a range warning points at the line they can go and edit.
 */
function setting(env: NodeJS.ProcessEnv, suffix: string): { value?: string; name: string } {
  const current = `HERS_${suffix}`;
  const old = `ANNA_${suffix}`;
  if (env[current]?.trim()) return { value: env[current], name: current };
  if (env[old]?.trim()) return { value: env[old], name: old };
  return { value: undefined, name: current };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const warnings: string[] = [];

  const model = setting(env, 'MODEL');
  const profile = setting(env, 'PROFILE');
  const data = setting(env, 'DATA');
  const host = setting(env, 'HOST');
  const port = setting(env, 'PORT');
  const maxSilence = setting(env, 'MAX_SILENCE_MS');
  const minSilence = setting(env, 'MIN_SILENCE_MS');
  const cameraFps = setting(env, 'CAMERA_FPS');
  const screenFps = setting(env, 'SCREEN_FPS');
  const hedraBudget = setting(env, 'HEDRA_BUDGET_USD');
  const callPage = setting(env, 'CALL_PAGE_URL');

  const hedraKey = str(env.HEDRA_API_KEY, '');
  const telegramToken = str(env.TELEGRAM_BOT_TOKEN, '');
  const livekitUrl = str(env.LIVEKIT_URL, '');
  const livekitKey = str(env.LIVEKIT_API_KEY, '');
  const livekitSecret = str(env.LIVEKIT_API_SECRET, '');

  const livekitParts = [livekitUrl, livekitKey, livekitSecret].filter(Boolean).length;
  if (livekitParts > 0 && livekitParts < 3) {
    warnings.push(
      'LiveKit is half configured. All three of LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are needed; phone calls are off.',
    );
  }

  const config: Config = {
    geminiApiKey: str(env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY, ''),
    model: str(model.value, DEFAULT_LIVE_MODEL),
    profileDir: path.resolve(str(profile.value, defaultProfileDir())),
    dataDir: path.resolve(str(data.value, 'data')),
    host: str(host.value, '127.0.0.1'),
    port: int(port.value, 5175, 1, 65535, port.name, warnings),
    maxSilenceMs: int(
      maxSilence.value,
      DEFAULT_MAX_SILENCE_MS,
      5_000,
      6 * 60 * 60 * 1000,
      maxSilence.name,
      warnings,
    ),
    minSilenceMs: int(
      minSilence.value,
      DEFAULT_MIN_SILENCE_MS,
      1_000,
      6 * 60 * 60 * 1000,
      minSilence.name,
      warnings,
    ),
    // The Live API accepts at most one frame per second and bills for every one
    // of them, so the ceiling here is the API's, not a preference.
    cameraFps: rate(cameraFps.value, 1, cameraFps.name, warnings),
    screenFps: rate(screenFps.value, 0.5, screenFps.name, warnings),
    hedra: hedraKey
      ? { apiKey: hedraKey, budgetUsd: money(hedraBudget.value, 1, hedraBudget.name, warnings) }
      : null,
    telegram: telegramToken
      ? { token: telegramToken, allowedChatIds: chatIds(env.TELEGRAM_ALLOWED_CHAT_IDS, warnings) }
      : null,
    livekit:
      livekitUrl && livekitKey && livekitSecret
        ? {
            url: livekitUrl,
            apiKey: livekitKey,
            apiSecret: livekitSecret,
            callPageUrl: str(callPage.value, ''),
          }
        : null,
    warnings,
  };

  if (config.minSilenceMs > config.maxSilenceMs) {
    warnings.push(
      `${minSilence.name} (${config.minSilenceMs}) is above ${maxSilence.name} (${config.maxSilenceMs}); using the ceiling for both.`,
    );
    config.minSilenceMs = config.maxSilenceMs;
  }

  if (hedraKey && !hedraKey.includes(':')) {
    warnings.push(
      'HEDRA_API_KEY looks wrong. Hedra keys are the whole `k_live_…:sk_…` string, both halves and the colon.',
    );
  }

  if (config.telegram && config.telegram.allowedChatIds.length === 0) {
    warnings.push(
      'TELEGRAM_ALLOWED_CHAT_IDS is not set. She will reply to the first chat that messages her and then only that one. Set it once you know your chat id — /whoami tells you.',
    );
  }

  if (config.livekit && !config.livekit.callPageUrl) {
    warnings.push(
      `${callPage.name} is not set, so /call has nowhere to send you. Publish call/ to GitHub Pages and point this at it.`,
    );
  }

  return config;
}

/** Reads `.env` if there is one. Real environment variables always win. */
export function loadDotEnv(file = '.env'): void {
  try {
    process.loadEnvFile(file);
  } catch {
    // No .env is the normal case for anyone using real environment variables.
  }
}

// ---------------------------------------------------------------------------

/** `0`, `false`, `no` and `off` are all off; anything else present is on. */
function flag(value: string | undefined, fallback: boolean): boolean {
  const text = value?.trim().toLowerCase();
  if (!text) return fallback;
  return !['0', 'false', 'no', 'off'].includes(text);
}

function str(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function int(
  value: string | undefined,
  fallback: number,
  low: number,
  high: number,
  name: string,
  warnings: string[],
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) {
    warnings.push(`${name}="${value}" is not a number; using ${fallback}.`);
    return fallback;
  }
  if (parsed < low || parsed > high) {
    const clamped = Math.min(high, Math.max(low, parsed));
    warnings.push(`${name}=${parsed} is out of range ${low}-${high}; using ${clamped}.`);
    return clamped;
  }
  return parsed;
}

function rate(value: string | undefined, fallback: number, name: string, warnings: string[]): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseFloat(value.trim().replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warnings.push(`${name}="${value}" is not a positive number; using ${fallback}.`);
    return fallback;
  }
  if (parsed > 1) {
    warnings.push(`${name}=${parsed} is above the Live API's limit of 1 frame per second; using 1.`);
    return 1;
  }
  return parsed;
}

/**
 * A budget in dollars.
 *
 * Clamped to something sane rather than trusted: this number is the only thing
 * between a typo and a bill, and `HERS_HEDRA_BUDGET_USD=1000` is far more likely
 * to be a slip than an intention.
 */
function money(
  value: string | undefined,
  fallback: number,
  name: string,
  warnings: string[],
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseFloat(value.trim().replace(',', '.').replace(/^\$/, ''));
  if (!Number.isFinite(parsed) || parsed < 0) {
    warnings.push(`${name}="${value}" is not an amount; using $${fallback}.`);
    return fallback;
  }
  if (parsed > 100) {
    warnings.push(`${name}=$${parsed} is very high; capping at $100.`);
    return 100;
  }
  return parsed;
}

/**
 * Telegram chat ids, which are the allowlist.
 *
 * A bot token is a bearer token for a public endpoint: anyone who finds the bot
 * can message it. Without this list she would read her memory of one person out
 * to whoever says hello, so the empty case is handled by pinning to the first
 * chat rather than by trusting everyone.
 */
function chatIds(value: string | undefined, warnings: string[]): number[] {
  if (!value?.trim()) return [];
  const ids: number[] = [];
  for (const part of value.split(/[,\s]+/).filter(Boolean)) {
    const parsed = Number.parseInt(part, 10);
    if (Number.isFinite(parsed)) ids.push(parsed);
    else warnings.push(`TELEGRAM_ALLOWED_CHAT_IDS contains "${part}", which is not a chat id.`);
  }
  return ids;
}
