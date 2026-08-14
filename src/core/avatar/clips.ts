/**
 * The clip library: what a photo-driven avatar is actually made of.
 *
 * The VRM renderer animates a rig, so a gesture is free and exists the instant
 * it is authored. A generated-video avatar has neither property: one clip takes
 * 30 seconds to five minutes to render and costs $0.10–$0.50, which rules out
 * generating anything per utterance — a companion who waits two minutes to nod
 * is not a companion. So the cost is moved in time instead. Every gesture is
 * generated **once**, at setup, from a single photograph, and conversation-time
 * playback becomes a lookup in this library. The `[lean_in]` directives the
 * model already writes (see core/persona/performance.ts) select a clip here
 * exactly as they select a pose in renderer/avatar/poses.ts.
 *
 * That makes the library a small, very expensive database, and three properties
 * of it drive everything in this file:
 *
 *  - **It costs money.** Nineteen clips is a few dollars and the better part of
 *    an hour. Every transition below is written so that a crash, a retry or a
 *    restart cannot cause the same clip to be paid for twice, and so that bytes
 *    already on disk are always believed over anything the manifest claims.
 *  - **It is partial for a long time.** The user must be able to talk to her
 *    while the library is still rendering, so "not ready yet" is a normal state
 *    with a defined fallback rather than an error. See {@link resolvePlayback}.
 *  - **It belongs to one photograph.** A clip generated from last month's photo
 *    played next to this month's still is a different person blinking into
 *    frame. Identity is the hash of the source image, and it is the *only*
 *    invalidation mechanism — a separate "dirty" flag is a thing that can be
 *    wrong, and a hash cannot.
 *
 * Everything here is a pure function over plain data so the interesting cases —
 * an interrupted build, a manifest that disagrees with the disk, a slot that
 * fails forever — are testable without a filesystem and without a vendor.
 */

import { GESTURE_NAMES, type GestureName } from '../../shared/protocol.ts';

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * The base clip, and the reason the library has 19 entries rather than 18.
 *
 * Every other clip is a beat that fires and finishes. This one plays whenever
 * nothing else is playing, which for a companion is almost all of the time. It
 * is the difference between a photograph on the screen and a person standing
 * there, so it is generated first and the library is close to useless without
 * it.
 */
export const IDLE_SLOT = 'idle';

export type ClipSlotName = GestureName | typeof IDLE_SLOT;

export const CLIP_SLOT_NAMES: readonly ClipSlotName[] = [IDLE_SLOT, ...GESTURE_NAMES];

/**
 * The order the library is built in.
 *
 * A library becomes useful long before it is complete, so this is ranked by
 * presence bought per dollar rather than alphabetically: idle first because
 * without it nothing moves at all, then the four gestures Anna's persona
 * actually reaches for in almost every turn (`[tilt_head]`, `[lean_in]`,
 * `[nod]` — see the worked examples in core/persona/anna.ts), then the rest,
 * with the two posture changes last because they are the least useful and the
 * hardest to generate (see prompts.ts).
 */
export const BUILD_ORDER: readonly ClipSlotName[] = [
  'idle',
  'nod',
  'tilt_head',
  'lean_in',
  'shake_head',
  'cover_mouth_laugh',
  'look_away_thinking',
  'sway',
  'hand_to_chest',
  'lean_back',
  'wave',
  'shrug',
  'fidget',
  'point_at_user',
  'reach_toward_user',
  'hands_behind_back',
  'stretch',
  'sit_down',
  'stand_up',
];

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export type ClipStatus = 'pending' | 'generating' | 'ready' | 'failed';

/**
 * A provider-side job, kept because losing it means paying again.
 *
 * The submit/poll/download shape of every image-to-video API means a job
 * outlives our process: quit the app while nine clips are rendering and the
 * vendor keeps rendering them and keeps billing for them. Persisting the handle
 * turns a restart into a free re-poll instead of a second purchase.
 */
export interface ClipJobRef {
  providerId: string;
  id: string;
  submittedAt: number;
}

