/**
 * The desktop application: the same server, in a window, with an icon.
 *
 * ## What this is not
 *
 * It is not a second implementation of anything. The server in `src/server/`
 * still owns the HTTP routes, the WebSocket, her memory and her mood, and the
 * page in the window is the same page a browser would get from
 * `http://127.0.0.1`. This file does four things a terminal used to do for
 * free — decide where her folders live, pick a port, start the server, and open
 * something to look at it with — and then stays out of the way.
 *
 * That is the whole design goal. Two ways of running the same program is how
 * you get a bug that only exists in one of them. So this sets environment
 * variables and calls `main()`; every decision below that is made by the code
 * that was already there.
 *
 * ## Plain JavaScript, on purpose
 *
 * Everything else in this repository is TypeScript, and Electron runs it
 * happily — Electron 44 carries Node 24, which strips types with no build step
 * exactly as `npm start` does, and `node:sqlite` and the LiveKit binding are
 * both there. This one file is `.js` anyway, because it is the entry point
 * named in `package.json`: if type stripping ever broke, a `.ts` entry point
 * would fail before there was a window to say so in, and the failure would be a
 * dock icon that bounces once and disappears. The logic worth testing lives in
 * `src/server/app-paths.ts`, which is TypeScript and has tests.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { format } from 'node:util';

import { BrowserWindow, app, desktopCapturer, dialog, session, shell } from 'electron';

import { applyDesktopPaths } from '../src/server/app-paths.ts';

/**
 * The name, fixed here rather than taken from wherever Electron would find it.
 *
 * `app.getPath('userData')` is derived from the application name, and the name
 * differs between `npm run app` (the `name` field, `hers`) and the built
 * application (the bundle name, `Hers`). Two names is two profile folders, and
 * the way you find that out is by testing a build and meeting a stranger. So
 * the folder is stated once, absolutely, before anything reads it.
 */
const APP_NAME = 'Hers';

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));

/** Where everything she has lives. Made now, because the key gets written into it. */
const paths = applyDesktopPaths(app.getPath('userData'));
mkdirSync(paths.home, { recursive: true });

/*
 * A working directory that exists and is writable.
 *
 * Belt and braces. `app-paths` makes the three paths that matter absolute, so
 * nothing below should be resolving anything against the working directory —
 * but macOS hands a double-clicked application `/`, and a stray relative write
 * landing there fails in a way nobody could diagnose. Landing it beside her
 * profile is at worst a file somebody can find and delete.
 */
process.chdir(paths.home);

/**
 * Everything the server says, written down as well as printed.
 *
 * Run from a terminal, `npm start` prints where her profile is, which model she
 * is on, and every warning the configuration produced, and if she will not
 * start you read the reason. An application has no terminal. Without this the
 * entire diagnostic surface of a failed launch is a dock icon that bounced
 * once — which is not a hypothetical: a missing folder in the packaging list
 * produced exactly that, and it took an instrumented build to find out why.
 *
 * Truncated on every launch, so it is the last run rather than a year of them.
 * Nothing secret goes through `console` — the key is printed masked to its last
 * four characters and the bot token is never printed at all — so this is safe
 * to ask somebody to send you.
 */
const logFile = path.join(paths.home, 'hers.log');
try {
  writeFileSync(logFile, `Hers — ${new Date().toISOString()}\n`);
  for (const level of /** @type {const} */ (['log', 'warn', 'error'])) {
    const printed = console[level].bind(console);
    console[level] = (...args) => {
      printed(...args);
      try {
        appendFileSync(logFile, `${format(...args)}\n`);
      } catch {
        // A log that cannot be written must not be the reason she will not run.
      }
    };
  }
} catch {
  // Same rule one level up.
}

/** One copy. A second `getUpdates` poller is two halves of a Telegram conversation. */
if (!app.requestSingleInstanceLock()) app.exit(0);

/** @type {import('../src/server/index.ts').Running | null} */
let running = null;
/** @type {BrowserWindow | null} */
let window = null;

/**
 * A port nobody else is on.
 *
 * The clone's default is 5175 and it is a good default there: you type it into
 * a browser. Nothing types this one — the window opens itself — so a fixed
 * number buys nothing and costs the one collision that actually happens, which
 * is somebody running this application while a clone of the repository is
 * already serving on 5175. Asking the operating system for a free port removes
 * the question. `HERS_PORT` still wins, for anyone who wants a known address to
 * point a browser or a bookmark at.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/**
 * Media, allowed for her page and nothing else.
 *
 * Her three senses are `getUserMedia` and `getDisplayMedia`, and in a browser
 * the browser asks. There is no browser here, so this is the thing that asks —
 * and the honest version of "ask" for a window that only ever shows one origin
 * is to allow that origin and refuse every other. The user's real consent is
 * upstream of this in two places that both still apply: the buttons beside the
 * message box, which are off until pressed, and the operating system's own
 * microphone, camera and screen-recording prompts, which this cannot answer.
 */
function allowMediaFor(origin) {
  const permitted = new Set(['media', 'clipboard-sanitized-write']);
  const mine = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permitted.has(permission) && mine(contents.getURL()));
  });

  session.defaultSession.setPermissionCheckHandler((contents, permission, requesting) =>
    permitted.has(permission) && (mine(requesting) || (contents ? mine(contents.getURL()) : false)),
  );

  /*
   * Screen sharing.
   *
   * `useSystemPicker` hands the choice to macOS's own screen-share picker,
   * which is the right answer where it exists: it is the dialog the user
   * already knows and it is the only one that can offer a single window
   * without this process having enumerated their windows first. Where it does
   * not exist, the handler below runs, and it asks rather than assuming — a
   * screen share that silently picks display one is not a screen share
   * somebody agreed to.
   */
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      void (async () => {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources.length === 0) return callback({});
        if (sources.length === 1) return callback({ video: sources[0] });

        const { response } = await dialog.showMessageBox({
          type: 'question',
          message: 'Which screen should she see?',
          buttons: [...sources.map((each) => each.name), 'Cancel'],
          cancelId: sources.length,
          defaultId: 0,
        });
        callback(response < sources.length ? { video: sources[response] } : {});
      })();
    },
    { useSystemPicker: true },
  );
}

