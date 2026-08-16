/**
 * The static half of the server: the website, and Anna's gallery.
 *
 * Small on purpose. There is no framework here because there are four routes,
 * and a router would be more code than the routes.
 *
 * Two security properties this file is responsible for, both of which matter
 * more than they look for something bound to localhost:
 *
 *   - **No path escapes its root.** Every request path is resolved and then
 *     checked to still be inside the directory it was meant to be inside. A
 *     browser will not send `..`, but the thing making the request is not
 *     always a browser.
 *   - **The gallery is served by name, not by path.** A file is only served if
 *     the gallery's own listing already knows about it, so the route cannot be
 *     talked into reading `../mood.state.json` however it is spelled.
 */

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import type { Gallery } from '../core/gallery/gallery.ts';
import { mimeFor } from '../core/gallery/gallery.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticOptions {
  /** Built website. */
  webRoot: string;
  gallery: Gallery;
  /** Rendered when the site has not been built yet. */
  onMissingBuild: () => string;
  /** Answers `GET /api/status`. */
  status: () => unknown;
}

export function createRequestHandler(options: StaticOptions) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // `URL` needs an origin; the host header is only used to parse and never
    // trusted for anything, so a forged one cannot reach outside this handler.
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }

    if (pathname === '/api/status') {
      send(response, 200, TYPES['.json']!, JSON.stringify(options.status()));
      return;
    }

    if (pathname.startsWith('/gallery/')) {
      await serveGalleryItem(options.gallery, pathname.slice('/gallery/'.length), response);
      return;
    }

    await serveStatic(options, pathname, response);
  };
}

async function serveGalleryItem(
  gallery: Gallery,
  rawName: string,
  response: ServerResponse,
): Promise<void> {
  const item = await gallery.resolve(rawName);
  if (!item) {
    send(response, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }
  const { size } = await stat(item.absolutePath);
  response.writeHead(200, {
    'content-type': mimeFor(path.extname(item.name)),
    'content-length': size,
    // Generated files get a fresh name every time, so anything served here is
    // immutable for as long as it exists.
    'cache-control': 'private, max-age=3600',
  });
  createReadStream(item.absolutePath).pipe(response);
}

async function serveStatic(
  options: StaticOptions,
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const root = path.resolve(options.webRoot);
  if (!existsSync(path.join(root, 'index.html'))) {
    send(response, 503, TYPES['.html']!, options.onMissingBuild());
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(root, relative);

  // The trailing separator matters: without it `/webroot-evil` passes a plain
  // `startsWith` check against `/webroot`.
  if (target !== root && !target.startsWith(root + path.sep)) {
    send(response, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }

  const file = existsSync(target) && (await stat(target)).isFile()
    ? target
    : path.join(root, 'index.html');

  const { size } = await stat(file);
  response.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000',
  });
  createReadStream(file).pipe(response);
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** Shown when someone runs `npm start` before `npm run build`. */
export function missingBuildPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Anna</title>
<style>
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; background:#0f1015; color:#e8e6f0;
         display:grid; place-items:center; min-height:100vh; margin:0; }
  main { max-width: 34rem; padding: 2rem; }
  code { background:#1c1d26; padding:.15em .45em; border-radius:.3em; }
  h1 { font-weight: 500; letter-spacing:-.02em; }
</style></head><body><main>
<h1>The website has not been built yet.</h1>
<p>Anna's server is running, but there is nothing to serve. Build it once:</p>
<p><code>npm run build</code></p>
<p>Or run <code>npm run dev</code>, which rebuilds as you edit.</p>
</main></body></html>`;
}
