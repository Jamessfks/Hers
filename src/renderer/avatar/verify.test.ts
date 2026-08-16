/**
 * The frame every clip is measured against, and what happens around it.
 *
 * The decision that makes or breaks the whole check is a pure one: *which*
 * frame becomes the reference, and when a candidate is refused. That is the
 * part that costs money if it is wrong — a verdict is written to the manifest,
 * and clearing a bad one means paying to render the slot again.
 *
 * The rest of `verifyClip` used to be untestable, because the decoder it calls
 * exists only inside Chromium. It takes an injected one now, for the reason the
 * provider registry takes an injected `fetch`: the decisions worth checking are
 * all downstream of the decode.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SeamReference, verifyClip, verifyPending, type VerifyDeps } from './verify.ts';
import type { ClipFrames } from './clip-frames.ts';
import type { Frame } from '../../core/avatar/seam.ts';
import type { SeamVerdict } from '../../shared/protocol.ts';

/**
 * A frame of flat grey with a darker square in it, so the block metric has
 * something to find. `shift` moves every channel, which is how a frame that
 * decoded badly differs from one that did not.
 */
function frame(width: number, height: number, shift = 0): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const inSquare = x > width * 0.3 && x < width * 0.6 && y > height * 0.2 && y < height * 0.5;
      const value = (inSquare ? 60 : 180) + shift;
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

/**
 * The same picture with the subject somewhere else.
 *
 * The failure the sanity check exists for is not a frame that failed to decode
 * — that one is obvious at any threshold — but one that is lit, plausible and
 * wrong. Every clip in the real library ends on one of these.
 */
function moved(width: number, height: number, by: number): Frame {
  const base = frame(width, height);
  const data = new Uint8ClampedArray(base.data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + Math.min(width - 1, Math.max(0, x - by))) * 4;
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        data[at + channel] = base.data[from + channel]!;
      }
    }
  }
  return { width, height, data };
}

const SIZE: [number, number] = [64, 96];

/** What the decoder hands back, without a decoder. */
function decoded(first: Frame, last: Frame): ClipFrames {
  return { first, last, hold: [{ index: 72, frame: last }], durationSeconds: 5 };
}

/** Deps that measure one clip and record where the verdict went. */
function rig(
  extra: Partial<VerifyDeps> = {},
): { deps: VerifyDeps; written: Array<[string, SeamVerdict]>; asked: string[] } {
  const written: Array<[string, SeamVerdict]> = [];
  const asked: string[] = [];
  return {
    written,
    asked,
    deps: {
      loadClip: async (slot) => {
        asked.push(slot);
        return new Uint8Array([1, 2, 3]);
      },
      sourceFrame: async () => frame(...SIZE),
      report: async (slot, seam) => {
        written.push([slot, seam]);
      },
      extract: async () => decoded(frame(...SIZE, 1), frame(...SIZE, 2)),
      ...extra,
    },
  };
}

test('the first clip measured becomes the reference for its size', () => {
  const reference = new SeamReference();
  const source = frame(...SIZE);
  const opening = frame(...SIZE, 1); // a re-encode of the same picture
  assert.equal(reference.adopt(opening, source), opening);
});

test('every later clip is measured against the first, not against itself', () => {
  /*
   * The invariant the whole design rests on. `hologram.ts` cuts between
   * *different* clips, so what has to hold is that clip A's last frame matches
   * clip B's first. Measuring each clip against its own opening only proves
   * each clip is self-consistent — which is every clip passing individually
   * while every cut still pops.
   */
  const reference = new SeamReference();
  const source = frame(...SIZE);
  const first = frame(...SIZE, 1);
  assert.equal(reference.adopt(first, source), first);

  const second = frame(...SIZE, 2);
  assert.equal(reference.adopt(second, source), first, 'the second clip does not get its own');
});

test('a frame that did not decode is refused rather than believed', () => {
  /*
   * As a candidate, a black first frame made one clip fail and be re-measured
   * next launch — self-healing. As a *reference* it would make the whole
   * library's verdicts wrong, and `bestCutFrame` would go looking for whichever
   * frame best matched black and could record a clean verdict with a nonsense
   * cut point, permanently.
   */
  const reference = new SeamReference();
  const source = frame(...SIZE);
  const black = frame(...SIZE);
  black.data.fill(0);
  black.data.fill(255, 3);
  assert.equal(reference.adopt(black, source), null);
});

test('nothing is adopted before the photograph has decoded', () => {
  // `sourceFrame` returns null until the still has loaded, and the library
  // event that starts a verification pass can easily arrive first. Refusing
  // costs one deferred pass; guessing writes a verdict to disk.
  const reference = new SeamReference();
  assert.equal(reference.adopt(frame(...SIZE, 1), null), null);
});

test('a refused candidate does not become the reference by trying twice', () => {
  const reference = new SeamReference();
  const source = frame(...SIZE);
  const black = frame(...SIZE);
  black.data.fill(0);
  black.data.fill(255, 3);

  assert.equal(reference.adopt(black, source), null);
  const good = frame(...SIZE, 1);
  assert.equal(reference.adopt(good, source), good, 'the next honest frame still gets in');
});

