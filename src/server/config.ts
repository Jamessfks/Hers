/**
 * Everything Anna needs to know before she can start, read from the
 * environment and from `.env`.
 *
 * One rule the rest of the server depends on: **a bad value never throws
 * here.** Anything unparseable falls back to the default and is reported in
 * `warnings`, which the doctor command and the UI both surface. The one thing
 * that is genuinely fatal — no Gemini key — is not thrown either; the server
 * still starts and serves a setup page saying exactly what to do, because a
 * process that exits with a stack trace teaches a first-time user nothing.
 */

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
  /** Ceiling on silence before Anna speaks first, in milliseconds. */
  maxSilenceMs: number;
  minSilenceMs: number;
  /** Frames per second sent to Gemini. The API accepts at most one. */
  cameraFps: number;
  screenFps: number;
  telegram: { token: string; allowedChatIds: number[] } | null;
  livekit: { url: string; apiKey: string; apiSecret: string; callPageUrl: string } | null;
  warnings: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const warnings: string[] = [];

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
    model: str(env.ANNA_MODEL, DEFAULT_LIVE_MODEL),
    profileDir: path.resolve(str(env.ANNA_PROFILE, 'anna-profile')),
    dataDir: path.resolve(str(env.ANNA_DATA, 'data')),
    host: str(env.ANNA_HOST, '127.0.0.1'),
    port: int(env.ANNA_PORT, 5175, 1, 65535, 'ANNA_PORT', warnings),
    maxSilenceMs: int(
      env.ANNA_MAX_SILENCE_MS,
      DEFAULT_MAX_SILENCE_MS,
      5_000,
      6 * 60 * 60 * 1000,
      'ANNA_MAX_SILENCE_MS',
      warnings,
    ),
    minSilenceMs: int(
      env.ANNA_MIN_SILENCE_MS,
      DEFAULT_MIN_SILENCE_MS,
      1_000,
      6 * 60 * 60 * 1000,
      'ANNA_MIN_SILENCE_MS',
      warnings,
    ),
    // The Live API accepts at most one frame per second and bills for every one
    // of them, so the ceiling here is the API's, not a preference.
    cameraFps: rate(env.ANNA_CAMERA_FPS, 1, 'ANNA_CAMERA_FPS', warnings),
    screenFps: rate(env.ANNA_SCREEN_FPS, 0.5, 'ANNA_SCREEN_FPS', warnings),
    telegram: telegramToken
      ? { token: telegramToken, allowedChatIds: chatIds(env.TELEGRAM_ALLOWED_CHAT_IDS, warnings) }
      : null,
    livekit:
      livekitUrl && livekitKey && livekitSecret
        ? {
            url: livekitUrl,
            apiKey: livekitKey,
            apiSecret: livekitSecret,
            callPageUrl: str(env.ANNA_CALL_PAGE_URL, ''),
          }
        : null,
    warnings,
  };

  if (config.minSilenceMs > config.maxSilenceMs) {
    warnings.push(
      `ANNA_MIN_SILENCE_MS (${config.minSilenceMs}) is above ANNA_MAX_SILENCE_MS (${config.maxSilenceMs}); using the ceiling for both.`,
    );
    config.minSilenceMs = config.maxSilenceMs;
  }

  if (config.telegram && config.telegram.allowedChatIds.length === 0) {
    warnings.push(
      'TELEGRAM_ALLOWED_CHAT_IDS is not set. Anna will reply to the first chat that messages her and then only that one. Set it once you know your chat id — /whoami tells you.',
    );
  }

  if (config.livekit && !config.livekit.callPageUrl) {
    warnings.push(
      'ANNA_CALL_PAGE_URL is not set, so /call has nowhere to send you. Publish call/ to GitHub Pages and point this at it.',
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
 * can message it. Without this list Anna would read her memory of one person
 * out to whoever says hello, so the empty case is handled by pinning to the
 * first chat rather than by trusting everyone.
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
