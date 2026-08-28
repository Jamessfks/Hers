import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { setFrontmatterValue } from '../../shared/frontmatter.ts';
import { applyWizard } from '../../shared/wizard.ts';
import { isFirstRun } from './first-run.ts';
import { DEFAULT_PROFILE_FILES } from './defaults.ts';
import {
  ensureProfile,
  loadProfile,
  loadVolatility,
  readProfileFiles,
  saveProfileFiles,
} from './profile.ts';
import { PROFILE_FILES } from './types.ts';

const scratch = () => mkdtemp(path.join(tmpdir(), 'hers-first-run-'));

/** The six files as they ship, keyed the way `readProfileFiles` keys them. */
function shipped(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of PROFILE_FILES) files[name] = DEFAULT_PROFILE_FILES[`${name}.md`] ?? '';
  return files;
}

// ---------------------------------------------------------------------------
// What counts as fresh
// ---------------------------------------------------------------------------

test('the folder as it ships, beside an empty memory, is a first run', () => {
  assert.equal(isFirstRun({ files: shipped(), hasHistory: false }), true);
});

test('anything at all in memory means they have met', () => {
  // A turn, a fact or a summary — `hasHistory` is the one that asks the whole
  // store rather than the session about to start.
  assert.equal(isFirstRun({ files: shipped(), hasHistory: true }), false);
});

test('once she has named herself there is no first run left to have', () => {
  const files = shipped();
  files.identity = setFrontmatterValue(
    setFrontmatterValue(files.identity ?? '', 'name', 'Mei'),
    'named',
    'self',
  );
  assert.equal(isFirstRun({ files, hasHistory: false }), false);
});

test('a name typed in by hand counts too, marker or no marker', () => {
  // `ensureNamed` reads both conditions and leaves a hand-picked name alone.
  // This has to agree with it, or somebody who named her in a text editor gets
  // offered a wizard that would tell her she has no name.
  const files = shipped();
  files.identity = setFrontmatterValue(files.identity ?? '', 'name', 'Mei');
  assert.equal(isFirstRun({ files, hasHistory: false }), false);
});

test('the placeholder is the placeholder however it was typed', () => {
  const files = shipped();
  files.identity = setFrontmatterValue(files.identity ?? '', 'name', 'anna');
  assert.equal(isFirstRun({ files, hasHistory: false }), true);
});

test('a half-written identity file is still a first run', () => {
  // The folder is explicitly allowed to be missing things; `loadProfile` falls
  // back to the placeholder, and so does this.
  assert.equal(isFirstRun({ files: { ...shipped(), identity: 'Just prose.' }, hasHistory: false }), true);
});

test('the wizard having run is enough on its own', () => {
  const files = shipped();
  files.relationship = setFrontmatterValue(files.relationship ?? '', 'met', '2026-08-27');
  assert.equal(isFirstRun({ files, hasHistory: false }), false);
});

// ---------------------------------------------------------------------------
// The two halves, against each other
// ---------------------------------------------------------------------------

test('skipping every step still ends the first run for good', () => {
  // The case neither of the other two signals catches: somebody opens the page,
  // answers nothing, and never speaks to her. Without this the wizard would be
  // waiting again on the next reload, forever.
  const files = shipped();
  const after = { ...files, ...applyWizard(files, {}, '2026-08-27') };

  assert.equal(isFirstRun({ files: after, hasHistory: false }), false);
});

test('answering every step ends it too', () => {
  const files = shipped();
  const after = {
    ...files,
    ...applyWizard(
      files,
      {
        traits: ['teases'],
        age: '31',
        from: 'Lisbon',
        temperament: 'level',
        wants: ['noticing'],
        aboutThem: 'I work nights.',
        refusals: ['romance'],
      },
      '2026-08-27',
    ),
  };

  assert.equal(isFirstRun({ files: after, hasHistory: false }), false);
  // And it did not name her on the way past. That is still hers to do.
  assert.equal(after.identity?.includes('name: Anna'), true);
  assert.equal(after.identity?.includes('named:'), false);
});

// ---------------------------------------------------------------------------
// On disk
// ---------------------------------------------------------------------------

test('a skipped wizard leaves a profile that loads exactly as it shipped', async () => {
  const untouched = await scratch();
  const skipped = await scratch();
  try {
    const before = await ensureProfile(untouched);
    await ensureProfile(skipped);

    const files = await readProfileFiles(skipped);
    const written = await saveProfileFiles(skipped, applyWizard(files, {}, '2026-08-27'));
    assert.deepEqual(written, ['relationship']);

    const after = await loadProfile(skipped);
    assert.deepEqual({ ...after, dir: '' }, { ...before, dir: '' });
  } finally {
    await rm(untouched, { recursive: true, force: true });
    await rm(skipped, { recursive: true, force: true });
  }
});

test('an answered wizard reaches the loaded profile, and only where it should', async () => {
  const dir = await scratch();
  try {
    await ensureProfile(dir);
    const files = await readProfileFiles(dir);
    await saveProfileFiles(
      dir,
      applyWizard(
        files,
        { age: '31', from: 'Lisbon', voice: 'Kore', temperament: 'weather', traits: ['gentle'] },
        '2026-08-27',
      ),
    );

    const profile = await loadProfile(dir);
    assert.equal(profile.identity.age, '31');
    assert.equal(profile.identity.from, 'Lisbon');
    assert.equal(profile.voice.voice, 'Kore');
    assert.equal(profile.moodBaseline.energy, 0.25);
    // Read separately, because the mood engine owns it — and it is the one
    // number of the five that does not live on the vector.
    assert.equal(await loadVolatility(dir), 0.9);
    assert.ok(profile.prose.personality?.includes('Bluntness is not a shortcut'));

    // Untouched: the name is hers to choose, and the pronouns were not asked about.
    assert.equal(profile.identity.name, 'Anna');
    assert.equal(profile.identity.named, undefined);
    assert.equal(profile.identity.pronouns, 'she/her');
    // Every file still parses into something complete.
    for (const name of PROFILE_FILES) assert.ok(profile.prose[name]?.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
