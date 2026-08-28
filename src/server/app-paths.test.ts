import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { applyDesktopPaths, desktopPaths } from './app-paths.ts';
import { envFilePath, loadConfig, loadDotEnv } from './config.ts';
import { setEnvValue } from './env-file.ts';

const env = (values: Record<string, string> = {}) => values as NodeJS.ProcessEnv;

/** A plausible `app.getPath('userData')`, absolute and nested, on either OS. */
const USER_DATA =
  process.platform === 'win32'
    ? 'C:\\Users\\someone\\AppData\\Roaming\\Hers'
    : '/Users/someone/Library/Application Support/Hers';

test('with nothing set, everything lives under the folder the OS gave the app', () => {
  const paths = desktopPaths(USER_DATA, env());
  assert.equal(paths.profileDir, path.join(USER_DATA, 'hers-profile'));
  assert.equal(paths.dataDir, path.join(USER_DATA, 'data'));
  assert.equal(paths.envFile, path.join(USER_DATA, '.env'));
  assert.deepEqual(paths.overridden, { profileDir: false, dataDir: false, envFile: false });
});

test('nothing lands next to the executable', () => {
  // The failure this is here to stop: a packaged app writing beside its own
  // binary, which is read-only on macOS and wiped by an upgrade everywhere.
  for (const each of Object.values(desktopPaths(USER_DATA, env()))) {
    if (typeof each !== 'string') continue;
    assert.ok(path.isAbsolute(each), `${each} is absolute`);
    assert.ok(
      each === USER_DATA || each.startsWith(USER_DATA + path.sep),
      `${each} is inside the per-user folder`,
    );
  }
});

test('an existing install is not orphaned: HERS_PROFILE still wins', () => {
  const mine = path.resolve(path.sep, 'Volumes', 'disk', 'her');
  const paths = desktopPaths(USER_DATA, env({ HERS_PROFILE: mine }));
  assert.equal(paths.profileDir, mine);
  assert.equal(paths.overridden.profileDir, true);
  assert.equal(paths.dataDir, path.join(USER_DATA, 'data'), 'and the rest is unaffected');
});

test('HERS_DATA and HERS_ENV_FILE win the same way', () => {
  const data = path.resolve(path.sep, 'Volumes', 'disk', 'memory');
  const file = path.resolve(path.sep, 'Volumes', 'disk', 'keys.env');
  const paths = desktopPaths(USER_DATA, env({ HERS_DATA: data, HERS_ENV_FILE: file }));
  assert.equal(paths.dataDir, data);
  assert.equal(paths.envFile, file);
  assert.deepEqual(paths.overridden, { profileDir: false, dataDir: true, envFile: true });
});

test('the pre-1.0 names are still honoured, because the server still honours them', () => {
  // `config.ts` reads ANNA_PROFILE. If this did not, the desktop build would
  // set HERS_PROFILE and silently overrule an environment that works today.
  const mine = path.resolve(path.sep, 'Volumes', 'disk', 'anna');
  const paths = desktopPaths(USER_DATA, env({ ANNA_PROFILE: mine }));
  assert.equal(paths.profileDir, mine);
  assert.equal(paths.overridden.profileDir, true);
});

test('HERS_ wins over ANNA_ when somebody has both', () => {
  const now = path.resolve(path.sep, 'now');
  const then = path.resolve(path.sep, 'then');
  const paths = desktopPaths(USER_DATA, env({ HERS_PROFILE: now, ANNA_PROFILE: then }));
  assert.equal(paths.profileDir, now);
});

test('a blank variable is not an answer', () => {
  // `HERS_PROFILE=` in a `.env`, or an empty value exported by a launcher. The
  // rest of the server treats blank as unset and so does this.
  const paths = desktopPaths(USER_DATA, env({ HERS_PROFILE: '   ', HERS_DATA: '' }));
  assert.equal(paths.profileDir, path.join(USER_DATA, 'hers-profile'));
  assert.equal(paths.dataDir, path.join(USER_DATA, 'data'));
});

test('a relative override lands under the per-user folder, not under /', () => {
  // There is no working directory to mean "here" when an icon is double-clicked
  // — macOS hands the process `/`. Resolving against that would put somebody's
  // profile at /her.
  const paths = desktopPaths(USER_DATA, env({ HERS_PROFILE: 'her' }));
  assert.equal(paths.profileDir, path.join(USER_DATA, 'her'));
});

test('applying it puts absolute paths in the environment and leaves ANNA_ alone', () => {
  const values = env({ ANNA_PROFILE: path.resolve(path.sep, 'old', 'her') });
  const paths = applyDesktopPaths(USER_DATA, values);

  assert.equal(values.HERS_PROFILE, paths.profileDir);
  assert.equal(values.HERS_DATA, paths.dataDir);
  assert.equal(values.HERS_ENV_FILE, paths.envFile);
  assert.equal(
    values.ANNA_PROFILE,
    path.resolve(path.sep, 'old', 'her'),
    'a variable this module does not own is not this module to rewrite',
  );
});

test('the environment it writes is one loadConfig reads back unchanged', () => {
  /*
   * The join this is really testing. `loadConfig` finishes every path with
   * `path.resolve`, which answers a question about the working directory — and
   * a packaged app has no meaningful one. Writing absolute paths is what makes
   * that resolve a no-op, so the server sees the same two folders wherever it
   * happens to have been launched from.
   */
  const values = env({});
  const paths = applyDesktopPaths(USER_DATA, values);
  const config = loadConfig(values);

  assert.equal(config.profileDir, paths.profileDir);
  assert.equal(config.dataDir, paths.dataDir);
  assert.deepEqual(config.warnings, [], 'and none of it is worth warning about');
});

