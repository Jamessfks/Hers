/**
 * The browser's end of the conversation.
 *
 * Two decisions here are worth stating outright.
 *
 * **Origin is checked, and rejecting is the default.** WebSockets are exempt
 * from the same-origin policy: any page on the internet, in a browser that is
 * already sitting on this machine, can open `ws://127.0.0.1:5175/ws` and start
 * talking. Binding to localhost is not protection against that — the attacker
 * *is* on localhost. So the handshake is refused unless the `Origin` header is
 * one this server actually serves from. This is the single most important
 * twenty lines in the server.
 *
 * **There is one desktop conversation, not one per tab.** A second tab opening
 * a second Live session would mean two Annas with one memory, two sets of
 * billing, and both of them talking. The newest tab takes the conversation and
 * the previous one is told why it went quiet.
 */

import type { IncomingMessage, Server } from 'node:http';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import {
  MediaKind,
  decodeMediaFrame,
  encodeMediaFrame,
  parseClientMessage,
} from '../shared/protocol.ts';
import type { ClientMessage, SenseName, ServerMessage } from '../shared/protocol.ts';
import { Companion } from '../core/session/companion.ts';
import type { Brain } from '../core/session/brain.ts';
import { readProfileFiles, saveProfileFiles } from '../core/profile/profile.ts';

/** A screen frame at 1080p JPEG is comfortably under this; nothing legitimate is not. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export interface WebBridgeOptions {
  brain: Brain;
  server: Server;
  /** Origins the handshake will accept. */
  allowedOrigins: Set<string>;
  version: string;
}

export class WebBridge {
  readonly #options: WebBridgeOptions;
  readonly #wss: WebSocketServer;
  #socket: WebSocket | null = null;
  #companion: Companion | null = null;

  constructor(options: WebBridgeOptions) {
    this.#options = options;
    this.#wss = new WebSocketServer({
      server: options.server,
      path: '/ws',
      maxPayload: MAX_PAYLOAD_BYTES,
      verifyClient: ({ origin, req }, done) => {
        // A non-browser client (curl, a test, the doctor command) sends no
        // Origin at all. That is allowed: the header exists to stop *pages*
        // from reaching in, and a page always sends one.
        if (!origin) return done(true);
        if (options.allowedOrigins.has(origin)) return done(true);
        done(false, 403, 'Origin not allowed');
        void req;
      },
    });

    this.#wss.on('connection', (socket, request) => void this.#accept(socket, request));
  }

  async close(): Promise<void> {
    await this.#companion?.sleep();
    this.#companion = null;
    for (const client of this.#wss.clients) client.close(1001, 'Anna is shutting down');
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  // -------------------------------------------------------------------------

  async #accept(socket: WebSocket, request: IncomingMessage): Promise<void> {
    void request;

    const previous = this.#socket;
    this.#socket = socket;
    if (previous && previous.readyState === previous.OPEN) {
      sendJson(previous, {
        t: 'trouble',
        message: 'You opened Anna in another tab. She is over there now.',
      });
      previous.close(1000, 'superseded');
    }

    // The companion outlives the socket on purpose: a tab reload should not end
    // the conversation, restart the mood, or re-bill a fresh Gemini session.
    if (!this.#companion) {
      this.#companion = new Companion({
        brain: this.#options.brain,
        channel: 'desktop',
        sink: {
          audio: (pcm) => this.#sendMedia(MediaKind.ANNA_PCM24, pcm),
          transcript: (who, text, final) => this.#send({ t: 'transcript', who, text, final }),
          state: (state) => this.#send({ t: 'state', state }),
          mood: (mood) => this.#send({ t: 'mood', mood }),
          interrupted: () => this.#send({ t: 'interrupted' }),
          show: (item) =>
            this.#send({
              t: 'show',
              url: `/gallery/${encodeURIComponent(item.name)}`,
              kind: item.kind,
              caption: item.caption,
            }),
          trouble: (message) => this.#send({ t: 'trouble', message }),
        },
      });
    }

    const brain = this.#options.brain;
    sendJson(socket, {
      t: 'ready',
      version: this.#options.version,
      model: brain.config.model,
      voice: brain.profile.voice.voice,
      senses: this.#companion.situation.senses,
      configured: Boolean(brain.config.geminiApiKey),
      telegram: Boolean(brain.config.telegram),
      livekit: Boolean(brain.config.livekit),
    });
    sendJson(socket, { t: 'mood', mood: brain.mood.read() });
    if (this.#companion.live) sendJson(socket, { t: 'state', state: 'listening' });

    socket.on('message', (data, isBinary) => {
      void this.#onMessage(socket, data as Buffer, isBinary);
    });
    socket.on('close', () => {
      if (this.#socket === socket) this.#socket = null;
    });
    socket.on('error', () => {
      if (this.#socket === socket) this.#socket = null;
    });
  }

  async #onMessage(socket: WebSocket, data: Buffer, isBinary: boolean): Promise<void> {
    const companion = this.#companion;
    if (!companion) return;

    if (isBinary) {
      const { kind, payload } = decodeMediaFrame(data);
      const frame = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
      if (kind === MediaKind.MIC_PCM16) companion.hear(frame);
      else if (kind === MediaKind.CAMERA_JPEG) companion.see(frame, 'camera');
      else if (kind === MediaKind.SCREEN_JPEG) companion.see(frame, 'screen');
      return;
    }

    const message = parseClientMessage(data.toString('utf8'));
    if (!message) return;
    await this.#onControl(socket, companion, message);
  }

  async #onControl(
    socket: WebSocket,
    companion: Companion,
    message: ClientMessage,
  ): Promise<void> {
    switch (message.t) {
      case 'hello':
        return;

      case 'wake':
        await companion.wake();
        return;

      case 'sleep':
        await companion.sleep();
        return;

      case 'say':
        if (typeof message.text === 'string') companion.say(message.text.slice(0, 4000));
        return;

      case 'sense': {
        const sense = message.sense;
        if (!isSense(sense)) return;
        companion.setSense(sense, message.on === true);
        this.#send({ t: 'sense', sense, on: message.on === true });
        return;
      }

      case 'presence':
        companion.notePresence(Number(message.idleSeconds) || 0, message.tabVisible !== false);
        return;

      case 'interrupt':
        companion.interrupt();
        return;

      case 'profile.load':
        sendJson(socket, {
          t: 'profile',
          files: await readProfileFiles(this.#options.brain.config.profileDir),
        });
        return;

      case 'profile.save': {
        if (typeof message.files !== 'object' || message.files === null) return;
        await saveProfileFiles(this.#options.brain.config.profileDir, message.files);
        await this.#options.brain.reloadProfile();
        sendJson(socket, {
          t: 'profile',
          files: await readProfileFiles(this.#options.brain.config.profileDir),
        });
        // Honest about when it lands: a Live session's system instruction is
        // fixed at setup, so this is the next wake, not this sentence.
        this.#send({
          t: 'trouble',
          message: 'Saved. She picks up the changes the next time she wakes.',
        });
        return;
      }

      default:
        return;
    }
  }

  #send(message: ServerMessage): void {
    if (this.#socket) sendJson(this.#socket, message);
  }

  #sendMedia(kind: number, payload: Buffer): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(encodeMediaFrame(kind as MediaKind, payload), { binary: true });
  }
}

function sendJson(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function isSense(value: unknown): value is SenseName {
  return value === 'hearing' || value === 'sight' || value === 'screen';
}
