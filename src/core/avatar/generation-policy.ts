/**
 * How freely Anna is allowed to spend money growing her own body.
 *
 * Every clip in the library is a paid render against a provider that bills on
 * ingest, and the app is designed to generate them lazily — she reaches for
 * `[wave]`, and if no wave exists that is the moment it would be worth having
 * one. Left ungoverned that is an app which decides, on its own, to spend the
 * user's money in response to its own sentences. This module is the governor.
 *
 * ## Reuse is not a tier
 *
 * Worth stating because it is the question this module is *not* about: a clip
 * that already exists on disk is always played from disk, at every tier,
 * forever. Nothing here can cause a re-render of something already rendered.
 * The tiers only decide what happens when a named motion is missing, which is
 * the only moment money is on the table.
 *
 * ## Why the axes are the axes
 *
 * Four different things can go wrong and one dial cannot stop all of them:
 *
 *  - **Which slots** bounds the worst case at all. `idle` is the only clip
 *    whose absence means nothing moves; every other slot degrades quietly,
 *    because `Hologram.play()` no-ops on a missing one.
 *  - **How many** bounds a single bad afternoon.
 *  - **How often** bounds a runaway loop — a conversation that keeps reaching
 *    for the same missing gesture should not submit it eighteen times.
 *  - **How much** is the backstop that does not depend on the other three being
 *    right. Hedra will not quote before ingest, so a clip's price is not known
 *    until it has been paid; a ceiling in dollars is the only limit expressed
 *    in the units the user actually cares about.
 */

import type { GenerationTier } from '../../shared/protocol.ts';
import { BUILD_ORDER, IDLE_SLOT, type ClipLibrary, type ClipSlotName } from './clips.ts';

export type { GenerationTier };

export interface TierPolicy {
  /** Shown in settings. One line, in the user's terms, not the system's. */
  readonly summary: string;
  /**
   * Slots this tier will ever pay for. Anything outside it is played if it
   * happens to exist and otherwise skipped.
   */
  readonly eligible: readonly ClipSlotName[];
  /** Ceiling for one run of the app. Resets when it restarts. */
  readonly maxPerSession: number;
  /** Ceiling on the library as a whole, counting clips already rendered. */
  readonly maxTotal: number;
  /** Minimum gap between two renders, in minutes. */
  readonly cooldownMinutes: number;
  /** Hard stop, in dollars, measured against what the library has already cost. */
  readonly spendCeilingUsd: number;
  /**
   * `onDemand` renders only what she just reached for. `prewarm` also works
   * down BUILD_ORDER in the background when nothing is being asked of it.
   */
  readonly mode: 'onDemand' | 'prewarm';
}

/**
 * The three tiers.
 *
 * The numbers are chosen, not measured, and the reasoning is in each summary
 * rather than in a table somewhere else. One real figure anchors them: the only
 * clip this project has actually paid for cost $0.25, recorded in a library
 * manifest. Hedra does not quote before ingest, so every ceiling below is
 * expressed in dollars rather than in clips for that reason — a count would be
 * a guess wearing a number's clothes.
 */
export const TIERS: Readonly<Record<GenerationTier, TierPolicy>> = {
  /*
   * Low is not "a bit less". It is "she will never surprise you with a bill".
   *
   * Exactly one slot is eligible, and it is the one whose absence is the
   * difference between a photograph and a companion: with no idle clip nothing
   * on screen moves at all. Every other gesture degrades silently, so a user who
   * wants to spend nothing loses gestures and keeps the product.
   */
  low: {
    summary: 'Only the idle loop, once. Nothing else is ever rendered.',
    eligible: [IDLE_SLOT],
    maxPerSession: 1,
    maxTotal: 1,
    cooldownMinutes: 0,
    spendCeilingUsd: 1,
    mode: 'onDemand',
  },

  /*
   * Medium is the default, and it buys the five clips that carry almost every
   * turn: the idle loop plus the four gestures the persona reaches for
   * constantly. BUILD_ORDER already ranks slots by presence-per-dollar, so this
   * is its first five rather than a second opinion about which gestures matter.
   *
   * The ten-minute cooldown is the runaway guard: a conversation that keeps
   * asking for the same missing gesture pays for it once and then waits.
   */
  medium: {
    summary: 'The idle loop and the four gestures she uses most, as she needs them.',
    eligible: BUILD_ORDER.slice(0, 5),
    maxPerSession: 3,
    maxTotal: 5,
    cooldownMinutes: 10,
    spendCeilingUsd: 5,
    mode: 'onDemand',
  },

  /*
   * High fills the library. Every slot is eligible and it pre-warms in
   * BUILD_ORDER rather than waiting to be asked, because at this tier the user
   * has said the library is worth having complete — and a gesture rendered
   * before it is needed is one that lands on the beat instead of two minutes
   * after it.
   *
   * The two-minute cooldown is not a budget control at this point; it is
   * politeness to a rate limit.
   */
  high: {
    summary: 'Fill the whole library in the background, up to a $20 ceiling.',
    eligible: [...BUILD_ORDER],
    maxPerSession: 6,
    maxTotal: BUILD_ORDER.length,
    cooldownMinutes: 2,
    spendCeilingUsd: 20,
    mode: 'prewarm',
  },
};

