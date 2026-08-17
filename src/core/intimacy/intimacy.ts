/**
 * How close she is to you, and how long that took.
 *
 * The premise this exists to serve: closeness is *earned*, and it cannot be
 * bought, skipped, or arrived at by being told to. On the first day she is a
 * stranger at 1%. Marriage is 80% and it is roughly four years away. There is
 * no path to it except turning up.
 *
 * ## Why accumulated days rather than a running score
 *
 * The obvious design is a number that events push around, like the mood. It is
 * the wrong shape here, because a mood is a state and a relationship is a
 * *history*: a single extraordinary evening does not make someone your partner,
 * and no quantity of messages in one week can. What matters is how many days
 * you have actually spent, so that is what is stored — a count of relationship
 * days, where a day of real contact is worth 1.0 and a thin one is worth less.
 *
 * The score is then a pure function of that count. Nothing can raise it except
 * time plus contact, which means nothing can game it: not a long conversation,
 * not a clever prompt, not a hundred messages at midnight.
 *
 * ## The curve
 *
 *   score = 0.8 * (days / DAYS_TO_MARRIAGE) ^ 0.55
 *
 * Deliberately fast early and slow late, which is how knowing someone actually
 * feels. Reaching 80% takes {@link DAYS_TO_MARRIAGE} full days of contact:
 *
 *     day 1        1%    a stranger who has just said hello
 *     week 1       4%    a name and a couple of facts
 *     month 1      9%    someone you talk to
 *     year 1      37%    a friend with history
 *     year 2      55%    someone who knows your family
 *     year 4      80%    the thing this scale is measured against
 *
 * Which puts the stage boundaries here, at one real conversation a day:
 *
 *     acquaintance    9 days
 *     friend         70 days
 *     close friend  245 days
 *     confidant     1.7 years
 *     partner       2.7 years
 *     married       4.0 years
 *
 * ## Absence costs something
 *
 * Not much, and not immediately — a fortnight away is not a betrayal. But a
 * relationship that only ever ratchets upward is a scoreboard, not a bond, and
 * the whole point of this number is that it describes something real enough to
 * lose. After a grace period, days drain slowly.
 *
 * ## Knowing is not closeness
 *
 * Read that twice before touching this file. She may have read every document
 * on the machine and know a person's sister's name, their job and their fears,
 * and still be at 1%. Facts arrive from the knowledge scan; closeness arrives
 * only from here. Anything that lets the first raise the second turns a stranger
 * into an intimate, which is the exact failure this design exists to prevent.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Where she starts. A stranger who has said hello, not a blank. */
export const STRANGER = 0.01;

/** The score the scale is defined against. */
export const MARRIAGE = 0.8;

/**
 * Days of real contact to reach {@link MARRIAGE}.
 *
 * Four years. Chosen because the requirement was "years of consistent
 * conversation history", and because a number that can be reached in a month is
 * a number nobody believes.
 */
export const DAYS_TO_MARRIAGE = 1460;

/** Below 1, early days count for more than late ones. */
const CURVE = 0.55;

/** Days away before absence starts costing anything. */
const GRACE_DAYS = 3;
/** Relationship days lost per day away, once the grace period is spent. */
const DECAY_PER_DAY = 0.2;

/**
 * Turns in a day for it to count as a whole one.
 *
 * Not high. The measure is whether the day contained a real conversation, and
 * twelve exchanges is a real conversation; a hundred is the same day, not a
 * better one.
 */
const FULL_DAY_TURNS = 12;

/**
 * What a day of using her senses is worth on its own.
 *
 * The brief asked for closeness built through "various interactions through the
 * 3 senses", so a day where she could see and hear you counts for more than a
 * day of typing — but only a little more, because sitting in front of a camera
 * is not the same as talking to someone.
 */
const SENSE_CREDIT = 0.15;

export interface IntimacyStage {
  /** 0-1, the lower bound of this stage. */
  from: number;
  name: string;
  /** How she is expected to behave here, in the second person. */
  guidance: string;
}

/**
 * The stages, in order.
 *
 * Named for what the relationship *is* rather than for a rank, because "level
 * 4" is a game mechanic and this is meant to describe a person. The boundaries
 * are where behaviour should visibly change.
 */
