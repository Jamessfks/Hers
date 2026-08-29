/**
 * Everything the server answers over plain HTTP: the website, and the two
 * requests that set her up.
 *
 * Small on purpose. There is no framework here because there are a handful of
 * routes, and a router would be more code than the routes.
 *
 *   POST /api/key      a pasted Gemini key
 *   POST /api/reset    delete everything and start over
 *   GET  /api/status   what is configured, for a person or a health check
 *   GET  anything else the built site, with a single-page fallback
 *
 * One security property this file is responsible for, and it matters more than
 * it looks for something bound to localhost: **no path escapes its root.**
 * Every request path is resolved and then checked to still be inside the
 * directory it was meant to be inside. A browser will not send `..`, but the
 * thing making the request is not always a browser.
 */

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

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
  /**
   * Origins allowed to reach the API, and the only `Host` values accepted.
   *
   * The same set the WebSocket handshake uses, threaded in rather than rebuilt,
   * because two lists that are meant to be identical eventually are not.
   * Omitted only by tests that are not exercising the guard.
   */
  allowedOrigins?: ReadonlySet<string>;
  /** Rendered when the site has not been built yet. */
  onMissingBuild: () => string;
  /** Answers `GET /api/status`. */
  status: () => unknown;
  /** Takes a pasted Gemini key. Rejects it with something worth reading. */
  setKey?: (key: string) => Promise<{ ok: boolean; error?: string; keyHint?: string }>;
  /**
   * Takes a pasted Telegram bot token and brings the bridge up on it.
   *
   * Answers with the bot's username and the link that gets somebody into the
   * chat, because the token alone is not enough to finish: nothing in the Bot
   * API tells a bot which chat is its owner's, so a human has to speak first.
   */
  setBotToken?: (token: string) => Promise<{
    ok: boolean;
    error?: string;
    username?: string;
    link?: string;
  }>;
  /** Forgets everything and starts again. */
  reset?: () => Promise<{ ok: boolean; error?: string }>;
  /** What she has been allowed to read, and where it would be sensible to look. */
  /** Permission to read these folders, followed immediately by the scan. */
}

/** A key, a confirmation word — nothing that reaches here is large. */
const MAX_JSON_BYTES = 8 * 1024;

/** Typed by hand into the reset box, so a stray click cannot do this. */
export const RESET_PHRASE = 'start over';

/**
 * Whether a request is allowed to be here at all.
 *
 * `ws.ts` calls its own version of this the most important twenty lines in the
 * server, and it was right, and for a long time this file had nothing like it.
 * That was survivable while Hers was a thing you started in a terminal. It is
 * not survivable now she is a double-clickable application, because the whole
 * point of an application is that it is running while you browse.
 *
 * Two checks, for two different attacks.
 *
 * **`Origin`, for cross-site request forgery.** A page on the internet cannot
 * read this server's replies — no `Access-Control-Allow-Origin` is ever sent —
 * but it does not need to read them. `POST` with a CORS-safelisted content type
 * skips the preflight entirely, so `evil.example` could silently call
 * `/api/reset` and wipe her, `/api/key` and route every frame of your camera
 * through somebody else's Google project, or `/api/telegram` and install a bot
 * token of its own — after which the bridge pins the first chat that speaks to
 * it, and the first chat is theirs. Measured, all three, before this function
 * existed.
 *
 * **`Host`, for DNS rebinding.** Origin alone is not enough: a name the
 * attacker controls, re-resolved to `127.0.0.1`, makes their page genuinely
 * same-origin, and then the Origin header is one they are allowed to send. The
 * defence is to refuse a `Host` this server was never bound to.
 *
 * **A missing `Origin` is allowed, deliberately.** Browsers always send one on
 * a cross-origin request, so absence means the caller is not a page: `curl`,
 * `npm run doctor`, the packaged app's own renderer on first paint. Refusing it
 * would break every one of those to stop nothing, since a page cannot suppress
 * the header.
 */
function permitted(request: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null' && !allowed.has(origin)) {
    return false;
  }

  const host = request.headers.host;
  if (typeof host === 'string' && host !== '') {
    // The allowlist holds scheme-qualified origins; a Host header does not carry
    // one, so compare on the authority alone.
    const authorities = new Set([...allowed].map((entry) => entry.replace(/^https?:\/\//, '')));
    if (!authorities.has(host)) return false;
  }

  return true;
}

export function createRequestHandler(options: StaticOptions) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (options.allowedOrigins && !permitted(request, options.allowedOrigins)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Forbidden\n');
      return;
    }

    // `URL` needs an origin; the host header is parsed here only to read the
    // path out of it, and `permitted` above has already refused any Host this
    // server was not bound to.
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === 'POST' && pathname === '/api/key') {
      await setKey(options, request, response);
      return;
    }

    if (request.method === 'POST' && pathname === '/api/telegram') {
      await setBotToken(options, request, response);
      return;
    }

    if (request.method === 'POST' && pathname === '/api/reset') {
      await reset(options, request, response);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }

    if (pathname === '/api/status') {
      send(response, 200, TYPES['.json']!, JSON.stringify(options.status()));
      return;
    }

    // Everything else under /api is a mistake rather than a page. Falling
    // through to the single-page fallback would answer `GET /api/key` with the
    // app shell, and an endpoint that returns HTML when you get it wrong is an
    // endpoint nobody can debug.
    if (pathname.startsWith('/api/')) {
      send(response, 404, TYPES['.json']!, JSON.stringify({ error: 'No such route.' }));
      return;
    }

    await serveStatic(options, pathname, response);
  };
}

