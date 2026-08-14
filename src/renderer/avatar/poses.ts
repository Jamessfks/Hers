/**
 * The gesture library, authored as procedural key poses rather than as motion
 * capture clips.
 *
 * Grok's Ani plays hand-authored animations from a studio, selected in context
 * by the model. We cannot licence a motion library, so the clips are written
 * here as keyframed bone offsets on the VRM humanoid rig. Two things that buys
 * us, beyond cost:
 *
 *  - Every gesture works on *any* VRM the user loads, because the humanoid bone
 *    names are part of the spec. A retargeted FBX clip does not.
 *  - Gestures are additive over the idle layer, so breathing and weight shift
 *    keep running underneath a wave instead of being replaced by it. Clip-based
 *    systems have to blend two full-body animations to get the same result, and
 *    usually do not bother, which is why avatars go statue-still mid-gesture.
 *
 * Angles are degrees, converted once at load. Rotations are applied as offsets
 * from the model's own rest pose, so a character authored with arms down and
 * one authored with arms out both read correctly.
 */

import type { GestureName } from '../../shared/protocol.ts';

export type BoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'upperChest'
  | 'neck'
  | 'head'
  | 'leftShoulder'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'leftHand'
  | 'rightShoulder'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'rightHand';

/** Euler offsets in degrees, XYZ order. */
export type Pose = Partial<Record<BoneName, [number, number, number]>>;

export interface Keyframe {
  /** Normalised position in the clip, 0 to 1. */
  at: number;
  pose: Pose;
}

export interface GestureClip {
  durationMs: number;
  keys: Keyframe[];
  /**
   * How strongly this reads. Used to scale the whole clip when the model asks
   * for a softer take with `[nod x0.4]`.
   */
  baseWeight: number;
}

const empty: Pose = {};

/**
 * The standing rest pose, applied underneath everything else by the idle layer.
 *
 * This exists because the VRM humanoid rest pose is a **T-pose**: arms straight
 * out, palms down. That is correct as a rigging convention and absurd as a
 * character standing in your room, so every frame starts by bringing the arms
 * down to a human stance. Skip this and the whole product ships as a scarecrow.
 *
 * The numbers: a VRM's left arm extends along +X, so rotating about Z by -70°
 * swings it down to the side; the right arm extends along -X and needs +70°.
 * Twenty degrees off vertical is where a relaxed arm actually hangs — dead
 * vertical reads as attention, not as ease. The slight elbow bend and forward
 * shoulder roll keep the arms off the hips and stop the silhouette going flat.
 *
 * Every clip in this file is authored *relative to this pose*, which is why
 * `wave` asks for -58 on the right upper arm: from a hanging arm, that raises
 * it to roughly horizontal.
 */