export interface ClipEntry {
  slot: ClipSlotName;
  status: ClipStatus;
  /** File name inside the library's `clips/` directory. Set only when ready. */
  file: string | null;
  /** Length of the finished clip. 0 until one exists. */
  durationMs: number;
  /** In-flight job, or null. Non-null only while `status` is 'generating'. */
  job: ClipJobRef | null;
  /** How many times generation has been attempted, successful or not. */
  attempts: number;
  /** Why the last attempt failed, phrased for a human. */
  error: string | null;
  /** What this slot has cost so far. Failed attempts are often billed too. */
  spentUsd: number;
  updatedAt: number;
}

export interface ClipLibrary {
  version: 1;
  /** Full hex digest of the source photograph. The library's identity. */
  sourceHash: string;
  /** File name of the stored copy of the photograph, inside the library dir. */
  sourceFile: string;
  /** Which provider generated, or is generating, these clips. */
  providerId: string;
  createdAt: number;
  clips: Record<ClipSlotName, ClipEntry>;
}

/**
 * How many times a slot may be attempted before it is left alone.
 *
 * A clip that has failed three times is a prompt the model will not accept or a
 * subject the safety filter will not animate, not a flake — and the difference
 * between those two matters because retrying the first costs nothing and
 * retrying the second costs $0.50 a go, forever, while the user watches a
 * progress bar that never finishes.
 */
export const MAX_ATTEMPTS = 3;

/**
 * The transitions that are allowed to happen.
 *
 * Written out rather than implied because the expensive mistake is a legal-
 * looking one: `generating -> generating` is a double submit, and it costs
 * money every time it happens rather than throwing an error someone would
 * notice.
 */
export const CLIP_TRANSITIONS: Record<ClipStatus, readonly ClipStatus[]> = {
  // 'pending -> pending' is allowed: it is what re-queuing an interrupted or
  // orphaned attempt looks like, and it must be idempotent.
  pending: ['pending', 'generating'],
  generating: ['ready', 'failed', 'pending'],
  ready: ['pending', 'generating'],
  failed: ['pending', 'generating'],
};