/**
 * A Gemini key, pasted into the website.
 *
 * It arrives over a loopback connection to a process that already has the
 * user's other keys, is checked against Google before anything is written, and
 * goes into `.env` — never back out to the browser, which is the whole of
 * Google's guidance on the subject. The reply says which key is in force by its
 * last four characters and nothing more.
 */
async function setBotToken(
  options: StaticOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!options.setBotToken) {
    send(response, 404, TYPES['.json']!, JSON.stringify({ error: 'Not available.' }));
    return;
  }

  const body = await readJson(request, response);
  if (!body) return;

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) {
    send(response, 400, TYPES['.json']!, JSON.stringify({ error: 'No token was sent.' }));
    return;
  }

  const result = await options.setBotToken(token);
  send(
    response,
    result.ok ? 200 : 422,
    TYPES['.json']!,
    JSON.stringify(
      result.ok ? { ok: true, username: result.username, link: result.link } : { error: result.error },
    ),
  );
}

async function setKey(
  options: StaticOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!options.setKey) {
    send(response, 404, TYPES['.json']!, JSON.stringify({ error: 'Not available.' }));
    return;
  }

  const body = await readJson(request, response);
  if (!body) return;

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) {
    send(response, 400, TYPES['.json']!, JSON.stringify({ error: 'No key was sent.' }));
    return;
  }

  const result = await options.setKey(key);
  send(
    response,
    result.ok ? 200 : 422,
    TYPES['.json']!,
    JSON.stringify(result.ok ? { ok: true, keyHint: result.keyHint ?? '' } : { error: result.error }),
  );
}

/**
 * Delete everything and start again.
 *
 * Gated on a phrase typed by hand rather than on a button alone. This is the
 * one request in the program that destroys something the user cannot get back,
 * and a POST that does that on the strength of a single click is a POST that
 * will eventually be made by accident.
 */
async function reset(
  options: StaticOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!options.reset) {
    send(response, 404, TYPES['.json']!, JSON.stringify({ error: 'Not available.' }));
    return;
  }

  const body = await readJson(request, response);
  if (!body) return;

  const confirm = typeof body.confirm === 'string' ? body.confirm.trim().toLowerCase() : '';
  if (confirm !== RESET_PHRASE) {
    send(
      response,
      400,
      TYPES['.json']!,
      JSON.stringify({ error: `Type “${RESET_PHRASE}” to confirm.` }),
    );
    return;
  }

  const result = await options.reset();
  send(
    response,
    result.ok ? 200 : 500,
    TYPES['.json']!,
    JSON.stringify(result.ok ? { ok: true } : { error: result.error }),
  );
}

/** A small JSON body, or nothing — having already answered the request. */
async function readJson(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Record<string, unknown> | null> {
  /*
   * A JSON content type is required, and that is a security check rather than
   * pedantry. `text/plain`, `application/x-www-form-urlencoded` and
   * `multipart/form-data` are the three types a cross-origin `fetch` may send
   * without a preflight, which is exactly how a page on the internet reached
   * these endpoints before `permitted` existed. Requiring the one type that
   * cannot be sent without a preflight is a second lock on the same door, and
   * the website has always sent it.
   */
  const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    send(response, 415, TYPES['.json']!, JSON.stringify({ error: 'Expected JSON.' }));
    return null;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const bytes = chunk as Buffer;
      total += bytes.length;
      if (total > MAX_JSON_BYTES) {
        send(response, 413, TYPES['.json']!, JSON.stringify({ error: 'That is too long.' }));
        request.destroy();
        return null;
      }
      chunks.push(bytes);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      send(response, 400, TYPES['.json']!, JSON.stringify({ error: 'Expected an object.' }));
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    send(response, 400, TYPES['.json']!, JSON.stringify({ error: 'That request was not readable.' }));
    return null;
  }
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

  const file = (await resolveFile(target)) ?? path.join(root, 'index.html');

  const { size } = await stat(file);
  response.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000',
  });
  createReadStream(file).pipe(response);
}

/**
 * A file, or the `index.html` inside a directory, or nothing.
 *
 * The directory case is what makes `/call/` work rather than silently falling
 * through to the app's own index — which looks, from the outside, exactly like
 * the call page being broken.
 */
async function resolveFile(target: string): Promise<string | null> {
  if (!existsSync(target)) return null;
  const stats = await stat(target);
  if (stats.isFile()) return target;
  if (!stats.isDirectory()) return null;
  const index = path.join(target, 'index.html');
  return existsSync(index) ? index : null;
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>Hers</title>
<style>
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; background:#0f1015; color:#e8e6f0;
         display:grid; place-items:center; min-height:100vh; margin:0; }
  main { max-width: 34rem; padding: 2rem; }
  code { background:#1c1d26; padding:.15em .45em; border-radius:.3em; }
  h1 { font-weight: 500; letter-spacing:-.02em; }
</style></head><body><main>
<h1>The website has not been built yet.</h1>
<p>The server is running, but there is nothing to serve. Build it once:</p>
<p><code>npm run build</code></p>
<p>Or run <code>npm run dev</code>, which rebuilds as you edit.</p>
</main></body></html>`;
}
