import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  SCAN_LIMITS,
  describeScan,
  explain,
  looksLikeSecret,
  readConsent,
  scanFolders,
  writeConsent,
} from './scan.ts';

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hers-scan-'));
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, 'utf8');
  }
  return root;
}

// -- consent ----------------------------------------------------------------

test('nothing is consented to until it is written down', async () => {
  const dir = await tree({});
  const consent = await readConsent(dir);
  assert.deepEqual(consent.folders, []);
  assert.equal(consent.at, 0, 'no default folders, and no implied yes');
});

test('consent survives, and a corrupt record is no consent at all', async () => {
  const dir = await tree({});
  await writeConsent(dir, { folders: ['/Users/someone/Documents'], at: 1, scannedAt: 0 });
  assert.deepEqual((await readConsent(dir)).folders, ['/Users/someone/Documents']);

  await writeFile(path.join(dir, 'knowledge.json'), 'not json', 'utf8');
  assert.deepEqual((await readConsent(dir)).folders, [], 'unreadable must fail closed');
});

// -- the thing that must never happen ---------------------------------------

test('anything that looks like a credential is refused by name', () => {
  for (const name of [
    '.env',
    '.env.production',
    'id_rsa',
    'Copy of id_rsa',
    'server.pem',
    'aws-credentials-old.txt',
    'my passwords.md',
    'wallet.dat',
    'seed-phrase.txt',
    'GITHUB_TOKEN.txt',
    'bank.kdbx',
  ]) {
    assert.equal(looksLikeSecret(name), true, name);
  }

  for (const name of ['notes.md', 'transcript.pdf', 'cover-letter.docx', 'thesis.tex']) {
    assert.equal(looksLikeSecret(name), false, name);
  }
});

test('a secret in an approved folder is still never opened', async () => {
  const root = await tree({
    'notes.md': 'I am a Northeastern student studying computer science.',
    '.env': 'GEMINI_API_KEY=AIzaSyREALKEYWOULDBEHERE',
    'aws-credentials.txt': 'aws_secret_access_key = wJalrXUtn',
    'id_rsa': '-----BEGIN OPENSSH PRIVATE KEY-----',
  });

  const report = await scanFolders([root]);
  const everything = JSON.stringify(report);

  assert.equal(report.refused, 3);
  assert.ok(!everything.includes('AIzaSy'), 'a key in a prompt is the incident this prevents');
  assert.ok(!everything.includes('wJalrXUtn'));
  assert.ok(!everything.includes('PRIVATE KEY'));
  assert.ok(everything.includes('Northeastern'), 'and the ordinary file is still read');
});

// -- what it collects -------------------------------------------------------

test('plain text is read and everything else contributes its name', async () => {
  const root = await tree({
    'notes.md': 'Applying for a 2027 co-op.',
    'transcript.pdf': '%PDF-1.7 binary nonsense',
    'photo.jpg': 'not really a jpeg',
  });

  const report = await scanFolders([root]);
  const byName = new Map(report.findings.map((f) => [f.name, f.excerpt]));

  assert.match(byName.get('notes.md') ?? '', /2027 co-op/);
  assert.equal(byName.get('transcript.pdf'), '', 'the name is the signal, not the bytes');
  assert.equal(byName.get('photo.jpg'), '');
  assert.equal(report.read, 1);
  assert.equal(report.seen, 3);
});

test('a Google Docs stub yields its title and nothing else', async () => {
  /*
   * Measured against the format rather than assumed: a `.gdoc` is a ~175-byte
   * JSON pointer holding a URL and a document id, with no content in it at all,
   * and Drive's own filesystem driver refuses programmatic reads. The title is
   * genuinely all that is available without going through the Drive API.
   */
  const root = await tree({
    'Q3 budget.gdoc': JSON.stringify({
      url: 'https://docs.google.com/open?id=1AbC',
      doc_id: '1AbC',
      email: 'someone@example.com',
    }),
  });

  const report = await scanFolders([root]);
  assert.equal(report.findings[0]?.name, 'Q3 budget.gdoc');
  assert.equal(report.findings[0]?.excerpt, '', 'there is no content in a stub to read');
  assert.ok(
    !JSON.stringify(report).includes('someone@example.com'),
    'and the account in it is not ours to take',
  );
});

test('caches and repositories are not walked', async () => {
  const root = await tree({
    'notes.md': 'real',
    'node_modules/left-pad/index.js': 'module.exports = 1',
    '.git/config': '[core]',
    'Library/Caches/thing.txt': 'cache',
  });

  const report = await scanFolders([root]);
  const names = report.findings.map((f) => f.name).join(' ');
  assert.ok(names.includes('notes.md'));
  assert.ok(!names.includes('left-pad'), 'a dependency tree is not a person');
  assert.ok(!names.includes('config'));
  assert.ok(!names.includes('cache'));
});

test('an excerpt is the opening of a file, not the whole thing', async () => {
  const root = await tree({ 'long.md': 'x'.repeat(50_000) });
  const report = await scanFolders([root]);
  assert.ok((report.findings[0]?.excerpt.length ?? 0) <= SCAN_LIMITS.excerptBytes);
});

test('a folder that is not there is reported, not thrown', async () => {
  const report = await scanFolders([path.join(tmpdir(), 'hers-definitely-not-here')]);
  assert.equal(report.findings.length, 0);
  assert.equal(report.denied.length, 1);
  assert.match(report.denied[0]?.reason ?? '', /nothing at that path/i);
});

test('a refusal comes with the thing that fixes it', () => {
  const denied = explain(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
  if (process.platform === 'darwin') {
    assert.match(denied, /Full Disk Access/);
    assert.match(denied, /Node upgrade silently revokes it/, 'the trap worth warning about');
  } else {
    assert.match(denied, /refused/i);
  }
});

test('the description leads with names, so it survives truncation', async () => {
  const root = await tree({
    'neu-transcript.pdf': 'binary',
    'co-op-cover-letter.md': 'Dear hiring manager,',
  });

  const described = describeScan(await scanFolders([root]));
  assert.ok(described.indexOf('neu-transcript.pdf') < described.indexOf('EXCERPTS'));
  assert.match(described, /Dear hiring manager/);
});

test('an empty scan describes itself without pretending to know anything', async () => {
  const described = describeScan(await scanFolders([await tree({})]));
  assert.match(described, /FILES ON THIS MACHINE/);
  assert.ok(!described.includes('EXCERPTS'), 'no excerpts section when there are none');
});
