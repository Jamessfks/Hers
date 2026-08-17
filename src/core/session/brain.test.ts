import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Brain, safeToDelete } from './brain.ts';
import { loadConfig } from '../../server/config.ts';
import { writeChosenName } from '../profile/profile.ts';
import { PLACEHOLDER_NAME } from '../profile/naming.ts';

async function fixture(env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'anna-brain-'));
  const config = loadConfig({
    GEMINI_API_KEY: 'test-key',
    ANNA_PROFILE: path.join(root, 'profile'),
    ANNA_DATA: path.join(root, 'data'),
    ...env,
  } as NodeJS.ProcessEnv);
  return { root, config, brain: await Brain.open(config, { offline: true }) };
}

test('the parts are read through the brain, so a reload reaches every holder', async () => {
  const f = await fixture();

  // Anything that captured these would keep the originals; the point of the
  // getters is that there is nothing to capture.
  const before = f.brain.memory;
  await f.brain.reload();
  assert.notEqual(f.brain.memory, before, 'memory was rebuilt');
  assert.equal(f.brain.memory.turnCount(), 0);
});

test('a reload keeps everything she knows', async () => {
  const f = await fixture();
  f.brain.memory.record('user', 'my sister is called Mei');
  await f.brain.memory.remember('identity', 'their sister is Mei', { confidence: 0.9 });

  await f.brain.reload();

  assert.equal(f.brain.memory.turnCount(), 1, 'a reload is not a reset');
  assert.equal(f.brain.memory.allFacts().length, 1);
});

test('a wipe leaves her a stranger, with the defaults back', async () => {
  const f = await fixture();

  f.brain.memory.record('user', 'my sister is called Mei');
  await f.brain.memory.remember('identity', 'their sister is Mei', { confidence: 0.9 });
  f.brain.mood.feel('exchange');
  await f.brain.mood.flush();
  await f.brain.avatar.setSource(pngBytes(), 'image/png');
  await mkdir(path.join(f.config.profileDir, 'gallery'), { recursive: true });
  await writeFile(path.join(f.config.profileDir, 'gallery', 'her.jpg'), 'not really a jpeg');

  assert.ok(f.brain.avatar.face(), 'she had a face to start with');

  await f.brain.wipe();

  assert.equal(f.brain.memory.turnCount(), 0, 'the conversation is gone');
  assert.equal(f.brain.memory.allFacts().length, 0, 'and so is everything she kept');
  assert.equal(f.brain.avatar.face(), null, 'and her face');
  assert.deepEqual(await f.brain.gallery.list(), [], 'and her pictures');
  assert.equal(f.brain.hasHistory, false);

  // The defaults are back rather than an empty folder: she has to be someone.
  assert.ok(f.brain.profile.identity.name, 'she has a name again');
  assert.ok(existsSync(f.config.profileDir), 'and a profile folder to edit');
  assert.ok((await readdir(f.config.profileDir)).length > 0);
});

test('a wipe leaves a working brain rather than a closed one', async () => {
  const f = await fixture();
  f.brain.memory.record('user', 'before');
  await f.brain.wipe();

  // The database handle is closed to delete the file; writing through the old
  // one would throw, which is exactly what the getters exist to prevent.
  f.brain.memory.record('user', 'after');
  assert.equal(f.brain.memory.turnCount(), 1);
  assert.equal(f.brain.memory.liveTranscript(5)[0]?.text, 'after');
});


// -- the guard --------------------------------------------------------------

test('what is safe to delete, and what is not', () => {
  const cwd = path.resolve('/Users/someone/code/anna');
  const home = path.resolve('/Users/someone');
  const safe = (dir: string) => safeToDelete(dir, cwd, home);

  assert.equal(safe('/Users/someone/code/anna/data'), true);
  assert.equal(safe('/Users/someone/Library/Anna/profile'), true);

  assert.equal(safe(''), false);
  assert.equal(safe('data'), false, 'a relative path could resolve anywhere');
  assert.equal(safe(path.parse(cwd).root), false, 'the root of the disk');
  assert.equal(safe('/data'), false, 'one level down is still too close to it');
  assert.equal(safe(home), false, 'their home directory');
  assert.equal(safe(cwd), false, 'the folder the program is running in');
  assert.equal(safe('/Users/someone/code'), false, 'and anything containing it');
});

/**
 * A PNG header the studio will accept.
 *
 * Dimensions are read out of IHDR rather than taken on trust, so the bytes have
 * to be real even though the pixels never are.
 */
