/**
 * The frame every clip is measured against.
 *
 * `verifyClip` itself needs a video decoder and cannot run under Node, but the
 * decision that makes or breaks the whole check is a pure one: *which* frame
 * becomes the reference, and when a candidate is refused. That is what this
 * covers, and it is the part that costs money if it is wrong — a verdict is
 * written to the manifest, and clearing a bad one means paying to render the
 * slot again.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SeamReference } from './verify.ts';
import type { Frame } from '../../core/avatar/seam.ts';

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

const SIZE: [number, number] = [64, 96];

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
