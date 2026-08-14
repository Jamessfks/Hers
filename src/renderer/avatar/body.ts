/**
 * Anna's body.
 *
 * Three layers, composited every frame, in this order:
 *
 *   1. idle      Always running. Breathing, weight shift, micro-motion of the
 *                head, blinks, eye saccades. This is the layer that decides
 *                whether she reads as alive when she is doing nothing, which is
 *                most of the time.
 *   2. gesture   Additive on top of idle. At most two clips at once, each with
 *                its own fade envelope.
 *   3. speech    Jaw and mouth shapes driven by the audio envelope, plus the
 *                small head motion that comes with talking.
 *
 * The layering is the whole trick. An avatar that swaps to a gesture animation
 * goes rigid everywhere the clip does not touch, and the stillness reads
 * instantly as a machine playing a file. Keeping idle underneath means she is
 * still breathing while she waves.
 */

import type { VRM } from '@pixiv/three-vrm';
import { Euler, Object3D, Quaternion, Vector3 } from 'three';

import type { ExpressionName, GestureName } from '../../shared/protocol.ts';
import {
  DEG_TO_RAD,
  GESTURE_CLIPS,
  HELD_GESTURES,
  sampleClip,
  type BoneName,
  type Pose,
} from './poses.ts';

/** VRM 1.0 expression presets we can rely on existing. */
const EXPRESSION_MAP: Record<ExpressionName, Array<[string, number]>> = {
  neutral: [['neutral', 1]],
  happy: [['happy', 0.85]],
  warm: [
    ['happy', 0.42],
    ['relaxed', 0.5],
  ],
  amused: [
    ['happy', 0.7],
    ['relaxed', 0.25],
  ],
  playful: [
    ['happy', 0.55],
    ['surprised', 0.15],
  ],
  smirk: [
    ['happy', 0.3],
    ['relaxed', 0.35],
  ],
  sad: [['sad', 0.8]],
  concerned: [
    ['sad', 0.45],
    ['relaxed', 0.2],
  ],
  surprised: [['surprised', 0.75]],
  skeptical: [
    ['angry', 0.22],
    ['relaxed', 0.3],
  ],
  thoughtful: [['relaxed', 0.55]],
  tender: [
    ['relaxed', 0.6],
    ['happy', 0.2],
  ],
};

const ALL_PRESETS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;

interface ActiveGesture {
  name: GestureName;
  clip: (typeof GESTURE_CLIPS)[GestureName];
  startedAt: number;
  weight: number;
  held: boolean;
}

/** How long a gesture fades in and out, as a fraction of its duration. */
const FADE = 0.18;
/** Never run more than this many clips at once; more reads as twitching. */
const MAX_CONCURRENT_GESTURES = 2;

export class Body {
  readonly #vrm: VRM;
  readonly #restRotations = new Map<BoneName, Quaternion>();
  readonly #bones = new Map<BoneName, Object3D>();
  #gestures: ActiveGesture[] = [];
  #expression: ExpressionName = 'neutral';
  #expressionWeight = 1;
  #targetExpression: Record<string, number> = {};
  #currentExpression: Record<string, number> = {};

  // Speech
  #mouthOpen = 0;
  #mouthTarget = 0;
  #vowel = 0;

  // Blink
  #blinkAt = 0;
  #blinkPhase = 0;

  // Gaze
  readonly #gazeTarget = new Object3D();
  #gazeMode: 'user' | 'away' | 'down' | 'screen' = 'user';
  /** Where the person actually is, in world space. See {@link setViewer}. */
  readonly #viewer = new Vector3(0, 1.1, 3.8);
  /** Current and next saccade offsets, in radians of arc. */
  readonly #saccade = new Vector3();
  readonly #saccadeTo = new Vector3();
  #saccadeAt = 0;
  #saccadeProgress = 1;

  #time = 0;

  constructor(vrm: VRM) {
    this.#vrm = vrm;
    this.#cacheBones();
    vrm.scene.add(this.#gazeTarget);
    if (vrm.lookAt) vrm.lookAt.target = this.#gazeTarget;
    this.#blinkAt = 1.5 + Math.random() * 2.5;
    this.#scheduleSaccade(0);
  }

  /**
   * Tell Anna where the person watching her is sitting.
   *
   * Without this she looks at a point straight out from her own head, which for
   * a figure framed head-to-toe is well above and behind the viewer — she
   * spends the entire conversation staring over your shoulder. Eye contact is
   * the single cheapest thing that separates a character from a mannequin, and
   * it is worth a parameter.
   */
  setViewer(position: Vector3): void {
    this.#viewer.copy(position);
  }

  // -- Commands from the brain ---------------------------------------------

  playGesture(name: GestureName, intensity = 1): void {
    const clip = GESTURE_CLIPS[name];
    if (!clip) return;

    // A repeated gesture restarts rather than stacking: two overlapping nods
    // add up to one very large nod.
    this.#gestures = this.#gestures.filter((active) => active.name !== name);

    if (name === 'stand_up') {
      this.#gestures = this.#gestures.filter((active) => !HELD_GESTURES.has(active.name));
    }

    if (this.#gestures.length >= MAX_CONCURRENT_GESTURES) {
      // Do not drop the oldest outright, that pops. Push it into its own
      // fade-out by moving its start time to the tail of its envelope.
      const oldest = this.#gestures.shift();
      if (oldest && !oldest.held) {
        const remaining = oldest.clip.durationMs * FADE;
        this.#gestures.push({
          ...oldest,
          startedAt: this.#time - (oldest.clip.durationMs - remaining) / 1000,
        });
      }
    }