function pngBytes(width = 512, height = 640): Buffer {
  const header = Buffer.alloc(33);
  header.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

test('a borrowed profile is a copy, so nothing a test does reaches the real one', async () => {
  /*
   * The shape the audit relies on. Its gesture check needs the real profile for
   * one reason — the rendered clips live there — and it used to open the real
   * folder to get them, then pin closeness to 70% and put it back afterwards on
   * a path that was not a `finally`. A throw in between would have left somebody's
   * own relationship parked at a number a test chose, and it also wrote a
   * generated picture into their gallery.
   *
   * Copying the avatar folder removes the failure rather than handling it. This
   * asserts the property that makes that true: two brains over two directories
   * share nothing, even when one was seeded from the other.
   */
  const original = await fixture();
  await original.brain.avatar.setSource(pngBytes(), 'image/png');
  original.brain.intimacy.release();
  await original.brain.intimacy.flush();

  const borrowed = await mkdtemp(path.join(tmpdir(), 'anna-borrowed-'));
  const { cp } = await import('node:fs/promises');
  await cp(path.join(original.config.profileDir, 'avatar'), path.join(borrowed, 'avatar'), {
    recursive: true,
  });

  const copy = await Brain.open(
    loadConfig({
      GEMINI_API_KEY: 'test-key',
      ANNA_PROFILE: borrowed,
      ANNA_DATA: path.join(borrowed, 'data'),
    } as NodeJS.ProcessEnv),
    { offline: true },
  );

  // The clips came across, which is the only reason to borrow at all.
  assert.ok(copy.avatar.face(), 'the photograph has to survive the copy');

  copy.intimacy.pin(0.7);
  await copy.intimacy.flush();
  assert.equal(copy.intimacy.read().percent, 70);

  const reread = await Brain.open(original.config, { offline: true });
  assert.equal(reread.intimacy.read().pinned, false, 'the real relationship is untouched');
  assert.equal(reread.intimacy.read().percent, 1);
});

// -- she names herself, once ------------------------------------------------

test('a name she chose is never chosen again', async () => {
  /*
   * The criterion is "permanent", and permanence is the whole feature — a name
   * that could be re-rolled is a handle. The condition is two things on purpose:
   * no marker *and* the shipped placeholder still in place.
   */
  const f = await fixture();
  await writeChosenName(f.config.profileDir, 'Mira', 'it fits');
  await f.brain.reload();

  assert.equal(f.brain.profile.identity.name, 'Mira');
  assert.equal(
    await f.brain.ensureNamed(),
    null,
    'she has a name, so there is nothing to decide',
  );
  assert.equal(f.brain.profile.identity.name, 'Mira', 'and it did not move');
});

test('a name the user typed is theirs, not hers to replace', async () => {
  const f = await fixture();
  const file = path.join(f.config.profileDir, 'identity.md');
  const { readFile } = await import('node:fs/promises');
  await writeFile(file, (await readFile(file, 'utf8')).replace('name: Anna', 'name: Ines'), 'utf8');
  await f.brain.reload();

  // No marker, but the name is not the placeholder — somebody decided already.
  assert.equal(f.brain.profile.identity.named, undefined);
  assert.equal(await f.brain.ensureNamed(), null);
  assert.equal(f.brain.profile.identity.name, 'Ines');
});

test('with no key she stays a placeholder rather than being named badly', async () => {
  const f = await fixture({ GEMINI_API_KEY: '' });
  assert.equal(await f.brain.ensureNamed(), null);
  assert.equal(f.brain.profile.identity.name, PLACEHOLDER_NAME, 'next time, then');
  assert.equal(f.brain.profile.identity.named, undefined, 'and the choice is still open');
});

test('a fresh profile is waiting to be named', async () => {
  const f = await fixture();
  assert.equal(f.brain.profile.identity.name, PLACEHOLDER_NAME);
  assert.equal(f.brain.profile.identity.named, undefined, 'the two conditions to choose');
});

test('starting over means she gets to choose again', async () => {
  // A reset makes her a stranger with a new face, and a stranger she names
  // herself. Keeping the old name through a wipe would be the one thing that
  // survived somebody asking for nothing to.
  const f = await fixture();
  await writeChosenName(f.config.profileDir, 'Mira', 'it fits');
  await f.brain.reload();
  assert.equal(f.brain.profile.identity.name, 'Mira');

  await f.brain.wipe();
  assert.equal(f.brain.profile.identity.name, PLACEHOLDER_NAME);
  assert.equal(f.brain.profile.identity.named, undefined);
});
