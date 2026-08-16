/**
 * Measuring whether a clip ends where it began.
 *
 * This is the half of the seam check that has to live in the window, and it is
 * the reason the check went unwired for so long: `core/avatar/seam.ts` has done
 * the arithmetic since it was written, but the arithmetic needs decoded RGBA,
 * decoding needs a `<video>` and a canvas, and main has neither. Main pays for
 * the clip and writes it to disk; only this process can look at it.
 *
 * ## Why it matters more here than in most players
 *
 * Every clip in the library is generated *from the same photograph* and is
 * supposed to return to it. `hologram.ts` relies on that: it cuts between clips
 * with no cross-fade, because if two clips both end and begin on the same frame
 * there is nothing to fade. When a clip drifts, the failure is not one visible
 * seam in one place — it is a pop at every entry and exit, forever, and on the
 * idle loop it repeats every few seconds.
 *
 * Vendors denoise and re-encode the init image, so "the prompt asked it to end
 * where it started" is a wish. This is the part that checks.
 *
 * The title says "where it began" rather than "the photograph" for a reason
 * established by measurement; see the long note in {@link verifyClip}.
 */

import { ASSUMED_FPS, extractClipFrames } from './clip-frames.ts';
import {
  bestCutFrame,
  closesCleanly,
  describeSeam,
  measureSeam,
  type Frame,
} from '../../core/avatar/seam.ts';
import type { SeamVerdict } from '../../shared/protocol.ts';

export interface VerifyDeps {
  /** The clip's bytes. Null when the slot turns out not to be on disk. */
  loadClip: (slot: string) => Promise<Uint8Array | null>;
  /**
   * The source photograph, decoded at exactly the size asked for.
   *
   * The size is a parameter rather than a property because it is not knowable
   * until the clip is open. `extractClipFrames` samples at the video's native
   * resolution, and a generated clip is whatever the vendor rendered — Hedra
   * offers 540p, 720p and 1080p — which need not match the photograph it was
   * made from. `measureSeam` throws `FrameSizeMismatch` on a mismatch, so a
   * source decoded once at its own dimensions would fail on every clip whose
   * render size differed, and fail in a way that reads like a broken decoder.
   *
   * Feeding the verdict was its original job and is no longer: resampling one
   * side of the comparison is precisely what made it untrustworthy. It now
   * reports one diagnostic number — how far the clip's opening frame sits from
   * the photograph — which catches a clip that started from the wrong pose
   * entirely. Returning null is allowed and costs only that number.
   */
  sourceFrame: (width: number, height: number) => Promise<Frame | null>;
  /** Where the verdict goes. */
  report: (slot: string, seam: SeamVerdict) => Promise<unknown>;
  /** Diagnostics, so a failure here is visible without a devtools window. */
  note?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * The frame every clip of a given size is expected to open on, once one has
 * been seen and sanity-checked.
 *
 * Keyed by render size because that is the only thing two frames can be
 * compared at: `measureSeam` refuses a size mismatch, and resampling one side
 * to fix it is the error this whole comparison was rewritten to avoid. In
 * practice one vendor at one setting produces one size, so this holds one entry
 * for the generated clips and a second for anything hand-dropped.
 */
export class SeamReference {
  readonly #bySize = new Map<string, Frame>();

  /**
   * How far a candidate reference may sit from the photograph and still be
   * believed.
   *
   * The floor is known: a same-size frame of the same moment measures 0.0025,
   * and a vendor render of the same photograph measures 0.0102 once the 0.6%
   * resample is included. A frame that failed to decode — black, or half
   * painted — measures around 0.3 against a lit photograph. 0.1 sits an order
   * of magnitude above the floor and well below the failure, and only
   * `meanDelta` is used because it is the one number the resample does not
   * dominate.
   *
   * This exists because the reference is no longer a *candidate*. When each
   * clip was measured against the photograph, a first frame that decoded badly
   * made that clip fail and be measured again next launch, which is
   * self-healing. As a reference it would instead make the whole library's
   * verdicts wrong — and worse, `bestCutFrame` would hunt for whichever frame
   * best matched a black one and could record a `closesCleanly` with a
   * nonsense cut point, permanently.
   */
  static readonly SANITY_MEAN = 0.1;