test('an override survives the round trip through loadConfig too', () => {
  const mine = path.resolve(path.sep, 'Volumes', 'disk', 'her');
  const values = env({ HERS_PROFILE: mine });
  applyDesktopPaths(USER_DATA, values);
  assert.equal(loadConfig(values).profileDir, mine);
});

test('the key a first-time user pastes in has somewhere to land', async () => {
  /*
   * The whole first-run problem in one test.
   *
   * Run from a clone, the Setup panel writes the pasted key to `.env` beside
   * `package.json` and everything works. An installed application has no such
   * place: on macOS its own folder is inside a read-only, signed bundle, and on
   * Windows it is under `Program Files`. If the key had nowhere to go, the
   * first run would be the only run, and the failure would arrive as an
   * unexplained error in a dialog with no terminal behind it.
   *
   * So this walks the real path: decide the folder, write a key the way the
   * Setup route writes one, and read it back the way startup reads it.
   */
  const userData = await mkdtemp(path.join(tmpdir(), 'hers-desktop-'));
  const names = ['HERS_ENV_FILE', 'HERS_PROFILE', 'HERS_DATA', 'GEMINI_API_KEY'] as const;
  const before = new Map(names.map((name) => [name, process.env[name]]));
  try {
    const paths = applyDesktopPaths(userData, process.env);
    assert.equal(paths.envFile, path.join(userData, '.env'));

    // Exactly what `applyGeminiKey` does, minus the call to Google that checks
    // the key is real — which is the one part of that route this cannot reach
    // without a network and an account.
    await setEnvValue(envFilePath(), 'GEMINI_API_KEY', 'AIzaTestKeyNotReal');

    assert.match(
      await readFile(paths.envFile, 'utf8'),
      /^GEMINI_API_KEY=AIzaTestKeyNotReal$/m,
      'and it landed in the per-user folder, not beside the executable',
    );

    // And the next start finds it. `loadDotEnv` is the first thing `main` does.
    delete process.env.GEMINI_API_KEY;
    loadDotEnv();
    assert.equal(loadConfig(process.env).geminiApiKey, 'AIzaTestKeyNotReal');
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// Reading the keys file before deciding the paths
// ---------------------------------------------------------------------------

/*
 * The bug this guards. `applyDesktopPaths` writes HERS_PROFILE, HERS_DATA and
 * HERS_ENV_FILE into the environment, and `process.loadEnvFile` will not
 * overwrite a variable that is already set. The desktop entry point used to
 * decide the paths first and read the file second, so every one of those keys
 * written into `.env` was ignored — and four documents promised otherwise. The
 * documented way to move an existing install produced a stranger instead.
 */

test('HERS_PROFILE in the keys file wins, if the file is read first', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'hers-userdata-'));
  const clone = await mkdtemp(path.join(tmpdir(), 'hers-clone-'));
  await writeFile(path.join(userData, '.env'), `HERS_PROFILE=${clone}\n`, 'utf8');

  // The order the entry point now uses.
  const env: NodeJS.ProcessEnv = {};
  const before = process.env.HERS_PROFILE;
  try {
    delete process.env.HERS_PROFILE;
    loadDotEnv(path.join(userData, '.env'));
    env.HERS_PROFILE = process.env.HERS_PROFILE;

    const paths = desktopPaths(userData, env);
    assert.equal(paths.profileDir, path.resolve(clone), 'the keys file was ignored');
    assert.equal(paths.overridden.profileDir, true);
  } finally {
    if (before === undefined) delete process.env.HERS_PROFILE;
    else process.env.HERS_PROFILE = before;
  }
});

test('the wrong order makes it a dead letter, which is what shipped', async () => {
  // Kept as a test rather than a comment so the reason the order matters is
  // executable: decide first, and the file cannot be heard afterwards.
  const userData = await mkdtemp(path.join(tmpdir(), 'hers-userdata-'));
  const clone = await mkdtemp(path.join(tmpdir(), 'hers-clone-'));
  await writeFile(path.join(userData, '.env'), `HERS_PROFILE=${clone}\n`, 'utf8');

  const env: NodeJS.ProcessEnv = {};
  applyDesktopPaths(userData, env); // decided, before anything was read
  const already = env.HERS_PROFILE;

  // process.loadEnvFile only fills in what is absent, so this changes nothing.
  assert.equal(env.HERS_PROFILE, already);
  assert.notEqual(path.resolve(already ?? ''), path.resolve(clone));
});

test('a keys file with nothing in it leaves the defaults alone', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'hers-userdata-'));
  await writeFile(path.join(userData, '.env'), 'GEMINI_API_KEY=\n', 'utf8');

  loadDotEnv(path.join(userData, '.env'));
  const paths = desktopPaths(userData, {});

  assert.equal(paths.profileDir, path.join(path.resolve(userData), 'hers-profile'));
  assert.equal(paths.overridden.profileDir, false);
});

test('a missing keys file is not an error, because it is the normal first run', () => {
  const missing = path.join(tmpdir(), 'hers-definitely-absent', '.env');
  assert.doesNotThrow(() => loadDotEnv(missing));
});
