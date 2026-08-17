import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { WebSocket } from 'ws';

import { Brain } from '../core/session/brain.ts';
import { loadConfig } from './config.ts';
import { WebBridge } from './ws.ts';
import { Conversation } from '../core/session/conversation.ts';
import { CLOSE_SUPERSEDED, MediaKind, decodeMediaFrame } from '../shared/protocol.ts';
import type { ServerMessage } from '../shared/protocol.ts';

/**
 * The origin check is the most important twenty lines in the server, and it is
 * only testable end to end.
 *
 * WebSockets are exempt from the same-origin policy. Any page, on any site, in
 * a browser that happens to be running on this machine, can open a socket to
 * `ws://127.0.0.1:5175/ws` — and binding to localhost is no defence at all when
 * the attacker is already on localhost. So these tests are about one question:
 * does an `Origin` we do not serve get refused.
 */
async function bridge() {
  const root = await mkdtemp(path.join(tmpdir(), 'hers-ws-'));
  const config = loadConfig({
    HERS_PROFILE: path.join(root, 'profile'),
    HERS_DATA: path.join(root, 'data'),
  } as NodeJS.ProcessEnv);

  const brain = await Brain.open(config, { offline: true });
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const web = new WebBridge({
    brain,
    conversation: new Conversation({ brain }),
    server,
    version: 'test',
    allowedOrigins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
  });

  return {
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    async close() {
      await web.close();
      await brain.close();
      server.close();
    },
  };
}

/** Resolves to `true` if the handshake completed, `false` if it was refused. */
function tryConnect(url: string, origin?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, origin ? { origin } : {});
    const settle = (allowed: boolean) => {
      socket.removeAllListeners();
      socket.close();
      resolve(allowed);
    };
    socket.on('open', () => settle(true));
    socket.on('error', () => settle(false));
    setTimeout(() => settle(false), 3000).unref();
  });
}

test('a page on another origin cannot open a socket to her', async () => {
  const app = await bridge();
  try {
    for (const origin of [
      'https://evil.example',
      'http://evil.example',
      'http://127.0.0.1:9999',
      'http://localhost',
      'null',
      `http://127.0.0.1:${app.port}.evil.example`,
    ]) {
      assert.equal(await tryConnect(app.url, origin), false, `${origin} was allowed in`);
    }
  } finally {
    await app.close();
  }
});

test('the page she serves is allowed in, under either name for localhost', async () => {
  const app = await bridge();
  try {
    assert.equal(await tryConnect(app.url, `http://127.0.0.1:${app.port}`), true);
    assert.equal(await tryConnect(app.url, `http://localhost:${app.port}`), true);
  } finally {
    await app.close();
  }
});

test('a client with no Origin at all is allowed, because a page always sends one', async () => {
  const app = await bridge();
  try {
    assert.equal(await tryConnect(app.url), true);
  } finally {
    await app.close();
  }
});

test('the first thing she says is what the UI needs to draw itself', async () => {
  const app = await bridge();
  try {
    const messages = await collect(app.url, `http://127.0.0.1:${app.port}`, 2);
    const ready = messages.find((message) => message.t === 'ready');
    assert.ok(ready, 'no ready message');
    assert.equal(ready.t === 'ready' && ready.configured, false, 'no key is configured here');
    assert.ok(ready.t === 'ready' && ready.cameraFps > 0);
    assert.deepEqual(
      ready.t === 'ready' ? Object.keys(ready.senses).sort() : [],
      ['hearing', 'screen', 'sight'],
    );
    assert.ok(messages.some((message) => message.t === 'mood'));
  } finally {
    await app.close();
  }
});

test('a malformed control frame is ignored rather than fatal', async () => {
  const app = await bridge();
  try {
    const socket = new WebSocket(app.url, { origin: `http://127.0.0.1:${app.port}` });
    await new Promise((resolve) => socket.on('open', resolve));

    socket.send('not json at all');
    socket.send('{"t":"nonexistent"}');
    socket.send(JSON.stringify({ t: 'sense', sense: '../../etc/passwd', on: true }));
    socket.send(JSON.stringify({ t: 'presence', idleSeconds: 'lots', tabVisible: 'yes' }));
    // A binary frame with a kind nobody defined.
    socket.send(Buffer.from([0x7f, 1, 2, 3]), { binary: true });

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(socket.readyState, WebSocket.OPEN, 'rubbish took the socket down');
    socket.close();
  } finally {
    await app.close();
  }
});

test('an evicted tab is told it was evicted, not that the network blipped', async () => {
  /*
   * The bug this guards is not subtle once seen: closed with 1000 "normal
   * closure", an evicted tab reconnects — which evicts the tab that replaced
   * it, which reconnects. Measured in a browser at 47 sockets and 96 state
   * changes in 25 seconds, with the status label strobing asleep/listening.
   *
   * RFC 6455 §7.4.2 reserves 4000-4999 for private use and the code reaches
   * the browser's close handler, so it is the one place a "stop trying" can
   * be said.
   */
  const app = await bridge();
  const origin = `http://127.0.0.1:${app.port}`;
  try {
    const first = new WebSocket(app.url, { origin });
    await new Promise((resolve) => first.on('open', resolve));

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      first.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    const second = new WebSocket(app.url, { origin });
    await new Promise((resolve) => second.on('open', resolve));

    const event = await closed;
    assert.equal(event.code, CLOSE_SUPERSEDED, `closed with ${event.code}, which reads as "retry"`);
    assert.notEqual(event.code, 1000, 'a normal closure is indistinguishable from a blip');
    assert.match(event.reason, /superseded/);
    second.close();
  } finally {
    await app.close();
  }
});

test('the media frame kinds the browser sends are the ones the server reads', () => {
  // A guard against the two halves drifting: the browser tags frames by these
  // numbers and the server switches on them, and nothing else connects them.
  const round = (kind: number) => decodeMediaFrame(Uint8Array.from([kind, 1, 2])).kind;
  assert.equal(round(MediaKind.MIC_PCM16), MediaKind.MIC_PCM16);
  assert.equal(round(MediaKind.CAMERA_JPEG), MediaKind.CAMERA_JPEG);
  assert.equal(round(MediaKind.SCREEN_JPEG), MediaKind.SCREEN_JPEG);
});

async function collect(url: string, origin: string, count: number): Promise<ServerMessage[]> {
  const socket = new WebSocket(url, { origin });
  const messages: ServerMessage[] = [];
  await new Promise<void>((resolve) => {
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      messages.push(JSON.parse(String(data)) as ServerMessage);
      if (messages.length >= count) resolve();
    });
    setTimeout(resolve, 2000).unref();
  });
  socket.close();
  return messages;
}