export const DEFAULT_TIER: GenerationTier = 'medium';

/** What the caller knows about spending so far. */
export interface GenerationState {
  /** Clips rendered since this run of the app started. */
  generatedThisSession: number;
  /** When the last render was submitted. Null when none has been. */
  lastGeneratedAt: number | null;
}

export type GenerationVerdict =
  | { allowed: true }
  /**
   * `reason` is written to be shown to the user, not logged. Every refusal here
   * is a decision they configured, so it should read as the app respecting a
   * setting rather than as something going wrong.
   */
  | { allowed: false; reason: string };

/**
 * Whether one missing slot may be rendered right now.
 *
 * Deliberately pure and deliberately given the library rather than a count: the
 * spend and the number of finished clips are both facts already recorded in the
 * manifest, and re-deriving them here means a caller cannot get them wrong or
 * forget to persist them.
 */
export function mayGenerate(
  slot: ClipSlotName,
  library: ClipLibrary,
  tier: GenerationTier,
  state: GenerationState,
  now = Date.now(),
): GenerationVerdict {
  const policy = TIERS[tier];

  // The cheapest check first, and the one that is not about money: a slot that
  // already exists is never re-rendered, at any tier.
  if (library.clips[slot]?.status === 'ready') {
    return { allowed: false, reason: `${slot} is already in the library.` };
  }

  if (!policy.eligible.includes(slot)) {
    return {
      allowed: false,
      reason: `The ${tier} setting does not render ${slot}.`,
    };
  }

  if (state.generatedThisSession >= policy.maxPerSession) {
    return {
      allowed: false,
      reason: `That is ${policy.maxPerSession} new clips this session, which is the ${tier} limit. Restart to render more.`,
    };
  }

  const ready = readyCount(library);
  if (ready >= policy.maxTotal) {
    return {
      allowed: false,
      reason: `Her library has ${ready} clips, which is the ${tier} limit.`,
    };
  }

  const spent = spentUsd(library);
  if (spent >= policy.spendCeilingUsd) {
    return {
      allowed: false,
      reason: `Her library has cost $${spent.toFixed(2)}, which is the ${tier} ceiling.`,
    };
  }

  if (state.lastGeneratedAt !== null && policy.cooldownMinutes > 0) {
    const waited = now - state.lastGeneratedAt;
    const required = policy.cooldownMinutes * 60_000;
    if (waited < required) {
      const left = Math.ceil((required - waited) / 60_000);
      return {
        allowed: false,
        reason: `Another render in about ${left} minute${left === 1 ? '' : 's'}.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * The next slot worth rendering unprompted, or null.
 *
 * Only the `prewarm` tier has one. The others render what was asked for and
 * nothing else, which is the difference between a library that fills itself and
 * one that responds.
 */
export function nextPrewarmSlot(
  library: ClipLibrary,
  tier: GenerationTier,
  state: GenerationState,
  now = Date.now(),
): ClipSlotName | null {
  if (TIERS[tier].mode !== 'prewarm') return null;
  for (const slot of BUILD_ORDER) {
    if (mayGenerate(slot, library, tier, state, now).allowed) return slot;
  }
  return null;
}

/** What the library has cost so far, from the manifest rather than a counter. */
export function spentUsd(library: ClipLibrary): number {
  let total = 0;
  for (const entry of Object.values(library.clips)) total += entry.spentUsd ?? 0;
  return Math.round(total * 100) / 100;
}

function readyCount(library: ClipLibrary): number {
  let count = 0;
  for (const entry of Object.values(library.clips)) if (entry.status === 'ready') count += 1;
  return count;
}
