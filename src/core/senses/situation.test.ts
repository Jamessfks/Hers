import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Situation, formatLocalTime, isLateNight } from './situation.ts';

/** A clock the test moves by hand. */
function clock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function watching(time = clock()) {
  const situation = new Situation(time.now);
  situation.setSense('screen', true);
  return { situation, time };
}

test('nothing is known about the screen until the browser says something', () => {
  const { situation } = watching();
  const screen = situation.snapshot().screen;
  assert.equal(screen.at, 0, 'a zero timestamp is how the rest of the system tells "no reading"');
  assert.equal(screen.stillSeconds, 0);
  assert.equal(screen.sinceSwitchMs, Number.POSITIVE_INFINITY);
});

test('stillness carries forward between reports', () => {
  const { situation, time } = watching();
  situation.noteScreen('still', 120);

  time.advance(25_000);
  assert.equal(
    situation.snapshot().screen.stillSeconds,
    145,
    'the browser reports every 30s; the seconds in between still passed',
  );
});

test('stillness stops accruing once the browser goes quiet', () => {
  const { situation, time } = watching();
  situation.noteScreen('still', 60);

  time.advance(10 * 60_000);
  assert.equal(
    situation.snapshot().screen.stillSeconds,
    60,
    'a frozen tab is not evidence of concentration',
  );
});

test('a busy screen does not accumulate stillness', () => {
  const { situation, time } = watching();
  situation.noteScreen('working', 0);
  time.advance(25_000);
  assert.equal(situation.snapshot().screen.stillSeconds, 0);
});

test('a switch is remembered as a moment, and ages', () => {
  const { situation, time } = watching();
  situation.noteScreen('switched', 0);
  assert.equal(situation.snapshot().screen.sinceSwitchMs, 0);

  time.advance(90_000);
  situation.noteScreen('working', 0);
  assert.equal(situation.snapshot().screen.sinceSwitchMs, 90_000);
});

test('reports are ignored while the screen sense is off', () => {
  const situation = new Situation(clock().now);
  situation.noteScreen('switched', 0);
  assert.equal(situation.snapshot().screen.at, 0, 'she is not sharing a screen with anyone');
});

test('stopping the share drops what was known about it', () => {
  const { situation } = watching();
  situation.noteScreen('still', 40 * 60);
  situation.setSense('screen', false);

  const screen = situation.snapshot().screen;
  assert.equal(screen.at, 0);
  assert.equal(screen.stillSeconds, 0, 'a stopped share must not read as forty minutes of staring');
  assert.equal(screen.sinceSwitchMs, Number.POSITIVE_INFINITY);
});

test('a new conversation keeps the screen, like presence', () => {
  const { situation } = watching();
  situation.noteScreen('working', 0);
  situation.notePresence(5, true);
  situation.noteUserSpoke();

  situation.reset();
  const snapshot = situation.snapshot();
  assert.equal(snapshot.turns, 0);
  assert.ok(snapshot.screen.at > 0, 'the screen did not go away because a conversation ended');
  assert.ok(snapshot.presence.at > 0);
});

test('a nonsense duration does not become a nonsense reason', () => {
  const { situation } = watching();
  situation.noteScreen('still', Number.NaN);
  assert.equal(situation.snapshot().screen.stillSeconds, 0);
  situation.noteScreen('still', -50);
  assert.equal(situation.snapshot().screen.stillSeconds, 0);
});

// -- the pre-existing bits, which had no test of their own -------------------

test('the time is phrased the way a person would say it', () => {
  assert.equal(formatLocalTime(new Date(2026, 7, 14, 23, 40)), 'Friday 11:40pm');
  assert.equal(formatLocalTime(new Date(2026, 7, 14, 0, 5)), 'Friday 12:05am');
  assert.equal(formatLocalTime(new Date(2026, 7, 14, 12, 0)), 'Friday 12:00pm');
});

test('late night is the small hours, not the evening', () => {
  assert.equal(isLateNight(23), false);
  assert.equal(isLateNight(3), true);
  assert.equal(isLateNight(5), false);
});
