/**
 * Attention: when Anna speaks first, and what she has noticed.
 *
 * This is the hardest judgement in the product and the one most companion apps
 * get wrong in the same direction. Given a live feed of what the user is doing,
 * the tempting design is to react to it — and a companion who reacts to
 * everything is not attentive, she is a smoke alarm. The rules below are
 * therefore mostly about *not* speaking:
 *
 *   - one opener per cooldown window, regardless of how many triggers fire;
 *   - each trigger has its own longer cooldown, so she cannot make the same
 *     observation twice in an evening;
 *   - quiet hours are absolute;
 *   - anything that fires while the user is mid-conversation is dropped, since
 *     she already has the floor.
 *
 * The output is a *reason*, not a line of dialogue. Anna writes her own words
 * from the reason plus her memory; canned openers are recognisable within a day
 * and they are the fastest way to break the illusion.
 */

import type { SenseEvent } from '../../shared/protocol.ts';
import { READ_STALE_MS } from './sight.ts';

export type TriggerId =
  | 'returned'
  | 'stuck'
  | 'late-night'
  | 'calendar'
  | 'looks-rough'
  | 'long-silence';

export interface Opener {
  trigger: TriggerId;
  /** Fed to the persona prompt as "you are opening because: …". */
  reason: string;
  /** Higher wins when several fire at once. */
  priority: number;
}

export interface AttentionPolicy {
  proactive: boolean;
  /** Floor between any two openers. */
  minMinutesBetweenOpeners: number;
  /** Local hours during which Anna stays silent, e.g. [1, 8]. */
  quietHours: [number, number] | null;
}

/** Everything attention needs to know, folded from the sense stream. */
export interface Situation {
  present: boolean;
  /** Free-text read from the vision model, if the camera is on. */
  read?: string;
  app?: string;
  windowTitle?: string;
  idleSeconds: number;
  /** How long the frontmost app has been unchanged, in minutes. */
  minutesOnSameApp: number;
  /** Wall-clock gap since the user was last seen, in minutes. */
  minutesSinceLastPresent: number;
  /** Minutes since either of them last said anything. */
  minutesSinceLastTurn: number;
  /** Whether a conversation is currently live. */
  inConversation: boolean;
  nextEvent?: { summary: string; startsInMinutes: number };
}

/** Per-trigger cooldowns, in minutes. Deliberately long. */
const TRIGGER_COOLDOWN_MINUTES: Record<TriggerId, number> = {
  returned: 90,
  stuck: 120,
  'late-night': 360,
  calendar: 45,
  'looks-rough': 180,
  'long-silence': 60,
};

export class Attention {
  #policy: AttentionPolicy;
  readonly #lastFiredAt = new Map<TriggerId, number>();
  #lastOpenerAt = 0;

  constructor(policy: AttentionPolicy) {
    this.#policy = policy;
  }

  setPolicy(policy: AttentionPolicy): void {
    this.#policy = policy;
  }

  /**
   * Should Anna say something unprompted right now?
   *
   * Pure apart from the cooldown bookkeeping, which only advances when an
   * opener is actually returned — a suppressed trigger must not burn its own
   * cooldown, or a single quiet hour would silence her for the rest of the day.
   */
  decide(situation: Situation, now: number): Opener | null {
    if (!this.#policy.proactive) return null;
    if (!situation.present) return null;
    if (situation.inConversation) return null;
    if (this.#inQuietHours(now)) return null;

    const sinceLastOpener = minutes(now - this.#lastOpenerAt);
    if (this.#lastOpenerAt > 0 && sinceLastOpener < this.#policy.minMinutesBetweenOpeners) {
      return null;
    }

    const candidates = this.#candidates(situation, now)
      .filter((opener) => this.#offCooldown(opener.trigger, now))
      .sort((a, b) => b.priority - a.priority);

    const chosen = candidates[0];
    if (!chosen) return null;

    this.#lastOpenerAt = now;
    this.#lastFiredAt.set(chosen.trigger, now);
    return chosen;
  }

  #candidates(situation: Situation, now: number): Opener[] {
    const openers: Opener[] = [];
    const hour = new Date(now).getHours();

    if (situation.nextEvent && situation.nextEvent.startsInMinutes <= 12) {
      openers.push({
        trigger: 'calendar',
        priority: 100,
        reason: `"${situation.nextEvent.summary}" starts in ${situation.nextEvent.startsInMinutes} minutes and they have not mentioned it`,
      });
    }

    if (situation.read && looksRough(situation.read)) {
      openers.push({
        trigger: 'looks-rough',
        priority: 90,
        reason: `you looked up and they seem off — ${situation.read}`,
      });
    }

    if (situation.minutesSinceLastPresent >= 45) {
      openers.push({
        trigger: 'returned',
        priority: 70,
        reason: `they just came back after ${Math.round(situation.minutesSinceLastPresent)} minutes away`,
      });
    }

    if (situation.minutesOnSameApp >= 40 && situation.app) {
      openers.push({
        trigger: 'stuck',
        priority: 50,
        reason: `they have been in ${situation.app} for ${Math.round(situation.minutesOnSameApp)} minutes straight without moving on`,
      });
    }

    if ((hour >= 1 && hour < 5) && situation.idleSeconds < 300) {
      openers.push({
        trigger: 'late-night',
        priority: 60,
        reason: `it is ${hour === 0 ? 12 : hour}am and they are still up and working`,
      });
    }

    if (situation.minutesSinceLastTurn >= 240 && situation.minutesSinceLastTurn < 100000) {
      openers.push({
        trigger: 'long-silence',
        priority: 20,
        reason: `you have not talked in ${Math.round(situation.minutesSinceLastTurn / 60)} hours and you were thinking about them`,
      });
    }

    return openers;
  }

  #offCooldown(trigger: TriggerId, now: number): boolean {
    const last = this.#lastFiredAt.get(trigger);
    if (last === undefined) return true;
    return minutes(now - last) >= TRIGGER_COOLDOWN_MINUTES[trigger];
  }

  #inQuietHours(now: number): boolean {
    const quiet = this.#policy.quietHours;
    if (!quiet) return false;
    const [from, to] = quiet;
    const hour = new Date(now).getHours();
    // A window like [23, 7] wraps past midnight.
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  }
}

const ROUGH_SIGNALS = [
  'slump',
  'head in',
  'hands on face',
  'rubbing',
  'crying',
  'tears',
  'tense',
  'hunched',
  'exhausted',
  'frowning',
  'staring blankly',
  'shoulders up',
];

function looksRough(read: string): boolean {
  const lower = read.toLowerCase();
  return ROUGH_SIGNALS.some((signal) => lower.includes(signal));
}

function minutes(milliseconds: number): number {
  return milliseconds / 60000;
}

// ---------------------------------------------------------------------------
// Folding the raw sense stream into a Situation
// ---------------------------------------------------------------------------

/**
 * Accumulates sense events into the single snapshot {@link Attention} reads.
 *
 * Kept separate from Attention so the policy can be tested against handmade
 * situations without simulating an event stream, and so a new sensor is one
 * `case` here rather than a change to the judgement rules.
 */
export class SituationTracker {
  #present = true;
  #read: string | undefined;
  #readAt = 0;
  #app: string | undefined;
  #windowTitle: string | undefined;
  #idleSeconds = 0;
  #appSince = Date.now();
  #lastPresentAt = Date.now();
  #lastTurnAt = Date.now();
  #nextEvent: { summary: string; startsInMinutes: number } | undefined;

