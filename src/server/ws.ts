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
 * a second Live session would mean two of her with one memory, two sets of
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
import type { ClientMessage, ServerMessage, TelegramView } from '../shared/protocol.ts';
import type { Conversation, Origin } from '../core/session/conversation.ts';
import { maskKey } from './setup.ts';
import { daysFor, nextStageAfter } from '../core/intimacy/intimacy.ts';
import type { Brain } from '../core/session/brain.ts';
import { hasChosenName } from '../core/profile/first-run.ts';

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
  /** The one conversation, shared with every other surface. */
  conversation: Conversation;
  server: Server;
  /** Origins the handshake will accept. */
  allowedOrigins: Set<string>;
  /**
   * Whether a client that sends no `Origin` at all may connect.
   *
   * Off. A browser cannot suppress the header, so absence means the caller is
   * not a page — which is not the same as the caller being trustworthy. See the
   * note in `verifyClient`.
   */
  allowHeadless?: boolean;
  version: string;
  /**
   * The bot as the page may know it.
   *
   * A function rather than a value: the bot can be set up while the page is
   * open, and a page that connects afterwards has to be told the current answer
   * rather than the one that was true when this bridge was built.
   */
  telegram?: () => TelegramView;
}

export class WebBridge {
  readonly #options: WebBridgeOptions;
  readonly #wss: WebSocketServer;
  #socket: WebSocket | null = null;
  #attached = false;
  #orphanTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WebBridgeOptions) {
    this.#options = options;
    this.#wss = new WebSocketServer({
      server: options.server,
      path: '/ws',
      maxPayload: MAX_PAYLOAD_BYTES,
      verifyClient: ({ origin, req }, done) => {
        /*
         * A missing Origin used to be allowed, on the reasoning that a page
         * always sends one so absence must mean `curl` or the doctor. The first
         * half is true and the conclusion does not follow: it also meant any
         * other process on the machine, holding no secret, could find the port
         * with one scan and get everything this socket carries — her mood, the
         * key hint, and a microphone she never granted.
         *
         * Nothing legitimate needed it. The website is a page and sends one; the
         * doctor speaks HTTP and never opens this socket; the audit scripts send
         * one. So it is refused, and anybody who genuinely wants a headless
         * client can say so out loud with `HERS_ALLOW_HEADLESS=1`.
         */
        if (!origin) return done(options.allowHeadless === true, 403, 'Origin required');
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
    this.#options.conversation.detach('web');
    this.#attached = false;
    await this.#options.conversation.sleep();
    for (const client of this.#wss.clients) client.close(1001, 'Hers is shutting down');
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

    this.#attach();
    this.#sendOpening(socket);
    if (this.#options.conversation.live) sendJson(socket, { t: 'state', state: 'listening' });

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
   * Registers the browser as a surface on the one conversation.
   *
   * Everything reaches it, whatever channel it came from. That is the whole
   * point of the tab: OpenClaw's dashboard attaches to the agent's main session
   * so it "lets you see cross-channel context for that agent in one place", and
   * a browser that showed only its own half of the conversation would be the
   * thing this refactor exists to remove. So `origin` is read and ignored here —
   * deliberately, and only here.
   */
  #attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    this.#options.conversation.attach({
      name: 'web',
      audio: (pcm) => this.#sendMedia(MediaKind.HERS_PCM24, pcm),
      // The browser no longer shows a transcript, but the interface is still
      // required — Telegram's surface uses the same event to know what to
      // send back as a message or a voice note.
      transcript: () => undefined,
      state: (state) => this.#send({ t: 'state', state }),
      mood: (mood) => this.#send({ t: 'mood', mood }),
      named: (name) => this.#send({ t: 'name', name }),
      interrupted: () => this.#send({ t: 'interrupted' }),
      trouble: (message) => this.#send({ t: 'trouble', message }),
    });
  }

