import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bedtime } from './bedtime.ts';
import type { Rhythm } from './rhythm.ts';

const NIGHT: Rhythm = { sleepHour: 23, wakeHour: 7, why: 'measured' };

/** A clock the test moves by hand, and a companion that records being put to bed. */
function bedtime(startHour: number, rhythm: Rhythm = NIGHT) {
  let hour = startHour;
  let awake = true;
  const slept: number[] = [];
  const scheduler = new Bedtime({
    rhythm: () => rhythm,
    isAwake: () => awake,
    onBedtime: () => {
      slept.push(hour);
      awake = false;
    },
    // Only the hour matters, so the date is a fixed day with the hour moved.
    now: () => new Date(2026, 7, 28, hour, 30).getTime(),
  });
  // The baseline `start()` would establish, without arming a real timer.
  scheduler.tick();

  return {
    slept,
    to(next: number) {
      hour = next;
      scheduler.tick();
    },
    wake() {
      awake = true;
    },
    get awake() {
      return awake;
    },
  };
}

test('a companion awake at her own bedtime is put to bed', () => {
  const b = bedtime(21);
  b.to(22);
  assert.deepEqual(b.slept, [], 'not before the hour');
  b.to(23);
  assert.deepEqual(b.slept, [23]);
});

/**
 * The reason this watches an edge rather than a level.
 *
 * `rhythm.ts` says waking her is always the user's. A scheduler that acted on
 * "the clock is inside her window" would cut them off sixty seconds after every
 * wake, all night, which is a worse companion than one with no bedtime at all.
 */
test('waking her inside her own night does not put her straight back', () => {
  const b = bedtime(22);
  b.to(23);
  assert.deepEqual(b.slept, [23]);

  b.wake();
  b.to(1);
  b.to(2);
  b.to(3);
  assert.deepEqual(b.slept, [23], 'she was put to bed once and stayed up after being woken');
  assert.equal(b.awake, true);
});

test('she is not put to bed twice for one bedtime', () => {
  const b = bedtime(22);
  b.to(23);
  b.to(23);
  b.to(0);
  assert.deepEqual(b.slept, [23]);
});

/**
 * The case a `setTimeout` to the hour gets wrong.
 *
 * A machine suspended at 22:00 and opened at 02:00 never fires a timer that was
 * scheduled for 23:00. Reading the clock fresh on each tick means the boundary
 * is noticed on the first tick after waking, however long the gap was.
 */
test('an hour that passes while the machine is asleep is still noticed', () => {
  const b = bedtime(22);
  b.to(2);
  assert.deepEqual(b.slept, [2], 'the jump across the boundary counts as the boundary');
});

/**
 * Starting up inside her own night must not slam the door.
 *
 * The first tick has no previous answer, and treating that as "she was awake"
 * would end any conversation started at midnight one minute in.
 */
test('starting her up at midnight does not immediately put her to bed', () => {
  const b = bedtime(1);
  b.to(1);
  b.to(2);
  assert.deepEqual(b.slept, []);
});

test('a companion already asleep is left alone', () => {
  const b = bedtime(22);
  b.to(23);
  assert.deepEqual(b.slept, [23]);
  // She is asleep now; crossing more of the window changes nothing.
  b.to(0);
  assert.deepEqual(b.slept, [23]);
});

test('her hours are read fresh, so a rewritten rhythm takes effect', () => {
  let rhythm: Rhythm = { sleepHour: 2, wakeHour: 10, why: '' };
  let hour = 22;
  const slept: number[] = [];
  const scheduler = new Bedtime({
    rhythm: () => rhythm,
    isAwake: () => true,
    onBedtime: () => slept.push(hour),
    now: () => new Date(2026, 7, 28, hour, 30).getTime(),
  });

  scheduler.tick();
  hour = 23;
  scheduler.tick();
  assert.deepEqual(slept, [], 'her bedtime is 2am at this point');

  // Setup finishes and writes a different hour.
  rhythm = { sleepHour: 23, wakeHour: 7, why: '' };
  hour = 22;
  scheduler.tick();
  hour = 23;
  scheduler.tick();
  assert.deepEqual(slept, [23]);
});

test('stopping ends the schedule', () => {
  const slept: number[] = [];
  const scheduler = new Bedtime({
    rhythm: () => NIGHT,
    isAwake: () => true,
    onBedtime: () => slept.push(1),
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => undefined,
  });
  scheduler.start();
  scheduler.stop();
  scheduler.stop();
  assert.deepEqual(slept, []);
});
