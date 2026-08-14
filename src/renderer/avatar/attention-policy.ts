/**
 * How Anna holds herself, per conversational state.
 *
 * Split out from `body.ts` so it can be read and tested without a WebGL
 * context — and because these numbers are the behaviour, not an implementation
 * detail. They are drawn from conversation-analysis findings rather than
 * invented, and the comments say which, so that changing one is a decision
 * rather than a tweak.
 */

import type { Pose } from './poses.ts';

/** What Anna is doing, which changes how she holds herself. */
export type Attention = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * How much of the time she looks at the person, per state.
 *
 * These are not invented. Conversation-analysis studies put gaze at the partner
 * at roughly three quarters of the time while *listening* and under half while
 * *speaking* — the listener holds a long look with short glances away, and the
 * speaker looks away in long stretches and glances back to hand over the turn.
 * Getting this backwards is what makes an avatar feel like it is staring, and
 * making it constant is what makes one feel blind.
 */
export const GAZE_AT_USER: Record<Attention, number> = {
  idle: 0.35,
  listening: 0.78,
  thinking: 0.2,
  speaking: 0.45,
};

/** How long one fixation lasts before she may look elsewhere, in seconds. */
export const FIXATION_SECONDS: Record<Attention, [number, number]> = {
  idle: [1.6, 5.0],
  listening: [1.8, 4.5],
  thinking: [1.2, 3.0],
  speaking: [0.9, 2.6],
};

/**
 * Seconds between backchannel nods while listening.
 *
 * Listeners produce feedback every ten to twenty seconds in ordinary
 * conversation, and the overwhelming majority of it is a head nod rather than a
 * word. Continuer nods are also visibly *smaller* than agreement nods, which is
 * why these fire at low intensity — a full nod every fifteen seconds reads as
 * a bobblehead.
 */
export const BACKCHANNEL_SECONDS: [number, number] = [9, 22];

/** Posture bias per state, applied under the idle layer. */
export const ATTENTION_POSE: Record<Attention, Pose> = {
  idle: {},
  // Toward the person, chin slightly down: the shape of paying attention.
  listening: { spine: [2.5, 0, 0], chest: [1.5, 0, 0], head: [2, 0, 0] },
  // Weight back, head off to one side: the shape of working something out.
  thinking: { spine: [-2, 0, 0], head: [-2, 6, 3], neck: [0, 3, 0] },
  speaking: { chest: [1, 0, 0] },
};
