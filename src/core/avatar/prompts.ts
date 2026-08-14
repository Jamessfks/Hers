/**
 * The generation prompts, one per clip slot.
 *
 * ## Why every clip must start and end on the source pose
 *
 * At conversation time these clips are concatenated in an order nobody can
 * predict: the model writes `[tilt_head]` and then, four seconds later,
 * `[lean_in]`, and in between the idle clip has looped twice. Any clip can
 * follow any other, so the only way the result reads as one continuous person
 * is if every clip begins and ends on the *same* frame — the source photograph.
 * Then the seam between clip A and clip B is a cut between two frames that are
 * already identical, which is not visible at all.
 *
 * Break that and you get one of two failures, both fatal to the illusion:
 *
 *  - **Teleporting.** Clip A ends with her hand half-raised, clip B starts with
 *    it at her side. The hand jumps. This happens at *every* transition, which
 *    for a companion who gestures once a sentence is several times a minute,
 *    and the eye reads it as a glitch rather than as movement.
 *  - **Ghosting.** The usual fix is a 200ms cross-fade, which works when the
 *    two poses are nearly identical and is worse than the cut when they are
 *    not: two semi-transparent copies of a person's arm in different places is
 *    the single most recognisable tell of a cheap video avatar. And the more
 *    expressive the gesture, the further apart the poses, the worse the fade.
 *
 * Loop closure also makes the library *cheap to repair*. Because every clip is
 * anchored to the same frame, one bad clip can be regenerated on its own
 * without touching the other eighteen — nothing downstream depends on where it
 * ended, because where it ended is where everything starts.
 *
 * The idle clip is the strictest case: it plays on repeat for hours, so a
 * mismatch of even a few pixels between its last and first frame becomes a
 * visible twitch on a fixed period, which is far more noticeable than a random
 * one. It is generated first and it is the one worth regenerating until it is
 * right.
 *
 * ## Why the clips are longer than the poses they mirror
 *
 * `poses.ts` can ask for a 700ms nod because it drives a rig. No image-to-video
 * API will sell one: they quantise to fixed lengths, commonly around five
 * seconds, and bill per clip rather than per second. So each prompt asks for the
 * gesture as a *beat near the start* and then explicitly asks the subject to
 * settle back to the source pose and hold still for the remainder. The player
 * can then cut out of the clip anywhere inside that hold — the pose is already
 * closed, so an early cut is still seamless — which is how a 5s purchase gives
 * back a 700ms nod. `beatMs` is that cut point, and it is copied from the VRM
 * clip so the same `[nod]` reads at the same speed on both renderers.
 *
 * ## What this does not solve
 *
 * **The mouth.** These clips are generated before anyone knows what she will
 * say, so they cannot be lip-synced, and every prompt therefore forbids speech
 * shapes — a mouth moving to the wrong words is much worse than a mouth that
 * does not move. Real lip sync needs either a per-utterance video pass (the
 * per-minute streaming category rejected in docs/adr/0003-avatar-renderer.md)
 * or a 2D mouth overlay driven by the TTS amplitude envelope, which the audio
 * path already produces. That is a separate piece of work and it is not
 * pretended at here.
 */

import type { ClipSlotName } from './clips.ts';

/**
 * What we ask the vendor for, in seconds.
 *
 * Five is the shortest length the common image-to-video products all offer, and
 * since billing is per clip rather than per second, asking for less saves
 * nothing and gives the gesture less room to settle. Providers that only do 4s
 * or 10s should quantise this themselves — the prompts do not depend on the
 * exact number, only on there being slack after the beat.
 */
export const CLIP_SECONDS = 5;

