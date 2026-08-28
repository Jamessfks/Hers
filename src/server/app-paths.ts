/**
 * Where her folders go when she is a double-clickable application rather than a
 * clone you run from a terminal.
 *
 * Run from a clone, every path in this program is relative to the directory you
 * started it in: `hers-profile/`, `data/`, `.env`. That is right for a clone —
 * the folders sit next to the code, you can see them, and moving the clone moves
 * her. It is wrong for an application. A packaged app has no meaningful working
 * directory (macOS hands it `/` when you launch from the Dock), the folder it
 * lives in is read-only on macOS and inside `Program Files` on Windows, and
 * writing beside the executable is how an app loses everything on an upgrade.
 *
 * So the desktop build hands this module the per-user folder the operating
 * system already set aside for it — Electron's `app.getPath('userData')`, which
 * is `~/Library/Application Support/Hers` on macOS and
 * `%APPDATA%\Hers` on Windows — and this decides what lives in it.
 *
 * Two rules, and the second one is the whole reason this is a module with tests
 * rather than four lines in the Electron entry point:
 *
 *   **Nothing here is read at run time by the rest of the server.** This writes
 *   `HERS_PROFILE`, `HERS_DATA` and `HERS_ENV_FILE` into the environment and
 *   then gets out of the way. Every other file goes on reading configuration the
 *   one way it always has, which means the packaged app and the clone are the
 *   same program with different environments rather than two code paths.
 *
 *   **An environment variable that is already set always wins.** Somebody who
 *   has been talking to her for months with `HERS_PROFILE` pointing at a folder
 *   on an external disk installs the app and finds her there, not a stranger.
 *   That includes the pre-1.0 `ANNA_` spellings, which the rest of the server
 *   still honours and which would otherwise be silently overruled here.
 */

import path from 'node:path';

/** What the desktop build decided, and what it is about to put in the environment. */
export interface DesktopPaths {
  /** The per-user folder everything below lives in, unless overridden. */
  home: string;
  profileDir: string;
  dataDir: string;
  /** The file the pasted Gemini key and bot token are written to. */
  envFile: string;
  /** True for each path the caller had already chosen through the environment. */
  overridden: { profileDir: boolean; dataDir: boolean; envFile: boolean };
}

/**
 * One setting, under its current name or the one this project used to use.
 *
 * The same pair of names {@link import('./config.ts')} reads, for the same
 * reason: a working `.env` should not stop working because the project was
 * renamed. Kept as its own small function rather than imported, because
 * `config.ts` keeps its version private and a second copy of six lines is
 * cheaper than widening that file's surface for one caller.
 */
function chosen(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  const current = env[`HERS_${suffix}`]?.trim();
  if (current) return current;
  const old = env[`ANNA_${suffix}`]?.trim();
  if (old) return old;
  return undefined;
}

/**
 * Decides where everything lives. Reads the environment; changes nothing.
 *
 * A relative override is resolved against the per-user folder rather than the
 * working directory, and that is deliberate. `HERS_PROFILE=her` typed into a
 * terminal means "beside the clone", because the clone is where you are
 * standing. There is nowhere to be standing when an icon is double-clicked, and
 * resolving it against `/` would put her profile at `/her`. Anyone who means a
 * specific place can say so with an absolute path, and absolute paths pass
 * through here untouched.
 */
export function desktopPaths(userData: string, env: NodeJS.ProcessEnv = process.env): DesktopPaths {
  const home = path.resolve(userData);
  const under = (value: string): string => path.resolve(home, value);

  const profile = chosen(env, 'PROFILE');
  const data = chosen(env, 'DATA');
  const envFile = chosen(env, 'ENV_FILE');

  return {
    home,
    profileDir: profile ? under(profile) : path.join(home, 'hers-profile'),
    dataDir: data ? under(data) : path.join(home, 'data'),
    envFile: envFile ? under(envFile) : path.join(home, '.env'),
    overridden: {
      profileDir: profile !== undefined,
      dataDir: data !== undefined,
      envFile: envFile !== undefined,
    },
  };
}

/**
 * Decides, then writes the decision into the environment for the server to read.
 *
 * Absolute paths are written back even when they came from the environment
 * unchanged, so that everything downstream sees a path that means the same thing
 * from any working directory. That matters more than it looks: `loadConfig`
 * finishes with `path.resolve`, and `path.resolve` on a relative value answers a
 * question about the working directory that a packaged application has no
 * business being asked.
 *
 * The old `ANNA_` names are left exactly as they were found. Deleting them would
 * be tidier and would also be this function quietly rewriting somebody's
 * environment; `HERS_` is what the server prefers, so setting it is enough.
 */
export function applyDesktopPaths(
  userData: string,
  env: NodeJS.ProcessEnv = process.env,
): DesktopPaths {
  const paths = desktopPaths(userData, env);
  env.HERS_PROFILE = paths.profileDir;
  env.HERS_DATA = paths.dataDir;
  env.HERS_ENV_FILE = paths.envFile;
  return paths;
}
