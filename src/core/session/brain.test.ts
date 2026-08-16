import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Brain, safeToDelete } from './brain.ts';
import { loadConfig } from '../../server/config.ts';

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
