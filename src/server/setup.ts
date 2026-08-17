/**
 * Setting Anna up from the website: the key, and starting over.
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
import { loadConfig } from './config.ts';
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
  envFile = '.env',
): Promise<Config> {
  const trimmed = key.trim();
  await setEnvValue(envFile, 'GEMINI_API_KEY', trimmed);
  process.env.GEMINI_API_KEY = trimmed;
  const config = loadConfig();
  await brain.reload(config);
  return config;
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
