/**
 * The menu bar item.
 *
 * Anna has a frameless, click-through window and no dock presence worth
 * speaking of, which leaves a real problem: once she is running there is no
 * obvious way to reach settings, and no obvious way to make her stop. A menu
 * bar item is the conventional answer for an always-on app, and conventional is
 * exactly right here — this is the one part of the product that should be
 * boring and findable.
 *
 * The icon is a template image (black plus alpha, `Template` suffix), so macOS
 * recolours it for light and dark menu bars and inverts it when the menu is
 * open. Shipping a coloured icon is the classic tell of a port.
 */

import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron';

import type { AnnaConfig } from '../shared/protocol.ts';

/**
 * The icon, inlined rather than loaded from disk.
 *
 * `nativeImage.createFromPath(join(app.getAppPath(), …))` works in development
 * and silently produces an empty image inside a packaged `.asar` — which does
 * not throw, does not log, and leaves you with a Tray object that exists and
 * shows nothing. It is 1.1kB of base64; the packaging problem is not worth
 * having.
 */
const ICON_1X =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA8ElEQVR4nI3SMU7EQAwF0JcFCkBE' +
  'oqBENEtFQ80NOAAVJTUlV6HjGltQcYaVqKn2AEhIC0JkKPBI2ckky5es2N/2j8cz1NH8kxstTLjA' +
  'XXBPeO3lRjGLojneoziFP4/crGwo44RbtFiHtcGlsmd3ZJJVfPcq3CSasH0sekdY4KCX3yqScR6W' +
  'UR55oJa3fIJ7HEf8hUe8hUg3NX6LZW/8bCucqtxERl7oTTR84jtsHdxDUVu9haMYcafIJxyWxbVR' +
  'OuObHrzCmkAKgZ8Q68LP3CjyMz7Dh+ESEy4nfryRuMKzv9tY4gXX25ozmsIv4w38AkYJOTKNMGt8' +
  'AAAAAElFTkSuQmCC';

const ICON_2X =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAB30lEQVR4nNWWvUoDQRDHf5ekESxS' +
  'aGGnqSxi5wtoo6WltZ1FXsQXyDMICmkUImKTNqUSEAtLbQTTCImXs7gZsrnc3e6eG8E/DMftfO7s' +
  'zO5EVEckBJAI/RnqjmtWRHaRXJ1EHG7L2isQG7yVwEx5BxgBE6GRrGXlgqIm3y7zM89SNyMbDHq+' +
  'J+JoQprymVAsa4nImDpBA+iLsynLu58Kr+8TQMNBJhLDAC2K01sTasm/U1G6npUW1Zg05XlGE+GN' +
  'MzqlcAlAWw6gJzpxjlwsvJ781wsCrQRtrSbwzPzMTUqE12RFrajZ2gEGLBfhQHimrBW+UWpRRcAR' +
  'sC/rQ+COtAZWehu6tJZX//tkoEa6wwbQBjZYfA0/gUfgy5ANBt3VKfBE8VX8ApwbAQcpRHXeMRzp' +
  '9WvSzOBfGEH8CmqgLQ6+hYoyYL4JB5kNlDqw8c9YnAPK5FWuUyLnHIAW0h7z9nOxGQG78q9vQqUA' +
  'skZ94GQ7+ODgi38TQJWr1UnHpwZ8EaQGlP9O8SCShV5Ub4aNQj1bAKp4aTNkQAeTa0cfVmgL3pI/' +
  'iOQNJkNgjUDvgU4368AVxdew0j2wZQRvNe4ahKb/EDgGNjMyH8ADcJOjEwQ+c55z2qucT71ETzvA' +
  'eec/iIua10e9zBUAAAAASUVORK5CYII=';

export interface TrayDeps {
  window: BrowserWindow;
  /**
   * Show or hide her. Goes through main rather than calling `window.hide()`
   * here, because hiding also stops her mid-sentence and suppresses her
   * speaking first — behaviour that must not differ between the menu bar and
   * the button on her window.
   */
  setVisible: (visible: boolean) => void;
  config: () => AnnaConfig;
  setConfig: (patch: Record<string, unknown>) => void;
  openSettings: () => void;
  /** True when a language key and a voice key are both present. */
  isConfigured: () => boolean;
}

/** A Tray that can be asked to redraw its menu after config changes. */
export type AnnaTray = Tray & { refresh(): void };

export function createTray(deps: TrayDeps): AnnaTray {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_1X}`);
  icon.addRepresentation({
    scaleFactor: 2,
    dataURL: `data:image/png;base64,${ICON_2X}`,
  });
  // Template images are black plus alpha; macOS recolours them for light and
  // dark menu bars and inverts them while the menu is open. A coloured icon
  // here is the classic tell of a port.
  icon.setTemplateImage(true);

  const tray = new Tray(icon);
  tray.setToolTip('Anna');

  const render = (): void => {
    const settings = deps.config();
    const configured = deps.isConfigured();

    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: configured ? 'Anna is here' : 'Anna needs a key to speak',
          enabled: false,
        },
        { type: 'separator' },
        {
          label: deps.window.isVisible() ? 'Hide her' : 'Show her',
          accelerator: 'Alt+Command+A',
          click: () => deps.setVisible(!deps.window.isVisible()),
        },
        {
          label: 'Let her speak first',
          type: 'checkbox',
          checked: settings.presence.proactive,
          click: (item) => {
            deps.setConfig({ presence: { proactive: item.checked } });
            render();
          },
        },
        {
          label: 'Camera',
          type: 'checkbox',
          checked: settings.senses.camera,
          click: (item) => {
            deps.setConfig({ senses: { camera: item.checked } });
            render();
          },
        },
        {
          label: 'Microphone',
          type: 'checkbox',
          checked: settings.senses.microphone,
          click: (item) => {
            deps.setConfig({ senses: { microphone: item.checked } });
            render();
          },
        },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => deps.openSettings() },
        { type: 'separator' },
        { label: 'Quit Anna', accelerator: 'Command+Q', role: 'quit' },
      ]),
    );
  };

  render();
  deps.window.on('show', render);
  deps.window.on('hide', render);

  return Object.assign(tray, { refresh: render });
}