export interface ClipPrompt {
  /**
   * The one action, written as a beat. Deliberately short: these models follow
   * a single clear instruction and average two vague ones together, which comes
   * back as a gesture that is neither.
   */
  motion: string;
  /**
   * Where the gesture is over and the hold begins — the point the player may
   * cut at. Mirrors the `durationMs` of the same gesture in
   * renderer/avatar/poses.ts so timing is identical across renderers.
   */
  beatMs: number;
  /**
   * `closed` clips end on the source pose and can follow or precede anything.
   * `open` clips end somewhere else and are the exception, not the rule.
   */
  loop: 'closed' | 'open';
  /**
   * The frame this clip starts on. `source` is the photograph. Anything else
   * names a slot whose *final* frame is the anchor, which means that slot must
   * be generated first and its last frame extracted — a two-stage build.
   */
  anchor?: ClipSlotName;
  /** Failure modes specific to this gesture, added to the negative prompt. */
  avoid?: string;
}

/**
 * Rules attached to every prompt.
 *
 * These are the constraints that keep nineteen independently generated clips
 * looking like nineteen seconds of the same continuous shot. Framing and
 * background are in here rather than in each motion line because a model that
 * is told once, firmly, holds a constraint better than one told nineteen times
 * in nineteen different phrasings — and because a single drift in one clip
 * (she is 5% larger, the lamp behind her moved) makes that clip unusable next
 * to all the others no matter how good the gesture is.
 */
export const SHARED_RULES: readonly string[] = [
  'The first frame is the photograph, unchanged.',
  'The final frame returns to the photograph, matching it pose for pose.',
  'The camera is locked off on a tripod: no pan, tilt, zoom, dolly, or handheld drift.',
  'The subject stays the same size and in the same place in frame throughout.',
  'The background, the lighting, the wardrobe and the hair are the ones in the photograph and do not change.',
  'Exactly one action, performed once.',
  'Her mouth stays closed and relaxed. She is not speaking.',
  'One continuous take: no cuts, no fades, no speed changes, no added text or graphics.',
  'After the action she settles back into the photograph pose and holds it, still and breathing, until the clip ends.',
];

/**
 * The shared negative prompt.
 *
 * Split from {@link SHARED_RULES} because most image-to-video APIs take a
 * separate negative field, and the ones that do not get it appended — a
 * negative sent as a positive instruction ("no morphing") reliably produces the
 * thing it names, so this must not be pasted into the main prompt by accident.
 */
export const NEGATIVE_PROMPT = [
  'camera movement',
  'zoom',
  'pan',
  'cut',
  'jump cut',
  'crossfade',
  'morphing face',
  'changing identity',
  'changing clothes',
  'changing background',
  'extra people',
  'extra limbs',
  'distorted hands',
  'talking',
  'lip movement',
  'text',
  'watermark',
  'subtitles',
  'slow motion',
  'ending in a different pose',
].join(', ');

/**
 * The library, authored in the same order and the same voice as the keyframed
 * clips in renderer/avatar/poses.ts — the same eighteen names, plus idle, so a
 * `[shrug]` means the same thing whichever renderer is drawing her.
 */
