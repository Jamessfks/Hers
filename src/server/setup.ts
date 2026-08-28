/**
 * Setting her up from the website: the keys, the bot, and starting over.
 *
 * Both of these used to be things you did in a text editor and a terminal, and
 * both are things a person should be able to do from the page they are already
 * looking at. What they have in common is that they change the world outside
 * this process — a file on disk, a directory that gets deleted — so they are
 * here, in one small module, rather than spread through the request handler.
 *
 * The key never travels back to the browser. Google's guidance is explicit that
 * keys belong in the environment and not in anything client-side, so the page
 * can submit one and can be told the last four characters of the one in force,
 * and that is all it ever learns.
 */

import type { Brain } from '../core/session/brain.ts';
import { setEnvValue } from './env-file.ts';
import { envFilePath, loadConfig } from './config.ts';
import type { Config } from './config.ts';

/** Where a key is checked. Free, and the error it returns is worth reading. */
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';

/** Long enough for a slow connection, short enough that the page is not stuck. */
const CHECK_TIMEOUT_MS = 12_000;

export interface KeyCheck {
  ok: boolean;
  /** Phrased for a person. Google's own message is usually already that. */
  reason?: string;
}

/**
 * Asks Google whether this key works, before writing it down.
 *
 * A metadata call rather than a generation: it costs nothing, it needs no model
 * name to be right, and it distinguishes the three things that actually go
 * wrong — a mistyped key, a key with the API disabled, and no internet — which
 * "she did not answer" does not.
 */
