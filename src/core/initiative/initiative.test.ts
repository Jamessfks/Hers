import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Initiative, pickReason } from './initiative.ts';
import type { SituationSnapshot } from '../senses/situation.ts';

/**
 * A fake clock with a fake timer queue.
 *
 * The whole point of this class is a three-minute promise, and a test that
 * actually waits three minutes is a test nobody runs. So time is a number and
 * timers are a sorted list, which also makes "did it ever exceed the ceiling"
 * answerable exactly rather than approximately.
 */
function clockFixture() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();

  return {
    get now() {
      return now;
    },
    setTimer(fn: () => void, ms: number) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle: ReturnType<typeof setTimeout>) {
      pending.delete(handle as unknown as number);
    },
    /** Runs every timer due within `ms`, in order. */
    advance(ms: number) {
      const deadline = now + ms;
      for (;;) {
        let soonest: { id: number; at: number; fn: () => void } | null = null;
        for (const [id, entry] of pending) {
          if (entry.at <= deadline && (!soonest || entry.at < soonest.at)) {
            soonest = { id, ...entry };
          }
        }
        if (!soonest) break;
        pending.delete(soonest.id);
        now = soonest.at;
        soonest.fn();
      }
      now = deadline;
    },
  };
}

function situation(overrides: Partial<SituationSnapshot> = {}): SituationSnapshot {
  return {
    senses: { hearing: true, sight: false, screen: false },
    presence: { idleSeconds: 5, tabVisible: true, at: 1 },
    screen: { activity: 'still', stillSeconds: 0, sinceSwitchMs: Infinity, at: 0 },
    sinceUserSpokeMs: 30_000,
    sinceAnnaSpokeMs: 30_000,
    turns: 4,
    hour: 14,
    localTime: 'Friday 2:00pm',
    ...overrides,
  };
}

function build(
  options: {
    busy?: () => boolean;
    random?: () => number;
    max?: number;
    /** Simulates the turn her opener produces landing straight away. */
    completeTurns?: boolean;
  } = {},
) {
  const clock = clockFixture();
  const opened: { at: number; reason: string }[] = [];
  const initiative = new Initiative({
    maxSilenceMs: options.max ?? 180_000,
    minSilenceMs: 45_000,
    isBusy: options.busy ?? (() => false),
    observe: () => situation(),
    onOpen: (reason) => {
      opened.push({ at: clock.now, reason });
      if (options.completeTurns !== false) initiative.noteAnnaFinished(true);
    },
    now: () => clock.now,
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (handle) => clock.clearTimer(handle),
    ...(options.random ? { random: options.random } : { random: () => 0.999 }),
  });
  return { clock, initiative, opened };
}

test('she never goes more than three minutes without speaking', () => {
  const { clock, initiative, opened } = build();
  initiative.start();

  // An hour of nobody saying anything, with the delay drawn at its longest.
  clock.advance(60 * 60_000);

  // Every gap while she is still trying must be inside the ceiling. She stops
  // after two unanswered openers, which is a separate promise — see the test
  // about not talking to an empty room.
  assert.ok(opened.length > 0, 'she never spoke at all');
  let previous = 0;
  for (const opener of opened) {
    const gap = opener.at - previous;
    assert.ok(gap <= 180_000, `went ${gap}ms without speaking, which is over the ceiling`);
    previous = opener.at;
  }
});

test('the gap varies rather than landing on the same second every time', () => {
  const draws = [0.02, 0.4, 0.95, 0.6, 0.15];
  let index = 0;
  const { clock, initiative, opened } = build({
    random: () => draws[index++ % draws.length] ?? 0.5,
  });
  initiative.start();
  clock.advance(15 * 60_000);

  const gaps = opened.map((opener, i) => opener.at - (opened[i - 1]?.at ?? 0));
  assert.ok(new Set(gaps).size > 1, `every gap was identical: ${gaps.join(', ')}`);
});

test('she waits for a gap rather than talking over anyone', () => {
  let busy = true;
  const { clock, initiative, opened } = build({ busy: () => busy });
  initiative.start();

  clock.advance(300_000);
  assert.equal(opened.length, 0, 'spoke while the floor was busy');

  busy = false;
  clock.advance(10_000);
  assert.equal(opened.length, 1, 'did not speak once the floor cleared');
});

test('being poked resets the clock', () => {
  const { clock, initiative, opened } = build({ random: () => 0.999 });
  initiative.start();

  // Keep interrupting just before the ceiling.
  for (let i = 0; i < 10; i += 1) {
    clock.advance(170_000);
    initiative.poke();
  }
  assert.equal(opened.length, 0, 'she opened despite the conversation being alive');
});

test('she stops talking to an empty room rather than repeating herself', () => {
  const { clock, initiative, opened } = build({ random: () => 0 });
  initiative.start();
  clock.advance(60 * 60_000);

  assert.ok(opened.length <= 3, `opened ${opened.length} times into silence`);
  assert.equal(initiative.waiting, true, 'she should be waiting for a reason, not a clock');
});

test('a person coming back is a reason, and she starts again', () => {
  const { clock, initiative, opened } = build({ random: () => 0 });
  initiative.start();
  clock.advance(60 * 60_000);
  const beforeReturn = opened.length;

  initiative.poke();
  assert.equal(initiative.waiting, false);
  clock.advance(5 * 60_000);
  assert.ok(opened.length > beforeReturn, 'she never spoke again after they came back');
});

