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
/*
 * A phone's proportions, on purpose.
 *
 * 406x880 is 0.461 — the aspect of the conversation this layout is copied from,
 * to within a pixel. It is not an arbitrary desktop panel size: the whole visual
 * grammar of an instant-messaging thread (the bubble column, the avatar gutter
 * behind it, the floating composer with air under it) is calibrated to a tall
 * narrow window, and it comes apart in a wide one. Bubbles at 900px wide are a
 * document, not a conversation.
 *
 * The old 420x680 was sized so her *face* was readable inside a bezel. She is
 * the full background now, so height buys thread instead of pixels-per-face.
 */
const WIDTH = 406;
const HEIGHT = 880;
/** Gap from the screen edges, so she is not jammed into the corner. */
const MARGIN = 28;

export interface AnnaWindow {
  window: BrowserWindow;
  /** Let clicks through everywhere except the given rectangles. */
  setInteractiveRegion(hit: boolean): void;
  /**
   * Resize the panel to a height the renderer measured.
   *
   * The panel's height is not a design constant any more — it follows the
   * photograph. A square portrait in a fixed 420x680 frame is 40% black bars,
   * which reads as a video that failed to load rather than as a considered
   * frame, and cropping to fill instead would cut the top of her head off.
   *
   * The bottom-right corner is held fixed while the height changes, so the panel
   * grows upward from where the user parked it rather than walking down the
   * screen every time a photograph is swapped.
   */
  fitHeight(height: number): void;
}

export function createAnnaWindow(): AnnaWindow {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;

  /*
   * 880 is taller than the work area on a 13" laptop, and a window that opens
   * with its composer below the dock is a window with no way to type in it. The
   * aspect is the intent, not the pixel count, so the width follows the height
   * down and the shape survives the clamp.
   */
  const height = Math.min(HEIGHT, workArea.height - MARGIN * 2);
  const width = Math.round((height * WIDTH) / HEIGHT);

  const window = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - MARGIN,
    y: workArea.y + workArea.height - height - MARGIN,
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

    fitHeight(height: number) {
      if (window.isDestroyed()) return;
      // Clamped hard. This number is computed in the renderer from CSS and an
      // image's dimensions, and a renderer bug here would otherwise be a window
      // taller than the display or one pixel high.
      const wanted = Math.round(height);
      if (!Number.isFinite(wanted)) return;
      const target = Math.max(320, Math.min(workArea.height - MARGIN * 2, wanted));

      const bounds = window.getBounds();
      if (Math.abs(bounds.height - target) < 2) return;

      // Hold the bottom edge: the panel grows upward out of the corner it sits
      // in, rather than pushing its own bottom off the screen.
      const bottom = bounds.y + bounds.height;
      window.setBounds({
        x: bounds.x,
        y: Math.max(workArea.y, bottom - target),
        width: bounds.width,
        height: target,
      });
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
