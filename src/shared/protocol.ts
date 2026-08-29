/**
 * The wire between the browser and the local server.
 *
 * Two frame kinds, on purpose:
 *
 *   binary  media, and only media. One leading byte says what it is, the rest
 *           is the payload verbatim. Audio arrives every 20-40ms for as long as
 *           the microphone is on, and base64 inside JSON would cost a third
 *           more bytes and a parse on both ends for no benefit at all.
 *   text    JSON control messages, which are rare, structured, and worth being
 *           able to read in a devtools network pane.
 *
 * Everything here is shared by `src/web` (runs in the browser) and `src/server`
 * (runs in Node), so it must not import from either.
 */

import type { ScreenActivity } from './screen-change.ts';

export type { ScreenActivity };

/** The three words the screen watcher can report. Used to validate the wire. */
export const SCREEN_ACTIVITIES: readonly ScreenActivity[] = ['still', 'working', 'switched'];

// ---------------------------------------------------------------------------
// Binary media frames
// ---------------------------------------------------------------------------

/** First byte of every binary frame. */
export const MediaKind = {
  /** Browser -> server. Microphone, PCM signed 16-bit little-endian, 16kHz mono. */
  MIC_PCM16: 0x01,
  /** Browser -> server. A camera still, JPEG. */
  CAMERA_JPEG: 0x02,
  /** Browser -> server. A screen still, JPEG. */
  SCREEN_JPEG: 0x03,
  /** Server -> browser. Her voice, PCM signed 16-bit little-endian, 24kHz mono. */
  HERS_PCM24: 0x81,
} as const;

export type MediaKind = (typeof MediaKind)[keyof typeof MediaKind];

/**
 * Close codes this application defines for itself.
 *
 * RFC 6455 §7.4.2 reserves 4000-4999 for private use, and a code in that range
 * is delivered to the browser's `onclose` handler — which is the whole point.
 * Closing an evicted tab with 1000 "normal closure" gave it no way to tell
 * "you were replaced, stop" from "the network blipped, try again", so it tried
 * again, evicting the tab that replaced it, forever. Measured at 47 sockets in
 * 25 seconds before this existed.
 */
export const CLOSE_SUPERSEDED = 4001;

/** Sample rate Gemini Live expects on the way in. */
export const INPUT_SAMPLE_RATE = 16_000;
/** Sample rate Gemini Live produces on the way out. */
export const OUTPUT_SAMPLE_RATE = 24_000;

export function encodeMediaFrame(kind: MediaKind, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = kind;
  frame.set(payload, 1);
  return frame;
}

export function decodeMediaFrame(frame: Uint8Array): { kind: number; payload: Uint8Array } {
  return { kind: frame[0] ?? 0, payload: frame.subarray(1) };
}

// ---------------------------------------------------------------------------
// Control messages: browser -> server
// ---------------------------------------------------------------------------

/** Which of the three senses a message is about. */
export type SenseName = 'hearing' | 'sight' | 'screen';

export const SENSE_NAMES: readonly SenseName[] = ['hearing', 'sight', 'screen'];

export type ClientMessage =
  /** Sent once on connect. */
  | { t: 'hello' }
  /**
   * The user is present and doing things, or is not.
   *
   * The browser cannot see which application has focus, and should not try —
   * what it can honestly report is whether this tab has been touched, which is
   * enough for her to tell "sitting here quietly" from "gone".
   */
  | { t: 'presence'; idleSeconds: number; tabVisible: boolean }
  /**
   * What the shared screen has been doing.
   *
   * Not a duplicate of the frames: the frames go to Gemini and show *what* is on
   * the screen, and this says whether it has been moving. The arithmetic happens
   * in the browser — see `shared/screen-change.ts` — because comparing two
   * frames server-side would mean decoding every JPEG we currently forward
   * untouched. Sent when the answer changes, not per frame.
   */
  | { t: 'screen'; activity: ScreenActivity; stillSeconds: number }
  /** Stop talking, now. Sent when the user starts speaking over her. */
  | { t: 'interrupt' }
  /** Start or restart the conversation. */
  | { t: 'wake' }
  /** Close the live session and stop the clock. */
  | { t: 'sleep' }
  /** Ask how close she is. */
  | { t: 'intimacy.load' };

// ---------------------------------------------------------------------------
// Control messages: server -> browser
// ---------------------------------------------------------------------------

/** What the server is doing, as one word the UI can render. */
export type ConnectionState =
  | 'asleep'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'reconnecting'
  | 'error';