    this.#gestures.push({
      name,
      clip,
      startedAt: this.#time,
      weight: clip.baseWeight * Math.min(1, Math.max(0.1, intensity)),
      held: HELD_GESTURES.has(name),
    });
  }

  setExpression(name: ExpressionName, weight = 1): void {
    this.#expression = name;
    this.#expressionWeight = Math.min(1, Math.max(0, weight));
    const targets: Record<string, number> = {};
    for (const preset of ALL_PRESETS) targets[preset] = 0;
    for (const [preset, value] of EXPRESSION_MAP[name] ?? []) {
      targets[preset] = value * this.#expressionWeight;
    }
    this.#targetExpression = targets;
  }

  get expression(): ExpressionName {
    return this.#expression;
  }

  setGaze(mode: 'user' | 'away' | 'down' | 'screen'): void {
    this.#gazeMode = mode;
  }

  /**
   * Drives the mouth from the speech envelope.
   *
   * Real viseme extraction needs phonemes, which needs either a forced aligner
   * or a TTS that returns timings — neither is available across all three
   * voices we support. An amplitude-driven jaw with a slow vowel drift is what
   * virtually every live avatar rig actually does, and at conversational
   * distance it is indistinguishable. What is *not* indistinguishable is a
   * mouth that snaps between open and closed, so the envelope is smoothed
   * asymmetrically: fast to open, slow to close, like a jaw.
   */
  setSpeechEnergy(energy: number): void {
    this.#mouthTarget = Math.min(1, Math.max(0, energy));
  }

  /** Everything stops. Used on barge-in. */
  silence(): void {
    this.#mouthTarget = 0;
  }

  // -- Frame ---------------------------------------------------------------

  update(deltaSeconds: number): void {
    this.#time += deltaSeconds;
    this.#resetToRest();

    const pose: Pose = {};
    this.#applyIdle(pose);
    this.#applyGestures(pose);
    this.#applySpeechMotion(pose);
    this.#writePose(pose);

    this.#updateMouth(deltaSeconds);
    this.#updateBlink(deltaSeconds);
    this.#updateExpression(deltaSeconds);
    this.#updateGaze(deltaSeconds);

    this.#vrm.update(deltaSeconds);
  }

  // -- Layers --------------------------------------------------------------

  /**
   * The idle layer.
   *
   * Everything here is a sum of slow sines at incommensurable periods, which
   * gives motion that never visibly repeats without needing a noise texture or
   * a random walk that can drift. The amplitudes are small on purpose: an idle
   * that you can consciously see is an idle that will annoy someone within an
   * hour.
   */
  #applyIdle(pose: Pose): void {
    const t = this.#time;

    // Breathing, about 14 cycles a minute.
    const breath = Math.sin((t * Math.PI * 2) / 4.3);
    add(pose, 'chest', [breath * 1.1, 0, 0]);
    add(pose, 'upperChest', [breath * 0.7, 0, 0]);
    add(pose, 'spine', [breath * 0.4, 0, 0]);

    // Weight shift between feet, very slow.
    const shift = Math.sin(t * 0.19) * 0.6 + Math.sin(t * 0.083) * 0.4;
    add(pose, 'hips', [0, shift * 1.6, shift * 2.4]);
    add(pose, 'spine', [0, shift * -0.8, shift * -1.2]);

    // Head micro-motion: never perfectly still, never obviously moving.
    add(pose, 'head', [
      Math.sin(t * 0.41) * 0.8 + Math.sin(t * 1.13) * 0.3,
      Math.sin(t * 0.29) * 1.4 + Math.sin(t * 0.87) * 0.4,
      Math.sin(t * 0.23) * 0.9,
    ]);
    add(pose, 'neck', [Math.sin(t * 0.41) * 0.4, Math.sin(t * 0.29) * 0.6, 0]);

    // Arms hang with a slight sway rather than hanging dead.
    const armSway = Math.sin(t * 0.27) * 0.9;
    add(pose, 'leftUpperArm', [armSway * 0.6, 0, armSway]);
    add(pose, 'rightUpperArm', [armSway * 0.6, 0, -armSway]);
  }

  #applyGestures(pose: Pose): void {
    const now = this.#time;
    const surviving: ActiveGesture[] = [];

    for (const gesture of this.#gestures) {
      const elapsed = (now - gesture.startedAt) * 1000;
      const t = elapsed / gesture.clip.durationMs;

      if (t >= 1 && !gesture.held) continue;

      const clamped = Math.min(1, t);
      const envelope = gesture.held ? Math.min(1, t / FADE) : fadeEnvelope(clamped);
      const sampled = sampleClip(gesture.clip, clamped);

      for (const [bone, euler] of Object.entries(sampled) as Array<[BoneName, [number, number, number]]>) {
        const scale = gesture.weight * envelope;
        add(pose, bone, [euler[0] * scale, euler[1] * scale, euler[2] * scale]);
      }
      surviving.push(gesture);
    }

    this.#gestures = surviving;
  }

  /** The small motion that comes with talking, independent of the words. */
  #applySpeechMotion(pose: Pose): void {
    if (this.#mouthOpen < 0.02) return;
    const t = this.#time;
    const energy = this.#mouthOpen;
    add(pose, 'head', [
      Math.sin(t * 6.1) * 1.5 * energy,
      Math.sin(t * 4.3) * 1.8 * energy,
      Math.sin(t * 3.7) * 0.9 * energy,
    ]);
    add(pose, 'chest', [Math.sin(t * 5.2) * 0.6 * energy, 0, 0]);
  }

  // -- Writing to the rig --------------------------------------------------

  #cacheBones(): void {
    const humanoid = this.#vrm.humanoid;
    if (!humanoid) return;
    const names: BoneName[] = [
      'hips',
      'spine',
      'chest',
      'upperChest',
      'neck',
      'head',
      'leftShoulder',
      'leftUpperArm',
      'leftLowerArm',
      'leftHand',
      'rightShoulder',
      'rightUpperArm',
      'rightLowerArm',
      'rightHand',
    ];
    for (const name of names) {
      const node = humanoid.getNormalizedBoneNode(name);
      if (!node) continue;
      this.#bones.set(name, node);
      this.#restRotations.set(name, node.quaternion.clone());
    }
  }

  /**
   * Restores every driven bone to its rest rotation before composing the frame.
   *
   * Without this, offsets accumulate: frame two adds to frame one's result and
   * within a few seconds the character has folded in half. It is the classic
   * additive-animation bug and it looks like a physics failure rather than a
   * bookkeeping one.
   */
  #resetToRest(): void {
    for (const [name, node] of this.#bones) {
      const rest = this.#restRotations.get(name);
      if (rest) node.quaternion.copy(rest);
    }
  }

  #writePose(pose: Pose): void {
    const euler = new Euler();
    const offset = new Quaternion();
    for (const [name, angles] of Object.entries(pose) as Array<[BoneName, [number, number, number]]>) {
      const node = this.#bones.get(name);
      if (!node) continue;
      euler.set(angles[0] * DEG_TO_RAD, angles[1] * DEG_TO_RAD, angles[2] * DEG_TO_RAD, 'XYZ');
      offset.setFromEuler(euler);
      node.quaternion.multiply(offset);
    }
  }

  #updateMouth(delta: number): void {
    // Asymmetric smoothing: a jaw drops faster than it closes.
    const rate = this.#mouthTarget > this.#mouthOpen ? 26 : 12;
    this.#mouthOpen += (this.#mouthTarget - this.#mouthOpen) * Math.min(1, delta * rate);
    this.#vowel += delta * 3.1;

    const expressions = this.#vrm.expressionManager;
    if (!expressions) return;

    const open = this.#mouthOpen;
    // Drift between three mouth shapes so the mouth is not a single hinge.
    const aa = open * (0.6 + 0.4 * Math.sin(this.#vowel));
    const ih = open * (0.3 + 0.3 * Math.sin(this.#vowel * 1.7 + 1.2));
    const ou = open * (0.25 + 0.25 * Math.sin(this.#vowel * 0.9 + 2.4));
    expressions.setValue('aa', aa);
    expressions.setValue('ih', ih);
    expressions.setValue('ou', ou);
  }

  /**
   * Blinks.
   *
   * People blink every two to eight seconds, faster when stressed, and a blink
   * takes roughly 120ms. Getting the *interval* wrong is what makes an avatar
   * uncanny — a metronome blink is worse than no blink at all — so the next
   * blink is scheduled from a fresh random interval each time, and doubles
   * occasionally the way real ones do.
   */
  #updateBlink(delta: number): void {
    const expressions = this.#vrm.expressionManager;
    if (!expressions) return;

    this.#blinkAt -= delta;
    if (this.#blinkAt <= 0 && this.#blinkPhase <= 0) {
      this.#blinkPhase = 1;
      this.#blinkAt = 1.8 + Math.random() * 5 + (Math.random() < 0.12 ? -1.5 : 0);
    }

    if (this.#blinkPhase > 0) {
      this.#blinkPhase -= delta / 0.12;
      const value = Math.sin(Math.max(0, this.#blinkPhase) * Math.PI);
      expressions.setValue('blink', value);
      if (this.#blinkPhase <= 0) expressions.setValue('blink', 0);
    }
  }

  #updateExpression(delta: number): void {
    const expressions = this.#vrm.expressionManager;
    if (!expressions) return;
    // Expressions cross-fade over ~250ms; instant swaps read as a glitch.
    const step = Math.min(1, delta * 4);
    for (const preset of ALL_PRESETS) {
      const target = this.#targetExpression[preset] ?? 0;
      const current = this.#currentExpression[preset] ?? 0;
      const next = current + (target - current) * step;
      this.#currentExpression[preset] = next;
      expressions.setValue(preset, next);
    }
  }

  /**
   * Where she is looking.
   *
   * Two things here are worth more than they cost.
   *
   * First, `user` aims at the *viewer's actual position*, not at a point in
   * front of her own head. Those are the same thing only for a camera at head
   * height directly ahead, which is never true of a figure framed head to toe.
   *
   * Second, the wander is ballistic rather than smooth. Real eyes fixate for a
   * few hundred milliseconds and then jump; they do not drift continuously. A
   * sine wave on the gaze target produces slowly swimming eyes, which is one of
   * the most recognisable uncanny tells there is — and unlike a bad mesh, it
   * survives whatever character the user loads.
   */
  #updateGaze(delta: number): void {
    const head = this.#bones.get('head');
    if (!head) return;
    const origin = head.getWorldPosition(new Vector3());

    this.#advanceSaccade(delta);

    const base = new Vector3();
    switch (this.#gazeMode) {
      case 'user':
        base.copy(this.#viewer);
        break;
      case 'away':
        base.set(origin.x + 1.6, origin.y + 0.25, origin.z + 1.0);
        break;
      case 'down':
        base.set(origin.x + 0.1, origin.y - 0.85, origin.z + 0.7);
        break;
      case 'screen':
        base.set(origin.x - 1.0, origin.y - 0.05, origin.z + 1.4);
        break;
    }

    // Apply the saccade as an angular offset at the distance being looked at,
    // so a few degrees stays a few degrees whether she is looking at you or
    // across the room.
    const distance = Math.max(0.4, base.distanceTo(origin));
    this.#gazeTarget.position.set(
      base.x + this.#saccade.x * distance,
      base.y + this.#saccade.y * distance,
      base.z,
    );
  }

  #advanceSaccade(delta: number): void {
    this.#saccadeAt -= delta;

    if (this.#saccadeAt <= 0 && this.#saccadeProgress >= 1) {
      this.#scheduleSaccade(this.#time);
      // A blink rides along with roughly one jump in six, as it does in people.
      if (Math.random() < 0.16 && this.#blinkPhase <= 0) this.#blinkAt = 0;
    }

    if (this.#saccadeProgress < 1) {
      // ~50ms to complete the jump: fast enough to read as ballistic.
      this.#saccadeProgress = Math.min(1, this.#saccadeProgress + delta / 0.05);
      const eased = this.#saccadeProgress * this.#saccadeProgress * (3 - 2 * this.#saccadeProgress);
      this.#saccade.lerpVectors(this.#saccade, this.#saccadeTo, eased);
    }
  }

  /** Picks the next fixation point: 3-6 degrees away, held 100-400ms. */
  #scheduleSaccade(_now: number): void {
    const angle = Math.random() * Math.PI * 2;
    // Biased horizontally, because conversational gaze moves between the eyes
    // and the mouth far more than it moves up and down.
    const magnitude = (3 + Math.random() * 3) * (Math.PI / 180);
    this.#saccadeTo.set(Math.cos(angle) * magnitude, Math.sin(angle) * magnitude * 0.55, 0);
    this.#saccadeProgress = 0;
    this.#saccadeAt = 0.1 + Math.random() * 0.3;
  }
}

/** Fade a clip in and out so it does not pop at either end. */
export function fadeEnvelope(t: number): number {
  if (t < FADE) return t / FADE;
  if (t > 1 - FADE) return Math.max(0, (1 - t) / FADE);
  return 1;
}

function add(pose: Pose, bone: BoneName, delta: [number, number, number]): void {
  const current = pose[bone];
  if (!current) {
    pose[bone] = [delta[0], delta[1], delta[2]];
    return;
  }
  current[0] += delta[0];
  current[1] += delta[1];
  current[2] += delta[2];
}
