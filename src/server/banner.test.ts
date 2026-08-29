import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { VERSION, startupBanner } from './index.ts';
import { loadConfig } from './config.ts';

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

/**
 * What `npm start` prints once it is up.
 *
 * These exist for one sentence in `docs/PRIVACY.md`: that the doctor and the
 * startup banner both name the three paths this program writes to, resolved to
 * absolute. That sentence was false when it was first written — the banner
 * named the profile folder and the database and never mentioned `.env`, which
 * is the one somebody actually goes hunting for. Rather than soften the
 * sentence, the banner was fixed; this is what stops it regressing.
 */
test('the banner names all three paths, resolved to absolute', () => {
  const config = loadConfig(
    env({ HERS_PROFILE: 'somewhere/profile', HERS_DATA: 'somewhere/data' }),
  );
  const lines = startupBanner(config, '/tmp/hers-test/.env');

  const profile = lines.find((line) => line.includes('profile '));
  const memory = lines.find((line) => line.includes('memory '));
  const keys = lines.find((line) => line.includes('keys '));

  assert.ok(profile?.includes(path.resolve('somewhere/profile')), profile);
  assert.ok(memory?.includes(path.resolve('somewhere/data', 'memory.db')), memory);
  assert.ok(keys?.includes('/tmp/hers-test/.env'), keys);

  for (const line of [profile, memory, keys]) {
    const value = line?.trim().split(/\s{2,}/)[1] ?? '';
    assert.ok(path.isAbsolute(value.replace(' (not written yet)', '')), `not absolute: ${line}`);
  }
});

test('a keys file that does not exist yet says so rather than pointing at nothing', () => {
  // The common case on a first run, and the difference between "look here" and
  // "you have not made one yet" is the whole value of printing it.
  const lines = startupBanner(loadConfig(env({})), '/tmp/hers-test/definitely-absent/.env');
  assert.match(lines.join('\n'), /keys {6}\S+\.env \(not written yet\)/);
});

test('the banner reports the bridges and the model', () => {
  const off = startupBanner(loadConfig(env({})), '/tmp/.env').join('\n');
  assert.match(off, /telegram {2}off/);

  const on = startupBanner(
    loadConfig(env({ TELEGRAM_BOT_TOKEN: '1:x' })),
    '/tmp/.env',
  ).join('\n');
  assert.match(on, /telegram {2}on/);
});

test('VERSION agrees with package.json', async () => {
  /*
   * Nothing bound these together, and they drifted: `VERSION` and the artifact
   * name both said 1.3.0 for a build carrying a wizard and a desktop
   * application that 1.3.0 never had. The startup banner reports it, the status
   * endpoint reports it, the privacy page states which version it covers, and
   * the DMG is named after it — four places telling somebody the wrong thing.
   */
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    version: string;
  };

  assert.equal(VERSION, manifest.version);
});