export const CLIP_PROMPTS: Record<ClipSlotName, ClipPrompt> = {
  /**
   * The base clip. Plays whenever nothing else does, which is most of the day,
   * so the instruction is mostly about what *not* to do: any gesture in here
   * gets repeated every five seconds forever, and a person who scratches their
   * nose on a five-second cycle is a hallucination, not a companion.
   */
  idle: {
    motion:
      'She stands still and breathes. Her chest rises and falls, she blinks once or twice, ' +
      'her weight shifts by a hair. Nothing else moves.',
    beatMs: 5000,
    loop: 'closed',
    avoid: 'gesturing, head turning, walking, smiling on and off',
  },

  nod: {
    motion:
      'She nods once. Her chin drops, comes back up, and her head settles level again. ' +
      'A short, definite yes — not a bow.',
    beatMs: 700,
    loop: 'closed',
  },

  shake_head: {
    motion:
      'She shakes her head once: it turns to one side, across to the other, and back to centre. ' +
      'Small and human, not theatrical.',
    beatMs: 900,
    loop: 'closed',
  },

  tilt_head: {
    motion:
      'She tilts her head to one side, holds it there for a beat, and brings it back level. ' +
      'Curious, listening — the shoulders stay where they are.',
    beatMs: 1400,
    loop: 'closed',
    avoid: 'shoulder movement',
  },

  lean_in: {
    motion:
      'She leans her upper body a little closer, holds, then eases back to exactly where she started. ' +
      'Interested, not looming.',
    beatMs: 1800,
    loop: 'closed',
    // A model told to come closer will often walk instead, which breaks framing
    // and cannot be recovered by the return half of the clip.
    avoid: 'stepping forward, walking toward the camera, growing in frame',
  },

  lean_back: {
    motion:
      'She shifts her weight back and away, holds a beat, then returns to where she started. ' +
      'Taking something in, giving herself room.',
    beatMs: 1600,
    loop: 'closed',
    avoid: 'stepping backward, shrinking in frame',
  },

  shrug: {
    motion:
      'Both shoulders rise, her hands turn briefly palm-up, and everything drops back down. ' +
      'One shrug, then stillness.',
    beatMs: 1100,
    loop: 'closed',
  },

  wave: {
    motion:
      'Her near hand comes up to about shoulder height and waves twice from the wrist, ' +
      'then lowers to exactly where it rests in the photograph.',
    beatMs: 1600,
    loop: 'closed',
    avoid: 'the hand leaving frame, the hand ending up in a different place',
  },

  point_at_user: {
    motion:
      'She raises one hand and points once toward the camera, briefly, then lowers it again.',
    beatMs: 1200,
    loop: 'closed',
    // A finger toward the lens is the classic place these models lose a hand:
    // it is the fastest-moving, most foreshortened thing in the shot.
    avoid: 'the hand filling the frame, blurred or distorted fingers',
  },

  hands_behind_back: {
    motion:
      'She brings both hands together behind her back, holds the pose, then returns them to ' +
      'exactly where they rest in the photograph.',
    beatMs: 2200,
    loop: 'closed',
    avoid: 'hands reappearing in a different position, arms swapping sides',
  },

  hand_to_chest: {
    motion:
      'One hand rises to rest flat on her chest, stays a moment, and lowers again. ' +
      'A small, sincere gesture.',
    beatMs: 1900,
    loop: 'closed',
  },

  cover_mouth_laugh: {
    motion:
      'She laughs: her shoulders bounce twice, her eyes crease, one hand comes up to cover ' +
      'her mouth, then lowers as she settles.',
    beatMs: 1700,
    loop: 'closed',
    // The hand covering the mouth is doing real work here — it hides the one
    // part of the face these clips can never get right, so this is the only
    // clip in the set where an open mouth is allowed at all.
    avoid: 'speaking, exaggerated cartoon laughter',
  },

  stretch: {
    motion:
      'She stretches: both arms lift and open, her chest opens, her chin lifts, and then ' +
      'everything comes back down to rest.',
    beatMs: 2600,
    loop: 'closed',
    avoid: 'arms leaving frame',
  },

  look_away_thinking: {
    motion:
      'Her eyes go first and her head follows, turning away to one side as if working ' +
      'something out, then both come back to the camera.',
    beatMs: 2000,
    loop: 'closed',
  },

  reach_toward_user: {
    motion:
      'One hand reaches out toward the camera, palm up and open, holds for a moment, ' +
      'then withdraws to rest.',
    beatMs: 2200,
    loop: 'closed',
    avoid: 'the hand filling the frame, the hand going out of focus, blurred fingers',
  },

  /**
   * A posture change, not a beat — the same exception `HELD_GESTURES` carves
   * out in poses.ts. It cannot close its loop, because ending where it started
   * would mean standing back up, which is the opposite gesture.
   *
   * The consequence is a scheduling rule the player owes this library: an open
   * clip may only be played from the posture it starts in, and once it has
   * played, every closed clip in the library is anchored to the wrong pose
   * until its partner runs. In practice that means a sit/stand pair should be
   * treated as a mode switch with its own idle clip, or left out entirely.
   */
  sit_down: {
    motion:
      'She lowers herself into a seated position and settles there, still and composed.',
    beatMs: 1800,
    loop: 'open',
    avoid: 'standing back up, a chair appearing or changing shape',
  },

  /**
   * The clip that cannot be generated from the photograph.
   *
   * Standing up has to *start* seated, and the source image is not — so this is
   * the one slot that needs a second anchor: the final frame of `sit_down`,
   * extracted and fed back as the init image. Hence `anchor`.
   *
   * There is a much cheaper answer worth taking first: `stand_up` is `sit_down`
   * played backwards. The frames are already exact at both seams, it costs
   * nothing, and it cannot drift. It needs a reversed copy at build time (or a
   * player that can run a clip in reverse), which is why the prompt is written
   * out anyway — a provider that supports a second init image can generate it
   * properly, and a build without one should derive it.
   */
  stand_up: {
    motion: 'From seated, she rises smoothly to standing and settles on her feet.',
    beatMs: 1400,
    loop: 'open',
    anchor: 'sit_down',
    avoid: 'sitting back down, jumping, the chair moving with her',
  },

  sway: {
    motion:
      'She sways gently, weight moving from one foot to the other and back, ending balanced ' +
      'exactly as she began.',
    beatMs: 3200,
    loop: 'closed',
    avoid: 'dancing, stepping, hip swinging',
  },

  fidget: {
    motion:
      'Her hands make one small restless movement — fingers curling and settling — and go ' +
      'back to rest. Everything else stays where it is.',
    beatMs: 1500,
    loop: 'closed',
    avoid: 'picking up an object, an object appearing in her hands',
  },
};

