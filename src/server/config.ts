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
  /** Whether a client sending no `Origin` may open the WebSocket. Off. */
  allowHeadless: boolean;
  telegram: { token: string; allowedChatIds: number[] } | null;
  livekit: { url: string; apiKey: string; apiSecret: string; callPageUrl: string } | null;
  warnings: string[];
}

/** Where the profile folder lives unless told otherwise. */
export const PROFILE_DIR = 'hers-profile';

/**
 * The file the keys live in, relative to wherever Hers was started.
 *
 * One copy, because three places need it and two of them are promises made to
 * a reader: `loadDotEnv` reads it, `setEnvValue` writes it, and both the doctor
 * and the startup banner print it resolved so nobody has to guess which `.env`
 * is in force. `docs/PRIVACY.md` says those two print it; this is what makes
 * that true rather than nearly true.
 */
export const ENV_FILE = '.env';

/**
 * Whether a host only accepts connections from this machine.
 *
 * The whole security model of the web UI is that it has no authentication
 * because nothing else can reach it, so this is the predicate the rest of that
 * argument rests on. All of `127.0.0.0/8` counts, not just `127.0.0.1`, and the
 * bracketed IPv6 form is accepted because that is how it is typed into a URL.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare === '::1') return true;
  const parts = bare.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part)) && parts[0] === '127';
}

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
  const callPage = setting(env, 'CALL_PAGE_URL');

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
    allowHeadless: setting(env, 'ALLOW_HEADLESS').value?.trim() === '1',
    cameraFps: rate(cameraFps.value, 1, cameraFps.name, warnings),
    screenFps: rate(screenFps.value, 0.5, screenFps.name, warnings),
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

  /*
   * Binding off-loopback is allowed and is not warned about gently.
   *
   * The page has no login, because until now nothing else could reach it. On
   * any other host it can, and what is behind it is her memory of somebody and
   * a key that spends their money. Two things also simply stop working: the
   * microphone, camera and screen share all need a secure context, which
   * `localhost` is without a certificate and no other host is.
   *
   * A warning rather than a refusal, because someone doing this on purpose
   * behind their own firewall is entitled to. But `docs/PRIVACY.md` used to
   * call the loopback bind "the design, not a default to be adjusted", which
   * was flatly untrue — it is `HERS_HOST`, and `.env.example` ships it as a
   * documented knob. The claim is now accurate and this is what backs it.
   */
  if (!isLoopbackHost(config.host)) {
    warnings.push(
      `${host.name}=${config.host} binds the website to something other than this machine. ` +
        'It has no password, and anyone who can reach it can read her memory of you and spend ' +
        'your Gemini key. The microphone, camera and screen share will also stop working, ' +
        'because they need a secure context and only localhost is one without a certificate. ' +
        'Set HERS_HOST=127.0.0.1 unless you know exactly why you are not.',
    );
  }

  if (config.minSilenceMs > config.maxSilenceMs) {
    warnings.push(
      `${minSilence.name} (${config.minSilenceMs}) is above ${maxSilence.name} (${config.maxSilenceMs}); using the ceiling for both.`,
    );
    config.minSilenceMs = config.maxSilenceMs;
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

/**
 * Which file the keys are read from and written back to.
 *
 * `.env`, beside the clone, for everybody who runs this from a terminal — which
 * is where every other secret in this project already lives and where the
 * documentation points. The one caller who needs to say otherwise is the
 * desktop build: a packaged application's own folder is read-only on macOS and
 * inside `Program Files` on Windows, so the key pasted into the Setup panel has
 * to be written somewhere else or the first run is the only run.
 *
 * Read through a function rather than captured once, so that the desktop entry
 * point can set the variable before the server starts and every later write
 * lands in the same file as the first.
 *
 * Resolved to an absolute path, because the two places this is shown to a
 * person — `npm run doctor` and the first lines `npm start` prints — are worth
 * nothing if they say `.env` to somebody who does not know which directory they
 * were in.
 */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(str(env.HERS_ENV_FILE ?? env.ANNA_ENV_FILE, ENV_FILE));
}

/** Reads the key file if there is one. Real environment variables always win. */
export function loadDotEnv(file = envFilePath()): void {
  try {
    process.loadEnvFile(file);
  } catch {
    // No .env is the normal case for anyone using real environment variables.
  }
}

// ---------------------------------------------------------------------------

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
