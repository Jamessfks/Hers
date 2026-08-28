import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { WRITERS, WRITE_CALL_PATTERN } from './writers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The modules that touch the filesystem, found the same way a reader would.
 *
 * `grep` rather than a hand-rolled walk, because the point is that anyone can
 * run the identical command from `docs/PRIVACY.md` and get the identical
 * answer. A test that used its own private matching would prove something
 * nobody else can reproduce.
 */
function modulesThatWrite(): string[] {
  const output = execFileSync(
    'grep',
    [
      '-rlE',
      WRITE_CALL_PATTERN,
      '--include=*.ts',
      '--exclude=*.test.ts',
      // `writers.ts` states the pattern, so it contains the pattern, so it
      // matches itself. A rule cannot be its own subject. The test below keeps
      // this carve-out from turning into a hiding place.
      '--exclude=writers.ts',
      'src/',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return output
    .split('\n')
    .filter(Boolean)
    .map((file) => file.replace(/^src\//, ''))
    .sort();
}

test('the one file exempt from the scan cannot itself write', () => {
  // `writers.ts` is excluded above because it quotes the pattern. That is only
  // safe while it stays a list of facts with no filesystem access of its own.
  const source = readFileSync(path.join(root, 'src', 'shared', 'writers.ts'), 'utf8');
  assert.doesNotMatch(source, /^\s*import .* from 'node:(fs|sqlite)/m);
  assert.doesNotMatch(source, /^\s*import .* from 'node:fs\/promises'/m);
});

test('every module that writes to disk is listed', () => {
  const listed = new Set(WRITERS.map((writer) => writer.module));
  for (const module of modulesThatWrite()) {
    assert.ok(
      listed.has(module),
      `src/${module} writes to disk and is not in WRITERS. Add it there, and name what ` +
        'it writes in docs/PRIVACY.md — otherwise the file list the doctor prints is ' +
        'a claim with nothing holding it to the code.',
    );
  }
});

test('no module is listed that has stopped writing', () => {
  // The other direction, and the one that rots quietly: a module refactored to
  // write nothing leaves an entry describing a file that no longer appears.
  const scanned = new Set(modulesThatWrite());
  for (const { module } of WRITERS) {
    assert.ok(scanned.has(module), `WRITERS lists src/${module}, which no longer writes anything`);
  }
});

test('every path that can appear on disk is named in docs/PRIVACY.md', () => {
  const privacy = readFileSync(path.join(root, 'docs', 'PRIVACY.md'), 'utf8');
  for (const writer of WRITERS) {
    for (const wrote of writer.writes) {
      assert.ok(privacy.includes(wrote), `docs/PRIVACY.md never mentions ${wrote}`);
    }
  }
});

test('docs/PRIVACY.md quotes the exact pattern this test scans with', () => {
  // So the command a reader runs and the command that guards the list are one
  // string, not two that agree today.
  const privacy = readFileSync(path.join(root, 'docs', 'PRIVACY.md'), 'utf8');
  assert.ok(
    privacy.includes(WRITE_CALL_PATTERN),
    'docs/PRIVACY.md should contain WRITE_CALL_PATTERN verbatim, inside the grep it tells the reader to run',
  );
});

test('each writer says what it writes and when', () => {
  for (const writer of WRITERS) {
    assert.match(writer.what, /\S.*\.$/s, writer.module);
    assert.match(writer.when, /\S.*\.$/s, writer.module);
  }
});

test('docs/PRIVACY.md says which version it covers, and it is this one', () => {
  // A privacy document with no date is a document nobody can tell is stale.
  const version = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as { version: string };
  const privacy = readFileSync(path.join(root, 'docs', 'PRIVACY.md'), 'utf8');
  assert.ok(
    privacy.includes(`v${version.version}`),
    `docs/PRIVACY.md should say it covers v${version.version}`,
  );
});

test('the profile files the code ships are the profile files the list claims', () => {
  // `defaults.ts` is the actual source of what lands in the profile folder on a
  // first run. Reading it here means a seventh character file cannot be added
  // without this list and the document noticing.
  const defaults = readFileSync(path.join(root, 'src', 'core', 'profile', 'defaults.ts'), 'utf8');
  const shipped = [...defaults.matchAll(/^ {2}'([A-Za-z.]+\.md)':/gm)].map(([, name]) => name ?? '');
  const profile = WRITERS.find((writer) => writer.module === 'core/profile/profile.ts');
  assert.ok(shipped.length > 0, 'found no profile files in defaults.ts — has its shape changed?');
  for (const name of shipped) {
    assert.ok(profile?.writes.includes(name), `defaults.ts ships ${name} and WRITERS omits it`);
  }
});

test('nothing under src/ writes outside the three roots', () => {
  // A sanity check on the shape of the list rather than on the code: every
  // entry has to hang off the profile folder, the data folder, or the working
  // directory, because those are the only three the document tells you to look
  // in.
  for (const writer of WRITERS) {
    assert.ok(['profile', 'data', 'cwd'].includes(writer.root), writer.module);
  }
  // And the only thing outside the two directories Start over deletes is `.env`.
  const outside = WRITERS.filter((writer) => writer.root === 'cwd').flatMap((w) => w.writes);
  assert.deepEqual(outside, ['.env']);
});

/** Guards the assumption that `src/` is where all of this lives. */
test('the scan covers every source directory', () => {
  const dirs = readdirSync(path.join(root, 'src'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(dirs, ['bridges', 'core', 'server', 'shared', 'web']);
});
