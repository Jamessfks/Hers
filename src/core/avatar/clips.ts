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

import { GESTURE_NAMES, type GestureName, type SeamVerdict } from '../../shared/protocol.ts';

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
  /**
   * True when this clip's loop closure was actually measured.
   *
   * A hand-dropped clip, or one recovered from disk after a crash, has bytes
   * but no verdict. It plays — refusing to would make the feature unusable —
   * but nothing claims it is seamless, and the setup screen can offer to check
   * it rather than quietly implying it already has been.
   */
  verified?: boolean;
  slot: ClipSlotName;
  status: ClipStatus;
  /** File name inside the library's `clips/` directory. Set only when ready. */
  file: string | null;
  /**
   * Length of the finished clip.
   *
   * 0 means "nobody measured it" rather than "empty" — a clip recovered from
   * disk by {@link reconcile} has real bytes and no recorded duration, because
   * reading one out of a container means decoding it. The player must fall back
   * to the media element's own `duration` when this is 0.
   */
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
  /**
   * When this clip was last reached for, as opposed to last written.
   *
   * Distinct from `updatedAt`, which moves on every bookkeeping change and so
   * says nothing about use. This is the only ordering that can answer "which of
   * these is she not actually using", which is the question eviction asks when
   * the library is full and she wants a gesture she does not have.
   *
   * Absent means never played. Those are evicted first, and deliberately: a clip
   * that has been on disk through a whole conversation without once being the
   * right thing to do is the cheapest one to lose.
   */
  lastPlayedAt?: number;
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
 * Permissive on purpose, with one edge missing. Anything may become `ready`,
 * from any state, because a clip file on disk is the truth and the manifest is
 * only a claim about it — a user who hand-drops a clip into a `pending` slot
 * has produced a ready clip, and a state machine that argues with them is
 * wrong. Re-queueing is idempotent for the same reason.
 *
 * The edge that is missing is `generating -> generating`, and it is the only
 * one that matters: it is a second submit for a clip already being rendered,
 * which is not a corrupt state but a duplicate charge, and it fails silently in
 * every direction except this one.
 */
