import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { EnvFileError, setEnvValue } from './env-file.ts';

/** What `process.loadEnvFile` would see for one name. */
async function valueOf(file: string, name: string): Promise<string | null> {
  const contents = await readFile(file, 'utf8');
  let found: string | null = null;
  for (const line of contents.split(/\r?\n/)) {
    if (!new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line)) continue;
    // The last assignment wins, which is what a reader does.
    found = line.slice(line.indexOf('=') + 1).trim().replace(/^(['"`])(.*)\1$/s, '$2');
  }
  return found;
}

async function envFile(contents?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hers-env-'));
  const file = path.join(root, '.env');
  if (contents !== undefined) await writeFile(file, contents, 'utf8');
  return file;
}

test('a missing file is written from nothing', async () => {
  const file = await envFile();
  await setEnvValue(file, 'GEMINI_API_KEY', 'AIzaOne');
  assert.equal(await valueOf(file, 'GEMINI_API_KEY'), 'AIzaOne');
});

test('everything else in the file survives, comments and order included', async () => {
  const file = await envFile(
    [
      '# Hers',
      'LIVEKIT_URL=wss://example.livekit.cloud',
      '',
      'GEMINI_API_KEY=old',
      'HERS_PORT=5175',
      '',
    ].join('\n'),
  );

  await setEnvValue(file, 'GEMINI_API_KEY', 'AIzaNew');
  const lines = (await readFile(file, 'utf8')).split('\n');

  assert.deepEqual(lines.slice(0, 5), [
    '# Hers',
    'LIVEKIT_URL=wss://example.livekit.cloud',
    '',
    'GEMINI_API_KEY=AIzaNew',
    'HERS_PORT=5175',
  ]);
});

test('a variable set twice is set twice again, not left half stale', async () => {
  // The last assignment wins when the file is read, so a rewrite that updated
  // only the first one would look like it had done nothing at all.
  const file = await envFile('GEMINI_API_KEY=one\nHERS_PORT=1\nGEMINI_API_KEY=two\n');
  await setEnvValue(file, 'GEMINI_API_KEY', 'three');

  const contents = await readFile(file, 'utf8');
  assert.equal(contents.match(/GEMINI_API_KEY=three/g)?.length, 2);
  assert.doesNotMatch(contents, /=one|=two/);
});

test('an exported or indented assignment is still that assignment', async () => {
  const file = await envFile('  export GEMINI_API_KEY=old\n');
  await setEnvValue(file, 'GEMINI_API_KEY', 'new');
  assert.equal(await valueOf(file, 'GEMINI_API_KEY'), 'new');
  assert.doesNotMatch(await readFile(file, 'utf8'), /old/);
});

test('a commented-out line is a comment, not the value', async () => {
  const file = await envFile('# GEMINI_API_KEY=notthis\n');
  await setEnvValue(file, 'GEMINI_API_KEY', 'AIzaReal');

  const contents = await readFile(file, 'utf8');
  assert.match(contents, /# GEMINI_API_KEY=notthis/, 'their note is theirs');
  assert.equal(await valueOf(file, 'GEMINI_API_KEY'), 'AIzaReal');
});

test('a file with no trailing newline still gets its own line', async () => {
  const file = await envFile('HERS_PORT=5175');
  await setEnvValue(file, 'GEMINI_API_KEY', 'AIza');
  assert.match(await readFile(file, 'utf8'), /^HERS_PORT=5175\nGEMINI_API_KEY=AIza\n?$/);
});

test('a quoted value is read back without its quotes', async () => {
  const file = await envFile('GEMINI_API_KEY="AIzaQuoted"\n');
  assert.equal(await valueOf(file, 'GEMINI_API_KEY'), 'AIzaQuoted');
});

test('a value that would need quoting is refused rather than mangled', async () => {
  const file = await envFile('HERS_PORT=5175\n');
  for (const bad of ['has a space', 'has"quote', 'trailing#comment', 'new\nline', '']) {
    await assert.rejects(
      () => setEnvValue(file, 'GEMINI_API_KEY', bad),
      EnvFileError,
      JSON.stringify(bad),
    );
  }
  assert.equal(await readFile(file, 'utf8'), 'HERS_PORT=5175\n', 'and nothing was written');
});

test('the keys this program actually stores are all acceptable', async () => {
  const file = await envFile();
  for (const [name, value] of [
    // Shapes, not credentials. A "realistic" example in a public repository is
    // a real key one careless edit later.
    ['GEMINI_API_KEY', 'AIzaEXAMPLE_example-EXAMPLE'],
    ['TELEGRAM_ALLOWED_CHAT_IDS', '100000000'],
    ['LIVEKIT_URL', 'wss://example.livekit.cloud'],
    ['TELEGRAM_BOT_TOKEN', '1000000000:EXAMPLE-example_EXAMPLE'],
  ] as const) {
    await setEnvValue(file, name, value);
    assert.equal(await valueOf(file, name), value, name);
  }
});

test('a name that is not a variable name is refused', async () => {
  // The name goes into a regular expression that decides which line to
  // overwrite. Anything outside this shape is either a mistake or a way to
  // rewrite a line nobody meant to touch.
  const file = await envFile('HERS_PORT=5175\n');
  for (const bad of ['gemini_api_key', '1KEY', 'A B', 'KEY.*', '']) {
    await assert.rejects(() => setEnvValue(file, bad, 'value'), EnvFileError, JSON.stringify(bad));
  }
  assert.equal(await readFile(file, 'utf8'), 'HERS_PORT=5175\n');
});
