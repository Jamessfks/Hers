import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHANGED_FRACTION_THRESHOLD,
  FrameSizeMismatch,
  SEAM_THRESHOLD,
  bestCutFrame,
  closesCleanly,
  describeSeam,
  measureSeam,
  type Frame,
} from './seam.ts';

/** A frame of one flat colour. */
function flat(width: number, height: number, r: number, g: number, b: number): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Copies a frame and moves a rectangle of it, as a drifted subject would. */
function withPatch(base: Frame, x0: number, y0: number, w: number, h: number, value: number): Frame {
  const data = new Uint8ClampedArray(base.data);
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const at = (y * base.width + x) * 4;
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
    }
  }
  return { width: base.width, height: base.height, data };
}

test('an identical frame closes perfectly', () => {
  const source = flat(64, 64, 120, 130, 140);
  const measurement = measureSeam(source, flat(64, 64, 120, 130, 140));
  assert.equal(measurement.meanDelta, 0);
  assert.equal(measurement.changedFraction, 0);
  assert.equal(closesCleanly(measurement), true);
  assert.match(describeSeam(measurement), /closes cleanly/);
});

test('a subject that moved is caught even though most of the frame matches', () => {
  // The failure that matters: background identical, figure shifted. This is
  // exactly what an image-to-video model produces when it drifts.
  const source = flat(100, 100, 40, 40, 40);
  const drifted = withPatch(source, 40, 30, 20, 50, 200);
  const measurement = measureSeam(source, drifted);
  assert.equal(closesCleanly(measurement), false, 'a moved subject must not pass');
  assert.ok(measurement.worstDelta > 0.5, 'the 99th percentile should see the moved region');
  assert.match(describeSeam(measurement), /does not close/);
});

test('mean alone would have accepted that clip', () => {
  // 10% of the frame moving hard is a visible pop, but averaged over the whole
  // frame the mean stays low — which is why changedFraction is also a gate.
  const source = flat(100, 100, 40, 40, 40);
  const drifted = withPatch(source, 45, 45, 10, 10, 255);
  const measurement = measureSeam(source, drifted);
  assert.ok(measurement.meanDelta < SEAM_THRESHOLD, 'mean is deceptively low');
  assert.ok(measurement.worstDelta > 0.5, 'but the worst pixels are far off');
});

test('a uniform exposure shift is reported as levellable, not as movement', () => {
  // Worth separating: this one can be corrected without paying to regenerate.
  const source = flat(64, 64, 100, 100, 100);
  const brighter = flat(64, 64, 118, 118, 118);
  const measurement = measureSeam(source, brighter);
  assert.ok(measurement.exposureShift > 0, 'brighter should read positive');
  assert.equal(closesCleanly(measurement), false);
  assert.match(describeSeam(measurement), /levelling may fix this/);
});

test('a darker frame reports a negative shift', () => {
  const measurement = measureSeam(flat(32, 32, 120, 120, 120), flat(32, 32, 100, 100, 100));
  assert.ok(measurement.exposureShift < 0);
  assert.match(describeSeam(measurement), /darker/);
});

test('compression-level noise still closes cleanly', () => {
  // A re-encoded frame is never bit-identical. If this failed, every clip from
  // every vendor would be rejected and the feature could not ship at all.
  const source = flat(64, 64, 128, 128, 128);
  const noisy = flat(64, 64, 128, 128, 128);
  for (let i = 0; i < 64 * 64; i += 1) {
    const jitter = (i % 5) - 2; // +/- 2 levels
    noisy.data[i * 4] = 128 + jitter;
    noisy.data[i * 4 + 1] = 128 + jitter;
    noisy.data[i * 4 + 2] = 128 - jitter;
  }
  assert.equal(closesCleanly(measureSeam(source, noisy)), true);
});

test('mismatched sizes are refused rather than silently compared', () => {
  assert.throws(() => measureSeam(flat(10, 10, 0, 0, 0), flat(12, 10, 0, 0, 0)), FrameSizeMismatch);
});

test('an empty frame does not divide by zero', () => {
  assert.doesNotThrow(() => measureSeam(flat(0, 0, 0, 0, 0), flat(0, 0, 0, 0, 0)));
});

test('the best cut frame is found by measurement, not by a nominal timestamp', () => {
  // The hold keeps breathing, so a fixed cut point lands at an arbitrary phase.
  // Searching turns the guess into a measurement.
  const source = flat(50, 50, 90, 90, 90);
  const candidates = [
    { index: 10, frame: flat(50, 50, 110, 110, 110) },
    { index: 11, frame: flat(50, 50, 91, 91, 91) },
    { index: 12, frame: flat(50, 50, 130, 130, 130) },
  ];
  const best = bestCutFrame(source, candidates);
  assert.equal(best?.index, 11, 'the closest frame wins regardless of its position');
  assert.equal(closesCleanly(best!.measurement), true);
});

test('bestCutFrame on nothing returns nothing', () => {
  assert.equal(bestCutFrame(flat(4, 4, 0, 0, 0), []), null);
});

test('the thresholds are stated, not scattered', () => {
  assert.ok(SEAM_THRESHOLD > 0 && SEAM_THRESHOLD < 0.1);
  assert.ok(CHANGED_FRACTION_THRESHOLD > 0 && CHANGED_FRACTION_THRESHOLD < 0.5);
});
