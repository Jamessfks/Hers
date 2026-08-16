/**
 * The wire between the browser and the local Anna server.
 *
 * Twoframe kinds, on purpose:
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
  /** Server -> browser. Anna's voice, PCM signed 16-bit little-endian, 24kHz mono. */
  ANNA_PCM24: 0x81,
} as const;

export type MediaKind = (typeof MediaKind)[keyof typeof MediaKind];

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
  /** Something the user typed rather than said. */
  | { t: 'say'; text: string }
  /** A sense was switched on or off in the UI. */
  | { t: 'sense'; sense: SenseName; on: boolean }
  /**
   * The user is present and doing things, or is not.
   *
   * The browser cannot see which application has focus, and should not try —
   * what it can honestly report is whether this tab has been touched, which is
   * enough for Anna to tell "sitting here quietly" from "gone".
   */
  | { t: 'presence'; idleSeconds: number; tabVisible: boolean }
  /** Stop talking, now. Sent when the user starts speaking over her. */
  | { t: 'interrupt' }
  /** Start or restart the conversation. */
  | { t: 'wake' }
  /** Close the live session and stop the clock. */
  | { t: 'sleep' }
  /** Write changes back to the profile folder. */
  | { t: 'profile.save'; files: Record<string, string> }
  /** Ask for the profile folder as it is on disk. */
  | { t: 'profile.load' };

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

export type ServerMessage =
  /** First message on every connection. */
  | {
      t: 'ready';
      version: string;
      model: string;
      voice: string;
      senses: Record<SenseName, boolean>;
      /** False when the server has no Gemini key; the UI shows setup instead. */
      configured: boolean;
      telegram: boolean;
      livekit: boolean;
      /**
       * Frames per second the server will actually forward.
       *
       * Sent so the browser can throttle at the source. The server enforces the
       * same limit regardless — this is to stop the bytes being produced, not
       * to be trusted.
       */
      cameraFps: number;
      screenFps: number;
    }
  | { t: 'state'; state: ConnectionState }
  | { t: 'mood'; mood: MoodReadout }
  /**
   * A line of conversation.
   *
   * `final` is false for the running transcription of speech in progress and
   * true once the turn is closed. The UI replaces rather than appends while
   * false, or the transcript stutters.
   */
  | { t: 'transcript'; who: 'user' | 'anna'; text: string; final: boolean }
  /** Anna's audio was cut off. Drop whatever is still queued for playback. */
  | { t: 'interrupted' }
  | { t: 'sense'; sense: SenseName; on: boolean }
  /** Something went wrong, phrased for a person rather than a log. */
  | { t: 'trouble'; message: string }
  /** A picture or clip Anna chose to show. Served from /gallery. */
  | { t: 'show'; url: string; kind: 'image' | 'clip'; caption?: string }
  | { t: 'profile'; files: Record<string, string> };

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