export const REST_POSE: Pose = {
  leftShoulder: [0, 0, -4],
  rightShoulder: [0, 0, 4],
  leftUpperArm: [3, 0, -70],
  rightUpperArm: [3, 0, 70],
  leftLowerArm: [0, -12, -6],
  rightLowerArm: [0, 12, 6],
  leftHand: [0, 0, -4],
  rightHand: [0, 0, 4],
};
export const GESTURE_CLIPS: Record<GestureName, GestureClip> = {
  nod: {
    durationMs: 700,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      { at: 0.3, pose: { head: [14, 0, 0], neck: [6, 0, 0] } },
      { at: 0.6, pose: { head: [-4, 0, 0], neck: [-2, 0, 0] } },
      { at: 1, pose: empty },
    ],
  },

  shake_head: {
    durationMs: 900,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      { at: 0.25, pose: { head: [0, -16, 0], neck: [0, -6, 0] } },
      { at: 0.55, pose: { head: [0, 15, 0], neck: [0, 6, 0] } },
      { at: 0.8, pose: { head: [0, -7, 0] } },
      { at: 1, pose: empty },
    ],
  },

  tilt_head: {
    durationMs: 1400,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      { at: 0.25, pose: { head: [2, 3, 13], neck: [0, 2, 5] } },
      { at: 0.75, pose: { head: [2, 3, 12], neck: [0, 2, 5] } },
      { at: 1, pose: empty },
    ],
  },

  lean_in: {
    durationMs: 1800,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      {
        at: 0.28,
        pose: { hips: [6, 0, 0], spine: [5, 0, 0], chest: [3, 0, 0], head: [-5, 0, 0] },
      },
      {
        at: 0.72,
        pose: { hips: [6, 0, 0], spine: [5, 0, 0], chest: [3, 0, 0], head: [-5, 0, 0] },
      },
      { at: 1, pose: empty },
    ],
  },

  lean_back: {
    durationMs: 1600,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      { at: 0.3, pose: { hips: [-5, 0, 0], spine: [-4, 0, 0], head: [4, 0, 0] } },
      { at: 0.7, pose: { hips: [-5, 0, 0], spine: [-4, 0, 0], head: [4, 0, 0] } },
      { at: 1, pose: empty },
    ],
  },

  shrug: {
    durationMs: 1100,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      {
        at: 0.35,
        pose: {
          leftShoulder: [0, 0, -16],
          rightShoulder: [0, 0, 16],
          leftUpperArm: [0, 0, 14],
          rightUpperArm: [0, 0, -14],
          leftLowerArm: [0, -22, 0],
          rightLowerArm: [0, 22, 0],
          head: [4, 0, 0],
        },
      },
      {
        at: 0.65,
        pose: {
          leftShoulder: [0, 0, -14],
          rightShoulder: [0, 0, 14],
          leftUpperArm: [0, 0, 12],
          rightUpperArm: [0, 0, -12],
          leftLowerArm: [0, -20, 0],
          rightLowerArm: [0, 20, 0],
        },
      },
      { at: 1, pose: empty },
    ],
  },

  wave: {
    durationMs: 1600,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      { at: 0.18, pose: { rightUpperArm: [0, 0, -58], rightLowerArm: [0, -34, -22] } },
      { at: 0.38, pose: { rightUpperArm: [0, 0, -58], rightLowerArm: [0, -34, 12], rightHand: [0, 0, 18] } },
      { at: 0.56, pose: { rightUpperArm: [0, 0, -58], rightLowerArm: [0, -34, -20], rightHand: [0, 0, -14] } },
      { at: 0.74, pose: { rightUpperArm: [0, 0, -58], rightLowerArm: [0, -34, 10], rightHand: [0, 0, 14] } },
      { at: 1, pose: empty },
    ],
  },

  point_at_user: {
    durationMs: 1200,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      { at: 0.25, pose: { rightUpperArm: [-38, 0, -22], rightLowerArm: [0, -14, 0] } },
      { at: 0.6, pose: { rightUpperArm: [-42, 0, -20], rightLowerArm: [0, -10, 0] } },
      { at: 1, pose: empty },
    ],
  },

  hands_behind_back: {
    durationMs: 2200,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      {
        at: 0.3,
        pose: {
          leftUpperArm: [14, 0, 6],
          rightUpperArm: [14, 0, -6],
          leftLowerArm: [0, -46, 0],
          rightLowerArm: [0, 46, 0],
          chest: [-2, 0, 0],
        },
      },
      {
        at: 0.8,
        pose: {
          leftUpperArm: [14, 0, 6],
          rightUpperArm: [14, 0, -6],
          leftLowerArm: [0, -46, 0],
          rightLowerArm: [0, 46, 0],
          chest: [-2, 0, 0],
        },
      },
      { at: 1, pose: empty },
    ],
  },

  hand_to_chest: {
    durationMs: 1900,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      {
        at: 0.28,
        pose: { rightUpperArm: [-24, 0, -26], rightLowerArm: [0, -62, 0], head: [3, -4, 0] },
      },
      {
        at: 0.72,
        pose: { rightUpperArm: [-24, 0, -26], rightLowerArm: [0, -62, 0], head: [3, -4, 0] },
      },
      { at: 1, pose: empty },
    ],
  },

  cover_mouth_laugh: {
    durationMs: 1700,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      {
        at: 0.22,
        pose: { rightUpperArm: [-52, 0, -34], rightLowerArm: [0, -78, 0], head: [-8, 0, 6] },
      },
      {
        at: 0.5,
        pose: { rightUpperArm: [-50, 0, -34], rightLowerArm: [0, -78, 0], head: [-3, 0, 6], chest: [-4, 0, 0] },
      },
      {
        at: 0.72,
        pose: { rightUpperArm: [-52, 0, -34], rightLowerArm: [0, -78, 0], head: [-8, 0, 6] },
      },
      { at: 1, pose: empty },
    ],
  },

  stretch: {
    durationMs: 2600,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      {
        at: 0.35,
        pose: {
          leftUpperArm: [0, 0, 46],
          rightUpperArm: [0, 0, -46],
          spine: [-7, 0, 0],
          chest: [-5, 0, 0],
          head: [-10, 0, 0],
        },
      },
      {
        at: 0.6,
        pose: {
          leftUpperArm: [0, 0, 42],
          rightUpperArm: [0, 0, -42],
          spine: [-6, 0, 0],
          head: [-8, 0, 0],
        },
      },
      { at: 1, pose: empty },
    ],
  },

  look_away_thinking: {
    durationMs: 2000,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      { at: 0.25, pose: { head: [-6, 26, 4], neck: [-2, 10, 0] } },
      { at: 0.7, pose: { head: [-5, 24, 4], neck: [-2, 9, 0] } },
      { at: 1, pose: empty },
    ],
  },

  reach_toward_user: {
    durationMs: 2200,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      {
        at: 0.35,
        pose: {
          rightUpperArm: [-56, 0, -18],
          rightLowerArm: [0, -8, 0],
          rightHand: [-10, 0, 0],
          spine: [4, 0, 0],
        },
      },
      {
        at: 0.65,
        pose: {
          rightUpperArm: [-54, 0, -18],
          rightLowerArm: [0, -8, 0],
          rightHand: [-8, 0, 0],
          spine: [4, 0, 0],
        },
      },
      { at: 1, pose: empty },
    ],
  },

  // `sit_down` and `stand_up` are posture *changes* rather than beats: the
  // final key persists until the opposite gesture fires. The motion layer
  // treats a clip whose last key is non-empty as a held pose.
  sit_down: {
    durationMs: 1800,
    baseWeight: 1,
    keys: [
      { at: 0, pose: empty },
      { at: 1, pose: { hips: [0, 0, 0], spine: [4, 0, 0], chest: [2, 0, 0] } },
    ],
  },

  stand_up: {
    durationMs: 1400,
    baseWeight: 1,
    keys: [
      { at: 0, pose: { spine: [4, 0, 0] } },
      { at: 1, pose: empty },
    ],
  },

  sway: {
    durationMs: 3200,
    baseWeight: 0.7,
    keys: [
      { at: 0, pose: empty },
      { at: 0.25, pose: { hips: [0, 0, 4], spine: [0, 0, -2], head: [0, 0, -3] } },
      { at: 0.75, pose: { hips: [0, 0, -4], spine: [0, 0, 2], head: [0, 0, 3] } },
      { at: 1, pose: empty },
    ],
  },

  fidget: {
    durationMs: 1500,
    baseWeight: 0.6,
    keys: [
      { at: 0, pose: empty },
      { at: 0.3, pose: { leftHand: [0, 0, 12], leftLowerArm: [0, -12, 0] } },
      { at: 0.6, pose: { leftHand: [0, 0, -8], leftLowerArm: [0, -16, 0] } },
      { at: 1, pose: empty },
    ],
  },
};

