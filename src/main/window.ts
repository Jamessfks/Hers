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

/**
 * Anna's panel.
 *
 * A defined medium-sized stage in the corner rather than a full-height
 * transparent strip. The bounded form is the point: a frame around her reads as
 * a device sitting on the desk — the Proto hologram box — where an unbounded
 * figure over the whole screen reads as an overlay that is in the way.
 *
 * It also removes a whole class of problem. The full-height version had to
 * swallow the mouse only where she happened to be drawn, hit-tested by
 * guessing at her silhouette on every pointer move. A panel is simply a panel:
 * clicks inside belong to her, clicks outside do not.
 */
const WIDTH = 360;
const HEIGHT = 560;
/** Gap from the screen edges, so she is not jammed into the corner. */
const MARGIN = 28;

export interface AnnaWindow {
  window: BrowserWindow;
  /** Let clicks through everywhere except the given rectangles. */
  setInteractiveRegion(hit: boolean): void;
}

export function createAnnaWindow(): AnnaWindow {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;

  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + workArea.height - HEIGHT - MARGIN,
    minWidth: 260,
    minHeight: 400,
    // Transparent so the panel can have genuinely rounded corners; the frame
    // itself is drawn in CSS.
    transparent: true,
    frame: false,
    hasShadow: false,
    // Movable and resizable: it is her space on the desk, not a fixed fixture.
    resizable: true,
    movable: true,
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

  /*
   * Excluded from screen capture by default: a companion who turns up in a
   * shared screen during a work call is a betrayal, not a feature. Set
   * ANNA_ALLOW_CAPTURE=1 when you actually want her in a recording or a demo.
   *
   * Worth knowing before you debug the wrong thing: this makes her invisible to
   * `screencapture` and to any screen-recording tool, while remaining perfectly
   * visible on the display. A screenshot of an apparently empty panel is the
   * expected result, not a rendering failure — that misdiagnosis has cost real
   * time twice.
   */
  window.setContentProtection(process.env['ANNA_ALLOW_CAPTURE'] !== '1');

  window.once('ready-to-show', () => window.showInactive());

  // Anything Anna links to opens in the real browser, never inside her window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return {
    window,
    /**
     * Retained for the IPC contract, but a bounded panel is always interactive.
     * The old behaviour — swallowing the mouse only over her silhouette — was a
     * consequence of covering half the screen, and that is no longer true.
     */
    setInteractiveRegion() {
      // Intentionally empty. See the note on WIDTH.
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
