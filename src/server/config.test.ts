import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ENV_FILE,
  FORMER_PROFILE_DIR,
  PROFILE_DIR,
  envFilePath,
  isLoopbackHost,
  loadConfig,
  migrateProfileDir,
} from './config.ts';
import { DEFAULT_LIVE_MODEL } from '../core/gemini/models.ts';

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

test('an empty environment still produces a working configuration', () => {
  const config = loadConfig(env({}));
  assert.equal(config.geminiApiKey, '');
  assert.equal(config.model, DEFAULT_LIVE_MODEL);
  assert.equal(config.host, '127.0.0.1', 'binding wider by default would be a mistake');
  assert.equal(config.port, 5175);
  assert.equal(config.maxSilenceMs, 180_000, 'the three-minute promise is the default');
  assert.equal(config.telegram, null);
  assert.deepEqual(config.warnings, []);
});

test('GOOGLE_API_KEY is accepted, because half the docs use it', () => {
  assert.equal(loadConfig(env({ GOOGLE_API_KEY: 'abc' })).geminiApiKey, 'abc');
  assert.equal(
    loadConfig(env({ GEMINI_API_KEY: 'first', GOOGLE_API_KEY: 'second' })).geminiApiKey,
    'first',
  );
});

test('paths are resolved so nothing depends on the working directory', () => {
  const config = loadConfig(env({ HERS_PROFILE: 'somewhere', HERS_DATA: 'else' }));
  assert.ok(path.isAbsolute(config.profileDir));
  assert.ok(path.isAbsolute(config.dataDir));
});

test('a bad number warns and falls back rather than failing to start', () => {
  const config = loadConfig(env({ HERS_PORT: 'banana' }));
  assert.equal(config.port, 5175);
  assert.match(config.warnings.join(' '), /HERS_PORT/);
});

test('an out-of-range number is clamped and said out loud', () => {
  const config = loadConfig(env({ HERS_PORT: '99999' }));
  assert.equal(config.port, 65535);
  assert.match(config.warnings.join(' '), /out of range/);
});

test('a silence floor above the ceiling cannot silently break the promise', () => {
  const config = loadConfig(env({ HERS_MAX_SILENCE_MS: '60000', HERS_MIN_SILENCE_MS: '120000' }));
  assert.equal(config.maxSilenceMs, 60_000);
  assert.equal(config.minSilenceMs, 60_000);
  assert.match(config.warnings.join(' '), /above HERS_MAX_SILENCE_MS/);
});

test('frame rates cannot exceed what the Live API accepts', () => {
  const config = loadConfig(env({ HERS_CAMERA_FPS: '30', HERS_SCREEN_FPS: '0,25' }));
  assert.equal(config.cameraFps, 1, 'the API takes at most one frame per second');
  assert.equal(config.screenFps, 0.25, 'and a decimal comma is what half the world types');
  assert.match(config.warnings.join(' '), /1 frame per second/);
});

test('a Telegram bot with no allowlist is flagged, loudly', () => {
  const config = loadConfig(env({ TELEGRAM_BOT_TOKEN: '123:abc' }));
  assert.deepEqual(config.telegram?.allowedChatIds, []);
  assert.match(config.warnings.join(' '), /first chat/);
});

test('chat ids are parsed from anything a person would type', () => {
  const config = loadConfig(
    env({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_ALLOWED_CHAT_IDS: '111, -222  333' }),
  );
  assert.deepEqual(config.telegram?.allowedChatIds, [111, -222, 333]);
  assert.deepEqual(config.warnings, [], 'a valid list should not warn');
});

test('a chat id that is not a number is called out rather than dropped in silence', () => {
  const config = loadConfig(
    env({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_ALLOWED_CHAT_IDS: '111,@zicheng' }),
  );
  assert.deepEqual(config.telegram?.allowedChatIds, [111]);
  assert.match(config.warnings.join(' '), /@zicheng/);
});

// -- the v1.0 folder rename -------------------------------------------------