test('openers nobody answers back her off without breaking the promise', () => {
  const { clock, initiative, opened } = build({ random: () => 0 });
  initiative.start();

  // With random() === 0 every delay is the floor, which grows per unanswered
  // opener. It must still never exceed the ceiling.
  clock.advance(20 * 60_000);

  const gaps = opened.map((opener, i) => opener.at - (opened[i - 1]?.at ?? 0));
  assert.ok(gaps.length >= 2);
  assert.ok((gaps[1] ?? 0) > (gaps[0] ?? 0), 'the floor must rise when nobody answers');
  for (const gap of gaps) assert.ok(gap <= 180_000, `gap ${gap} exceeded the ceiling`);
});

test('stopping actually stops her', () => {
  const { clock, initiative, opened } = build();
  initiative.start();
  initiative.stop();
  clock.advance(600_000);
  assert.equal(opened.length, 0);
});

test('a floor above the ceiling cannot break the promise', () => {
  const clock = clockFixture();
  const opened: number[] = [];
  const initiative = new Initiative({
    maxSilenceMs: 60_000,
    minSilenceMs: 999_000,
    isBusy: () => false,
    observe: () => situation(),
    onOpen: () => opened.push(clock.now),
    now: () => clock.now,
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (handle) => clock.clearTimer(handle),
    random: () => 0.5,
  });

  initiative.start();
  clock.advance(300_000);
  assert.ok(opened.length >= 4, `expected roughly one per minute, got ${opened.length}`);
});

// -- reasons ----------------------------------------------------------------

test('the reason is drawn from what is actually true right now', () => {
  const away = pickReason(situation({ presence: { idleSeconds: 5, tabVisible: false, at: 1 } }));
  assert.match(away, /gone somewhere else/);

  const night = pickReason(situation({ hour: 3, localTime: 'Tuesday 3:12am' }));
  assert.match(night, /3:12am/);
  assert.match(night, /Do not tell them to sleep/);

  const idle = pickReason(situation({ presence: { idleSeconds: 40 * 60, tabVisible: true, at: 1 } }));
  assert.match(idle, /40 minutes/);

  const first = pickReason(situation({ turns: 0 }));
  assert.match(first, /not spoken/);
});

test('what the screen is doing is a reason to speak', () => {
  const watching = { hearing: true, sight: false, screen: true };

  const switched = pickReason(
    situation({
      senses: watching,
      screen: { activity: 'switched', stillSeconds: 0, sinceSwitchMs: 4000, at: 1 },
    }),
  );
  assert.match(switched, /moved to something else/);

  const staring = pickReason(
    situation({
      senses: watching,
      screen: { activity: 'still', stillSeconds: 42 * 60, sinceSwitchMs: Infinity, at: 1 },
    }),
  );
  assert.match(staring, /42 minutes/);

  const working = pickReason(
    situation({
      senses: watching,
      screen: { activity: 'working', stillSeconds: 0, sinceSwitchMs: Infinity, at: 1 },
    }),
  );
  assert.match(working, /keeps changing/);
});

test('a switch stops being news once it is old', () => {
  const reason = pickReason(
    situation({
      senses: { hearing: true, sight: false, screen: true },
      screen: { activity: 'still', stillSeconds: 300, sinceSwitchMs: 20 * 60_000, at: 1 },
    }),
  );
  assert.doesNotMatch(reason, /moved to something else/);
});

test('a screen nobody has reported on is not reasoned about', () => {
  // Telegram and phone calls have `screen` off and no browser behind them; the
  // desk has no reading at all for the first second or two.
  const reason = pickReason(
    situation({
      senses: { hearing: true, sight: false, screen: true },
      screen: { activity: 'still', stillSeconds: 99 * 60, sinceSwitchMs: 1000, at: 0 },
    }),
  );
  assert.doesNotMatch(reason, /moved to something else/);
  assert.doesNotMatch(reason, /99 minutes/);
});

test('after two unanswered openers she stops asking', () => {
  const reason = pickReason(situation(), 2);
  assert.match(reason, /not answered/);
  assert.match(reason, /does not need a reply/);
});

test('no reason is ever a bare greeting instruction', () => {
  const cases = [
    situation(),
    situation({ turns: 0 }),
    situation({ hour: 3 }),
    situation({ senses: { hearing: true, sight: true, screen: false } }),
    situation({ senses: { hearing: true, sight: false, screen: true } }),
    situation({ presence: { idleSeconds: 3600, tabVisible: true, at: 1 } }),
    situation({
      senses: { hearing: true, sight: false, screen: true },
      screen: { activity: 'switched', stillSeconds: 0, sinceSwitchMs: 2000, at: 1 },
    }),
    situation({
      senses: { hearing: true, sight: false, screen: true },
      screen: { activity: 'still', stillSeconds: 60 * 60, sinceSwitchMs: Infinity, at: 1 },
    }),
  ];
  for (const each of cases) {
    const reason = pickReason(each);
    assert.ok(reason.length > 20, `reason too thin: ${reason}`);
    assert.ok(!/^say hello/i.test(reason), reason);
  }
});
