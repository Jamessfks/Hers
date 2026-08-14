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
  | { kind: 'ambient'; description: string; at: number };

export type SenseKind = SenseEvent['kind'];

// ---------------------------------------------------------------------------
// Configuration surfaced to the settings UI
// ---------------------------------------------------------------------------

export type LlmProviderId = 'anthropic' | 'openai' | 'google';
export type TtsProviderId = 'cartesia' | 'elevenlabs' | 'hume';
export type SttProviderId = 'deepgram' | 'openai';
export type AvatarRendererId = 'vrm' | 'heygen' | 'tavus';

export interface AnnaConfig {
  llm: { provider: LlmProviderId; model: string };
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
  /** renderer -> main: user clicked through to a window control. */
  window: 'anna:window',
} as const;

export type BrainState = 'idle' | 'listening' | 'thinking' | 'speaking';
