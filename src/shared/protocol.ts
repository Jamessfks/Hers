/**
 * The wire contract between Anna's brain (Electron main process) and her body
 * (the renderer that draws the VRM).
 *
 * Everything that crosses the process boundary is declared here and nowhere
 * else. If a message is not in this file it does not exist.
 */

// ---------------------------------------------------------------------------
// Body: what the renderer is asked to do
// ---------------------------------------------------------------------------

/**
 * A single beat of performance. The brain emits these as a stream while the
 * model is still generating, so Anna starts moving and speaking before she has
 * finished deciding what to say — the same trick that makes a stage actor read
 * as alive rather than as a recording.
 */
export type PerformanceEvent =
  /** A clause of speech, already chunked at a natural breath point. */
  | { kind: 'say'; text: string; clauseId: number }
  /** Play a named clip from the gesture library. */
  | { kind: 'gesture'; name: GestureName; intensity?: number }
  /** Cross-fade the face into a named expression. */
  | { kind: 'expression'; name: ExpressionName; weight?: number }
  /** Where Anna's eyes go. `user` means the webcam-tracked head position. */
  | { kind: 'gaze'; target: 'user' | 'away' | 'down' | 'screen' }
  /** Anna's turn is over; the body should settle back to idle. */
  | { kind: 'turn-end'; turnId: string }
  /** Anna was interrupted mid-turn and must stop immediately. */
  | { kind: 'barge-in' };

/**
 * The gesture library. Deliberately small and hand-picked: an animation that
 * fires at the wrong moment is worse than no animation at all, and a large
 * library makes the model's choice noisier. Grow this only with clips that
 * have an unambiguous emotional meaning.
 */
export const GESTURE_NAMES = [
  'nod',
  'shake_head',
  'tilt_head',
  'lean_in',
  'lean_back',
  'shrug',
  'wave',
  'point_at_user',
  'hands_behind_back',
  'hand_to_chest',
  'cover_mouth_laugh',
  'stretch',
  'look_away_thinking',
  'reach_toward_user',
  'sit_down',
  'stand_up',
  'sway',
  'fidget',
] as const;
export type GestureName = (typeof GESTURE_NAMES)[number];

/**
 * Facial expressions. These map onto VRM 1.0 standard expression presets where
 * one exists, and onto custom blendshapes otherwise.
 */
export const EXPRESSION_NAMES = [
  'neutral',
  'happy',
  'warm',
  'amused',
  'sad',
  'concerned',
  'surprised',
  'skeptical',
  'playful',
  'smirk',
  'thoughtful',
  'tender',
] as const;
export type ExpressionName = (typeof EXPRESSION_NAMES)[number];

// ---------------------------------------------------------------------------
// Senses: what the world tells the brain
// ---------------------------------------------------------------------------

export type SenseEvent =
  | { kind: 'user-speech'; text: string; final: boolean; at: number }
  | { kind: 'user-typed'; text: string; at: number }
  | {
      kind: 'presence';
      /** Is the user in front of the machine at all? */
      present: boolean;
      /** Free-text read of the user from the vision model, e.g. "slumped, rubbing eyes". */
      read?: string;
      at: number;
    }
  | {
      kind: 'activity';
      app: string;
      windowTitle: string;
      /** Seconds since the last keyboard or mouse input. */
      idleSeconds: number;
      at: number;
    }
  | { kind: 'calendar'; summary: string; startsInMinutes: number; at: number }
  | { kind: 'ambient'; description: string; at: number }
  /**
   * A finished utterance, still as audio. Transcription happens in main so the
   * renderer never needs a provider key. See core/speech/stt.ts.
   */
  | { kind: 'user-audio'; audio: Uint8Array; mimeType: string; at: number }
  /**
   * A single camera frame, JPEG, base64. Sampled on a slow timer and never
   * stored — main sends it to the vision model and keeps only the sentence
   * that comes back.
   */
  | { kind: 'camera-frame'; jpegBase64: string; at: number };

export type SenseKind = SenseEvent['kind'];

// ---------------------------------------------------------------------------
// Configuration surfaced to the settings UI
// ---------------------------------------------------------------------------

export type LlmProviderId = 'anthropic' | 'openai' | 'google';
export type TtsProviderId = 'cartesia' | 'elevenlabs' | 'hume';
export type SttProviderId = 'deepgram' | 'openai';
export type AvatarRendererId = 'vrm' | 'heygen' | 'tavus';

export interface AnnaConfig {
  llm: {
    provider: LlmProviderId;
    /** The model actually used. Always belongs to `provider`. */
    model: string;
    /**
     * What was last chosen for each provider.
     *
     * Without this, switching provider to try something and switching back
     * silently drops your model choice — and because the two settings live in
     * different fields, the loss is invisible until a reply comes back from the
     * wrong model.
     */
    modelByProvider?: Partial<Record<LlmProviderId, string>>;
  };
  tts: { provider: TtsProviderId; voiceId: string };
  stt: { provider: SttProviderId };
  avatar: { renderer: AvatarRendererId; modelPath: string };
  senses: {
    camera: boolean;
    microphone: boolean;
    screenActivity: boolean;
    calendar: boolean;
    /** How often the camera is sampled, in seconds. Never faster than 15. */
    cameraIntervalSeconds: number;
  };
  presence: {
    /** Anna may start a conversation on her own. */
    proactive: boolean;
    /** Never speak first more than this often, in minutes. */
    minMinutesBetweenOpeners: number;
    /** Hours during which Anna stays quiet unless spoken to, e.g. [0, 8]. */
    quietHours: [number, number] | null;
  };
}

