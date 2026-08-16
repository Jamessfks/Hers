import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

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

  const server = createServer(
    createRequestHandler({
      webRoot,
      gallery: new Gallery(galleryDir),
      onMissingBuild: missingBuildPage,
      status: () => ({ version: '1.0.0' }),
    }),
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  started.push(() => server.close());
  const { port } = server.address() as AddressInfo;

  return {
    root,
    get: (requestPath: string) => fetch(`http://127.0.0.1:${port}${requestPath}`),
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
