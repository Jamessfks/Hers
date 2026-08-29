import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Brain, safeToDelete } from './brain.ts';
import { loadConfig } from '../../server/config.ts';
import { writeChosenName } from '../profile/profile.ts';
import { PLACEHOLDER_NAME } from '../profile/naming.ts';

async function fixture(env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hers-brain-'));
  const config = loadConfig({
    GEMINI_API_KEY: 'test-key',
    HERS_PROFILE: path.join(root, 'profile'),
    HERS_DATA: path.join(root, 'data'),
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

  await f.brain.wipe();

  assert.equal(f.brain.memory.turnCount(), 0, 'the conversation is gone');
  assert.equal(f.brain.memory.allFacts().length, 0, 'and so is everything she kept');
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
  const cwd = path.resolve('/Users/someone/code/hers');
  const home = path.resolve('/Users/someone');
  const safe = (dir: string) => safeToDelete(dir, cwd, home);

  assert.equal(safe('/Users/someone/code/hers/data'), true);
  assert.equal(safe('/Users/someone/Library/Hers/profile'), true);

  assert.equal(safe(''), false);
  assert.equal(safe('data'), false, 'a relative path could resolve anywhere');
  assert.equal(safe(path.parse(cwd).root), false, 'the root of the disk');
  assert.equal(safe('/data'), false, 'one level down is still too close to it');
  assert.equal(safe(home), false, 'their home directory');
  assert.equal(safe(cwd), false, 'the folder the program is running in');
  assert.equal(safe('/Users/someone/code'), false, 'and anything containing it');
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

test('two callers racing for her name get one name, and one model call', async () => {
  /*
   * Observed live: she announced "Casey" to the browser, and `identity.md` was
   * written four seconds later saying "Mei". Two callers reach `ensureNamed` — a
   * wake, and minting a call invite — and both read an in-memory profile snapshot,
   * so both saw the placeholder and both spent a naming call. The name she said was
   * not the name she has, which is the one thing this feature promises.
   *
   * Guarding the read cannot fix it: the gap is the network call between reading
   * and writing. The second caller has to wait on the first one's promise.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'hers-naming-race-'));
  let calls = 0;
  const brain = await Brain.open(
    loadConfig({
      GEMINI_API_KEY: 'test-key',
      HERS_PROFILE: path.join(root, 'profile'),
      HERS_DATA: path.join(root, 'data'),
    } as NodeJS.ProcessEnv),
    {
      // Slow on purpose: without a delay there is no window to race in, and a
      // test that cannot fail is not evidence.
      chooseName: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { name: `Mira${calls}`, why: 'it fits' };
      },
    },
  );

  const answers = await Promise.all([
    brain.ensureNamed(),
    brain.ensureNamed(),
    brain.ensureNamed(),
  ]);

  assert.equal(calls, 1, 'three callers, one naming call');
  assert.deepEqual(answers, ['Mira1', 'Mira1', 'Mira1'], 'and one answer');
  assert.equal(brain.profile.identity.name, 'Mira1', 'which is the one on disk');

  // And it is still permanent afterwards.
  assert.equal(await brain.ensureNamed(), null);
  assert.equal(calls, 1);
});