test('a profile folder from before the rename is moved, once, and only when it is safe', async () => {
  /*
   * What this replaced: a fallback that read `anna-profile` when `hers-profile`
   * was absent. It made the answer depend on run order, and a stray
   * `hers-profile` — which one command in this repo did in fact create — pointed
   * her at an empty stranger while the real face and memory sat in the folder
   * next to it. A rename has no such state to get wrong.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'hers-move-'));
  const previous = process.cwd();
  process.chdir(root);
  try {
    await mkdir(FORMER_PROFILE_DIR, { recursive: true });
    await writeFile(path.join(FORMER_PROFILE_DIR, 'identity.md'), '---\nname: Mira\n---\n', 'utf8');

    const first = migrateProfileDir({} as NodeJS.ProcessEnv);
    assert.deepEqual(
      { from: first.from, to: first.to },
      { from: FORMER_PROFILE_DIR, to: PROFILE_DIR },
      'it reports what it did so startup can say so out loud',
    );
    assert.equal(
      await readFile(path.join(PROFILE_DIR, 'identity.md'), 'utf8'),
      '---\nname: Mira\n---\n',
      'the name she chose came with the folder',
    );
    assert.equal(existsSync(FORMER_PROFILE_DIR), false, 'and there is only one folder now');

    // Idempotent: nothing left to move.
    assert.deepEqual(migrateProfileDir({} as NodeJS.ProcessEnv), {});

    // And it will not overwrite: two real folders is a decision for a human.
    await mkdir(FORMER_PROFILE_DIR, { recursive: true });
    await writeFile(path.join(FORMER_PROFILE_DIR, 'identity.md'), 'do not lose me', 'utf8');
    assert.deepEqual(migrateProfileDir({} as NodeJS.ProcessEnv), {});
    assert.equal(await readFile(path.join(FORMER_PROFILE_DIR, 'identity.md'), 'utf8'), 'do not lose me');
  } finally {
    process.chdir(previous);
  }
});

test('a profile folder someone named themselves is left exactly where it is', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hers-move-'));
  const previous = process.cwd();
  process.chdir(root);
  try {
    await mkdir(FORMER_PROFILE_DIR, { recursive: true });
    for (const env of [{ HERS_PROFILE: '/somewhere/else' }, { ANNA_PROFILE: '/somewhere/else' }]) {
      assert.deepEqual(migrateProfileDir(env as NodeJS.ProcessEnv), {}, JSON.stringify(env));
      assert.equal(existsSync(FORMER_PROFILE_DIR), true);
    }
  } finally {
    process.chdir(previous);
  }
});

test('the old variable names still work, and say so under their own name', () => {
  // Somebody's `.env` predates the rename. It should not stop working, and a
  // range warning has to name the line they can actually go and edit.
  const config = loadConfig({ GEMINI_API_KEY: 'k', ANNA_PORT: '4000' } as NodeJS.ProcessEnv);
  assert.equal(config.port, 4000);

  const bad = loadConfig({ GEMINI_API_KEY: 'k', ANNA_PORT: '99999' } as NodeJS.ProcessEnv);
  assert.match(bad.warnings.join(' '), /ANNA_PORT=99999/, 'not HERS_PORT, which they never set');

  // And the current name wins when both are present.
  const both = loadConfig({
    GEMINI_API_KEY: 'k',
    ANNA_PORT: '4000',
    HERS_PORT: '4001',
  } as NodeJS.ProcessEnv);
  assert.equal(both.port, 4001);
});

// ---------------------------------------------------------------------------
// Binding, and the warning that has to come with it
// ---------------------------------------------------------------------------

test('the default bind produces no warning, because it is the safe one', () => {
  assert.deepEqual(loadConfig(env({})).warnings, []);
  assert.deepEqual(loadConfig(env({ HERS_HOST: '127.0.0.1' })).warnings, []);
});

test('binding anywhere but this machine is warned about loudly', () => {
  // `docs/PRIVACY.md` used to say the loopback bind was "the design, not a
  // default to be adjusted". It is a default and it is adjustable, so the
  // document now says so — and this is the warning that makes saying so safe.
  for (const host of ['0.0.0.0', '192.168.1.10', '::', 'hers.local']) {
    const { warnings } = loadConfig(env({ HERS_HOST: host }));
    assert.equal(warnings.length, 1, host);
    assert.match(warnings[0] ?? '', /HERS_HOST/, host);
    assert.match(warnings[0] ?? '', /no password/i, host);
    assert.match(warnings[0] ?? '', /secure context/i, host);
  }
});

test('the warning names the variable that was actually set', () => {
  // Somebody upgrading from before v1.0 has ANNA_HOST in their file, and a
  // warning pointing at a line they do not have is a warning they cannot act on.
  const { warnings } = loadConfig(env({ ANNA_HOST: '0.0.0.0' }));
  assert.match(warnings[0] ?? '', /ANNA_HOST=0\.0\.0\.0/);
});

test('every way of writing this machine counts as this machine', () => {
  for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', '127.1.2.3']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', '128.0.0.1', 'example.com', '']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('the keys file is one name, resolved absolute, and the desktop build can move it', () => {
  assert.equal(ENV_FILE, '.env');
  assert.ok(path.isAbsolute(envFilePath()), 'a relative path is the thing nobody can find');
  assert.equal(envFilePath({} as NodeJS.ProcessEnv), path.resolve('.env'));

  // The packaged application cannot write beside its own executable, so it sets
  // this before the server starts. Every later write has to land in the same
  // file as the first, or the key you pasted is gone on the second launch.
  //
  // Compared through `path.resolve` rather than to the literal, because on
  // Windows `/somewhere/keys.env` resolves to `C:\somewhere\keys.env` and the
  // literal comparison failed there for every release anybody tagged. What is
  // being asserted is that the value is taken and made absolute, not which
  // separator the platform writes it with.
  const moved = { HERS_ENV_FILE: '/somewhere/keys.env' } as NodeJS.ProcessEnv;
  assert.equal(envFilePath(moved), path.resolve('/somewhere/keys.env'));

  // The old name still works, for an install that predates the rename.
  const legacy = { ANNA_ENV_FILE: '/somewhere/old.env' } as NodeJS.ProcessEnv;
  assert.equal(envFilePath(legacy), path.resolve('/somewhere/old.env'));
});
