/**
 * The browser's socket to the local server.
 *
 * Reconnects, because the server restarting during development is the normal
 * case and a page that has to be reloaded by hand every time is a page nobody
 * develops against. Backoff is short — this is a connection to localhost, so a
 * failure is either "not up yet" or "not coming back", and both are best served
 * by trying again in a moment.
 *
 * Outgoing media is dropped rather than queued while the socket is down, for
 * the same reason it is dropped inside the live session: a second of audio from
 * before the gap is not worth hearing after it.
 */

import {
  CLOSE_SUPERSEDED,
  MediaKind,
  decodeMediaFrame,
  encodeMediaFrame,
} from '../shared/protocol.ts';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';

const BACKOFF_MS = [250, 500, 1000, 2000, 4000];

export interface ConnectionHandlers {
  onMessage(message: ServerMessage): void;
  /** Anna's voice: PCM signed 16-bit little-endian, 24kHz mono. */
  onAudio(pcm: ArrayBuffer): void;
  /** `reconnected` is false the first time, true after a drop. */
  onOpen(reconnected: boolean): void;
  onClose(): void;
  /** Another tab took the conversation. This one has stopped trying. */
  onSuperseded(): void;
}

export class Connection {
  readonly #handlers: ConnectionHandlers;
  #socket: WebSocket | null = null;
  #attempt = 0;
  #closed = false;
  #everConnected = false;
  #timer: number | null = null;

  constructor(handlers: ConnectionHandlers) {
    this.#handlers = handlers;
  }

  get open(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.#closed = false;
    this.#openSocket();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#socket?.close();
    this.#socket = null;
  }

  send(message: ClientMessage): void {
    if (!this.open) return;
    this.#socket?.send(JSON.stringify(message));
  }

  sendMedia(kind: MediaKind, payload: ArrayBuffer): void {
    if (!this.open) return;
    this.#socket?.send(encodeMediaFrame(kind, new Uint8Array(payload)));
  }

  // -------------------------------------------------------------------------

  #openSocket(): void {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    socket.addEventListener('open', () => {
      const reconnected = this.#everConnected;
      this.#everConnected = true;
      this.#attempt = 0;
      this.send({ t: 'hello' });
      this.#handlers.onOpen(reconnected);
    });

    socket.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data === 'string') {
        try {
          this.#handlers.onMessage(JSON.parse(event.data) as ServerMessage);
        } catch {
          // A control frame we cannot parse is a bug on the server, not
          // something to take the page down for.
        }
        return;
      }
      const { kind, payload } = decodeMediaFrame(new Uint8Array(event.data));
      if (kind === MediaKind.ANNA_PCM24) {
        // `slice` rather than a view: the player keeps the buffer past this
        // callback, and a view into a reused frame would be overwritten.
        this.#handlers.onAudio(payload.slice().buffer);
      }
    });

    const retry = (event?: CloseEvent) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#handlers.onClose();

      // Evicted on purpose. Reconnecting here is what caused two open tabs to
      // fight over the conversation indefinitely.
      if (event?.code === CLOSE_SUPERSEDED) {
        this.#closed = true;
        this.#handlers.onSuperseded();
        return;
      }

      if (this.#closed) return;
      const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 4000;
      this.#attempt += 1;
      this.#timer = window.setTimeout(() => this.#openSocket(), delay);
    };

    socket.addEventListener('close', (event) => retry(event));
    socket.addEventListener('error', () => socket.close());
  }
}