/** Slots that do not return to the source pose. Mirrors HELD_GESTURES. */
export const OPEN_LOOP_SLOTS: ReadonlySet<ClipSlotName> = new Set(
  (Object.keys(CLIP_PROMPTS) as ClipSlotName[]).filter(
    (slot) => CLIP_PROMPTS[slot].loop === 'open',
  ),
);

export interface BuiltPrompt {
  prompt: string;
  /** For the vendor's negative field. Never append this to `prompt`. */
  avoid: string;
  seconds: number;
  /** Where the player may cut back to idle. */
  beatMs: number;
  /** null means "the source photograph". */
  anchorSlot: ClipSlotName | null;
}

/**
 * Compose the full instruction for one slot.
 *
 * The order is deliberate: the action first, then the rules. These models
 * weight the front of the prompt most heavily, and the action is the only part
 * that differs between clips — leading with nine lines of framing boilerplate
 * buries the one sentence that makes this clip a wave rather than a nod.
 */
export function buildClipPrompt(slot: ClipSlotName): BuiltPrompt {
  const clip = CLIP_PROMPTS[slot];
  const rules =
    clip.loop === 'closed'
      ? SHARED_RULES
      : // An open clip is told to hold its new pose instead of returning, and
        // the "final frame matches the photograph" rule is removed rather than
        // contradicted — a prompt that says both produces a clip that does
        // neither cleanly.
        SHARED_RULES.filter((rule) => !rule.startsWith('The final frame')).map((rule) =>
          rule.startsWith('After the action')
            ? 'After the action she holds the new pose, still and breathing, until the clip ends.'
            : rule,
        );

  return {
    prompt: [clip.motion, '', ...rules.map((rule) => `- ${rule}`)].join('\n'),
    avoid: clip.avoid ? `${NEGATIVE_PROMPT}, ${clip.avoid}` : NEGATIVE_PROMPT,
    seconds: CLIP_SECONDS,
    beatMs: clip.beatMs,
    anchorSlot: clip.anchor ?? null,
  };
}
