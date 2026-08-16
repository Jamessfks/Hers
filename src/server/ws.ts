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
  CLOSE_SUPERSEDED,
  MediaKind,
  SCREEN_ACTIVITIES,
  decodeMediaFrame,
  encodeMediaFrame,
  parseClientMessage,
} from '../shared/protocol.ts';
import type { ClientMessage, SenseName, ServerMessage } from '../shared/protocol.ts';
import { Companion } from '../core/session/companion.ts';
import { maskKey } from './setup.ts';
import type { Brain } from '../core/session/brain.ts';
import { readProfileFiles, saveProfileFiles } from '../core/profile/profile.ts';
import { AvatarError, isGesture } from '../core/avatar/studio.ts';

/** A screen frame at 1080p JPEG is comfortably under this; nothing legitimate is not. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * How long the conversation survives with nobody connected.
 *
 * The companion deliberately outlives the socket, so that reloading the page
 * does not end the conversation, reset her mood or start a second billed Gemini
 * session. But *forever* is the wrong number: close the tab and go to lunch,
 * and she would sit there holding a live session open, being prompted to say
 * something into the void every three minutes, all afternoon. Ninety seconds is
 * comfortably longer than a reload and far shorter than lunch.
 */
const ORPHAN_GRACE_MS = 90_000;

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
  #orphanTimer: ReturnType<typeof setTimeout> | null = null;

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

    // Without this, an error on the server socket is an unhandled 'error'
    // event, which in Node means the whole process dies — taking a live
    // conversation with it because something went wrong with a listener.
    this.#wss.on('error', (error) => {
      console.warn(`websocket server: ${error.message}`);
    });
  }

  async close(): Promise<void> {
    this.#cancelOrphanTimer();
    await this.#companion?.sleep();
    this.#companion = null;
    for (const client of this.#wss.clients) client.close(1001, 'Anna is shutting down');
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  // -------------------------------------------------------------------------

  async #accept(socket: WebSocket, request: IncomingMessage): Promise<void> {
    void request;

    this.#cancelOrphanTimer();
    const previous = this.#socket;
    this.#socket = socket;
    if (previous && previous.readyState === previous.OPEN) {
      /*
       * The code matters more than the message.
       *
       * Closed with 1000, the evicted tab reads a normal closure and
       * reconnects — which evicts the tab that just replaced it, which
       * reconnects, and so on at about two hertz for as long as both are open.
       * A private-use code is a fact the other end can act on: it stops.
       */
      previous.close(CLOSE_SUPERSEDED, 'superseded');
    }

    const companion = this.#ensureCompanion();
    this.#sendOpening(socket);
    if (companion.live) sendJson(socket, { t: 'state', state: 'listening' });

    socket.on('message', (data, isBinary) => {
      void this.#onMessage(socket, data as Buffer, isBinary);
    });
    const dropped = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#armOrphanTimer();
    };
    socket.on('close', dropped);
    socket.on('error', dropped);
  }

  /**
   * The conversation this page is having, made if there is not one.
   *
   * The companion outlives the socket on purpose — a tab reload should not end
   * the conversation, restart the mood, or re-bill a fresh Gemini session — but
   * it does not outlive a reset, which throws away the memory underneath it. So
   * this is called on every inbound message and not only on connect: after a
   * reset the page is still open and still talking, and the tab going silent
   * until somebody reloads it is not a way to meet someone new.
   */
  #ensureCompanion(): Companion {
    if (this.#companion) return this.#companion;
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
            caption: item.label,
          }),
        move: (gesture) => this.#send({ t: 'move', gesture }),
        trouble: (message) => this.#send({ t: 'trouble', message }),
      },
    });
    return this.#companion;
  }

  /** Who she is, what she looks like, and what has been said so far. */
  #sendOpening(socket: WebSocket): void {
    const brain = this.#options.brain;
    sendJson(socket, {
      t: 'ready',
      version: this.#options.version,
      model: brain.config.model,
      voice: brain.profile.voice.voice,
      senses: this.#companion?.situation.senses ?? {
        hearing: false,
        sight: false,
        screen: false,
      },
      configured: Boolean(brain.config.geminiApiKey),
      keyHint: maskKey(brain.config.geminiApiKey),
      telegram: Boolean(brain.config.telegram),
      livekit: Boolean(brain.config.livekit),
      cameraFps: brain.config.cameraFps,
      screenFps: brain.config.screenFps,
    });
    sendJson(socket, { t: 'mood', mood: brain.mood.read() });
    sendJson(socket, { t: 'avatar', avatar: brain.avatar.state() });
    sendJson(socket, {
      t: 'history',
      turns: brain.memory.liveTranscript(40).map((turn) => ({
        speaker: turn.speaker,
        text: turn.text,
        at: turn.at,
      })),
    });
  }

  async #onMessage(socket: WebSocket, data: Buffer, isBinary: boolean): Promise<void> {
    const companion = this.#ensureCompanion();

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
        if (typeof message.text !== 'string') return;
        /*
         * Typing to her while she is asleep is a request to talk to her.
         *
         * The browser does send `wake` as well, but the two messages are
         * handled concurrently and there is no ordering between them: the text
         * would reach a companion with no session, be filed into memory, and
         * get no answer. Which is precisely what the first message after
         * setting up a key is. Waking here is ordered by the `await` and is a
         * no-op when a session already exists.
         */
        if (!companion.live) await companion.wake();
        companion.say(message.text.slice(0, 4000));
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

      case 'screen': {
        // Validated rather than trusted: it arrives over a socket, and an
        // unrecognised word would end up in a prompt.
        if (!SCREEN_ACTIVITIES.includes(message.activity)) return;
        companion.noteScreen(message.activity, Number(message.stillSeconds) || 0);
        return;
      }

      case 'interrupt':
        companion.interrupt();
        return;

      case 'memory.load':
        sendJson(socket, this.#memory());
        return;

      case 'memory.edit':
        await this.#options.brain.memory.reword(Number(message.id), String(message.text ?? ''));
        sendJson(socket, this.#memory());
        return;

      case 'memory.forget':
        this.#options.brain.memory.forget(Number(message.id));
        sendJson(socket, this.#memory());
        return;

      case 'memory.add': {
        const text = String(message.text ?? '').trim();
        if (!text) return;
        // Typed by the owner, so it starts as certain as anything gets.
        await this.#options.brain.memory.remember('identity', text.slice(0, 500), {
          confidence: 0.95,
        });
        sendJson(socket, this.#memory());
        return;
      }

      case 'avatar.load':
        sendJson(socket, { t: 'avatar', avatar: this.#options.brain.avatar.state() });
        return;

      case 'avatar.render': {
        const gesture = message.gesture;
        if (!isGesture(gesture)) return;
        // Deliberately not awaited: a render takes minutes, and the socket has
        // to stay responsive — including for the message that says it failed.
        void this.#render(gesture, Number(message.seconds) || undefined);
        return;
      }

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

  #memory(): ServerMessage {
    const memory = this.#options.brain.memory;
    return {
      t: 'memory',
      facts: memory.allFacts().map((fact) => ({
        id: fact.id,
        kind: fact.kind,
        text: fact.text,
        confidence: fact.confidence,
      })),
      summary: memory.runningSummary() ?? '',
    };
  }

  /** Tells whoever is connected that the photograph or the clips changed. */
  announceAvatar(): void {
    this.#send({ t: 'avatar', avatar: this.#options.brain.avatar.state() });
  }

  /**
   * Ends the conversation and lets go of it entirely.
   *
   * Different from `close`, which is for shutdown: the socket stays up and the
   * page stays open. This is what has to happen before the memory underneath a
   * companion is deleted — a live session holding a `Brain` whose database has
   * been unlinked would go on writing turns into nothing.
   */
  async endSession(): Promise<void> {
    this.#cancelOrphanTimer();
    const companion = this.#companion;
    this.#companion = null;
    await companion?.sleep();
  }

  /**
   * Repaints the whole interface from a brain that has just changed underneath
   * it — a key that has come into force, or everything having been deleted.
   *
   * Everything is re-sent rather than a delta: after a reset, the correct
   * transcript, memory, mood, avatar and configuration are all different at
   * once, and a browser that patched some of them would be showing a mixture of
   * two Annas.
   */
  refresh(): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    this.#ensureCompanion();
    this.#sendOpening(socket);
    sendJson(socket, this.#memory());
    sendJson(socket, { t: 'state', state: this.#companion?.live ? 'listening' : 'asleep' });
  }

  /**
   * One gesture render, start to finish, reported as it goes.
   *
   * The `avatar` message is sent three times on purpose — before, on failure,
   * and after. A render is minutes long and costs money, so "nothing appears to
   * be happening" is not an acceptable state for the interface to sit in.
   */
  async #render(gesture: string, seconds: number | undefined): Promise<void> {
    const avatar = this.#options.brain.avatar;
    if (!isGesture(gesture)) return;

    this.announceAvatar();
    try {
      await avatar.render(gesture, { ...(seconds ? { seconds } : {}) });
      this.#send({ t: 'trouble', message: `She can ${gesture.replace('_', ' ')} now.` });
    } catch (error) {
      this.#send({
        t: 'trouble',
        message: error instanceof AvatarError ? error.message : `That render failed: ${String(error)}`,
      });
    } finally {
      this.announceAvatar();
    }
  }

  /**
   * Nobody is connected. Give them a moment to come back, then let her rest.
   */
  #armOrphanTimer(): void {
    this.#cancelOrphanTimer();
    this.#orphanTimer = setTimeout(() => {
      this.#orphanTimer = null;
      if (this.#socket) return;
      const companion = this.#companion;
      this.#companion = null;
      void companion?.sleep();
    }, ORPHAN_GRACE_MS);
    this.#orphanTimer.unref?.();
  }

  #cancelOrphanTimer(): void {
    if (this.#orphanTimer) clearTimeout(this.#orphanTimer);
    this.#orphanTimer = null;
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
