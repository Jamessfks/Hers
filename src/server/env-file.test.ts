import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { EnvFileError, readEnvValue, setEnvValue } from './env-file.ts';

async function envFile(contents?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'anna-env-'));
  const file = path.join(root, '.env');
  if (contents !== undefined) await writeFile(file, contents, 'utf8');
  return file;
}

test('a missing file is written from nothing', async () => {
  const file = await envFile();
  await setEnvValue(file, 'GEMINI_API_KEY', 'AIzaOne');
  assert.equal(await readEnvValue(file, 'GEMINI_API_KEY'), 'AIzaOne');
});

test('everything else in the file survives, comments and order included', async () => {
  const file = await envFile(
    ['# Anna', 'HEDRA_API_KEY=k_live_x:sk_y', '', 'GEMINI_API_KEY=old', 'ANNA_PORT=5175', ''].join(
      '\n',
    ),
  );

  await setEnvValue(file, 'GEMINI_API_KEY', 'AIzaNew');
  const lines = (await readFile(file, 'utf8')).split('\n');

  assert.deepEqual(lines.slice(0, 5), [
    '# Anna',
    'HEDRA_API_KEY=k_live_x:sk_y',
    '',
    'GEMINI_API_KEY=AIzaNew',
    'ANNA_PORT=5175',
  ]);
});

test('a variable set twice is set twice again, not left half stale', async () => {
  // The last assignment wins when the file is read, so a rewrite that updated
  // only the first one would look like it had done nothing at all.
  const file = await envFile('GEMINI_API_KEY=one\nANNA_PORT=1\nGEMINI_API_KEY=two\n');
  await setEnvValue(file, 'GEMINI_API_KEY', 'three');

  const contents = await readFile(file, 'utf8');
  assert.equal(contents.match(/GEMINI_API_KEY=three/g)?.length, 2);
  assert.doesNotMatch(contents, /=one|=two/);
});

test('an exported or indented assignment is still that assignment', async () => {
  const file = await envFile('  export GEMINI_API_KEY=old\n');
  await setEnvValue(file, 'GEMINI_API_KEY', 'new');
  assert.equal(await readEnvValue(file, 'GEMINI_API_KEY'), 'new');
  assert.doesNotMatch(await readFile(file, 'utf8'), /old/);
});

test('a commented-out line is a comment, not the value', async () => {
  const file = await envFile('# GEMINI_API_KEY=notthis\n');
  await setEnvValue(file, 'GEMINI_API_KEY', 'AIzaReal');

  const contents = await readFile(file, 'utf8');
  assert.match(contents, /# GEMINI_API_KEY=notthis/, 'their note is theirs');
  assert.equal(await readEnvValue(file, 'GEMINI_API_KEY'), 'AIzaReal');
});

test('a file with no trailing newline still gets its own line', async () => {
  const file = await envFile('ANNA_PORT=5175');
  await setEnvValue(file, 'GEMINI_API_KEY', 'AIza');
  assert.match(await readFile(file, 'utf8'), /^ANNA_PORT=5175\nGEMINI_API_KEY=AIza\n?$/);
});

test('a quoted value is read back without its quotes', async () => {
  const file = await envFile('GEMINI_API_KEY="AIzaQuoted"\n');
  assert.equal(await readEnvValue(file, 'GEMINI_API_KEY'), 'AIzaQuoted');
});

test('a value that would need quoting is refused rather than mangled', async () => {
  const file = await envFile('ANNA_PORT=5175\n');
  for (const bad of ['has a space', 'has"quote', 'trailing#comment', 'new\nline', '']) {
    await assert.rejects(
      () => setEnvValue(file, 'GEMINI_API_KEY', bad),
      EnvFileError,
      JSON.stringify(bad),
    );
  }
  assert.equal(await readFile(file, 'utf8'), 'ANNA_PORT=5175\n', 'and nothing was written');
});

test('the keys this program actually stores are all acceptable', async () => {
  const file = await envFile();
  for (const [name, value] of [
    ['GEMINI_API_KEY', 'AIzaSyD-abc_DEF123'],
    ['HEDRA_API_KEY', 'k_live_Abc-1:sk_Xyz_2'],
    ['LIVEKIT_URL', 'wss://anna.livekit.cloud'],
    ['TELEGRAM_BOT_TOKEN', '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ] as const) {
    await setEnvValue(file, name, value);
    assert.equal(await readEnvValue(file, name), value, name);
  }
});

test('reading a value that is not there is null, not a throw', async () => {
  assert.equal(await readEnvValue(await envFile('ANNA_PORT=1\n'), 'GEMINI_API_KEY'), null);
  assert.equal(await readEnvValue(path.join(tmpdir(), 'anna-nope', '.env'), 'ANYTHING'), null);
});