export async function checkGeminiKey(key: string): Promise<KeyCheck> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, reason: 'No key.' };

  try {
    const response = await fetch(MODELS_URL, {
      headers: { 'x-goog-api-key': trimmed },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true };

    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    const message = body?.error?.message?.trim();
    return {
      ok: false,
      reason: message
        ? `Google says: ${message}`
        : `Google refused the key (HTTP ${response.status}).`,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {
      ok: false,
      reason:
        name === 'TimeoutError'
          ? 'Google did not answer in time. Check the connection and try again.'
          : `Could not reach Google: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Stores a checked key and brings the rest of the program up to date with it.
 *
 * Three things have to happen together, and the order matters: the file so it
 * survives a restart, `process.env` so a re-read of the configuration agrees
 * with the file, and the brain so that memory stops using the offline embedder
 * it was built with when there was no key.
 *
 * Returns the reloaded configuration. Conversations already open keep the key
 * they started with, which is honest — a Live session's credentials are fixed
 * at setup, and telling the UI otherwise would be a lie.
 */
export async function applyGeminiKey(
  brain: Brain,
  key: string,
  envFile = envFilePath(),
): Promise<Config> {
  const trimmed = key.trim();
  await setEnvValue(envFile, 'GEMINI_API_KEY', trimmed);
  process.env.GEMINI_API_KEY = trimmed;
  const config = loadConfig();
  await brain.reload(config);
  return config;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

/**
 * Everything the Telegram half of setup needs, from the Bot API's own docs.
 *
 * `getMe` "requires no parameters" and returns a User for the bot itself,
 * carrying `is_bot`, `first_name` and an optional `username`. Every method lives
 * under `https://api.telegram.org/bot<token>/METHOD_NAME`, and every reply is a
 * JSON object with a boolean `ok` plus an optional `description` — which is what
 * a person should be shown when a token is wrong, because Telegram's own wording
 * is already better than anything invented here.
 */
const TELEGRAM_API = 'https://api.telegram.org';

/**
 * The documented deep-link payload.
 *
 * `https://t.me/<bot_username>?start=<payload>` is the documented form for a
 * private chat; the payload may be up to 64 characters of `A-Z a-z 0-9 _ -`, and
 * opening it delivers `/start hers` to the bot. It is used here purely to get the
 * user into the chat and past the Start button in one tap — the bot cannot learn
 * a chat id any other way, because nothing in the Bot API reveals one except an
 * update that arrives from it.
 */
const START_PAYLOAD = 'hers';

export interface BotCheck {
  ok: boolean;
  /** Without the @. Absent on a bot that has somehow not got one. */
  username?: string;
  /** The bot's display name, for confirming it is the one they meant. */
  name?: string;
  reason?: string;
}

/**
 * Asks Telegram whether this bot token works, before writing it down.
 *
 * `getMe` is the cheapest call in the API and it answers the three things that
 * matter: that the token is real, which bot it belongs to, and what its username
 * is — which is needed to build the link that gets the user into the chat.
 *
 * The token is never logged or echoed. A bot token is a bearer credential for a
 * public endpoint, so it is treated exactly like the Gemini key: it goes to
 * `.env` and the browser is told the bot's name, never the token.
 */
export async function checkBotToken(token: string): Promise<BotCheck> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, reason: 'No token.' };

  try {
    const response = await fetch(`${TELEGRAM_API}/bot${encodeURIComponent(trimmed)}/getMe`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: { is_bot?: boolean; username?: string; first_name?: string } }
      | null;

    if (!body?.ok || !body.result) {
      const said = body?.description?.trim();
      return {
        ok: false,
        // "Unauthorized" is what a wrong token gets, and it is not obvious what
        // that means about a string you just pasted.
        reason: said
          ? `Telegram says: ${said}${/unauthorized/i.test(said) ? ' — that usually means the token is wrong.' : ''}`
          : `Telegram refused the token (HTTP ${response.status}).`,
      };
    }

    if (!body.result.is_bot) {
      return { ok: false, reason: 'That token belongs to a person, not a bot. Make one with @BotFather.' };
    }

    return { ok: true, username: body.result.username, name: body.result.first_name };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {
      ok: false,
      reason:
        name === 'TimeoutError'
          ? 'Telegram did not answer in time. Check the connection and try again.'
          : `Could not reach Telegram: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The link that puts somebody in the chat with one tap. */
export function botLink(username: string): string {
  return `https://t.me/${username}?start=${START_PAYLOAD}`;
}

/**
 * Stores a checked bot token. Same three steps, same order, as the Gemini key.
 *
 * The bridge is not started here — that is the caller's job, because only the
 * caller knows whether one is already polling. Two pollers on one token is the
 * one thing that must not happen: the Bot API hands `getUpdates` to the newest
 * caller and terminates the other.
 */
export async function applyBotToken(token: string, envFile = envFilePath()): Promise<Config> {
  const trimmed = token.trim();
  await setEnvValue(envFile, 'TELEGRAM_BOT_TOKEN', trimmed);
  process.env.TELEGRAM_BOT_TOKEN = trimmed;
  return loadConfig();
}

/**
 * Writes down the chat she is allowed to talk to.
 *
 * Nothing in the Bot API tells a bot which chat belongs to its owner, so the
 * first chat that speaks is the only candidate there has ever been — the bridge
 * has always trusted it for the length of a run and printed the line to paste to
 * keep it. This makes it durable instead of asking somebody to edit a file, and
 * says so on the page rather than in a log nobody is reading.
 *
 * This overwrites rather than appends, and that is safe because of where it is
 * called from rather than anything it does itself: `TelegramBridge#permitted`
 * returns before pinning whenever the allowlist already has somebody in it, so
 * `onChatPinned` — the only caller — can fire only from empty. An allowlist
 * that already names somebody is a decision already taken, and a second chat
 * messaging the bot must not join it. A future caller that skips that check
 * would need the guard moved in here.
 */
export async function rememberChatId(chatId: number, envFile = envFilePath()): Promise<Config> {
  await setEnvValue(envFile, 'TELEGRAM_ALLOWED_CHAT_IDS', String(chatId));
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = String(chatId);
  return loadConfig();
}

/**
 * The last four characters, which is enough to tell two keys apart.
 *
 * Shown so that somebody who has three of these can see which one is in force
 * without it being a key anybody could use.
 */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  return trimmed.length <= 4 ? '••••' : `••••${trimmed.slice(-4)}`;
}