export interface MoodReadout {
  /** The long-run temperament, -1..1 per axis. Moves over days. */
  baseline: MoodVector;
  /** How she is right now, -1..1 per axis. Moves over minutes. */
  current: MoodVector;
  /** One or two words for the current mood, e.g. "quietly pleased". */
  label: string;
}

export interface MoodVector {
  /** Miserable (-1) to delighted (+1). */
  valence: number;
  /** Flat (-1) to wired (+1). */
  energy: number;
  /** Guarded (-1) to affectionate (+1). */
  warmth: number;
  /** Bored (-1) to absorbed (+1). */
  interest: number;
}

/**
 * What the page is told about the Telegram bot.
 *
 * The token is not here and never will be: it is a bearer credential for a
 * public endpoint, so the browser gets the bot's public username and the chat it
 * is linked to, both of which are already visible to anybody in that chat.
 */
export interface TelegramView {
  configured: boolean;
  /** Without the @. Absent until a token has been checked. */
  username?: string;
  /** The `t.me` link that gets somebody into the chat and past Start. */
  link?: string;
  /** The chat she is allowed to talk to. Absent until somebody has spoken. */
  chatId?: number;
}

export type ServerMessage =
  /** First message on every connection. */
  | {
      t: 'ready';
      version: string;
      model: string;
      /**
       * What she calls herself.
       *
       * On the wire because the browser cannot know it: she chooses it on the
       * first conversation and it is then a fact in her profile folder. The page
       * ships saying "Anna", which is a placeholder, and a companion whose name
       * in the interface disagrees with the name she answers to is two people.
       */
      name: string;
      /**
       * Whether that name is one anybody chose.
       *
       * False while it is still the placeholder the project ships with and she
       * has not had her first conversation — the same pair of conditions
       * `ensureNamed` reads, so a name typed into `identity.md` by hand counts
       * as chosen. The page draws no name at all when this is false, rather than
       * the shipped placeholder: a header reading "Anna" for a companion who has
       * not chosen a name yet is either a lie or a bug, and a stranger cannot
       * tell which.
       */
      named: boolean;
      voice: string;
      /** False when the server has no Gemini key; the UI shows setup instead. */
      configured: boolean;
      /**
       * The last four characters of the key in force, or empty.
       *
       * Enough to tell two keys apart and useless to anybody else. The key
       * itself never leaves the server — Google's own guidance is that it must
       * not be in anything client-side, and a local page is still client-side.
       */
      keyHint: string;
      telegram: boolean;
      /**
       * Frames per second the server will actually forward.
       *
       * Sent so the browser can throttle at the source. The server enforces the
       * same limit regardless — this is to stop the bytes being produced, not
       * to be trusted.
       */
      cameraFps: number;
      screenFps: number;
      /**
       * True when this page is inside the desktop application.
       *
       * The screen sense turns on it: the application grants capture from a
       * remembered source with no prompt, and a browser tab gets the operating
       * system's picker on every `getDisplayMedia` call with no way to remember
       * the answer. So she watches the screen in the app and does not in a tab.
       */
      desktop: boolean;
    }
  | { t: 'state'; state: ConnectionState }
  | { t: 'mood'; mood: MoodReadout }
  /** Server -> browser. The bot, as far as the page is allowed to know. */
  | { t: 'telegram'; telegram: TelegramView }
  /**
   * Server -> browser. She has just chosen her own name.
   *
   * Separate from `ready` because `ready` is sent when the socket opens, and she
   * chooses during her first wake — which is later. Without this the page keeps
   * the placeholder in its header while she introduces herself as something
   * else.
   */
  | { t: 'name'; name: string }
  /** Her audio was cut off. Drop whatever is still queued for playback. */
  | { t: 'interrupted' }
  /** Something went wrong, phrased for a person rather than a log. */
  | { t: 'trouble'; message: string }
  /**
   * How close she is, for the one control that shows it.
   *
   * Sent on connect and after any change. Deliberately a readout rather than a
   * raw number: the stage and the days are what a person understands, and the
   * percentage on its own reads as a score to be farmed.
   */
  | { t: 'intimacy'; intimacy: IntimacyView };

/** Closeness, as the interface needs to draw it. */
export interface IntimacyView {
  /** 0-100. */
  percent: number;
  stage: string;
  /** Accumulated days of real contact. */
  days: number;
  /** Calendar days since they met. 0 when they have not. */
  known: number;
  /** True when the user has set it by hand. */
  pinned: boolean;
  /** Days of contact still needed to reach the next stage. 0 at the top. */
  toNextStage: number;
  nextStage: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    if (typeof (value as { t?: unknown }).t !== 'string') return null;
    return value as ClientMessage;
  } catch {
    return null;
  }
}
