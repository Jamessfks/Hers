/**
 * Fetches the default character.
 *
 * Anna needs a body out of the box. Every good VRM belongs to somebody, so the
 * choice here was made on licence first and looks second: VRoid Studio's own
 * sample avatars are released CC0 by pixiv — copyright waived, no attribution
 * required, no conditions at all. That is the only category of model that can
 * be shipped inside an application without asking anything of the user or of
 * the author.
 *
 * The file is fetched at build time rather than committed, for two reasons:
 * a 15MB binary in git history is a permanent tax on every clone, and pinning
 * the URL plus a SHA-256 gives a stronger integrity guarantee than a blob
 * somebody could quietly replace in a later commit.
 *
 * If the download fails, the build still succeeds and Anna falls back to the
 * stand-in figure. A missing character is a worse first run, not a broken one.
 *
 * Usage: node scripts/fetch-character.mjs
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'resources', 'characters', 'anna-default.vrm');

const CHARACTER = {
  name: 'AvatarSample_B',
  author: 'pixiv / VRoid Studio',
  licence: 'CC0 1.0 Universal (public domain dedication)',
  licenceUrl: 'https://vroid.pixiv.help/hc/en-us/articles/4402614652569',
  url: 'https://raw.githubusercontent.com/madjin/vrm-samples/master/vroid/stable/AvatarSample_B.vrm',
  sha256: '4a271bd3b5a3d19e054fd113ee154635b72e7141f4a8ccbcdba3c7f9cea6ee8d',
  bytes: 15_728_640,
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function alreadyGood() {
  try {
    return sha256(await readFile(TARGET)) === CHARACTER.sha256;
  } catch {
    return false;
  }
}

async function main() {
  if (await alreadyGood()) {
    console.log(`[character] ${CHARACTER.name} already present and verified`);
    return;
  }

  console.log(`[character] fetching ${CHARACTER.name} (${CHARACTER.licence})`);
  const response = await fetch(CHARACTER.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${CHARACTER.url}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== CHARACTER.sha256) {
    // Refuse rather than ship something unverified. This file is parsed by a
    // large glTF stack in the least trusted process in the app.
    throw new Error(
      `checksum mismatch\n  expected ${CHARACTER.sha256}\n  got      ${digest}\n` +
        'The upstream file changed. Verify it by hand before updating the pin.',
    );
  }

  await mkdir(dirname(TARGET), { recursive: true });
  await writeFile(TARGET, bytes);
  console.log(
    `[character] wrote ${(bytes.length / 1e6).toFixed(1)}MB to resources/characters/anna-default.vrm`,
  );
}

main().catch((error) => {
  // Non-fatal on purpose: see the note at the top of this file.
  console.warn(`[character] skipped — ${error.message}`);
  console.warn('[character] Anna will use the stand-in figure until a .vrm is added.');
  process.exit(0);
});