  observe(event: SenseEvent): void {
    switch (event.kind) {
      case 'presence': {
        if (event.present) this.#lastPresentAt = event.at;
        this.#present = event.present;
        // Only replace the visual read when this event carries one. The 20s
        // activity poll emits presence with no `read`, which used to wipe the
        // camera's description about twenty seconds after every 45s frame.
        if (event.read !== undefined) {
          this.#read = event.read;
          this.#readAt = event.at;
        }
        break;
      }
      case 'activity': {
        if (event.app !== this.#app) {
          this.#app = event.app;
          this.#appSince = event.at;
        }
        this.#windowTitle = event.windowTitle;
        this.#idleSeconds = event.idleSeconds;
        break;
      }
      case 'calendar': {
        // A negative or empty event means "nothing coming up" — which has to
        // clear the old one, or a finished meeting is reported all day.
        this.#nextEvent =
          event.summary && event.startsInMinutes >= 0
            ? { summary: event.summary, startsInMinutes: event.startsInMinutes }
            : undefined;
        break;
      }
      case 'user-speech':
      case 'user-typed': {
        this.#lastTurnAt = event.at;
        this.#lastPresentAt = event.at;
        this.#present = true;
        break;
      }
      default:
        break;
    }
  }

  /** Anna talking also counts as the conversation being alive. */
  noteAnnaSpoke(at: number): void {
    this.#lastTurnAt = at;
  }

  snapshot(now: number, inConversation: boolean): Situation {
    // A visual read expires. Describing how someone looked three minutes ago
    // as though it were now is worse than not having looked — she confidently
    // tells you that you seem tired after you have got up and made coffee.
    const read = this.#read && now - this.#readAt < READ_STALE_MS ? this.#read : undefined;
    return {
      present: this.#present,
      ...(read && { read }),
      ...(this.#app && { app: this.#app }),
      ...(this.#windowTitle && { windowTitle: this.#windowTitle }),
      idleSeconds: this.#idleSeconds,
      minutesOnSameApp: minutes(now - this.#appSince),
      minutesSinceLastPresent: this.#present ? 0 : minutes(now - this.#lastPresentAt),
      minutesSinceLastTurn: minutes(now - this.#lastTurnAt),
      inConversation,
      ...(this.#nextEvent && { nextEvent: this.#nextEvent }),
    };
  }

  /**
   * The lines shown to Anna under "what you can see".
   *
   * Phrased the way a person in the room would describe it, not the way a
   * telemetry pipeline would. "They have been in Xcode for a while" is
   * something you notice; "app=Xcode idle_seconds=2871" is something you log.
   */
  describe(now: number): string[] {
    const lines: string[] = [];
    const situation = this.snapshot(now, false);

    if (!situation.present) {
      lines.push(`They are away — about ${Math.round(situation.minutesSinceLastPresent)} minutes now.`);
      return lines;
    }

    if (situation.app) {
      const duration = Math.round(situation.minutesOnSameApp);
      lines.push(
        duration >= 20
          ? `They have been in ${situation.app} for ${duration} minutes.`
          : `They are in ${situation.app}.`,
      );
    }
    if (situation.windowTitle && situation.windowTitle !== situation.app) {
      lines.push(`On screen: ${situation.windowTitle}`);
    }
    if (situation.idleSeconds > 180) {
      lines.push(`They have not touched the keyboard in ${Math.round(situation.idleSeconds / 60)} minutes.`);
    }
    if (situation.read) {
      lines.push(`How they look, just now: ${situation.read}`);
    } else if (this.#read) {
      // She looked, but it was a while ago. Say so rather than presenting a
      // stale observation as current.
      lines.push('You have not looked at them recently.');
    }
    if (situation.nextEvent) {
      lines.push(
        `Calendar: "${situation.nextEvent.summary}" in ${situation.nextEvent.startsInMinutes} minutes.`,
      );
    }
    return lines;
  }
}