test('a frame of the same person in a different pose is refused as the reference', () => {
  /*
   * The threshold used to be 0.1, which is *above* the failure it was written
   * to catch: measured against this library's own photograph, a different pose
   * of the same person in the same scene sits at 0.062 to 0.064
   * (docs/audits/hedra-generation.md). Adopting one costs the whole library —
   * every correct clip is then recorded as not closing, and `bestCutFrame`
   * writes a cut point taken from the wrong frame into the manifest.
   */
  const reference = new SeamReference();
  assert.equal(reference.adopt(moved(...SIZE, 10), frame(...SIZE)), null);
});

test('a frame that differs a little everywhere is refused by the second statistic', () => {
  // `meanDelta` alone is one number doing two jobs, and this is what it lets
  // through: a difference too small per pixel to move the average past 0.03 and
  // spread over the entire frame. `worstBlockDelta` cannot be the second
  // opinion — the 0.6% resample against the photograph saturates it — so
  // `changedFraction` is, at 0.064 for an unmoved frame against 0.513 for a
  // moved one.
  const reference = new SeamReference();
  assert.equal(reference.adopt(frame(...SIZE, 7), frame(...SIZE)), null);
});

test('a clip rendered at another size gets its own reference', () => {
  // `measureSeam` refuses a size mismatch, and resampling to fix it is the
  // error this comparison was rewritten to avoid. A hand-dropped clip at a
  // different resolution is a separate question, not a broken measurement.
  const reference = new SeamReference();
  const opening = frame(...SIZE, 1);
  assert.equal(reference.adopt(opening, frame(...SIZE)), opening);

  const other = frame(48, 72, 1);
  assert.equal(reference.adopt(other, frame(48, 72)), other);
  assert.notEqual(reference.adopt(frame(48, 72, 3), frame(48, 72)), opening);
});

test('the clip that becomes the reference says so in its verdict', async () => {
  // Something has to be the reference, and its own verdict then answers a
  // weaker question than every other verdict in the manifest: that it returns
  // to where *it* started rather than to where the others start. Unmarked it is
  // indistinguishable on disk from a real one, and it is the one verdict that
  // survives the reference being wrong.
  const reference = new SeamReference();
  const { deps, written } = rig();

  const first = await verifyClip('nod', deps, reference);
  assert.match(first!.summary, /its own reference/);

  const later = await verifyClip('tilt_head', deps, reference);
  assert.doesNotMatch(later!.summary, /its own reference/);
  assert.deepEqual(
    written.map(([slot]) => slot),
    ['nod', 'tilt_head'],
  );
});

test('nothing is decoded until the photograph is', async () => {
  /*
   * The reference cannot be adopted until the still has decoded, so a pass that
   * starts first refused every clip — after decoding all nineteen of them, one
   * at a time, on the thread that draws her. The library event that starts a
   * pass and the image `<img>` that has to load first are two independent
   * arrivals, so "first" is a coin toss.
   */
  let decodes = 0;
  const { deps, asked } = rig({
    sourceFrame: async () => null,
    extract: async () => {
      decodes += 1;
      return decoded(frame(...SIZE, 1), frame(...SIZE, 2));
    },
  });

  await verifyPending(['idle', 'nod', 'tilt_head'], deps);
  assert.equal(decodes, 0, 'no clip is decoded');
  assert.deepEqual(asked, [], 'and none is even read off disk');
});

test('a pass stops when the library it was measuring is replaced', async () => {
  /*
   * `verifyLibrary` guarded itself with a flag and the pass had no identity, so
   * a photograph swapped underneath it did not stop it: `loadClip` starts
   * handing it the *new* library's clips, which it measures against a reference
   * adopted from the old one, and reports as verdicts on the new one's slots.
   */
  let swapped = false;
  const { deps, asked } = rig({ abandoned: () => swapped });

  await verifyPending(['idle'], deps);
  assert.deepEqual(asked, ['idle'], 'the first pass works normally');

  swapped = true;
  await verifyPending(['nod', 'tilt_head'], deps);
  assert.deepEqual(asked, ['idle'], 'and nothing is touched once the library is not the one on screen');
});

test('a verdict measured before the swap is not written after it', async () => {
  // The between-clips check is not enough on its own: one decode is the long
  // part, and the library can be replaced inside it. A verdict is written to
  // the manifest and clearing a wrong one means paying to render the slot
  // again, so the last thing before writing is to ask again.
  let swapped = false;
  const { deps, written } = rig({
    extract: async () => {
      swapped = true;
      return decoded(frame(...SIZE, 1), frame(...SIZE, 2));
    },
    abandoned: () => swapped,
  });

  const verdict = await verifyClip('nod', deps, new SeamReference());
  assert.ok(verdict, 'it was measured');
  assert.deepEqual(written, [], 'and not recorded against a library it is not about');
});