/** The window. One, and it only ever shows her. */
function openWindow(url) {
  window = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    // Her page is a light one. Without this the first frame is Electron's
    // white, or on a dark system its black, and it flashes.
    backgroundColor: '#fbfaf8',
    title: APP_NAME,
    show: false,
    webPreferences: {
      // All defaults, spelled out because they are the security properties that
      // make this a browser rather than a hole. The page is loaded over HTTP
      // from a local server; it must not be able to reach Node.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  /*
   * The window is called Hers. It never shows a name.
   *
   * She chooses her own name in her first conversation, and until that has
   * happened `identity.name` holds `PLACEHOLDER_NAME` — the string `Anna`, what
   * this project was called before v1.0. A stranger who downloads `Hers.dmg`,
   * installs `Hers.app` and is greeted by a window called Anna has been handed a
   * name that is nobody's: not the product's, and not hers, because she has not
   * picked one yet.
   *
   * So the rule is the one the page follows: nothing displays a name until she
   * has one. The window title is the *application's* name, which is a different
   * thing and is always true. `preventDefault` is what pins it — measured: with
   * it the title is "Hers" against a page whose `<title>` says Anna, without it
   * the title is "Anna" — and `setTitle` re-asserts it rather than trusting that
   * one call to keep working across an Electron upgrade.
   *
   * If the title should ever follow her chosen name instead, this is the one
   * line to change, and the page's `<title>` is where that decision belongs.
   */
  window.on('page-title-updated', (event) => {
    event.preventDefault();
    window?.setTitle(APP_NAME);
  });

  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => (window = null));

  /*
   * Links leave. Two handlers because there are two ways out.
   *
   * Every outward link in her page — Google AI Studio for a key, BotFather for
   * a token, the `t.me` chat — is `target="_blank"`, which is the first
   * handler. The second is the one that matters if that ever changes: a
   * navigation away from her origin would replace her interface with a web page
   * and leave no way back, because this window has no address bar.
   */
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:$/.test(safeProtocol(target))) void shell.openExternal(target);
    return { action: 'deny' };
  });

  // Compared as an origin, not as a prefix. `startsWith` was the first version
  // and it is wrong in a way that is easy to miss: `http://127.0.0.1:58168`
  // is a prefix of `http://127.0.0.1:58168.example.com`, which is a different
  // host entirely and would have been treated as hers.
  const home = new URL(url).origin;

  window.webContents.on('will-navigate', (event, target) => {
    if (originOf(target) === home) return;
    event.preventDefault();
    if (/^https?:$/.test(safeProtocol(target))) void shell.openExternal(target);
  });

  void window.loadURL(url);
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function safeProtocol(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

app.on('second-instance', () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

/*
 * macOS keeps applications alive with no windows open and this one has a reason
 * to: she may be reachable on Telegram, and closing a window should not end a
 * conversation happening on a phone. Cmd-Q is how you stop her. Everywhere else
 * the last window closing is what quitting means.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!window && running) openWindow(running.url);
});

/*
 * Quitting waits for her memory to close.
 *
 * `stop()` closes the bridges, the conversation and the SQLite handle. Without
 * the wait, quitting kills the process mid-write and the answer to "did that
 * last thing I said get remembered" becomes "probably".
 */
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !running) return;
  quitting = true;
  event.preventDefault();
  const server = running;
  running = null;
  void (async () => {
    try {
      await server.stop();
    } catch {
      // Nothing useful to do about it, and it must not stop the quit.
    }
    app.quit();
  })();
});

/**
 * Everything, once the application is ready.
 *
 * ### Not `await app.whenReady()` at the top of the file
 *
 * That is the obvious way to write this and it hangs, silently, forever — no
 * window, no error, a dock icon that never stops bouncing. Electron emits
 * `ready` only after the main module has finished evaluating, and a top-level
 * `await` suspends exactly that. So the entry point waits on nothing, and this
 * runs from the callback. It cost half an hour to find and it is invisible in
 * the code that causes it, which is the only reason this paragraph is here.
 */
async function start() {
  try {
    // Set before the server reads its configuration, and only when nobody has
    // already chosen. Both spellings are checked, because `config.ts` reads both.
    if (!process.env.HERS_PORT?.trim() && !process.env.ANNA_PORT?.trim()) {
      process.env.HERS_PORT = String(await freePort());
    }

    const { main } = await import('../src/server/index.ts');
    running = await main();

    allowMediaFor(new URL(running.url).origin);
    openWindow(running.url);
  } catch (error) {
    fail(error);
  }
}

/**
 * Says why, in both places, and stops.
 *
 * `app.focus` before the dialog is not decoration. An application that has not
 * opened a window yet is not the active one, and a modal alert put up by an
 * inactive application does not come to the front — it waits behind whatever
 * the user is looking at, which is indistinguishable from nothing happening.
 * That is how the packaging bug this file logs about stayed invisible.
 */
function fail(error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  app.focus({ steal: true });
  dialog.showErrorBox(
    'Hers could not start',
    `${error instanceof Error ? error.message : String(error)}\n\n` +
      `There is more in ${logFile}`,
  );
  app.exit(1);
}

app.whenReady().then(start, fail);
