/**
 * The window Anna lives in.
 *
 * The goal is a hologram standing at the edge of the desk, not an app. That
 * means a transparent, frameless, always-on-top window that the user's clicks
 * pass straight through everywhere except where Anna actually is — otherwise a
 * full-height transparent pane sits over half the screen swallowing every click
 * meant for the editor underneath.
 *
 * macOS specifics that are easy to get wrong:
 *
 *  - `transparent: true` must be set at construction; it cannot be toggled.
 *  - `setVisibleOnAllWorkspaces` with `visibleOnFullScreen` keeps her present
 *    when the user goes full screen, which is exactly when they are deepest in
 *    something and most worth talking to.
 *  - `screen-saver` level, not `floating`: `floating` loses to full-screen
 *    video and to other floating windows.
 *  - The window is excluded from screen capture, because a companion appearing
 *    in a shared screen during a work call is a betrayal, not a feature.
 */

import { BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';

/** Anna's canvas: tall and narrow, sized for a standing full-body figure. */
const WIDTH = 420;
const HEIGHT_RATIO = 0.92;

export interface AnnaWindow {
  window: BrowserWindow;
  /** Let clicks through everywhere except the given rectangles. */
  setInteractiveRegion(hit: boolean): void;
}

export function createAnnaWindow(): AnnaWindow {
  const display = screen.getPrimaryDisplay();
  const height = Math.round(display.workAreaSize.height * HEIGHT_RATIO);

  const window = new BrowserWindow({
    width: WIDTH,
    height,
    x: display.workArea.x + display.workAreaSize.width - WIDTH - 24,
    y: display.workArea.y + display.workAreaSize.height - height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    // Do not steal focus when she appears; she is not asking for the floor.
    focusable: true,
    show: false,
    webPreferences: {
      // electron-vite emits an ESM preload as `.mjs` because this package is
      // `type: module`. Sandbox is off, which is what makes an ESM preload legal.
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Excluded from screen capture by default: a companion who turns up in a
  // shared screen during a work call is a betrayal, not a feature. Set
  // ANNA_ALLOW_CAPTURE=1 when you actually want her in a recording or a demo.
  window.setContentProtection(process.env['ANNA_ALLOW_CAPTURE'] !== '1');

  // Default to click-through. The renderer turns this off while the pointer is
  // over Anna herself or over the input bar.
  window.setIgnoreMouseEvents(true, { forward: true });

  window.once('ready-to-show', () => window.showInactive());

  // Anything Anna links to opens in the real browser, never inside her window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return {
    window,
    setInteractiveRegion(hit: boolean) {
      window.setIgnoreMouseEvents(!hit, { forward: true });
    },
  };
}

/**
 * A normal, focusable window for onboarding and settings.
 *
 * Deliberately not a child of Anna's window. A child window inherits
 * always-on-top, and a settings panel that floats above every other app while
 * you go and fetch an API key from a browser is genuinely infuriating.
 */
export function createSettingsWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 780,
    height: 700,
    minWidth: 620,
    minHeight: 520,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#131318',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void window.loadURL(`${devUrl}/settings.html`);
  else void window.loadFile(join(__dirname, '../renderer/settings.html'));

  return window;
}
