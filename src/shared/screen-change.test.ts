import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ScreenWatcher,
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
  classify,
  difference,
  signature,
} from './screen-change.ts';

/** A flat frame of one grey, which is the simplest thing a screen can be. */
function flat(width: number, height: number, level: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = level;
    rgba[i * 4 + 1] = level;
    rgba[i * 4 + 2] = level;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** A frame with a bright rectangle on a dark field — a window, roughly. */
function window_(
  width: number,
  height: number,
  box: { x: number; y: number; w: number; h: number },
): Uint8ClampedArray {
  const rgba = flat(width, height, 20);
  for (let y = box.y; y < box.y + box.h && y < height; y += 1) {
    for (let x = box.x; x < box.x + box.w && x < width; x += 1) {
      const at = (y * width + x) * 4;
      rgba[at] = 230;
      rgba[at + 1] = 230;
      rgba[at + 2] = 230;
    }
  }
  return rgba;
}

test('a signature is one cell per grid square, whatever the frame size', () => {
  for (const [w, h] of [
    [640, 360],
    [1920, 1080],
    [37, 21],
  ] as const) {
    const sig = signature(flat(w, h, 128), w, h);
    assert.equal(sig.length, SIGNATURE_WIDTH * SIGNATURE_HEIGHT, `${w}x${h}`);
  }
});

test('a flat frame reduces to its own brightness', () => {
  const sig = signature(flat(320, 180, 200), 320, 180);
  for (const cell of sig) assert.ok(Math.abs(cell - 200) <= 1, `cell was ${cell}`);
});

test('an identical frame is no difference at all', () => {
  const frame = window_(320, 180, { x: 40, y: 30, w: 120, h: 90 });
  const a = signature(frame, 320, 180);
  const b = signature(frame, 320, 180);
  assert.equal(difference(a, b), 0);
});

test('a cursor-sized change does not count as movement', () => {
  const before = window_(320, 180, { x: 40, y: 30, w: 120, h: 90 });
  const after = Uint8ClampedArray.from(before);
  // Ten pixels, which is about a caret.
  for (let i = 0; i < 10; i += 1) {
    const at = ((90 * 320) + 150 + i) * 4;
    after[at] = 255;
    after[at + 1] = 255;
    after[at + 2] = 255;
  }
  const delta = difference(signature(before, 320, 180), signature(after, 320, 180));
  assert.equal(classify(delta), 'still', `delta was ${delta}`);
});

test('scrolling reads as working, not as a switch', () => {
  const before = window_(320, 180, { x: 40, y: 30, w: 120, h: 90 });
  // The same window, shifted — which is roughly what a scroll looks like.
  const after = window_(320, 180, { x: 40, y: 44, w: 120, h: 90 });
  const delta = difference(signature(before, 320, 180), signature(after, 320, 180));
  assert.equal(classify(delta), 'working', `delta was ${delta}`);
});

test('a completely different screen reads as a switch', () => {
  const before = flat(320, 180, 20);
  const after = flat(320, 180, 230);
  const delta = difference(signature(before, 320, 180), signature(after, 320, 180));
  assert.equal(classify(delta), 'switched', `delta was ${delta}`);
});

test('mismatched signatures are maximally different rather than a crash', () => {
  assert.equal(difference(new Uint8Array(4), new Uint8Array(8)), 1);
  assert.equal(difference(new Uint8Array(0), new Uint8Array(0)), 1);
});

// -- the watcher ------------------------------------------------------------

test('stillness accumulates while nothing happens', () => {
  const watcher = new ScreenWatcher();
  const frame = signature(window_(320, 180, { x: 40, y: 30, w: 120, h: 90 }), 320, 180);

  let at = 1_000_000;
  watcher.observe(frame, at);
  for (let i = 0; i < 20; i += 1) {
    at += 2000;
    assert.equal(watcher.observe(frame, at), 'still');
  }
  assert.equal(watcher.stillSeconds(), 40, 'forty seconds of an unchanged screen');
});

test('any movement resets the clock', () => {
  const watcher = new ScreenWatcher();
  const a = signature(window_(320, 180, { x: 40, y: 30, w: 120, h: 90 }), 320, 180);
  const b = signature(window_(320, 180, { x: 40, y: 44, w: 120, h: 90 }), 320, 180);

  let at = 1_000_000;
  watcher.observe(a, at);
  at += 60_000;
  watcher.observe(a, at);
  assert.equal(watcher.stillSeconds(), 60);

  at += 2000;
  watcher.observe(b, at);
  assert.equal(watcher.stillSeconds(), 0, 'they did something; the clock starts again');
});

test('every switch is its own moment, back to back ones included', () => {
  const watcher = new ScreenWatcher();
  const dark = signature(flat(320, 180, 20), 320, 180);
  const light = signature(flat(320, 180, 230), 320, 180);

  watcher.observe(dark, 1000);
  assert.equal(watcher.observe(light, 3000), 'switched');
  assert.equal(watcher.observe(dark, 5000), 'switched', 'they moved again, and that is news too');
  assert.equal(watcher.observe(dark, 7000), 'still');
});

test('the first frame is not a change', () => {
  const watcher = new ScreenWatcher();
  assert.equal(
    watcher.observe(signature(flat(320, 180, 200), 320, 180), 1000),
    'still',
    'turning the screen on is not switching to it',
  );
});

test('with nothing seen, stillness is zero rather than since-the-epoch', () => {
  assert.equal(new ScreenWatcher().stillSeconds(Date.now()), 0);
});
