/**
 * API key storage.
 *
 * Keys go in the macOS Keychain via Electron's `safeStorage`, which is backed
 * by the OS keychain and unlocked with the user's login. Concretely:
 *
 *  - keys are never written to the config file, so a synced dotfile or a
 *    screenshot of settings cannot leak one;
 *  - keys never reach the renderer. The renderer asks for a *status*, gets a
 *    boolean and a masked hint, and that is all it can ever have. A compromised
 *    renderer — the process that loads remote avatar assets — cannot exfiltrate
 *    a key it has never been given;
 *  - the ciphertext is useless on another machine.
 *
 * If `safeStorage` is unavailable (an unusual Linux session with no keyring),
 * we refuse to store rather than silently falling back to plaintext, and tell
 * the user why.
 */

import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SecretName =
  | 'llm.anthropic'
  | 'llm.openai'
  | 'llm.google'
  | 'tts.cartesia'
  | 'tts.elevenlabs'
  | 'tts.hume'
  | 'stt.deepgram'
  | 'stt.openai'
  | 'avatar.heygen'
  | 'avatar.tavus';

interface Vault {
  version: 1;
  /** name -> base64 ciphertext. */
  entries: Record<string, string>;
}

export class Secrets {
  readonly #path: string;
  readonly #undecryptable = new Set<SecretName>();
  #vault: Vault = { version: 1, entries: {} };

  constructor(path = join(app.getPath('userData'), 'secrets.json')) {
    this.#path = path;
    this.#load();
  }

  get available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  set(name: SecretName, value: string): void {
    if (!this.available) {
      throw new Error(
        'This system has no secure keychain available, so Anna will not store your API key.',
      );
    }
    const trimmed = value.trim();
    if (!trimmed) {
      delete this.#vault.entries[name];
    } else {
      this.#vault.entries[name] = safeStorage.encryptString(trimmed).toString('base64');
    }
    this.#save();
  }

  get(name: SecretName): string | null {
    const encoded = this.#vault.entries[name];
    if (!encoded) return null;
    try {
      const value = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      this.#undecryptable.delete(name);
      return value;
    } catch {
      /*
       * Do NOT delete the entry.
       *
       * This used to drop the stored key on any decrypt failure, on the theory
       * that it must be a stale entry from another machine. That is one cause;
       * the others are a Keychain that has not been unlocked yet, a transient
       * Keychain error, and the app running under a different name — and in
       * every one of those cases deleting is destroying a working credential
       * the user pasted once and does not have to hand.
       *
       * A key that cannot be read today may read fine in a minute. Keep it,
       * report it, and let the user decide to replace it.
       */
      this.#undecryptable.add(name);
      return null;
    }
  }

  /** Keys that are stored but could not be decrypted this session. */
  get unreadable(): SecretName[] {
    return [...this.#undecryptable];
  }

  has(name: SecretName): boolean {
    return Boolean(this.#vault.entries[name]);
  }

  /** Everything the renderer is allowed to know about stored keys. */
  status(): Record<string, { present: boolean; hint: string }> {
    const out: Record<string, { present: boolean; hint: string }> = {};
    for (const name of Object.keys(this.#vault.entries)) {
      const value = this.get(name as SecretName);
      out[name] = {
        present: Boolean(value),
        hint: value
          ? `••••${value.slice(-4)}`
          : this.#undecryptable.has(name as SecretName)
            ? 'stored, but the Keychain would not release it'
            : '',
      };
    }
    return out;
  }

  #load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as Vault;
      if (parsed.version === 1 && parsed.entries) this.#vault = parsed;
    } catch {
      // No vault yet, or an unreadable one. Start clean.
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(this.#vault, null, 2), { mode: 0o600 });
  }
}
