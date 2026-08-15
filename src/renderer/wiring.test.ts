/**
 * Every interactive control in the panel must be referenced by the code.
 *
 * This exists because of a bug that shipped: the settings gear and the dismiss
 * button had their click handlers deleted along with an unrelated block, and
 * nothing caught it. The buttons still rendered, still highlighted on hover,
 * and did nothing whatsoever when clicked — there is no type error, no runtime
 * error, and no test in a suite that never opens a DOM.
 *
 * It is a crude check: it proves the id is mentioned, not that the handler is
 * correct. That is enough, because the failure mode here is deletion, and a
 * deleted handler takes its id reference with it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const here = new URL('.', import.meta.url).pathname;
const html = readFileSync(join(here, 'index.html'), 'utf8');
const main = readFileSync(join(here, 'main.ts'), 'utf8');
const settingsHtml = readFileSync(join(here, 'settings.html'), 'utf8');
const settings = readFileSync(join(here, 'settings.ts'), 'utf8');

/**
 * Controls the settings window drives through an attribute rather than an id.
 *
 * The key groups are deliberately generic — one function wires all four from
 * `[data-provider]`, `[data-key]` and friends — so their ids exist only for the
 * `<label for>` associations. Requiring `#video-key` to appear in settings.ts
 * would be asking for the duplication the data attributes exist to avoid.
 */
const WIRED_BY_ATTRIBUTE = /-(provider|key)$/;

/** Ids of controls a user can actually click or type into. */
function interactiveIds(markup: string): string[] {
  const ids: string[] = [];
  const pattern = /<(button|input|select|textarea)\b[^>]*\bid="([^"]+)"/g;
  for (const match of markup.matchAll(pattern)) ids.push(match[2]!);
  return ids;
}

test('the panel has the controls we think it has', () => {
  const ids = interactiveIds(html);
  assert.ok(ids.includes('who'), 'her name, which opens settings');
  assert.ok(ids.includes('settings'), 'the settings gear');
  assert.ok(ids.includes('plus'), 'the add button, which changes her photograph');
  assert.ok(ids.includes('voice'), 'the handset, which toggles the microphone');
  assert.ok(ids.includes('say'), 'the text input');
});

/*
 * `dismiss` is gone on purpose.
 *
 * The panel used to carry an ✕ that faded her out and hid the window. The bar
 * this layout copies has exactly two controls in it — a name and a gear — and a
 * third button would be the one thing on screen that is not in the reference.
 * Sending her away is still available in two places that were always the more
 * likely ones: the menu bar item and ⌥⌘A. If a dismiss control ever comes back
 * into the window, it belongs in this list.
 */

test('every interactive control is wired up in main.ts', () => {
  for (const id of interactiveIds(html)) {
    assert.ok(
      main.includes(`#${id}`),
      `#${id} exists in index.html but is never referenced in main.ts — it will render and do nothing`,
    );
  }
});

/**
 * The same check for the settings window, which is where the dead-button risk
 * actually lives now: it has thirty-odd controls to the panel's three, and the
 * newest of them spend money.
 */
test('every settings control is wired up in settings.ts', () => {
  for (const id of interactiveIds(settingsHtml)) {
    if (WIRED_BY_ATTRIBUTE.test(id)) continue;
    assert.ok(
      settings.includes(`#${id}`),
      `#${id} exists in settings.html but is never referenced in settings.ts — it will render and do nothing`,
    );
  }
});

test('the video provider group exists and follows the shared key-group contract', () => {
  // The whole reason `keyGroup` could be pointed at a fourth kind without being
  // rewritten. If this markup drifts, the group silently stops being wired.
  const group = /<div class="key-group" data-kind="video">([\s\S]*?)<\/div>\s*<\/section>/.exec(
    settingsHtml,
  );
  assert.ok(group, 'the video key group is missing from settings.html');
  for (const attribute of ['data-provider', 'data-key', 'data-save', 'data-reveal', 'data-forget', 'data-status', 'data-why']) {
    assert.ok(group[1]!.includes(attribute), `the video group is missing ${attribute}`);
  }
});
