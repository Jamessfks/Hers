import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { AvatarStudio } from '../core/avatar/studio.ts';
import { Gallery } from '../core/gallery/gallery.ts';
import { createRequestHandler, missingBuildPage } from './http.ts';

/**
 * The whole handler, over a real socket.
 *
 * Path traversal is the thing being tested and it is not testable by calling
 * the function directly: Node's HTTP parser, `URL`, and `decodeURIComponent`
 * each transform the path, and the bug this guards against always lives in the
 * gap between two of them.
 */
const started: Array<() => void> = [];
after(() => {
  for (const stop of started) stop();
});

async function serve() {
  const root = await mkdtemp(path.join(tmpdir(), 'anna-http-'));
  const webRoot = path.join(root, 'web');
  const galleryDir = path.join(root, 'gallery');
  await mkdir(webRoot, { recursive: true });
  await mkdir(galleryDir, { recursive: true });

  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Anna</title>');
  await writeFile(path.join(webRoot, 'app.js'), 'console.log(1)');
  await writeFile(path.join(galleryDir, 'smiling.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  // The things a traversal would be aiming at.
  await writeFile(path.join(root, 'secret.txt'), 'the api key');
  await writeFile(path.join(galleryDir, '..', 'mood.state.json'), '{"secret":true}');

  const gallery = new Gallery(galleryDir);
  const avatar = new AvatarStudio({
    dir: path.join(root, 'avatar'),
    client: null,
    budgetUsd: 0,
  });

  const keys: string[] = [];
  const resets: number[] = [];

  const server = createServer(
    createRequestHandler({
      webRoot,
      gallery: () => gallery,
      avatar: () => avatar,
      onMissingBuild: missingBuildPage,
      status: () => ({ version: '1.0.0' }),
      setKey: async (key) => {
        keys.push(key);
        return key === 'bad' ? { ok: false, error: 'Google says no.' } : { ok: true, keyHint: '••••key' };
      },
      reset: async () => {
        resets.push(Date.now());
        return { ok: true };
      },
    }),
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  started.push(() => server.close());
  const { port } = server.address() as AddressInfo;

  return {
    root,
    keys,
    resets,
    get: (requestPath: string) => fetch(`http://127.0.0.1:${port}${requestPath}`),
    post: (requestPath: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${requestPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
  };
}

test('the site is served, and unknown paths fall back to it', async () => {
  const app = await serve();
  const index = await app.get('/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<title>Anna<\/title>/);

  const asset = await app.get('/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);

  const unknown = await app.get('/some/deep/route');
  assert.equal(unknown.status, 200, 'a single-page app needs its own 404 handling');
});

test('a directory serves its own index, not the app shell', async () => {
  const app = await serve();
  await mkdir(path.join(app.root, 'web', 'call'), { recursive: true });
  await writeFile(path.join(app.root, 'web', 'call', 'index.html'), '<title>Calling Anna</title>');

  const response = await app.get('/call/');
  assert.match(
    await response.text(),
    /Calling Anna/,
    'falling through to the app shell here looks exactly like the call page being broken',
  );
});

test('status is JSON', async () => {
  const app = await serve();
  const response = await app.get('/api/status');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: '1.0.0' });
});

test('the gallery serves a known file', async () => {
  const app = await serve();
  const response = await app.get('/gallery/smiling.jpg');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

test('the gallery refuses anything it does not already list', async () => {
  const app = await serve();
  for (const attempt of [
    '/gallery/../secret.txt',
    '/gallery/%2e%2e%2fsecret.txt',
    '/gallery/..%2F..%2Fsecret.txt',
    '/gallery/mood.state.json',
    '/gallery/....//secret.txt',
    '/gallery/..\\secret.txt',
  ]) {
    const response = await app.get(attempt);
    const body = await response.text();
    assert.ok(!body.includes('the api key'), `${attempt} escaped the gallery`);
    assert.ok(!body.includes('"secret"'), `${attempt} reached app state`);
  }
});

test('static serving cannot be walked out of', async () => {
  const app = await serve();
  for (const attempt of [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/....//secret.txt',
    '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  ]) {
    const response = await app.get(attempt);
    const body = await response.text();
    assert.ok(!body.includes('the api key'), `${attempt} read outside the web root`);
  }
});

test('a sibling directory with the same prefix is not inside the root', async () => {
  // The classic off-by-one: `/webroot-evil` passes a bare startsWith('/webroot').
  const app = await serve();
  await mkdir(path.join(app.root, 'web-evil'), { recursive: true });
  await writeFile(path.join(app.root, 'web-evil', 'oops.txt'), 'the api key');

  const response = await app.get('/../web-evil/oops.txt');
  assert.ok(!(await response.text()).includes('the api key'));
});

test('write methods are refused', async () => {
  const app = await serve();
  const response = await fetch(new URL('/api/status', (await app.get('/')).url), {
    method: 'POST',
  });
  assert.equal(response.status, 405);
});

test('an unbuilt site says how to build it', () => {
  assert.match(missingBuildPage(), /npm run build/);
});

// -- setup ------------------------------------------------------------------

test('a pasted key reaches the server and only its last characters come back', async () => {
  const app = await serve();

  const response = await app.post('/api/key', { key: '  AIzaTestKey  ' });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok?: boolean; keyHint?: string };
  assert.equal(body.ok, true);
  assert.equal(body.keyHint, '••••key');
  assert.deepEqual(app.keys, ['AIzaTestKey'], 'the surrounding spaces of a paste are not the key');
});

test('a key Google refuses comes back as the reason, not as a 500', async () => {
  const app = await serve();
  const response = await app.post('/api/key', { key: 'bad' });
  assert.equal(response.status, 422);
  assert.match(((await response.json()) as { error: string }).error, /Google says no/);
});

test('an empty key is refused before anything is written', async () => {
  const app = await serve();
  const response = await app.post('/api/key', { key: '   ' });
  assert.equal(response.status, 400);
  assert.deepEqual(app.keys, []);
});

test('reset needs the words typed out', async () => {
  const app = await serve();

  for (const attempt of [{}, { confirm: 'yes' }, { confirm: 'reset' }]) {
    const refused = await app.post('/api/reset', attempt);
    assert.equal(refused.status, 400, JSON.stringify(attempt));
  }
  assert.equal(app.resets.length, 0, 'nothing was deleted on a near miss');

  const done = await app.post('/api/reset', { confirm: 'Start Over' });
  assert.equal(done.status, 200, 'and the case of what they typed is not the point');
  assert.equal(app.resets.length, 1);
});

test('a body that is not an object is a 400 rather than a crash', async () => {
  const app = await serve();
  assert.equal((await app.post('/api/key', '[1,2,3]')).status, 400);
  assert.equal((await app.post('/api/key', 'not json at all')).status, 400);
});

test('the setup routes are not readable, and do not answer with the app shell', async () => {
  const app = await serve();
  for (const route of ['/api/key', '/api/reset', '/api/anything']) {
    const response = await app.get(route);
    assert.equal(response.status, 404, route);
    assert.match(response.headers.get('content-type') ?? '', /json/, route);
  }
});