export function canTransition(from: ClipStatus, to: ClipStatus): boolean {
  return CLIP_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Building a library
// ---------------------------------------------------------------------------

export interface CreateLibraryOptions {
  sourceHash: string;
  sourceFile: string;
  providerId: string;
  now?: number;
}

export function createLibrary(options: CreateLibraryOptions): ClipLibrary {
  const now = options.now ?? Date.now();
  return {
    version: 1,
    sourceHash: options.sourceHash,
    sourceFile: options.sourceFile,
    providerId: options.providerId,
    createdAt: now,
    clips: Object.fromEntries(
      CLIP_SLOT_NAMES.map((slot) => [slot, blankEntry(slot, now)]),
    ) as Record<ClipSlotName, ClipEntry>,
  };
}

function blankEntry(slot: ClipSlotName, now: number): ClipEntry {
  return {
    slot,
    status: 'pending',
    file: null,
    durationMs: 0,
    job: null,
    attempts: 0,
    error: null,
    spentUsd: 0,
    updatedAt: now,
  };
}

/** The conventional file name for a slot. Extension follows the container. */
export function clipFileName(slot: ClipSlotName, extension = 'mp4'): string {
  return `${slot}.${extension.replace(/^\./, '')}`;
}

/** The slot a file on disk belongs to, or null if it is not one of ours. */
export function slotOfClipFile(fileName: string): ClipSlotName | null {
  const stem = fileName.slice(0, fileName.lastIndexOf('.') === -1 ? undefined : fileName.lastIndexOf('.'));
  return (CLIP_SLOT_NAMES as readonly string[]).includes(stem) ? (stem as ClipSlotName) : null;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function withEntry(
  library: ClipLibrary,
  slot: ClipSlotName,
  patch: Partial<ClipEntry>,
  now: number,
): ClipLibrary {
  const current = library.clips[slot];
  if (patch.status && !canTransition(current.status, patch.status)) {
    throw new Error(`${slot}: cannot go from ${current.status} to ${patch.status}`);
  }
  return {
    ...library,
    clips: { ...library.clips, [slot]: { ...current, ...patch, updatedAt: now } },
  };
}

/**
 * Record the *intent* to generate, before the request goes out.
 *
 * The handle is optional and usually absent here, which is the point: there is
 * a window between "the vendor accepted the job" and "we wrote the id down",
 * and a crash inside it leaves a clip we are being billed for and cannot claim.
 * Writing `generating` with a null job first turns that invisible loss into a
 * visible one — {@link reconcile} sees the intent with no handle and re-queues
 * the slot with a note, instead of the library quietly looking untouched.
 */
export function startGenerating(
  library: ClipLibrary,
  slot: ClipSlotName,
  job: ClipJobRef | null = null,
  now = Date.now(),
): ClipLibrary {
  const entry = library.clips[slot];
  if (entry.status === 'generating') {
    throw new Error(`${slot} is already generating; submitting again would be billed twice`);
  }
  return withEntry(
    library,
    slot,
    { status: 'generating', job, attempts: entry.attempts + 1, error: null },
    now,
  );
}

/** Attach the provider's job id once submit returns. */
export function attachJob(
  library: ClipLibrary,
  slot: ClipSlotName,
  job: ClipJobRef,
  now = Date.now(),
): ClipLibrary {
  if (library.clips[slot].status !== 'generating') {
    throw new Error(`${slot} is not generating; there is no job to attach`);
  }
  return withEntry(library, slot, { job }, now);
}

export interface CompletedClip {
  /** File name inside `clips/`, already written to disk. */
  file: string;
  durationMs: number;
  costUsd?: number;
}

export function completeClip(
  library: ClipLibrary,
  slot: ClipSlotName,
  clip: CompletedClip,
  now = Date.now(),
): ClipLibrary {
  const entry = library.clips[slot];
  return withEntry(
    library,
    slot,
    {
      status: 'ready',
      file: clip.file,
      durationMs: clip.durationMs,
      job: null,
      error: null,
      spentUsd: entry.spentUsd + (clip.costUsd ?? 0),
    },
    now,
  );
}

/**
 * A failed attempt is still billed by most vendors, so `costUsd` is accepted
 * here too. A library that under-reports what it spent is worse than one that
 * reports nothing, because it will be believed.
 */
export function failClip(
  library: ClipLibrary,
  slot: ClipSlotName,
  reason: string,
  options: { costUsd?: number; now?: number } = {},
): ClipLibrary {
  const entry = library.clips[slot];
  return withEntry(
    library,
    slot,
    {
      status: 'failed',
      job: null,
      error: reason,
      spentUsd: entry.spentUsd + (options.costUsd ?? 0),
    },
    options.now ?? Date.now(),
  );
}

/** Put a slot back in the queue. Used by reconcile, and by "try again". */
export function requeueClip(
  library: ClipLibrary,
  slot: ClipSlotName,
  reason: string | null = null,
  now = Date.now(),
): ClipLibrary {
  return withEntry(library, slot, { status: 'pending', job: null, error: reason }, now);
}

/** Clear the attempt counter so a slot that hit {@link MAX_ATTEMPTS} can run. */
export function resetAttempts(
  library: ClipLibrary,
  slot: ClipSlotName,
  now = Date.now(),
): ClipLibrary {
  return withEntry(library, slot, { attempts: 0 }, now);
}

// ---------------------------------------------------------------------------
// Resuming
// ---------------------------------------------------------------------------

/**
 * Make the manifest agree with the disk.
 *
 * Run on every load, because the two can disagree in both directions and each
 * direction has a different right answer:
 *
 *  - **File present, manifest says otherwise.** The bytes win, always. We paid
 *    for them. This happens on a crash between writing the clip and saving the
 *    manifest — an ordering chosen deliberately in library-store.ts, precisely
 *    so that the survivable failure is the one that costs nothing.
 *  - **Manifest says ready, file gone.** Believe the disk again and re-queue.
 *    The alternative is a library that looks complete and plays nothing.
 *  - **Generating with a job handle.** Left alone: the vendor is probably still
 *    working, and re-polling is free where re-submitting is not.
 *  - **Generating with no handle.** The crash window described in
 *    {@link startGenerating}. Re-queued, with the possible double-charge stated
 *    in `error` rather than swallowed.
 */
export function reconcile(
  library: ClipLibrary,
  filesPresent: ReadonlySet<string>,
  now = Date.now(),
): ClipLibrary {
  const bySlot = new Map<ClipSlotName, string>();
  for (const file of filesPresent) {
    const slot = slotOfClipFile(file);
    if (slot) bySlot.set(slot, file);
  }

  let next = library;
  for (const slot of CLIP_SLOT_NAMES) {
    const entry = next.clips[slot];
    const file = bySlot.get(slot);

    if (file) {
      if (entry.status !== 'ready' || entry.file !== file) {
        next = {
          ...next,
          clips: {
            ...next.clips,
            [slot]: { ...entry, status: 'ready', file, job: null, error: null, updatedAt: now },
          },
        };
      }
      continue;
    }

    if (entry.status === 'ready') {
      next = requeueClip(next, slot, 'The clip file went missing, so it will be made again.', now);
      continue;
    }

    if (entry.status === 'generating' && !entry.job) {
      next = requeueClip(
        next,
        slot,
        'Anna stopped before the job id was saved. This one may have been charged for already.',
        now,
      );
    }
  }
  return next;
}

/** Slots that still need to be generated, in {@link BUILD_ORDER}. */
export function pendingWork(library: ClipLibrary): ClipSlotName[] {
  return BUILD_ORDER.filter((slot) => {
    const entry = library.clips[slot];
    if (entry.status === 'pending') return true;
    return entry.status === 'failed' && entry.attempts < MAX_ATTEMPTS;
  });
}

/** Jobs that were in flight when we stopped, and can be re-polled for free. */
export function resumableJobs(library: ClipLibrary): Array<{ slot: ClipSlotName; job: ClipJobRef }> {
  const out: Array<{ slot: ClipSlotName; job: ClipJobRef }> = [];
  for (const slot of BUILD_ORDER) {
    const entry = library.clips[slot];
    if (entry.status === 'generating' && entry.job) out.push({ slot, job: entry.job });
  }
  return out;
}

/** Slots that have given up. Surfaced so the UI can offer "try these again". */
export function exhaustedSlots(library: ClipLibrary): ClipSlotName[] {
  return BUILD_ORDER.filter((slot) => {
    const entry = library.clips[slot];
    return entry.status === 'failed' && entry.attempts >= MAX_ATTEMPTS;
  });
}

// ---------------------------------------------------------------------------
// Reading the library at conversation time
// ---------------------------------------------------------------------------

export interface LibraryProgress {
  ready: number;
  generating: number;
  pending: number;
  failed: number;
  total: number;
  /** 0 to 1. What a progress bar should show. */
  fraction: number;
  /** Sum of every slot's `spentUsd`. */
  spentUsd: number;
  /** Can she be shown at all? True once the idle clip exists. */
  alive: boolean;
}

export function libraryProgress(library: ClipLibrary): LibraryProgress {
  const counts: Record<ClipStatus, number> = { pending: 0, generating: 0, ready: 0, failed: 0 };
  let spentUsd = 0;
  for (const slot of CLIP_SLOT_NAMES) {
    const entry = library.clips[slot];
    counts[entry.status] += 1;
    spentUsd += entry.spentUsd;
  }
  const total = CLIP_SLOT_NAMES.length;
  return {
    ...counts,
    total,
    fraction: counts.ready / total,
    // Rounded because floating point addition of prices produces things like
    // 0.30000000000000004, and a companion that says she has spent
    // $0.30000000000000004 has stopped being a companion.
    spentUsd: Math.round(spentUsd * 10000) / 10000,
    alive: library.clips[IDLE_SLOT].status === 'ready',
  };
}

export type Playback =
  | { kind: 'clip'; slot: ClipSlotName; file: string; durationMs: number }
  /** Nothing generated yet: show the photograph itself. */
  | { kind: 'still'; reason: string };

/**
 * What to play for a gesture, given how much of the library exists.
 *
 * The chain is: the gesture, then idle, then the still. Falling back to idle
 * rather than to the still matters more than it looks — a missed `[wave]` costs
 * nothing, because the gesture vocabulary is advisory and the model emits it
 * without knowing what has been generated, but a frozen frame in the middle of
 * a sentence reads as a crash. She keeps breathing; the wave simply does not
 * happen.
 *
 * The alternative — hold the turn until the clip is ready — would make the
 * first hour after setup unusable, which is the hour the user decides whether
 * any of this was worth it.
 */
export function resolvePlayback(library: ClipLibrary, slot: ClipSlotName): Playback {
  const wanted = library.clips[slot];
  if (wanted.status === 'ready' && wanted.file) {
    return { kind: 'clip', slot, file: wanted.file, durationMs: wanted.durationMs };
  }

  const idle = library.clips[IDLE_SLOT];
  if (slot !== IDLE_SLOT && idle.status === 'ready' && idle.file) {
    return { kind: 'clip', slot: IDLE_SLOT, file: idle.file, durationMs: idle.durationMs };
  }

  return { kind: 'still', reason: `${slot} has not been generated yet` };
}

/** Whether this library was made from this photograph. The only invalidation. */
export function matchesSource(library: ClipLibrary, sourceHash: string): boolean {
  return library.sourceHash === sourceHash;
}

// ---------------------------------------------------------------------------
// Parsing a manifest we did not write
// ---------------------------------------------------------------------------

/**
 * Rebuild a library from whatever was on disk.
 *
 * Deliberately forgiving. The manifest is an index to files that cost money,
 * and an older or hand-edited one must never cause them to be regenerated:
 * unknown slots are dropped, missing slots come back as pending, and anything
 * unparseable resets that *slot* rather than the library. {@link reconcile}
 * then promotes whatever is actually on disk back to ready, so the worst case
 * of a mangled manifest is a lost duration figure, not a lost library.
 *
 * Returns null only when the file is not a clip library at all.
 */
export function parseLibrary(raw: unknown): ClipLibrary | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;
  if (typeof raw.sourceHash !== 'string' || !raw.sourceHash) return null;

  const now = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();
  const stored = isRecord(raw.clips) ? raw.clips : {};

  const clips = Object.fromEntries(
    CLIP_SLOT_NAMES.map((slot) => [slot, parseEntry(stored[slot], slot, now)]),
  ) as Record<ClipSlotName, ClipEntry>;

  return {
    version: 1,
    sourceHash: raw.sourceHash,
    sourceFile: typeof raw.sourceFile === 'string' ? raw.sourceFile : '',
    providerId: typeof raw.providerId === 'string' ? raw.providerId : 'unknown',
    createdAt: now,
    clips,
  };
}

function parseEntry(raw: unknown, slot: ClipSlotName, now: number): ClipEntry {
  const blank = blankEntry(slot, now);
  if (!isRecord(raw)) return blank;

  const status =
    typeof raw.status === 'string' && raw.status in CLIP_TRANSITIONS
      ? (raw.status as ClipStatus)
      : 'pending';

  return {
    slot,
    status,
    file: typeof raw.file === 'string' ? raw.file : null,
    durationMs: numberOr(raw.durationMs, 0),
    job: parseJob(raw.job),
    attempts: numberOr(raw.attempts, 0),
    error: typeof raw.error === 'string' ? raw.error : null,
    spentUsd: numberOr(raw.spentUsd, 0),
    updatedAt: numberOr(raw.updatedAt, now),
  };
}

function parseJob(raw: unknown): ClipJobRef | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || typeof raw.providerId !== 'string') return null;
  return { id: raw.id, providerId: raw.providerId, submittedAt: numberOr(raw.submittedAt, 0) };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
