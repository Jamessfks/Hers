/**
 * Measuring whether a clip actually closes back onto the source photo.
 *
 * This is the load-bearing check for the whole generated-clip idea, and it was
 * the thing most conspicuously missing: clips were accepted on the strength of
 * a prompt that *asked* the model to start and end on the source pose. That is
 * a wish, not a guarantee. Image-to-video models denoise and re-encode the init
 * image, so frame 0 is already a reconstruction of the photo rather than the
 * photo; the last frame drifts further.
 *
 * The consequence of not checking is specific and bad. Every clip anchors to
 * the same photo, so a mismatch is not one seam in one place — it is a pop at
 * every entry and every exit, and for the idle clip it repeats on a loop
 * forever. A pop that small is exactly the kind of thing that reads as "fake"
 * without the viewer being able to say why.
 *
 * So a clip is not `ready` until it has been measured. If it drifted, it gets
 * regenerated or the best-matching frame inside the hold is used as the cut
 * point instead of the nominal one.
 *
 * Everything here is pure: it takes decoded RGBA and returns numbers. Frame
 * extraction belongs to the renderer, which has a video decoder; putting it
 * here would make this untestable and drag a media stack into `core`.
 */

/** A decoded frame. RGBA, 4 bytes per pixel, row-major. */
export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface SeamMeasurement {
  /**
   * Mean absolute per-channel difference, 0..1.
   *
   * The headline number. Below {@link SEAM_THRESHOLD} a cut is not visible at
   * normal playback speed; above it, the figure jumps.
   */
  meanDelta: number;
  /**
   * The worst 16x16 block's mean difference, 0..1.
   *
   * Mean over the whole frame hides the failure that matters most: a clip whose
   * face drifted but whose background is identical scores a fine mean and still
   * pops, because the viewer is looking at the face.
   *
   * A percentile was tried first and is not good enough — a face is well under
   * 1% of a full-body frame, so even the 99th percentile sits in untouched
   * background and reports nothing. Blocks work because drift is *contiguous*:
   * a moved subject saturates the blocks it occupies no matter how small a
   * fraction of the total frame it is.
   */
  worstBlockDelta: number;
  /**
   * How far the whole frame has shifted in brightness, -1..1.
   *
   * Separated out because it is the one kind of drift that is cheap to correct
   * rather than regenerate: a clip that is right but 4% darker can be levelled,
   * where a clip whose subject has moved cannot.
   */
  exposureShift: number;
  /** Fraction of pixels differing by more than a just-noticeable amount. */
  changedFraction: number;
}

/**
 * Above this mean delta, assume the cut is visible.
 *
 * 0.02 is roughly 5 levels out of 255 averaged over the frame — around the
 * point where a hard cut between two otherwise identical frames stops reading
 * as a compression wobble and starts reading as a jump. It is a starting value
 * to be tuned against real generated clips, not a law, and it is exported so a
 * test can state what it means rather than hardcoding a number twice.
 */
export const SEAM_THRESHOLD = 0.02;

/** Per-pixel difference above which a pixel counts as visibly changed. */
const JUST_NOTICEABLE = 6 / 255;

/** Block edge, in pixels. Small enough to isolate a face, big enough to ignore noise. */
const BLOCK = 16;

/**
 * Mean difference within a single block, above which that block has moved.
 *
 * Higher than the whole-frame threshold on purpose: a block that contains an
 * edge of the subject will always differ more than the frame average, and
 * holding it to the frame threshold would reject every clip.
 */
export const BLOCK_THRESHOLD = 0.09;

/** Fraction of the frame that may visibly change before a cut reads as a jump. */
export const CHANGED_FRACTION_THRESHOLD = 0.06;

