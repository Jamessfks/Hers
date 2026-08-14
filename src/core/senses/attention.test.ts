import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Attention, SituationTracker, type Situation } from './attention.ts';

const POLICY = { proactive: true, minMinutesBetweenOpeners: 20, quietHours: null } as const;

/** A user sitting there, doing nothing that warrants comment. */
function calm(overrides: Partial<Situation> = {}): Situation {
  return {
    present: true,
    app: 'Xcode',
    idleSeconds: 5,
    minutesOnSameApp: 3,
    minutesSinceLastPresent: 0,
    minutesSinceLastTurn: 10,
    inConversation: false,
    ...overrides,
  };
}

/** A weekday afternoon, safely outside any late-night trigger. */
const AFTERNOON = new Date('2026-08-14T14:00:00').getTime();
const MINUTE = 60_000;

test('stays quiet when nothing is worth mentioning', () => {
  assert.equal(new Attention({ ...POLICY }).decide(calm(), AFTERNOON), null);
});

test('never speaks first when proactivity is off', () => {
  const attention = new Attention({ ...POLICY, proactive: false });
  assert.equal(attention.decide(calm({ minutesOnSameApp: 90 }), AFTERNOON), null);
});

test('never speaks first while the user is away', () => {
  const attention = new Attention({ ...POLICY });
  assert.equal(attention.decide(calm({ present: false, minutesOnSameApp: 90 }), AFTERNOON), null);
});

test('never interrupts a live conversation', () => {
  const attention = new Attention({ ...POLICY });
  assert.equal(attention.decide(calm({ inConversation: true, minutesOnSameApp: 90 }), AFTERNOON), null);
});

test('respects quiet hours, including a window that wraps midnight', () => {
  const attention = new Attention({ ...POLICY, quietHours: [23, 7] });
  const twoAm = new Date('2026-08-14T02:00:00').getTime();
  const noon = new Date('2026-08-14T12:00:00').getTime();
  assert.equal(attention.decide(calm({ minutesOnSameApp: 90 }), twoAm), null);
  assert.ok(attention.decide(calm({ minutesOnSameApp: 90 }), noon), 'should speak outside quiet hours');
});

test('an imminent calendar event outranks everything else', () => {
  const attention = new Attention({ ...POLICY });
  const opener = attention.decide(
    calm({
      minutesOnSameApp: 90,
      minutesSinceLastPresent: 0,
      nextEvent: { summary: 'Demo with Ravi', startsInMinutes: 8 },
    }),
    AFTERNOON,
  );
  assert.equal(opener?.trigger, 'calendar');
  assert.match(opener?.reason ?? '', /Demo with Ravi/);
});

test('reads distress from the vision description', () => {
  const attention = new Attention({ ...POLICY });
  const opener = attention.decide(calm({ read: 'slumped forward, rubbing their eyes' }), AFTERNOON);
  assert.equal(opener?.trigger, 'looks-rough');
});

test('a neutral vision read is not treated as distress', () => {
  const attention = new Attention({ ...POLICY });
  assert.equal(attention.decide(calm({ read: 'sitting upright, drinking tea' }), AFTERNOON), null);
});

test('only one opener fires per cooldown window', () => {
  const attention = new Attention({ ...POLICY });
  const situation = calm({ minutesOnSameApp: 90 });
  assert.ok(attention.decide(situation, AFTERNOON));
  assert.equal(attention.decide(situation, AFTERNOON + 5 * MINUTE), null, 'too soon');
});

test('a suppressed trigger does not burn its own cooldown', () => {
  const attention = new Attention({ ...POLICY, quietHours: [0, 23] });
  const situation = calm({ minutesOnSameApp: 90 });
  const quiet = new Date('2026-08-14T10:00:00').getTime();
  assert.equal(attention.decide(situation, quiet), null);

  const open = new Attention({ ...POLICY });
  assert.ok(open.decide(situation, quiet), 'the same trigger must still be available later');
});

