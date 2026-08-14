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

/** Ids of controls a user can actually click or type into. */
function interactiveIds(markup: string): string[] {
  const ids: string[] = [];
  const pattern = /<(button|input|select|textarea)\b[^>]*\bid="([^"]+)"/g;
  for (const match of markup.matchAll(pattern)) ids.push(match[2]!);
  return ids;
}

test('the panel has the controls we think it has', () => {
  const ids = interactiveIds(html);
  assert.ok(ids.includes('settings'), 'the settings gear');
  assert.ok(ids.includes('dismiss'), 'the dismiss button');
  assert.ok(ids.includes('say'), 'the text input');
});

test('every interactive control is wired up in main.ts', () => {
  for (const id of interactiveIds(html)) {
    assert.ok(
      main.includes(`#${id}`),
      `#${id} exists in index.html but is never referenced in main.ts — it will render and do nothing`,
    );
  }
});
