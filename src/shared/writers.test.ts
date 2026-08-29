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
      // `.js` as well as `.ts`, and `electron/` as well as `src/`, because the
      // desktop entry point is plain JavaScript outside `src/` and it writes
      // `hers.log`. Scanning only `src/**/*.ts` meant the one module added in
      // the same round as this test was the one module it could not see, and
      // the whole suite stayed green while `docs/PRIVACY.md` failed to name a
      // file the program writes on every launch.
      '--include=*.js',
      '--exclude=*.test.ts',
      // `writers.ts` states the pattern, so it contains the pattern, so it
      // matches itself. A rule cannot be its own subject. The test below keeps
      // this carve-out from turning into a hiding place.
      '--exclude=writers.ts',
      'src/',
      'electron/',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return output
    .split('\n')
    .filter(Boolean)
    // `src/` is stripped so entries read `core/profile/profile.ts`; anything
    // outside it keeps its directory, so `electron/main.js` stays itself.
    .map((file) => (file.startsWith('src/') ? file.slice('src/'.length) : file))
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


/**
 * Whether a field is an explanation rather than a placeholder.
 *
 * The previous version of these assertions required a non-empty string ending
 * in a full stop, which `"x."` satisfies. That is a punctuation check wearing a
 * documentation check's clothes: the whole premise of these lists is that every
 * entry carries a reason a person can read, and a test that green-lights `"x."`
 * is not holding anyone to it.
 *
 * Eight words is not a quality bar and is not pretending to be one. It is the
 * floor below which a sentence cannot be doing the job — no real answer to
 * "what is sent here and when" fits in fewer.
 */
function explains(prose: string): boolean {
  const words = prose.trim().split(/\s+/).filter(Boolean);
  return words.length >= 8 && /\.$/.test(prose.trim());
}

test('each writer says what it writes and when', () => {
  for (const writer of WRITERS) {
    assert.ok(explains(writer.what), `${writer.module} what: "${writer.what}"`);
    assert.ok(explains(writer.when), `${writer.module} when: "${writer.when}"`);
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

test('nothing writes outside the roots the document names', () => {
  // A sanity check on the shape of the list rather than on the code: every
  // entry has to hang off the profile folder, the data folder, the working
  // directory, the application's own folder, or — since v2.0 gave her a `write`
  // tool — nowhere in particular, because those are the only ones the document
  // tells you to look in.
  for (const writer of WRITERS) {
    assert.ok(['profile', 'data', 'cwd', 'app', 'anywhere'].includes(writer.root), writer.module);
  }
  // The only thing outside the two directories Start over deletes is `.env`,
  // plus the application's log, which is rewritten on every launch anyway.
  const outside = WRITERS.filter((writer) => writer.root === 'cwd').flatMap((w) => w.writes);
  assert.deepEqual(outside, ['.env']);
  const app = WRITERS.filter((writer) => writer.root === 'app').flatMap((w) => w.writes);
  assert.deepEqual(app, ['hers.log']);
});

/**
 * The one unbounded writer, held to being the only one.
 *
 * `anywhere` is a hole in the guarantee the rest of this file makes, and the
 * point of naming it as its own root was so that the hole could be counted.
 * A second module quietly acquiring the same freedom is exactly the drift these
 * tests exist to catch, so it fails here rather than being noticed later.
 */
test('exactly one module can write to a path the user chose', () => {
  const unbounded = WRITERS.filter((writer) => writer.root === 'anywhere');
  assert.deepEqual(
    unbounded.map((writer) => writer.module),
    ['core/hands/hands.ts'],
  );
});

/**
 * Guards the assumption that the scan looks everywhere code lives.
 *
 * The previous version of this test listed the subdirectories of `src/`, so it
 * could not notice a new *top-level* directory — which is precisely how
 * `electron/` arrived, wrote a log file, and left the document incomplete with
 * every test green. It now watches the repository root as well.
 */
test('a new top-level directory of code cannot appear unnoticed', () => {
  const known = new Set([
    'src',
    'electron',
    'scripts',
    'build',
    'docs',
    'dist',
    'release',
    'node_modules',
    'data',
    'hers-profile',
    'anna-profile',
  ]);
  const top = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  for (const name of top) {
    assert.ok(known.has(name), `${name}/ is new: does the write scan need to cover it?`);
  }
});

test('the scan covers every source directory', () => {
  const dirs = readdirSync(path.join(root, 'src'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(dirs, ['bridges', 'core', 'server', 'shared', 'web']);
});