export class FrameSizeMismatch extends Error {
  constructor(a: Frame, b: Frame) {
    super(`Frames differ in size: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
    this.name = 'FrameSizeMismatch';
  }
}

/**
 * Compares two frames.
 *
 * Alpha is ignored: the source photo is opaque, and a generated clip's alpha —
 * if it has one at all — says nothing about whether the cut is visible.
 */
export function measureSeam(source: Frame, candidate: Frame): SeamMeasurement {
  if (source.width !== candidate.width || source.height !== candidate.height) {
    throw new FrameSizeMismatch(source, candidate);
  }

  const pixels = source.width * source.height;
  if (pixels === 0) {
    return { meanDelta: 0, worstBlockDelta: 0, exposureShift: 0, changedFraction: 0 };
  }

  let total = 0;
  let signed = 0;
  let changed = 0;

  const blocksX = Math.max(1, Math.ceil(source.width / BLOCK));
  const blocksY = Math.max(1, Math.ceil(source.height / BLOCK));
  const blockTotals = new Float64Array(blocksX * blocksY);
  const blockCounts = new Uint32Array(blocksX * blocksY);

  for (let y = 0; y < source.height; y += 1) {
    const blockRow = Math.floor(y / BLOCK) * blocksX;
    for (let x = 0; x < source.width; x += 1) {
      const at = (y * source.width + x) * 4;
      const dr = candidate.data[at]! - source.data[at]!;
      const dg = candidate.data[at + 1]! - source.data[at + 1]!;
      const db = candidate.data[at + 2]! - source.data[at + 2]!;

      const magnitude = (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) / 3;
      total += magnitude;
      signed += (dr + dg + db) / 3;
      if (magnitude / 255 > JUST_NOTICEABLE) changed += 1;

      const block = blockRow + Math.floor(x / BLOCK);
      blockTotals[block]! += magnitude;
      blockCounts[block]! += 1;
    }
  }

  let worstBlock = 0;
  for (let i = 0; i < blockTotals.length; i += 1) {
    const count = blockCounts[i]!;
    if (count === 0) continue;
    const mean = blockTotals[i]! / count;
    if (mean > worstBlock) worstBlock = mean;
  }

  return {
    meanDelta: total / pixels / 255,
    worstBlockDelta: worstBlock / 255,
    exposureShift: signed / pixels / 255,
    changedFraction: changed / pixels,
  };
}

/** True when a cut at this frame would not be visible at normal speed. */
export function closesCleanly(measurement: SeamMeasurement): boolean {
  return (
    measurement.meanDelta <= SEAM_THRESHOLD &&
    measurement.changedFraction <= CHANGED_FRACTION_THRESHOLD &&
    measurement.worstBlockDelta <= BLOCK_THRESHOLD
  );
}

/**
 * Picks the frame in a clip's hold window that best returns to the source.
 *
 * The nominal cut point is a guess: prompts ask for a gesture "near the start"
 * and then a still hold, but no vendor time-locks a beat, and the hold is asked
 * to keep breathing — so it oscillates rather than freezing. Cutting at a fixed
 * millisecond therefore lands at an arbitrary phase of that oscillation.
 *
 * Searching the hold for the closest frame turns a guess into a measurement,
 * and it is the difference between a seam that sometimes works and one that
 * always does.
 */
export function bestCutFrame(
  source: Frame,
  candidates: readonly { index: number; frame: Frame }[],
): { index: number; measurement: SeamMeasurement } | null {
  let best: { index: number; measurement: SeamMeasurement } | null = null;
  for (const candidate of candidates) {
    const measurement = measureSeam(source, candidate.frame);
    if (!best || measurement.meanDelta < best.measurement.meanDelta) {
      best = { index: candidate.index, measurement };
    }
  }
  return best;
}

/**
 * A one-line verdict for the diagnostics log and the setup UI.
 *
 * Phrased so someone reading it knows what to do: regenerate, level the
 * exposure, or accept.
 */
export function describeSeam(measurement: SeamMeasurement): string {
  if (closesCleanly(measurement)) {
    return `closes cleanly (mean ${(measurement.meanDelta * 100).toFixed(1)}%)`;
  }
  if (
    Math.abs(measurement.exposureShift) > measurement.meanDelta * 0.7 &&
    measurement.changedFraction > 0.5
  ) {
    return `whole frame is ${measurement.exposureShift > 0 ? 'brighter' : 'darker'} by ${(
      Math.abs(measurement.exposureShift) * 100
    ).toFixed(1)}% — levelling may fix this without regenerating`;
  }
  return `does not close: worst region moved ${(measurement.worstBlockDelta * 100).toFixed(
    0,
  )}%, ${(measurement.changedFraction * 100).toFixed(1)}% of the frame changed`;
}