/** Clips whose final key should be held rather than released. */
export const HELD_GESTURES = new Set<GestureName>(['sit_down']);

/** Samples a clip at normalised time `t`, linearly between keyframes. */
export function sampleClip(clip: GestureClip, t: number): Pose {
  const clamped = Math.min(1, Math.max(0, t));
  let previous = clip.keys[0]!;
  let next = clip.keys.at(-1)!;

  for (let i = 0; i < clip.keys.length - 1; i += 1) {
    const a = clip.keys[i]!;
    const b = clip.keys[i + 1]!;
    if (clamped >= a.at && clamped <= b.at) {
      previous = a;
      next = b;
      break;
    }
  }

  const span = next.at - previous.at;
  const local = span <= 0 ? 1 : (clamped - previous.at) / span;
  const eased = easeInOutCubic(local);

  const bones = new Set<BoneName>([
    ...(Object.keys(previous.pose) as BoneName[]),
    ...(Object.keys(next.pose) as BoneName[]),
  ]);

  const out: Pose = {};
  for (const bone of bones) {
    const from = previous.pose[bone] ?? [0, 0, 0];
    const to = next.pose[bone] ?? [0, 0, 0];
    out[bone] = [
      from[0] + (to[0] - from[0]) * eased,
      from[1] + (to[1] - from[1]) * eased,
      from[2] + (to[2] - from[2]) * eased,
    ];
  }
  return out;
}

/**
 * Ease used between every pair of keys.
 *
 * Linear interpolation is the single most recognisable tell of a cheap avatar:
 * real limbs accelerate out of rest and decelerate into it. Cubic in-out is the
 * cheapest curve that removes the tell.
 */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export const DEG_TO_RAD = Math.PI / 180;
