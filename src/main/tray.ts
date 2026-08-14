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

import { Menu, Tray, app, nativeImage, type BrowserWindow } from 'electron';
import { join } from 'node:path';

import type { AnnaConfig } from '../shared/protocol.ts';

export interface TrayDeps {
  window: BrowserWindow;
  config: () => AnnaConfig;
  setConfig: (patch: Record<string, unknown>) => void;
  openSettings: () => void;
  /** True when a language key and a voice key are both present. */
  isConfigured: () => boolean;
}

/** A Tray that can be asked to redraw its menu after config changes. */
export type AnnaTray = Tray & { refresh(): void };

export function createTray(deps: TrayDeps): AnnaTray {
  const icon = nativeImage.createFromPath(
    join(app.getAppPath(), 'resources', 'trayTemplate.png'),
  );
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
          click: () => {
            if (deps.window.isVisible()) deps.window.hide();
            else deps.window.showInactive();
            render();
          },
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
