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
   * The 99th-percentile pixel difference, 0..1.
   *
   * Mean alone hides the failure that matters most. A clip whose face has
   * drifted but whose background is identical scores a fine mean and still
   * pops, because a viewer is looking at the face. This catches that.
   */
  worstDelta: number;
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
    return { meanDelta: 0, worstDelta: 0, exposureShift: 0, changedFraction: 0 };
  }

  let total = 0;
  let signed = 0;
  let changed = 0;
  // A histogram rather than a sorted array: 256 buckets is enough resolution
  // for a percentile and avoids allocating a float per pixel on a 4K frame.
  const histogram = new Uint32Array(256);

  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    const dr = candidate.data[at]! - source.data[at]!;
    const dg = candidate.data[at + 1]! - source.data[at + 1]!;
    const db = candidate.data[at + 2]! - source.data[at + 2]!;

    const magnitude = (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) / 3;
    total += magnitude;
    signed += (dr + dg + db) / 3;
    histogram[Math.min(255, Math.round(magnitude))]! += 1;
    if (magnitude / 255 > JUST_NOTICEABLE) changed += 1;
  }

  return {
    meanDelta: total / pixels / 255,
    worstDelta: percentile(histogram, pixels, 0.99) / 255,
    exposureShift: signed / pixels / 255,
    changedFraction: changed / pixels,
  };
}

/** True when a cut at this frame would not be visible at normal speed. */
export function closesCleanly(measurement: SeamMeasurement): boolean {
  return (
    measurement.meanDelta <= SEAM_THRESHOLD &&
    measurement.changedFraction <= CHANGED_FRACTION_THRESHOLD
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

/** The `p`th percentile magnitude from a difference histogram. */
function percentile(histogram: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let seen = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value]!;
    if (seen >= target) return value;
  }
  return histogram.length - 1;
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
  return `does not close: ${(measurement.changedFraction * 100).toFixed(0)}% of the frame moved (mean ${(
    measurement.meanDelta * 100
  ).toFixed(1)}%)`;
}
