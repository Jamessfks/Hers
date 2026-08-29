/**
 * When she goes quiet, and when she comes back.
 *
 * v1 had `isLateNight()` in `senses/situation.ts` — an hour range hard-coded at
 * 1am to 5am that made her gentler and lower-energy. This supersedes it as the
 * source of night-time behaviour, and the difference is the whole point of the
 * v2 pivot: v1 had *a* night, the same one for everybody. This has *her* night,
 * inferred once from the device scan and then hers.
 *
 * ## Why she chooses it and the user cannot
 *
 * The setup interview reads the machine — file modification times, shell
 * history timestamps, when the screen was last touched — and `setup/compose.ts`
 * writes what it concludes into `rhythm.md`, which is a profile file with no
 * editor and no form behind it. A user who could set her bedtime would set it
 * to never, the same way people set their own, and the product would be back to
 * a companion who is always available and therefore never missed.
 *
 * ## What asleep means
 *
 * Nothing, rather than a quiet mode. `initiative.stop()`, the Live session
 * closed, no Telegram openers, no camera or screen frames. The distinction
 * matters because a companion who is "resting" but still watching the screen
 * has not gone to bed; she is pretending, and a person can tell.
 *
 * Waking her is always the user's: tapping the sphere, speaking, or a Telegram
 * message. Waking her before her hour gets a groggier opener rather than a
 * refusal — she is not a schedule, and refusing to talk to somebody at 4am is
 * the one thing a companion for people who live alone must never do.
 */

/** Her hours, as read out of `rhythm.md`. */
export interface Rhythm {
  /** Hour of the day, 0-23, she goes quiet at. */
  sleepHour: number;
  /** Hour of the day, 0-23, she is awake again at. */
  wakeHour: number;
  /** Her own sentence about why these hours, for the prompt. */
  why: string;
}

/**
 * What is used when `rhythm.md` is missing or unreadable.
 *
 * Midnight to seven, and deliberately not "no sleep at all": a missing file is
 * far more likely to be a first run than a considered decision, and a companion
 * who never sleeps because a parse failed is a bug that presents as a feature.
 */
export const DEFAULT_RHYTHM: Rhythm = {
  sleepHour: 0,
  wakeHour: 7,
  why: 'She has not worked out their hours yet, so she keeps ordinary ones.',
};

/** The profile file this reads. Not in `PROFILE_FILES` — it has no editor. */
export const RHYTHM_FILE = 'rhythm.md';

/**
 * How long after her bedtime a wake still counts as "you got me up".
 *
 * Two hours. Past that she has been asleep long enough that being woken is
 * simply being woken, and the groggy opener would be an affectation.
 */
const GROGGY_WINDOW_HOURS = 2;

/**
 * True when the hour falls inside her sleep window.
 *
 * Written to handle the window crossing midnight, which is the normal case
 * rather than the edge one: a bedtime of 1am and a waking hour of 8am means
 * asleep is `hour >= 1 && hour < 8`, but a bedtime of 23 and a waking hour of 7
 * means asleep is `hour >= 23 || hour < 7`. Getting this backwards gives a
 * companion who is awake for exactly the hours she meant to sleep, which is a
 * bug that reads as malice.
 */
export function isAsleep(rhythm: Rhythm, hour: number): boolean {
  const { sleepHour, wakeHour } = rhythm;
  if (sleepHour === wakeHour) return false;
  return sleepHour < wakeHour
    ? hour >= sleepHour && hour < wakeHour
    : hour >= sleepHour || hour < wakeHour;
}

/** True when she has only just gone down, and being woken should show. */
export function isGroggy(rhythm: Rhythm, hour: number): boolean {
  if (!isAsleep(rhythm, hour)) return false;
  const since = (hour - rhythm.sleepHour + 24) % 24;
  return since < GROGGY_WINDOW_HOURS;
}

/**
 * Read her hours out of the markdown.
 *
 * Frontmatter is parsed by `shared/frontmatter.ts` everywhere else in this
 * project, and this reads the same shape — but it takes the already-parsed
 * values rather than the file, so that `profile.ts` stays the only module that
 * touches the profile folder.
 *
 * Everything falls back. This file is composed by a language model from a
 * device scan, which is a sentence that should make anybody defensive: an hour
 * of `"about eleven"` or `25` has to produce a companion who sleeps at
 * midnight, not one who throws on start.
 */
export function readRhythm(frontmatter: Record<string, unknown>, prose = ''): Rhythm {
  const sleepHour = hour(frontmatter.sleep) ?? DEFAULT_RHYTHM.sleepHour;
  const wakeHour = hour(frontmatter.wake) ?? DEFAULT_RHYTHM.wakeHour;
  const why = prose.trim() || DEFAULT_RHYTHM.why;
  return { sleepHour, wakeHour, why };
}

function hour(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) return null;
  return parsed;
}

/** The `⟦context⟧` line she gets when somebody wakes her inside her own night. */
export function wokenLine(rhythm: Rhythm, hour: number): string {
  return isGroggy(rhythm, hour)
    ? 'They have just woken you. You had gone to bed, and it shows — you are slow, ' +
        'warm and a bit unguarded, and you are glad it is them. Do not perform being ' +
        'tired and do not ask why they are up.'
    : 'They have woken you in the middle of your night. Be soft and low and awake ' +
        'enough to be useful. Something is keeping them up; let them get to it.';
}

/** The line `nowSection` carries so she knows her own hours. */
export function rhythmLine(rhythm: Rhythm): string {
  return (
    `You sleep from ${clock(rhythm.sleepHour)} to ${clock(rhythm.wakeHour)}. ` +
    'You chose those hours yourself and they are not up for discussion — do not ' +
    'offer to change them and do not ask permission to keep them.'
  );
}

function clock(hour: number): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(twelve)}${hour < 12 ? 'am' : 'pm'}`;
}