test('the same observation is not repeated within its own cooldown', () => {
  const attention = new Attention({ ...POLICY });
  const situation = calm({ minutesOnSameApp: 90, app: 'Xcode' });
  assert.equal(attention.decide(situation, AFTERNOON)?.trigger, 'stuck');
  // Well past the global opener gap, but still inside the 'stuck' cooldown.
  assert.equal(attention.decide(situation, AFTERNOON + 60 * MINUTE), null);
  assert.equal(attention.decide(situation, AFTERNOON + 130 * MINUTE)?.trigger, 'stuck');
});

// -- SituationTracker -------------------------------------------------------

test('tracker notices a change of app and restarts the clock', () => {
  const tracker = new SituationTracker();
  const start = AFTERNOON;
  tracker.observe({ kind: 'activity', app: 'Xcode', windowTitle: 'a.swift', idleSeconds: 0, at: start });
  const later = start + 30 * MINUTE;
  assert.ok(tracker.snapshot(later, false).minutesOnSameApp >= 29);

  tracker.observe({ kind: 'activity', app: 'Safari', windowTitle: 'docs', idleSeconds: 0, at: later });
  assert.ok(tracker.snapshot(later + MINUTE, false).minutesOnSameApp < 2, 'clock should reset');
});

test('tracker describes the world in plain language, not telemetry', () => {
  const tracker = new SituationTracker();
  tracker.observe({
    kind: 'activity',
    app: 'Xcode',
    windowTitle: 'ContentView.swift',
    idleSeconds: 600,
    at: AFTERNOON,
  });
  // The read is taken 24 minutes in, so it is fresh when described a minute
  // later. A 25-minute-old read is deliberately no longer reported as current.
  tracker.observe({
    kind: 'presence',
    present: true,
    read: 'hunched over',
    at: AFTERNOON + 24 * MINUTE,
  });
  const lines = tracker.describe(AFTERNOON + 25 * MINUTE).join('\n');
  assert.match(lines, /They have been in Xcode for 25 minutes\./);
  assert.match(lines, /have not touched the keyboard in 10 minutes/);
  assert.match(lines, /How they look, just now: hunched over/);
  assert.doesNotMatch(lines, /idle_seconds|app=/);
});

test('user input marks them present again', () => {
  const tracker = new SituationTracker();
  tracker.observe({ kind: 'presence', present: false, at: AFTERNOON });
  assert.equal(tracker.snapshot(AFTERNOON, false).present, false);
  tracker.observe({ kind: 'user-typed', text: 'hey', at: AFTERNOON + MINUTE });
  assert.equal(tracker.snapshot(AFTERNOON + MINUTE, false).present, true);
});

test('a visual read expires rather than being reported as current', () => {
  // She used to confidently say "you look tired" from an image three minutes
  // old, after the user had got up and made coffee.
  const tracker = new SituationTracker();
  tracker.observe({ kind: 'presence', present: true, read: 'slumped, rubbing eyes', at: AFTERNOON });

  assert.equal(tracker.snapshot(AFTERNOON + 30_000, false).read, 'slumped, rubbing eyes');
  assert.equal(
    tracker.snapshot(AFTERNOON + 5 * 60_000, false).read,
    undefined,
    'a five-minute-old read must not be presented as now',
  );
  assert.match(
    tracker.describe(AFTERNOON + 5 * 60_000).join('\n'),
    /not looked at them recently/,
    'and she should know she has not looked',
  );
});

test('a stale read cannot trigger the distress opener', () => {
  const attention = new Attention({ ...POLICY });
  const tracker = new SituationTracker();
  tracker.observe({ kind: 'presence', present: true, read: 'head in hands', at: AFTERNOON });
  const stale = tracker.snapshot(AFTERNOON + 6 * 60_000, false);
  assert.equal(attention.decide(stale, AFTERNOON + 6 * 60_000), null);
});
