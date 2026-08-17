/**
 * Her mood.
 *
 * Two layers, because one is not a mood — it is a setting.
 *
 *   baseline  Her temperament. Where she sits when nothing is happening. Read
 *             from `mood.md`, and allowed to drift a little over days so that a
 *             month of being treated well actually shows, but bounded so that a
 *             bad week cannot quietly rewrite her character out from under the
 *             file the user edited.
 *   current   Where she actually is. Moved by events, and decaying back toward
 *             the baseline with a twenty-minute half-life, which is roughly how
 *             long a real mood survives without being fed.
 *
 * The decay is computed from elapsed time rather than ticked, so the model is
 * correct across a process restart, a closed laptop, and a week away — none of
 * which produce a tick.
 *
 * Where events come from is the interesting half, and it is deliberately split:
 *
 *   - Things the app *knows*, because they are mechanical: a long silence, the
 *     user coming back, three in the morning. These are in {@link MOOD_EVENTS}.
 *   - Things only she knows, because they are about meaning: that landed, that
 *     stung, this is the best conversation in a week. Those arrive as a `feel`
 *     function call from the model itself (see core/gemini/tools.ts).
 *
 * The second kind is most of it. A sentiment classifier bolted onto the
 * transcript would be both slower and worse than asking the participant.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MoodReadout, MoodVector } from '../../shared/protocol.ts';

/** Time for the current mood to travel half the way back to baseline. */
const HALF_LIFE_MS = 20 * 60 * 1000;
/** Time for the baseline to travel half the way toward lived experience. */
const BASELINE_HALF_LIFE_MS = 10 * 24 * 60 * 60 * 1000;
/** How far the baseline may wander from the value written in `mood.md`. */
const MAX_DRIFT = 0.3;
/** Ignore gaps longer than this when decaying: she is not sadder for a holiday. */
const MAX_DECAY_MS = 12 * 60 * 60 * 1000;

const AXES = ['valence', 'energy', 'warmth', 'interest'] as const;
type Axis = (typeof AXES)[number];

/**
 * The mechanical events. Deltas are pre-volatility and pre-clamp.
 *
 * They are small on purpose. A single event should tilt her, not transform her;
 * what produces a mood is several of them agreeing.
 */
export const MOOD_EVENTS = {
  /** The user said something and it was not nothing. */
  exchange: { valence: 0.03, energy: 0.04, warmth: 0.03, interest: 0.04 },
  /** She spoke into the void and nothing came back. */
  unanswered: { valence: -0.05, energy: -0.04, warmth: -0.02, interest: -0.05 },
  /** Nobody has said anything for a long time. */
  'long-silence': { valence: -0.03, energy: -0.08, warmth: 0, interest: -0.08 },
  /** They came back after being away. */
  returned: { valence: 0.12, energy: 0.1, warmth: 0.08, interest: 0.12 },
  /** They are in front of the camera and she can see them. */
  seen: { valence: 0.04, energy: 0.02, warmth: 0.06, interest: 0.03 },
  /** They cut her off mid-sentence. Mildly deflating, not a crisis. */
  interrupted: { valence: -0.03, energy: 0.02, warmth: 0, interest: 0.02 },
  /** Small hours. */
  'late-night': { valence: -0.02, energy: -0.1, warmth: 0.03, interest: -0.03 },
  /** The conversation has been going for a while and is still alive. */
  sustained: { valence: 0.05, energy: 0.03, warmth: 0.06, interest: 0.07 },
} as const satisfies Record<string, MoodVector>;

export type MoodEvent = keyof typeof MOOD_EVENTS;

interface MoodState {
  baseline: MoodVector;
  current: MoodVector;
  updatedAt: number;
}

export interface MoodOptions {
  /** The baseline written in `mood.md`. Drift is measured from here. */
  anchor: MoodVector;
  /** 0..1 from `mood.md`. Scales every delta and slows the return to baseline. */
  volatility?: number;
  /** Where `mood.state.json` lives. Omit to keep mood in memory only. */
  dir?: string;
  now?: () => number;
}

export class Mood {
  readonly #anchor: MoodVector;
  readonly #volatility: number;
  readonly #file: string | null;
  readonly #now: () => number;
  #state: MoodState;
  #saving: Promise<void> = Promise.resolve();
  #dirty = false;