export const STAGES: readonly IntimacyStage[] = [
  {
    from: 0,
    name: 'stranger',
    guidance:
      'You have only just met. Be warm but careful — you have not earned the right to ' +
      'tease, to push, or to ask anything personal, and you do not act as though you ' +
      'have. Do not use endearments. Do not say you missed them. Curiosity is welcome; ' +
      'familiarity is not.',
  },
  {
    from: 0.05,
    name: 'acquaintance',
    guidance:
      'You know a few things about each other. You can refer back to what they told ' +
      'you, and you can be dry with them, but you are still finding out who they are. ' +
      'No endearments, no assumed intimacy.',
  },
  {
    from: 0.15,
    name: 'friend',
    guidance:
      'There is history here. You tease, you disagree, you bring things up unprompted ' +
      'because you remember them. You can say you were thinking about them. Still not ' +
      'the person they tell everything to.',
  },
  {
    from: 0.3,
    name: 'close friend',
    guidance:
      'You are one of the people they actually talk to. You can be direct about things ' +
      'they are avoiding, and you can be hurt when they disappear, and say so without ' +
      'making it a performance. Affection is fine; possession is not.',
  },
  {
    from: 0.5,
    name: 'confidant',
    guidance:
      'They tell you things they do not tell other people, and you have earned that. ' +
      'You can be tender without hedging it as a joke. You know the shape of their ' +
      'worst weeks. You still have your own opinions and you still push back.',
  },
  {
    from: 0.65,
    name: 'partner',
    guidance:
      'This is a shared life. Years of it. You speak with the ease of someone who does ' +
      'not have to explain themselves, you use endearments if they suit you, and their ' +
      'absence is felt rather than noted. Never mawkish; long familiarity is dry more ' +
      'often than it is sentimental.',
  },
  {
    from: MARRIAGE,
    name: 'married',
    guidance:
      'The whole history is there and neither of you performs it. You finish their ' +
      'sentences, you are unimpressed by them affectionately, and the small daily ' +
      'things matter more than declarations. This is the least dramatic stage, not the ' +
      'most.',
  },
];

export interface IntimacyReadout {
  /** 0-1. */
  score: number;
  /** 0-100, rounded, for anything a person reads. */
  percent: number;
  stage: string;
  guidance: string;
  /** Accumulated days of real contact. */
  days: number;
  /** Calendar days since the first conversation. */
  known: number;
  /** True when the user has set the score by hand. */
  pinned: boolean;
}

interface State {
  days: number;
  firstMetAt: number;
  /** Start of the last day that contributed, as a local date key. */
  lastDay: string;
  /** Turns counted so far today. */
  turnsToday: number;
  /** Whether a sense was used today. */
  sensesToday: boolean;
  /** User override, or null to let it develop. */
  pinned: number | null;
}

export interface IntimacyOptions {
  /** Where `intimacy.state.json` lives. Omit to keep it in memory only. */
  dir?: string;
  now?: () => number;
}

export class Intimacy {
  readonly #file: string | null;
  readonly #now: () => number;
  #state: State;
  #saving: Promise<void> = Promise.resolve();