export const CLIP_TRANSITIONS: Record<ClipStatus, readonly ClipStatus[]> = {
  /*
   * `pending -> failed` and `ready -> failed` were both missing, and their
   * absence made the seam check unreachable rather than merely unwired.
   *
   * A clip is written `ready` and unmeasured, because measuring needs a decoder
   * that only the renderer has. When the verdict comes back and says the clip
   * drifted, demoting it is `ready -> failed` — which threw. So the branch in
   * `completeClip` that has always handled a failing seam could never have run
   * even if something had called it, and the first thing to wire the check up
   * would have crashed on the first bad clip rather than recording it.
   *
   * Failing is legal from anywhere, for the same reason `failed -> failed` had
   * to be added: it is not a corrupt state, it is the outcome of an attempt, and
   * a state machine that refuses to record a real outcome turns a finding into
   * an exception thrown from inside the code handling the finding.
   */
  pending: ['pending', 'generating', 'ready', 'failed'],
  generating: ['pending', 'ready', 'failed'],
  ready: ['pending', 'generating', 'ready', 'failed'],
  // `failed -> failed` was missing, and its absence was not theoretical: a slot
  // that fails twice is ordinary, and the second `failClip` threw *inside the
  // catch block* that was handling the first failure. That replaced the real
  // error with a confusing one and aborted the whole build.
  failed: ['pending', 'generating', 'ready', 'failed'],
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

/**
 * The slot a file on disk belongs to, or null if it is not one of ours.
 *
 * Matches on the stem rather than demanding `.mp4`, because vendors hand back
 * different containers and a user dropping in their own clips has not done
 * anything wrong by keeping the `.webm` they were given.
 */
export function slotOfClipFile(fileName: string): ClipSlotName | null {
  const dot = fileName.lastIndexOf('.');
  const stem = dot === -1 ? fileName : fileName.slice(0, dot);
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

/**
 * Re-exported so callers of this module do not need two imports.
 *
 * Declared in shared/protocol.ts because it crosses the process boundary: the
 * renderer measures it and main records it. Measuring needs a video decoder and
 * `core` must stay runnable without one, which is why it is carried in rather
 * than computed here.
 */
export type { SeamVerdict };

export interface CompletedClip {
  /** File name inside `clips/`, already written to disk. */
  file: string;
  durationMs: number;
  costUsd?: number;
  /** Absent when the clip was accepted without being measured. */
  seam?: SeamVerdict;
}

export function completeClip(
  library: ClipLibrary,
  slot: ClipSlotName,
  clip: CompletedClip,
  now = Date.now(),
): ClipLibrary {
  const entry = library.clips[slot];

  /*
   * A clip is only ready if it actually closes back onto the source photo.
   *
   * This used to accept bytes on the strength of a prompt that *asked* the
   * model to start and end on the source pose. Vendors denoise and re-encode
   * the init image, so that is a wish rather than a guarantee — and because
   * every clip anchors to the same photo, a drifted last frame is not one seam
   * in one place but a pop at every entry and exit, repeating forever on the
   * idle loop.
   *
   * The measurement is taken by the caller (it needs a video decoder; see
   * renderer/avatar/clip-frames.ts) and handed in. A clip that arrives without
   * one is recorded as `unverified` rather than `ready`: the player can still
   * fall back to it, but nothing claims it is seamless.
   */
  if (clip.seam && !clip.seam.closesCleanly) {
    return withEntry(
      library,
      slot,
      {
        status: 'failed',
        file: clip.file,
        durationMs: clip.durationMs,
        job: null,
        error: `Clip does not return to the source pose — ${clip.seam.summary}`,
        spentUsd: entry.spentUsd + (clip.costUsd ?? 0),
      },
      now,
    );
  }

  return withEntry(
    library,
    slot,
    {
      status: 'ready',
      file: clip.file,
      // A measured cut point beats the nominal one: the hold keeps breathing,
      // so a fixed timestamp lands at an arbitrary phase of that movement.
      durationMs: clip.seam?.cutAtMs ?? clip.durationMs,
      // Only written when true: an absent flag already means "not measured",
      // and a `false` in every manifest is noise that has to round-trip.
      ...(clip.seam ? { verified: true } : {}),
      job: null,
      error: null,
      spentUsd: entry.spentUsd + (clip.costUsd ?? 0),
    },
    now,
  );
}

/**
 * Applies a seam measurement to a clip that is already on disk.
 *
 * {@link completeClip} takes a verdict too, and would be the whole story if the
 * measurement were available when the bytes land. It is not, and cannot be:
 * measuring needs a video decoder, only the renderer has one, and main is the
 * process that writes the file. So a clip arrives unmeasured — `ready` with no
 * `verified` flag — and the verdict follows a moment later, from the other side
 * of the IPC boundary, through here.
 *
 * The two functions deliberately reach the same conclusions from the same
 * verdict. A clip that does not close is failed with its file left in place,
 * because the bytes are paid for and a player that wants to fall back to them
 * still can; a clip that does is `verified` and takes the measured cut point
 * over the nominal one.
 *
 * Refuses a slot with no file. A seam verdict about a clip that was never
 * written is a bug in the caller, and silently inventing a `ready` entry for it
 * would put a manifest into a state nothing else in this module can produce.
 */
export function recordSeam(
  library: ClipLibrary,
  slot: ClipSlotName,
  seam: SeamVerdict,
  now = Date.now(),
): ClipLibrary {
  const entry = library.clips[slot];
  if (!entry.file) {
    throw new Error(`${slot} has no clip on disk, so there is no seam to record`);
  }

  /*
   * A clip that does not close keeps playing. It just stops claiming to loop.
   *
   * `completeClip` fails a clip whose seam is bad, and that is right *there*:
   * it is judging a render that has only just been paid for, and a bad one
   * should go back in the queue rather than into the library.
   *
   * Here the clip is already in the library, possibly for weeks, and possibly
   * the only one she has. Demoting it to `failed` removes it from `ready`, so
   * `Hologram` stops playing it — which is how measuring three working clips
   * for the first time turned a working avatar back into a still photograph.
   * That is a worse outcome than a visible seam, and it is the outcome the
   * `verified` flag exists to avoid: the comment on it says an unmeasured clip
   * "plays — refusing to would make the feature unusable — but nothing claims
   * it is seamless." A measured-and-imperfect clip is in exactly that position.
   *
   * So the verdict is recorded, the reason is kept for the setup screen, and
   * she keeps her body.
   */
  if (!seam.closesCleanly) {
    return withEntry(
      library,
      slot,
      {
        verified: false,
        error: `Does not return to the source pose — ${seam.summary}`,
        job: null,
      },
      now,
    );
  }

  return withEntry(
    library,
    slot,
    {
      status: 'ready',
      durationMs: seam.cutAtMs ?? entry.durationMs,
      verified: true,
      error: null,
      job: null,
    },
    now,
  );
}

/** Records that a clip was reached for, for the eviction ordering. */
export function notePlayed(
  library: ClipLibrary,
  slot: ClipSlotName,
  now = Date.now(),
): ClipLibrary {
  const entry = library.clips[slot];
  if (entry.status !== 'ready') return library;
  // Straight through rather than via `withEntry`: this is not a state change and
  // must not touch `updatedAt`, which several other things read as "when did
  // this slot last actually change".
  return {
    ...library,
    clips: { ...library.clips, [slot]: { ...entry, lastPlayedAt: now } },
  };
}

/**
 * The clip worth losing when the library is full and she wants another.
 *
 * Least-recently-played, with never-played first — a clip that has sat through
 * a whole conversation without once being the right thing to do is the cheapest
 * one to give up.
 *
 * `idle` is never a candidate, and that is not a preference. It is the only
 * clip that plays when nothing else is happening, which for a companion is
 * almost all of the time; evicting it would take her from a person standing
 * there back to a photograph, to buy a gesture she uses once.
 *
 * Returns null when there is nothing to evict, which is a real answer rather
 * than an error: a library holding only `idle` cannot make room.
 */
export function evictionCandidate(library: ClipLibrary): ClipSlotName | null {
  let worst: { slot: ClipSlotName; at: number } | null = null;

  for (const slot of BUILD_ORDER) {
    if (slot === IDLE_SLOT) continue;
    const entry = library.clips[slot];
    if (entry.status !== 'ready' || !entry.file) continue;

    const at = entry.lastPlayedAt ?? 0;
    if (!worst || at < worst.at) worst = { slot, at };
  }

  return worst?.slot ?? null;
}

/**
 * Returns a slot to `pending` so its place can be used by something else.
 *
 * The manifest entry is reset but `spentUsd` is kept, because the money was
 * spent and a library that forgets what it cost under-reports forever. Deleting
 * the file is the caller's job — this module never touches a disk.
 */
export function evictClip(
  library: ClipLibrary,
  slot: ClipSlotName,
  now = Date.now(),
): ClipLibrary {
  const entry = library.clips[slot];
  if (entry.status !== 'ready') throw new Error(`${slot} is not ready, so there is nothing to evict`);

  return withEntry(
    library,
    slot,
    {
      status: 'pending',
      file: null,
      durationMs: 0,
      job: null,
      error: null,
      verified: false,
      // Attempts reset too: this slot is being given up for room, not because
      // anything about it failed, and carrying a strike into its next life
      // would exhaust a perfectly renderable gesture.
      attempts: 0,
    },
    now,
  );
}

/**
 * Clips that are on disk and playable but whose seam has never been measured.
 *
 * The renderer asks for this list and works through it. `verified` is only ever
 * written as `true`, so its absence is the question rather than a third state.
 */
export function unverifiedClips(library: ClipLibrary): ClipSlotName[] {
  return BUILD_ORDER.filter((slot) => {
    const entry = library.clips[slot];
    return entry.status === 'ready' && entry.file !== null && !entry.verified;
  });
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

  /*
   * A failed *attempt* never demotes a clip that already exists.
   *
   * This used to be enforced by the transition table refusing `ready -> failed`
   * at all, which was the right protection expressed in the wrong place: it also
   * blocked {@link recordSeam}, whose entire job is to demote a clip on disk
   * that turns out not to loop. The two are different events — "the render did
   * not work" and "the render worked and the result is wrong" — and only the
   * second is entitled to take a playable clip away.
   *
   * The bytes are the truth. A retry that fails after a clip has landed leaves
   * the landed clip alone.
   */
  if (entry.status === 'ready') {
    throw new Error(`${slot} is already ready; a failed attempt cannot go from ready to failed`);
  }

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
        next = withEntry(next, slot, { status: 'ready', file, job: null, error: null }, now);
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