  /**
   * How close she is, shaped for the one control that shows it.
   *
   * The days-to-next-stage is computed here rather than in the browser because
   * it is the inverse of the curve, and the curve has exactly one home.
   */
  #intimacy(): ServerMessage {
    const readout = this.#options.brain.intimacy.read();
    const next = nextStageAfter(readout.score);
    return {
      t: 'intimacy',
      intimacy: {
        percent: readout.percent,
        stage: readout.stage,
        days: readout.days,
        known: readout.known,
        pinned: readout.pinned,
        toNextStage: next ? Math.max(0, Math.ceil(daysFor(next.from) - readout.days)) : 0,
        nextStage: next?.name ?? '',
      },
    };
  }

  /** Who she is, her mood, and how close she is. */
  #sendOpening(socket: WebSocket): void {
    const brain = this.#options.brain;
    sendJson(socket, {
      t: 'ready',
      version: this.#options.version,
      model: brain.config.model,
      name: brain.profile.identity.name,
      named: hasChosenName(brain.profile.identity),
      voice: brain.profile.voice.voice,
      configured: Boolean(brain.config.geminiApiKey),
      keyHint: maskKey(brain.config.geminiApiKey),
      telegram: Boolean(brain.config.telegram),
      cameraFps: brain.config.cameraFps,
      screenFps: brain.config.screenFps,
      desktop: brain.config.desktop,
    });
    sendJson(socket, { t: 'mood', mood: brain.mood.read() });
    sendJson(socket, this.#intimacy());
    const telegram = this.#options.telegram?.();
    if (telegram) sendJson(socket, { t: 'telegram', telegram });
  }

  async #onMessage(socket: WebSocket, data: Buffer, isBinary: boolean): Promise<void> {
    this.#attach();
    const companion = this.#options.conversation;

    if (isBinary) {
      const { kind, payload } = decodeMediaFrame(data);
      const frame = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
      if (kind === MediaKind.MIC_PCM16) companion.hear(frame, 'web');
      else if (kind === MediaKind.CAMERA_JPEG) companion.see(frame, 'camera', 'web');
      else if (kind === MediaKind.SCREEN_JPEG) companion.see(frame, 'screen', 'web');
      return;
    }

    const message = parseClientMessage(data.toString('utf8'));
    if (!message) return;
    await this.#onControl(socket, companion, message);
  }

  async #onControl(
    socket: WebSocket,
    companion: Conversation,
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

      case 'intimacy.load':
        sendJson(socket, this.#intimacy());
        return;

      default:
        return;
    }
  }

  /**
   * Tells every open page about the bot.
   *
   * Pushed rather than polled because the interesting half of Telegram setup
   * finishes outside the browser: somebody opens the link on a phone and presses
   * Start, and the page they left open at their desk should say so by itself.
   */
  announceTelegram(view: TelegramView): void {
    this.#send({ t: 'telegram', telegram: view });
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
    await this.#options.conversation.sleep();
  }

  /**
   * Repaints the whole interface from a brain that has just changed underneath
   * it — a key that has come into force, or everything having been deleted.
   *
   * Everything is re-sent rather than a delta: after a reset, the mood, the
   * intimacy readout and the configuration are all different at once, and a
   * browser that patched some of them would be showing a mixture of two of
   * her.
   */
  refresh(): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    this.#attach();
    this.#sendOpening(socket);
    sendJson(socket, {
      t: 'state',
      state: this.#options.conversation.live ? 'listening' : 'asleep',
    });
  }

  /**
   * Nobody is connected. Give them a moment to come back, then let her rest.
   */
  #armOrphanTimer(): void {
    this.#cancelOrphanTimer();
    this.#orphanTimer = setTimeout(() => {
      this.#orphanTimer = null;
      if (this.#socket) return;
      /*
       * The tab is gone, so the browser stops being a surface — but the
       * conversation only ends if nothing else is attached. With Telegram
       * connected she is still reachable, and closing the session because
       * somebody shut a browser tab would drop the thread on the phone too.
       */
      this.#options.conversation.detach('web');
      this.#attached = false;
      if (this.#options.conversation.attached.length === 0) {
        void this.#options.conversation.sleep();
      }
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
