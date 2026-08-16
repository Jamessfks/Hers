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

import { ASSUMED_FPS, extractClipFrames, type ClipFrames } from './clip-frames.ts';
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
  /**
   * True once the library this pass was started for is no longer the one on
   * screen.
   *
   * A pass is minutes of decoding and holds nothing but closures, so a
   * photograph swapped underneath it does not stop it: `loadClip` starts
   * handing it the *new* library's clips, which it measures against a
   * reference adopted from the old one and reports as verdicts on the new
   * one's slots. Verdicts are written to the manifest and clearing a wrong one
   * means paying to render the slot again, so the pass is abandoned rather
   * than allowed to finish — between clips, and again before anything is
   * written.
   */
  abandoned?: () => boolean;
  /**
   * Decodes a clip. Defaults to the real decoder.
   *
   * A seam for the same reason `fetch` is one in the provider registry: every
   * decision in this module happens *after* the decode, and a decoder that
   * exists only inside Chromium put all of them out of reach of a test. That
   * is how a reference came to be adopted on the strength of a single loose
   * comparison with nothing able to say so.
   */
  extract?: (url: string) => Promise<ClipFrames>;
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
   * This exists because the reference is no longer a *candidate*. When each
   * clip was measured against the photograph, a first frame that decoded badly
   * made that clip fail and be measured again next launch, which is
   * self-healing. As a reference it would instead make the whole library's
   * verdicts wrong — every correct clip recorded as not closing against it —
   * and worse, `bestCutFrame` would hunt for whichever frame best matched it
   * and could write a `cutAtMs` from a nonsense cut point, permanently.
   *
   * The numbers are the measured ones (docs/audits/hedra-generation.md). The
   * floor is 0.0025 for a same-size frame of the same moment and 0.0102 for a
   * vendor render of the same photograph, the 0.6% resample included. The
   * failure this has to catch is a frame that is lit and plausible and *wrong*
   * — and that failure is measured too, because it is the thing every clip in
   * this library ends on: a different pose of the same person in the same
   * scene sits 0.062 to 0.064 from the photograph. So the previous value of
   * 0.1 was above the failure it was written to catch, not merely loose. 0.03
   * is 3x the floor and half of the failure.
   */
  static readonly SANITY_MEAN = 0.03;

  /**
   * How much of the frame may have visibly moved.
   *
   * `meanDelta` alone is one statistic doing two jobs — seam.ts argues at
   * length that a frame average hides the failure that matters — and the
   * obvious second opinion cannot be used here: `worstBlockDelta` scores 0.17
   * against a 0.09 threshold on a frame that has not moved at all, because the
   * resample is exactly the small contiguous displacement it is built to find.
   * `changedFraction` is the one that survives it: 0.064 on that same
   * unmoved frame against 0.513 for a different pose. 0.25 sits between them
   * with room on both sides.
   */
  static readonly SANITY_CHANGED = 0.25;

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
    const against = measureSeam(source, candidate);
    if (against.meanDelta > SeamReference.SANITY_MEAN) return null;
    if (against.changedFraction > SeamReference.SANITY_CHANGED) return null;

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
 *
 * `reference` is required rather than defaulted. A default of a fresh
 * {@link SeamReference} reads as a convenience and is the one mistake this
 * whole comparison was rewritten to stop making: it silently turns the check
 * into each clip against its own opening frame, which every clip passes while
 * every cut between two of them pops.
 */
export async function verifyClip(
  slot: string,
  deps: VerifyDeps,
  reference: SeamReference,
): Promise<SeamVerdict | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.loadClip(slot);
  } catch (error) {
    // An IPC call that rejects used to take the whole pass with it, because
    // this one is outside the try below and `verifyPending` has no catch of its
    // own. One unreadable clip is not a reason to stop measuring the other
    // eighteen, and it is not a verdict either.
    deps.note?.('seam-read-failed', { slot, message: String(error).slice(0, 200) });
    return null;
  }
  if (!bytes) return null;

  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'video/mp4' }));
  try {
    const frames = await (deps.extract ?? extractClipFrames)(url);

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
    /*
     * The first clip of a pass is measured against itself, and the verdict says
     * so.
     *
     * There is no way round it — something has to be the reference — but the
     * verdict it produces answers a weaker question than every other verdict in
     * the manifest: that the clip returns to where *it* started, rather than to
     * where the others start. Written without a mark it is indistinguishable
     * from a real one, and it is the one verdict that survives the reference
     * being wrong.
     */
    const alone = opening === frames.first ? ' (its own reference)' : '';

    const atEnd = measureSeam(opening, frames.last);
    if (closesCleanly(atEnd)) {
      return await record(slot, deps, {
        closesCleanly: true,
        summary: `${describeSeam(atEnd)}${alone}`,
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
        summary: `${describeSeam(better.measurement)} (cut early)${alone}`,
        cutAtMs,
      });
    }

    return await record(slot, deps, {
      closesCleanly: false,
      summary: `${describeSeam(atEnd)}${alone}`,
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
  /*
   * The photograph is asked about once, before anything is decoded.
   *
   * Nothing in the pass can be measured until the still has decoded, because
   * that is what a candidate reference is sanity-checked against — so a pass
   * that starts first used to decode all nineteen multi-megabyte clips and
   * refuse all nineteen, on the thread that draws her. The size asked for is
   * arbitrary and the frame is thrown away: the only question a draw this
   * small answers is whether there is a decoded image at all, which is exactly
   * the question.
   */
  if (!(await deps.sourceFrame(1, 1))) {
    deps.note?.('seam-pass-deferred', { slots: slots.length });
    return;
  }

  const reference = new SeamReference();
  for (const slot of slots) {
    if (deps.abandoned?.()) {
      deps.note?.('seam-pass-abandoned', { at: slot });
      return;
    }
    await verifyClip(slot, deps, reference);
  }
}

async function record(slot: string, deps: VerifyDeps, seam: SeamVerdict): Promise<SeamVerdict> {
  deps.note?.('seam-measured', { slot, closes: seam.closesCleanly, summary: seam.summary });
  // Checked here as well as between clips: this one decode is minutes long on
  // a bad day, and the verdict is about a library that may have been replaced
  // while it ran. Returned rather than swallowed — it was measured, it just
  // must not be written.
  if (deps.abandoned?.()) return seam;
  await deps.report(slot, seam);
  return seam;
}
