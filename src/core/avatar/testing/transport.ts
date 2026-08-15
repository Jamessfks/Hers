/**
 * A fake `fetch` for the clip providers, and a guard against a real one.
 *
 * Every provider in this directory talks to a paid API. Hedra bills on ingest —
 * the money is gone the moment a submit is accepted, whatever happens
 * afterwards — so a test that accidentally reaches the network does not fail
 * loudly, it succeeds quietly and charges the user. The usual defence is a
 * comment asking people to be careful. This is the mechanical one.
 *
 * Two properties, and the second is the point:
 *
 *  1. Routes are matched by method and path, so a test says what it expects to
 *     be asked and gets to assert on it.
 *  2. **Anything unmatched throws.** Not a 404 — a thrown error naming the URL
 *     and saying no route claimed it. A provider that grows a new endpoint, or
 *     a test that forgets to inject, fails on the spot instead of falling
 *     through to `globalThis.fetch`.
 *
 * `allowHosts` exists for the one case where a real host name has to appear in
 * a URL — the presigned download links Hedra returns point at object storage —
 * and even then the request is still served from the route table. It widens
 * what may be *named*, never what may be *reached*.
 */

/** What a route returns. A bare object is JSON; a `Response` is passed through. */
export type RouteReply = Response | { status?: number; json?: unknown; body?: BodyInit };

export type RouteHandler = (request: Request) => RouteReply | Promise<RouteReply>;

export interface FakeTransportOptions {
  /**
   * Hosts a URL is allowed to name. The fake still answers from the route
   * table; this only decides whether the URL is refused before it gets there.
   */
  allowHosts?: readonly string[];
}

export interface RecordedCall {
  method: string;
  url: string;
  /** The request body, parsed as JSON where it was JSON. */
  body: unknown;
}

export interface FakeTransport {
  fetch: typeof globalThis.fetch;
  /** Every call that matched a route, in order. */
  calls: RecordedCall[];
  /** Calls whose URL path contains `fragment`. */
  matching(fragment: string): RecordedCall[];
}

const DEFAULT_ALLOWED = ['api.hedra.com', 'api.dev.runwayml.com', 'api.runwayml.com', 'files.test'];

/**
 * Builds a fake transport.
 *
 * Routes are keyed `"<METHOD> <path fragment>"`, matched in insertion order on
 * the first fragment the URL's path contains. Order matters and the more
 * specific route goes first — `/jobs/x/status` before `/jobs/x`.
 */
export function fakeTransport(
  routes: Record<string, RouteHandler | RouteReply>,
  options: FakeTransportOptions = {},
): FakeTransport {
  const allowed = new Set(options.allowHosts ?? DEFAULT_ALLOWED);
  const calls: RecordedCall[] = [];
  const entries = Object.entries(routes).map(([key, reply]) => {
    const space = key.indexOf(' ');
    return {
      method: key.slice(0, space).toUpperCase(),
      fragment: key.slice(space + 1),
      reply,
    };
  });

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);

    if (!allowed.has(url.hostname)) {
      throw new Error(
        `Blocked a request to ${url.hostname}. Only ${[...allowed].join(', ')} may be named in ` +
          `a test URL, and every request is answered from the route table — nothing here reaches ` +
          `the network. If this host is legitimate, add it to allowHosts explicitly.`,
      );
    }

    const target = url.pathname + url.search;
    const route = entries.find(
      (entry) => entry.method === request.method.toUpperCase() && target.includes(entry.fragment),
    );

    if (!route) {
      throw new Error(
        `No route for ${request.method} ${target}. The fake transport refuses unmatched ` +
          `requests rather than falling through to the real network, because the real network ` +
          `bills. Add a route, or fix the caller.`,
      );
    }

    calls.push({ method: request.method.toUpperCase(), url: request.url, body: await sniff(request) });

    const reply = typeof route.reply === 'function' ? await route.reply(request) : route.reply;
    return toResponse(reply);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    matching: (fragment) => calls.filter((call) => new URL(call.url).pathname.includes(fragment)),
  };
}

/**
 * A transport that fails every request the way a dead network does.
 *
 * Distinct from a route that returns 500: this throws, which is the shape of a
 * DNS failure or a socket reset, and is the path that used to abandon a paid
 * job because nothing caught it.
 */
export function unreachableTransport(message = 'network is down'): typeof globalThis.fetch {
  return (async () => {
    throw new TypeError(message);
  }) as typeof globalThis.fetch;
}

/**
 * A key that is obviously not real, for tests that need one.
 *
 * Named rather than a bare string so a grep for a real key's prefix finds
 * nothing, and so a reviewer reading a test can tell at a glance that no
 * credential is involved.
 */
export const FAKE_KEY = 'hedra_test_key_do_not_use';

async function sniff(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('json')) return null;
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

function toResponse(reply: RouteReply): Response {
  if (reply instanceof Response) return reply;
  if (reply.body !== undefined) {
    return new Response(reply.body, { status: reply.status ?? 200 });
  }
  return new Response(JSON.stringify(reply.json ?? {}), {
    status: reply.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}
