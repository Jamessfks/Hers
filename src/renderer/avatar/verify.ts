/**
 * Measuring whether a clip returns to the photograph it came from.
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
 */

import { ASSUMED_FPS, extractClipFrames } from './clip-frames.ts';
import { bestCutFrame, closesCleanly, describeSeam, measureSeam } from '../../core/avatar/seam.ts';
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
   */
  sourceFrame: (width: number, height: number) => Promise<ImageData | null>;
  /** Where the verdict goes. */
  report: (slot: string, seam: SeamVerdict) => Promise<unknown>;
  /** Diagnostics, so a failure here is visible without a devtools window. */
  note?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * Measures one clip and reports the verdict.
 *
 * Returns the verdict, or null when the clip could not be measured at all —
 * which is deliberately different from "measured and failed". A clip that
 * cannot be decoded keeps its unverified status and will be tried again; a clip
 * that decodes and drifts is a finding, and is recorded as one.
 */
export async function verifyClip(slot: string, deps: VerifyDeps): Promise<SeamVerdict | null> {
  const bytes = await deps.loadClip(slot);
  if (!bytes) return null;

  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'video/mp4' }));
  try {
    const frames = await extractClipFrames(url);
    // After the clip is open, because its render size decides the size the
    // source has to be decoded at. See `sourceFrame`.
    const source = await deps.sourceFrame(frames.last.width, frames.last.height);
    if (!source) return null;

    /*
     * The last frame is measured first, and the hold is only searched if it
     * fails.
     *
     * Searching always would be the tidier code and the wrong behaviour: it
     * would move the cut point of clips that are already correct, on the
     * strength of a fractionally better score, and the cut point decides how
     * long every gesture lasts.
     */
    const atEnd = measureSeam(source, frames.last);
    if (closesCleanly(atEnd)) {
      return await record(slot, deps, {
        closesCleanly: true,
        summary: describeSeam(atEnd),
      });
    }

    const better = bestCutFrame(source, frames.hold);
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
 */
export async function verifyPending(slots: readonly string[], deps: VerifyDeps): Promise<void> {
  for (const slot of slots) {
    await verifyClip(slot, deps);
  }
}

async function record(slot: string, deps: VerifyDeps, seam: SeamVerdict): Promise<SeamVerdict> {
  deps.note?.('seam-measured', { slot, closes: seam.closesCleanly, summary: seam.summary });
  await deps.report(slot, seam);
  return seam;
}