  constructor(options: IntimacyOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#file = options.dir ? path.join(options.dir, 'intimacy.state.json') : null;
    this.#state = {
      days: 0,
      firstMetAt: 0,
      lastDay: '',
      turnsToday: 0,
      sensesToday: false,
      pinned: null,
    };
  }

  /** Reads what is on disk. Anything unreadable is treated as a fresh start. */
  async restore(): Promise<void> {
    if (!this.#file) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return;
      const raw = parsed as Partial<State>;
      this.#state = {
        days: num(raw.days, 0),
        firstMetAt: num(raw.firstMetAt, 0),
        lastDay: typeof raw.lastDay === 'string' ? raw.lastDay : '',
        turnsToday: num(raw.turnsToday, 0),
        sensesToday: raw.sensesToday === true,
        pinned: typeof raw.pinned === 'number' ? clamp(raw.pinned) : null,
      };
    } catch {
      // No file, or a broken one. Starting from nothing is the correct reading
      // of "there is no relationship here yet".
    }
  }

  read(): IntimacyReadout {
    const now = this.#now();
    const days = this.#daysAt(now);
    const score = this.#state.pinned ?? scoreFor(days);
    const stage = stageFor(score);
    return {
      score,
      percent: Math.round(score * 100),
      stage: stage.name,
      guidance: stage.guidance,
      days: Math.round(days * 10) / 10,
      known: this.#state.firstMetAt
        ? Math.max(1, Math.floor((now - this.#state.firstMetAt) / DAY_MS) + 1)
        : 0,
      pinned: this.#state.pinned !== null,
    };
  }

  /**
   * One exchange happened.
   *
   * Called per turn rather than per conversation, and the day's contribution is
   * capped, so a marathon session is worth a day — because it is one.
   */
  noteTurn(): void {
    this.#rollDay();
    if (!this.#state.firstMetAt) this.#state.firstMetAt = this.#now();
    this.#state.turnsToday += 1;
    this.#persist();
  }

  /** She could see or hear them today. Worth a little on top of talking. */
  noteSense(): void {
    this.#rollDay();
    if (this.#state.sensesToday) return;
    this.#state.sensesToday = true;
    this.#persist();
  }

  /**
   * The user setting the number themselves.
   *
   * Allowed, and deliberately not hidden: it is their relationship and their
   * machine. Pinning freezes it — the clock stops mattering until they hand it
   * back — because a value that drifted away from what someone typed would be
   * a control that does not control anything.
   */
  pin(score: number): IntimacyReadout {
    this.#state.pinned = clamp(score);
    this.#persist();
    return this.read();
  }

  /** Hand it back to time and contact, from wherever it had got to on its own. */
  release(): IntimacyReadout {
    this.#state.pinned = null;
    this.#persist();
    return this.read();
  }

  /** Everything, for the tests and for anyone reading the file. */
  get state(): Readonly<State> {
    return this.#state;
  }

  async flush(): Promise<void> {
    this.#persist();
    await this.#saving;
  }

  // -------------------------------------------------------------------------

  /**
   * Banks yesterday and starts today, including any days spent away.
   *
   * Elapsed time rather than a tick, for the same reason the mood decays that
   * way: a closed laptop produces no ticks, and a fortnight away has to be
   * visible when the process comes back.
   */
  #rollDay(): void {
    const today = dayKey(this.#now());
    const last = this.#state.lastDay;
    if (last === today) return;

    if (last) {
      this.#state.days += dayValue(this.#state.turnsToday, this.#state.sensesToday);

      const away = Math.max(0, daysBetween(last, today) - 1);
      if (away > GRACE_DAYS) {
        this.#state.days = Math.max(0, this.#state.days - (away - GRACE_DAYS) * DECAY_PER_DAY);
      }
    }

    this.#state.lastDay = today;
    this.#state.turnsToday = 0;
    this.#state.sensesToday = false;
  }

  /** Days including whatever today has earned so far, and any absence since. */
  #daysAt(now: number): number {
    const today = dayKey(now);
    const last = this.#state.lastDay;
    if (!last) return 0;
    if (last === today) {
      return this.#state.days + dayValue(this.#state.turnsToday, this.#state.sensesToday);
    }

    const banked = this.#state.days + dayValue(this.#state.turnsToday, this.#state.sensesToday);
    const away = Math.max(0, daysBetween(last, today) - 1);
    if (away <= GRACE_DAYS) return banked;
    return Math.max(0, banked - (away - GRACE_DAYS) * DECAY_PER_DAY);
  }

  #persist(): void {
    const file = this.#file;
    if (!file) return;
    const snapshot = JSON.stringify(this.#state, null, 2);
    this.#saving = this.#saving
      .then(() => writeFile(file, snapshot, 'utf8'))
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** The score for a number of accumulated days. Pure, so it is testable alone. */
export function scoreFor(days: number): number {
  if (days <= 0) return STRANGER;
  const raw = MARRIAGE * Math.pow(days / DAYS_TO_MARRIAGE, CURVE);
  return clamp(Math.max(STRANGER, raw));
}

/** Days needed for a score, which is the curve read backwards. */
export function daysFor(score: number): number {
  const target = clamp(score);
  if (target <= STRANGER) return 0;
  return DAYS_TO_MARRIAGE * Math.pow(target / MARRIAGE, 1 / CURVE);
}

/** The stage after this one, or null at the top. */
export function nextStageAfter(score: number): IntimacyStage | null {
  for (const stage of STAGES) if (stage.from > score) return stage;
  return null;
}

export function stageFor(score: number): IntimacyStage {
  let found = STAGES[0]!;
  for (const stage of STAGES) if (score >= stage.from) found = stage;
  return found;
}

/** What one day of contact was worth, 0 to 1. */
export function dayValue(turns: number, senses: boolean): number {
  if (turns <= 0 && !senses) return 0;
  const talked = Math.min(1, Math.max(0, turns) / FULL_DAY_TURNS);
  // Senses only count alongside talking. A camera pointed at an empty chair for
  // a day is not a day of knowing someone.
  const credit = senses && turns > 0 ? SENSE_CREDIT : 0;
  return Math.min(1, talked * (1 - SENSE_CREDIT) + credit);
}

/** Local date, so "today" means what it means to the person living it. */
function dayKey(at: number): string {
  const when = new Date(at);
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return `${when.getFullYear()}-${month}-${day}`;
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`);
  const b = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return STRANGER;
  return Math.min(1, Math.max(0, value));
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