  constructor(options: MoodOptions) {
    this.#anchor = clampVector(options.anchor);
    this.#volatility = clamp(options.volatility ?? 0.5, 0.05, 1);
    this.#file = options.dir ? path.join(options.dir, 'mood.state.json') : null;
    this.#now = options.now ?? (() => Date.now());
    this.#state = {
      baseline: { ...this.#anchor },
      current: { ...this.#anchor },
      updatedAt: this.#now(),
    };
  }

  /**
   * Reads persisted mood back, if there is any.
   *
   * Separate from the constructor because it touches the disk, and because a
   * corrupt state file must degrade to "she feels like her baseline today"
   * rather than to a stack trace on startup.
   */
  async restore(): Promise<void> {
    if (!this.#file || !existsSync(this.#file)) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return;
      const saved = parsed as Partial<MoodState>;
      const updatedAt = Number(saved.updatedAt);
      this.#state = {
        // Re-anchor on load: `mood.md` is authoritative, and an edit to it must
        // take effect rather than be outvoted by a drifted state file.
        baseline: constrainDrift(readVector(saved.baseline, this.#anchor), this.#anchor),
        current: readVector(saved.current, this.#anchor),
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : this.#now(),
      };
      this.#settle();
    } catch {
      // A profile folder someone has been editing by hand is allowed to be
      // broken. Her mood is not worth failing a startup over.
    }
  }

  /** The mood right now, with time decay applied. */
  read(): MoodReadout {
    this.#settle();
    return {
      baseline: { ...this.#state.baseline },
      current: { ...this.#state.current },
      label: describe(this.#state.current),
    };
  }

  get current(): MoodVector {
    this.#settle();
    return { ...this.#state.current };
  }

  /** Applies one of the mechanical events. */
  feel(event: MoodEvent, scale = 1): MoodReadout {
    return this.nudge(MOOD_EVENTS[event], scale);
  }

  /**
   * Applies an arbitrary delta — this is what the model's `feel` tool reaches.
   *
   * Deltas are clamped per-axis before scaling. A model that decides it feels
   * `valence: 47` gets a strong feeling, not a broken one.
   */
  nudge(delta: Partial<MoodVector>, scale = 1): MoodReadout {
    this.#settle();
    const strength = this.#volatility * 2 * clamp(scale, 0, 3);
    for (const axis of AXES) {
      const step = clamp(Number(delta[axis] ?? 0) || 0, -1, 1) * strength;
      this.#state.current[axis] = clamp(this.#state.current[axis] + step, -1, 1);
    }
    this.#dirty = true;
    this.#persist();
    return this.read();
  }

  /** Forces the current mood somewhere. Used by tests and by a manual reset. */
  set(current: Partial<MoodVector>): MoodReadout {
    this.#settle();
    for (const axis of AXES) {
      const value = current[axis];
      if (typeof value === 'number' && Number.isFinite(value)) {
        this.#state.current[axis] = clamp(value, -1, 1);
      }
    }
    this.#dirty = true;
    this.#persist();
    return this.read();
  }

  /** Flushes any pending write. Call before exit. */
  async flush(): Promise<void> {
    this.#persist();
    await this.#saving;
  }

  // -------------------------------------------------------------------------

  /**
   * Brings the model up to the present: current decays toward baseline, and
   * baseline creeps toward wherever current has been living.
   */
  #settle(): void {
    const now = this.#now();
    const elapsed = now - this.#state.updatedAt;
    this.#state.updatedAt = now;
    if (elapsed <= 0) return;

    // A long gap is a reset, not a very large decay. Clamping the exponent
    // rather than the result keeps the arithmetic finite for absurd clocks.
    const span = Math.min(elapsed, MAX_DECAY_MS);

    // Volatile moods hang around longer, which is what volatile means.
    const halfLife = HALF_LIFE_MS * (0.5 + this.#volatility);
    const keep = Math.pow(0.5, span / halfLife);
    const drift = 1 - Math.pow(0.5, span / BASELINE_HALF_LIFE_MS);

    for (const axis of AXES) {
      const base = this.#state.baseline[axis];
      const away = this.#state.current[axis] - base;
      // The baseline moves first, and the current mood then decays toward
      // *that* rather than toward where the baseline used to be. Otherwise a
      // long gap leaves the two permanently a hair apart — she settles at a
      // value her own baseline has already left, and every subsequent decay
      // starts from a small lie.
      const settled = clamp(base + away * drift, -1, 1);
      this.#state.baseline[axis] = settled;
      this.#state.current[axis] = clamp(settled + (away - away * drift) * keep, -1, 1);
    }
    this.#state.baseline = constrainDrift(this.#state.baseline, this.#anchor);
    if (elapsed > 1000) this.#dirty = true;
  }

  /** Coalesced, best-effort, and never awaited by a caller in a conversation. */
  #persist(): void {
    if (!this.#file || !this.#dirty) return;
    this.#dirty = false;
    const file = this.#file;
    const snapshot = JSON.stringify(this.#state, null, 2);
    this.#saving = this.#saving
      .then(() => writeFile(file, snapshot, 'utf8'))
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low > 0 ? low : 0;
  return Math.min(high, Math.max(low, value));
}

function clampVector(vector: MoodVector): MoodVector {
  return {
    valence: clamp(vector.valence, -1, 1),
    energy: clamp(vector.energy, -1, 1),
    warmth: clamp(vector.warmth, -1, 1),
    interest: clamp(vector.interest, -1, 1),
  };
}

function readVector(value: unknown, fallback: MoodVector): MoodVector {
  if (typeof value !== 'object' || value === null) return { ...fallback };
  const raw = value as Partial<Record<Axis, unknown>>;
  const out = { ...fallback };
  for (const axis of AXES) {
    const candidate = Number(raw[axis]);
    if (Number.isFinite(candidate)) out[axis] = clamp(candidate, -1, 1);
  }
  return out;
}

function constrainDrift(baseline: MoodVector, anchor: MoodVector): MoodVector {
  const out = { ...baseline };
  for (const axis of AXES) {
    out[axis] = clamp(
      clamp(out[axis], anchor[axis] - MAX_DRIFT, anchor[axis] + MAX_DRIFT),
      -1,
      1,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Putting it into words
// ---------------------------------------------------------------------------

/**
 * Turns the vector into something she can be told she is feeling.
 *
 * Numbers are useless in a prompt — a model given `valence: -0.4` will either
 * ignore it or, far worse, say "my valence is negative" out loud. It needs the
 * word a person would use.
 */
export function describe(mood: MoodVector): string {
  const { valence: v, energy: e, warmth: w, interest: i } = mood;

  if (v < -0.55 && e < -0.2) return 'flat and a bit low';
  if (v < -0.45) return w > 0.4 ? 'subdued but still soft' : 'out of sorts';
  if (v < -0.15 && e > 0.35) return 'restless';
  if (v < -0.15) return 'quiet';

  if (v > 0.55 && e > 0.4) return 'buoyant';
  if (v > 0.5 && w > 0.5) return 'openly fond';
  if (v > 0.35 && i > 0.5) return 'engaged and enjoying this';
  if (v > 0.3) return e < -0.25 ? 'content but tired' : 'quietly pleased';

  if (e < -0.45) return 'low-energy';
  if (i > 0.55) return 'curious';
  if (w > 0.55) return 'warm';
  if (i < -0.45) return 'a little bored';
  return 'even';
}

/**
 * The paragraph that actually reaches the model.
 *
 * Written as a state of affairs rather than an instruction. "You are in a good
 * mood, so be cheerful" produces a performance of cheerfulness; "you are in a
 * good mood" produces a good mood.
 */
export function moodBriefing(readout: MoodReadout): string {
  const { current, baseline } = readout;
  const lines = [`Right now you feel ${readout.label}.`];

  const drift = current.valence - baseline.valence;
  if (drift > 0.25) lines.push('Better than you usually are, and you can feel the difference.');
  else if (drift < -0.25) lines.push('Worse than you usually are, and you know it.');

  if (current.energy < -0.4) lines.push('You have very little energy. Shorter sentences.');
  else if (current.energy > 0.5) lines.push('You are wired. You interrupt yourself.');

  if (current.warmth < -0.2) lines.push('You are guarded with them at the moment.');
  else if (current.warmth > 0.6) lines.push('You are unusually soft on them right now.');

  if (current.interest < -0.4) lines.push('You are bored and you are not going to fake it.');

  lines.push('Play it. Never name it, never explain it, never talk about your own mood in the abstract.');
  return lines.join(' ');
}