  /**
   * The reference for this size, adopting `candidate` if there is not one yet.
   *
   * Returns null when there is no reference and this frame cannot be trusted to
   * become one — the caller must then leave the clip unverified rather than
   * guess.
   */
  adopt(candidate: Frame, source: Frame | null): Frame | null {
    const key = `${candidate.width}x${candidate.height}`;
    const held = this.#bySize.get(key);
    if (held) return held;

    // No photograph to check against yet: the still has not decoded. Refusing
    // is the whole point — a reference adopted blind is a wrong answer written
    // to disk, where refusing costs one deferred pass.
    if (!source) return null;
    if (measureSeam(source, candidate).meanDelta > SeamReference.SANITY_MEAN) return null;

    this.#bySize.set(key, candidate);
    return candidate;
  }
}

/**
 * Measures one clip and reports the verdict.
 *
 * Returns the verdict, or null when the clip could not be measured at all —
 * which is deliberately different from "measured and failed". A clip that
 * cannot be decoded keeps its unverified status and will be tried again; a clip
 * that decodes and drifts is a finding, and is recorded as one.
 */
export async function verifyClip(
  slot: string,
  deps: VerifyDeps,
  reference = new SeamReference(),
): Promise<SeamVerdict | null> {
  const bytes = await deps.loadClip(slot);
  if (!bytes) return null;

  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'video/mp4' }));
  try {
    const frames = await extractClipFrames(url);

    /*
     * The comparison is between clips, not against the photograph, and that
     * correction came out of the numbers.
     *
     * Measuring against the photograph looks like the more fundamental check —
     * every clip is supposed to return to *it* — but it cannot be done without
     * resampling one side, because the vendor renders to its own frame size.
     * Here that is 718x1284 stretched to 720x1280: a 0.6% shear, invisible to
     * the eye and to `meanDelta`, and catastrophic for `worstBlockDelta`, which
     * is designed to be sensitive to exactly this kind of small contiguous
     * displacement. It scored 0.17 against a 0.09 threshold on a clip's own
     * opening frame — a frame that had not drifted at all.
     *
     * Two clips' first frames measured against *each other* settle it: 0.0027
     * mean, 0.0093 worst block, no pixel changed by a just-noticeable amount.
     * Every clip really does begin on the same frame; it was the comparison
     * that was wrong.
     *
     * The reference is shared across clips rather than being each clip's own
     * first frame, and that distinction is the whole invariant. `hologram.ts`
     * cuts between *different* clips, so what has to hold is
     * `clip_i.last ≈ clip_j.first` — and measuring each clip against itself
     * only proves `clip_i.last ≈ clip_i.first`, which is every clip passing
     * individually while every cut pops. One reference makes the relation
     * transitive again, and because it is another clip's frame at the same
     * size, nothing is resampled.
     */
    const source = await deps.sourceFrame(frames.first.width, frames.first.height);
    const opening = reference.adopt(frames.first, source);
    if (!opening) {
      // Either the photograph has not decoded yet, or this frame is too far
      // from it to be believed. Both are "come back later", not a verdict.
      deps.note?.('seam-reference-refused', { slot, hadSource: source !== null });
      return null;
    }

    /*
     * A clip that opens somewhere else is a different failure, and one this
     * comparison would otherwise hide: its last frame could match the reference
     * perfectly while its first frame does not, so cutting *into* it pops.
     * Reported rather than failed, because the reference is itself only one
     * clip's opinion and the first clip measured is always its own reference.
     */
    if (opening !== frames.first) {
      const entry = measureSeam(opening, frames.first);
      if (!closesCleanly(entry)) {
        deps.note?.('seam-opens-elsewhere', { slot, summary: describeSeam(entry) });
      }
    }

    /*
     * The last frame is measured first, and the hold is only searched if it
     * fails.
     *
     * Searching always would be the tidier code and the wrong behaviour: it
     * would move the cut point of clips that are already correct, on the
     * strength of a fractionally better score, and the cut point decides how
     * long every gesture lasts.
     */
    const atEnd = measureSeam(opening, frames.last);
    if (closesCleanly(atEnd)) {
      return await record(slot, deps, {
        closesCleanly: true,
        summary: describeSeam(atEnd),
      });
    }

    const better = bestCutFrame(opening, frames.hold);
    if (better && closesCleanly(better.measurement)) {
      // The clip is fine; it just runs on past the point where it was closed.
      // `index` is a frame number, not the ordinal of the sample — see
      // ASSUMED_FPS in clip-frames.ts.
      const cutAtMs = Math.round((better.index / ASSUMED_FPS) * 1000);
      return await record(slot, deps, {
        closesCleanly: true,
        summary: `${describeSeam(better.measurement)} (cut early)`,
        cutAtMs,
      });
    }

    return await record(slot, deps, {
      closesCleanly: false,
      summary: describeSeam(atEnd),
    });
  } catch (error) {
    // A clip that will not decode is not a clip that drifted. Leaving it
    // unverified means it plays and gets measured again next time, which is the
    // right outcome for a transient decode failure and a harmless one for a
    // permanently broken file.
    deps.note?.('seam-decode-failed', { slot, message: String(error).slice(0, 200) });
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Works through every clip that has never been measured.
 *
 * Sequential rather than parallel, and that is the whole design of this
 * function: each clip means decoding a multi-megabyte video into canvas frames,
 * and doing nineteen of those at once on the same thread that draws her would
 * stall the window she is being drawn in. There is no deadline here — an
 * unverified clip plays perfectly well — so the slow, polite version is free.
 *
 * The reference is shared across the whole pass and deliberately not cached
 * beyond it: it is a decoded frame, several megabytes of it, and the next pass
 * has a fresh library to take its opening from.
 */
export async function verifyPending(slots: readonly string[], deps: VerifyDeps): Promise<void> {
  const reference = new SeamReference();
  for (const slot of slots) {
    await verifyClip(slot, deps, reference);
  }
}

async function record(slot: string, deps: VerifyDeps, seam: SeamVerdict): Promise<SeamVerdict> {
  deps.note?.('seam-measured', { slot, closes: seam.closesCleanly, summary: seam.summary });
  await deps.report(slot, seam);
  return seam;
}