// ---------------------------------------------------------------------------
// IPC channel names
// ---------------------------------------------------------------------------

export const IPC = {
  /** main -> renderer: a beat of performance. */
  perform: 'anna:perform',
  /** main -> renderer: audio for the current clause, as a transferable buffer. */
  audio: 'anna:audio',
  /** renderer -> main: something the senses picked up. */
  sense: 'anna:sense',
  /** renderer -> main: read or write configuration. */
  configGet: 'anna:config:get',
  configSet: 'anna:config:set',
  /** renderer -> main: store a provider key in the OS keychain. */
  keySet: 'anna:key:set',
  keyStatus: 'anna:key:status',
  /** main -> renderer: brain state changed (thinking, speaking, listening). */
  state: 'anna:state',
  /** main -> renderer: something went wrong, phrased for a human. */
  trouble: 'anna:trouble',
  /** renderer -> main: user clicked through to a window control. */
  window: 'anna:window',
  /** renderer -> main: persist a dropped .vrm; returns its stored id. */
  characterSave: 'anna:character:save',
  /** renderer -> main: read the stored character back as bytes. */
  characterLoad: 'anna:character:load',
  /** renderer -> main: open a native file picker for a .vrm. */
  characterPick: 'anna:character:pick',

  // -- settings window ------------------------------------------------------

  /** renderer -> main: bring up the settings window. */
  settingsOpen: 'anna:settings:open',
  /** renderer -> main: check a key against the provider before storing it. */
  keyValidate: 'anna:key:validate',
  /** renderer -> main: forget a stored key. */
  keyDelete: 'anna:key:delete',
  /** renderer -> main: models this account can actually use. */
  modelsList: 'anna:models:list',
  /** renderer -> main: voices available on the configured voice provider. */
  voicesList: 'anna:voices:list',
  /** renderer -> main: synthesise a sample line so a voice can be auditioned. */
  voicePreview: 'anna:voice:preview',
  /** renderer -> main: counts and a sample of what Anna remembers. */
  memoryStats: 'anna:memory:stats',
  memoryFacts: 'anna:memory:facts',
  memoryForget: 'anna:memory:forget',
  memoryWipe: 'anna:memory:wipe',
  /** renderer -> main: which macOS permissions are actually granted. */
  permissions: 'anna:permissions',
  /** main -> renderer: configuration changed somewhere else. */
  configChanged: 'anna:config:changed',
  /** main -> renderer: she was hidden or brought back. */
  visibility: 'anna:visibility',
  /** main -> renderer: take a frame now, do not wait for the timer. */
  cameraCapture: 'anna:camera:capture',
  /**
   * renderer -> main: something went wrong in the body.
   *
   * The renderer's console is not reachable from a packaged app, so a failure
   * there — a character that will not load, a WebGL context that will not
   * create — is invisible to anyone debugging from outside. This puts it in the
   * diagnostics file alongside everything else.
   */
  bodyReport: 'anna:body:report',
  /** main -> renderer: demo script spoke on the user's behalf; echo it. */
  demoSaid: 'anna:demo:said',
} as const;

// ---------------------------------------------------------------------------
// Settings payloads
// ---------------------------------------------------------------------------

/** What kind of provider a key belongs to. Maps onto the SecretName prefix. */
export type KeyKind = 'llm' | 'tts' | 'stt';

export interface KeyStatus {
  present: boolean;
  /** Masked tail, e.g. "••••a91f". Never the key itself. */
  hint: string;
}

export interface VoiceOption {
  id: string;
  name: string;
  description?: string;
}

export interface MemoryStats {
  turns: number;
  facts: number;
  /** Oldest turn timestamp, or null when memory is empty. */
  since: number | null;
  summary: string | null;
}

export interface MemoryFactView {
  id: number;
  kind: string;
  text: string;
  confidence: number;
  lastSeenAt: number;
  recallCount: number;
}

/**
 * Granted macOS permissions, as observed rather than as declared.
 *
 * Checked by attempting the cheapest real read for each one. `Info.plist`
 * entries say what an app *may* ask for; only a real call says what it actually
 * has, and the settings screen needs the truth to explain why Anna has stopped
 * noticing things.
 */
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'unknown';

export interface PermissionReport {
  /** Read via a non-prompting API, so this is always a real answer. */
  accessibility: boolean;
  /**
   * Only ever probed when the calendar sense is already switched on, because
   * the probe itself triggers the macOS consent dialog. Reported as
   * `not-determined` otherwise.
   */
  calendar: PermissionState;
  /** Camera and microphone are asked for by the renderer, not probed here. */
  camera: PermissionState;
  microphone: PermissionState;
}

export type BrainState = 'idle' | 'listening' | 'thinking' | 'speaking';
