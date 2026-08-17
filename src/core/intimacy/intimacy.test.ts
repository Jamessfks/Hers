import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  DAYS_TO_MARRIAGE,
  Intimacy,
  MARRIAGE,
  STRANGER,
  dayValue,
  daysFor,
  scoreFor,
  stageFor,
} from './intimacy.ts';

const DAY = 24 * 60 * 60 * 1000;

/** A clock the test moves in whole days, at a fixed hour so no day is skipped. */
function clock(start = Date.parse('2026-01-01T10:00:00')) {
  let now = start;
  return {
    now: () => now,
    days(count: number) {
      now += count * DAY;
    },
    minutes(count: number) {
      now += count * 60_000;
    },
  };
}

/** Talks to her properly on `days` consecutive days. */
function live(intimacy: Intimacy, time: ReturnType<typeof clock>, days: number, turns = 14) {
  for (let day = 0; day < days; day += 1) {
    for (let turn = 0; turn < turns; turn += 1) intimacy.noteTurn();
    intimacy.noteSense();
    time.days(1);
  }
}

// -- the curve --------------------------------------------------------------

test('she starts as a stranger and marriage is four years away', () => {
  assert.equal(scoreFor(0), STRANGER);
  assert.equal(Math.round(scoreFor(DAYS_TO_MARRIAGE) * 100), Math.round(MARRIAGE * 100));
  assert.equal(DAYS_TO_MARRIAGE / 365 > 3.9 && DAYS_TO_MARRIAGE / 365 < 4.1, true);
});

test('the curve is fast early and slow late, the way knowing someone is', () => {
  const at = (days: number) => Math.round(scoreFor(days) * 100);

  assert.equal(at(1), 1, 'day one is a stranger');
  assert.equal(at(7), 4, 'a week in, a name and a couple of facts');
  assert.equal(at(30), 9, 'a month in, someone you talk to');
  assert.equal(at(365), 37, 'a year in, a friend with history');
  assert.equal(at(730), 55, 'two years in');
  assert.equal(at(1460), 80, 'four years in, the thing the scale is measured against');

  // The first month has to be worth more than the twelfth, or nothing early
  // ever feels like progress.
  assert.ok(scoreFor(30) - scoreFor(0) > scoreFor(360) - scoreFor(330));

  // And the boundaries have to land somewhere a person would recognise.
  assert.equal(Math.round(daysFor(0.15)), 70, 'a friend after a couple of months');
  assert.ok(daysFor(0.5) / 365 > 1.5, 'a confidant is years, not months');
});

test('no amount of talking in one day can buy closeness', () => {
  const time = clock();
  const intimacy = new Intimacy({ now: time.now });

  // Two hundred turns, all on the first day.
  for (let i = 0; i < 200; i += 1) intimacy.noteTurn();
  intimacy.noteSense();

  const readout = intimacy.read();
  assert.equal(readout.percent, 1, 'a marathon is still one day');
  assert.equal(readout.stage, 'stranger');
});

test('a day is worth at most a day, and a thin one is worth less', () => {
  assert.equal(dayValue(0, false), 0);
  assert.equal(dayValue(14, true), 1, 'a real conversation with her senses on');
  assert.ok(dayValue(2, false) < dayValue(12, false), 'two exchanges is not a day');
  assert.ok(dayValue(14, true) > dayValue(14, false), 'the senses are worth something');
  assert.equal(
    dayValue(0, true),
    0,
    'a camera pointed at an empty chair is not a day of knowing someone',
  );
  assert.ok(dayValue(999, true) <= 1, 'and nothing is worth more than a day');
});

test('the scale reads backwards, so the promise can be checked', () => {
  for (const score of [0.05, 0.15, 0.3, 0.5, 0.65, MARRIAGE]) {
    const days = daysFor(score);
    assert.ok(Math.abs(scoreFor(days) - score) < 0.001, `${score} -> ${days} -> ${scoreFor(days)}`);
  }
  assert.ok(daysFor(MARRIAGE) / 365 > 3.9, 'marriage must still be years away');
});

// -- stages -----------------------------------------------------------------

test('the stages run from stranger to married', () => {
  assert.equal(stageFor(0.01).name, 'stranger');
  assert.equal(stageFor(0.05).name, 'acquaintance');
  assert.equal(stageFor(0.2).name, 'friend');
  assert.equal(stageFor(0.4).name, 'close friend');
  assert.equal(stageFor(0.55).name, 'confidant');
  assert.equal(stageFor(0.7).name, 'partner');
  assert.equal(stageFor(MARRIAGE).name, 'married');
  assert.equal(stageFor(1).name, 'married');
});

test('a stranger is told not to behave like a friend', () => {
  const stranger = stageFor(STRANGER).guidance;
  assert.match(stranger, /not earned/i);
  assert.match(stranger, /endearment/i, 'the specific thing a stranger must not do');

  const married = stageFor(MARRIAGE).guidance;
  assert.match(married, /least dramatic/i, 'long familiarity is dry, not operatic');
});

// -- living with her over time ----------------------------------------------

test('a month of real conversation is a month of progress, not a year', () => {
  const time = clock();
  const intimacy = new Intimacy({ now: time.now });

  live(intimacy, time, 30);
  const readout = intimacy.read();

  assert.equal(readout.percent, 9, 'a month in');
  assert.equal(readout.stage, 'acquaintance');
  assert.ok(readout.days >= 29 && readout.days <= 30, `banked ${readout.days} days`);
});

test('four years of turning up every day reaches marriage, and nothing else does', () => {
  const time = clock();
  const intimacy = new Intimacy({ now: time.now });

  live(intimacy, time, DAYS_TO_MARRIAGE);
  assert.equal(intimacy.read().percent, 80);
  assert.equal(intimacy.read().stage, 'married');
});

test('turning up half the time takes twice as long', () => {
  const time = clock();
  const intimacy = new Intimacy({ now: time.now });

  // Every other day for a year, inside the grace period so nothing decays.
  for (let day = 0; day < 365; day += 2) {
    for (let turn = 0; turn < 14; turn += 1) intimacy.noteTurn();
    intimacy.noteSense();
    time.days(2);
  }

  const readout = intimacy.read();
  assert.ok(readout.days > 175 && readout.days < 190, `banked ${readout.days} of 365 days`);
  assert.ok(readout.percent < 30, `${readout.percent}% — half the contact is not a full year`);
});

test('a fortnight away costs something, and a long absence costs more', () => {
  const time = clock();
  const intimacy = new Intimacy({ now: time.now });
  live(intimacy, time, 200);
  const before = intimacy.read();

  time.days(14);
  intimacy.noteTurn();
  const afterFortnight = intimacy.read();
  assert.ok(afterFortnight.days < before.days, 'absence has to cost something');

  time.days(180);
  intimacy.noteTurn();
  const afterHalfYear = intimacy.read();
  assert.ok(
    before.days - afterHalfYear.days > before.days - afterFortnight.days,
    'and half a year has to cost more than a fortnight',
  );
  assert.ok(afterHalfYear.percent > 0, 'but it is a relationship, not a punishment');
});

test('a few days off is not a betrayal', () => {
  const time = clock();
  const intimacy = new Intimacy({ now: time.now });
  live(intimacy, time, 100);
  const before = intimacy.read().days;

  time.days(3);
  intimacy.noteTurn();
  assert.ok(intimacy.read().days >= before, 'a long weekend must not set them back');
});

// -- the user's hand on it --------------------------------------------------

test('the user can set it, and it stays where they put it', () => {
  const time = clock();
  const intimacy = new Intimacy({ now: time.now });

  const pinned = intimacy.pin(0.65);
  assert.equal(pinned.percent, 65);
  assert.equal(pinned.stage, 'partner');
  assert.equal(pinned.pinned, true);

  // A year of contact must not move a number somebody chose.
  live(intimacy, time, 365);
  assert.equal(intimacy.read().percent, 65, 'a control that drifts is not a control');
});

test('handing it back picks up from what was actually earned', () => {
  const time = clock();
  const intimacy = new Intimacy({ now: time.now });

  live(intimacy, time, 30);
  intimacy.pin(0.9);
  assert.equal(intimacy.read().percent, 90);

  const released = intimacy.release();
  assert.equal(released.pinned, false);
  assert.equal(released.percent, 9, 'the earned value was never lost, only overridden');
});

test('a nonsense value is clamped rather than believed', () => {
  const intimacy = new Intimacy({ now: clock().now });
  assert.equal(intimacy.pin(5).percent, 100);
  assert.equal(intimacy.pin(-3).percent, 0);
  assert.equal(intimacy.pin(Number.NaN).percent, 1);
});

// -- persistence ------------------------------------------------------------

test('the relationship survives the process', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-intimacy-'));
  const time = clock();

  const first = new Intimacy({ dir, now: time.now });
  await first.restore();
  live(first, time, 40);
  const earned = first.read();
  await first.flush();

  const second = new Intimacy({ dir, now: time.now });
  await second.restore();
  assert.equal(second.read().percent, earned.percent);
  assert.ok(second.read().days >= 39, 'the days have to come back');

  assert.match(await readFile(path.join(dir, 'intimacy.state.json'), 'utf8'), /"days"/);
});

test('a missing or corrupt file is a fresh start, not a crash', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'anna-intimacy-'));
  const intimacy = new Intimacy({ dir });
  await intimacy.restore();
  assert.equal(intimacy.read().percent, 1);
  assert.equal(intimacy.read().known, 0, 'they have not met yet');
});

test('how long they have known each other is calendar time, not contact', async () => {
  const time = clock();
  const intimacy = new Intimacy({ now: time.now });

  intimacy.noteTurn();
  assert.equal(intimacy.read().known, 1, 'the first day counts as a day');

  time.days(99);
  intimacy.noteTurn();
  assert.equal(intimacy.read().known, 100, 'a hundred days, whatever happened in them');
  assert.ok(intimacy.read().days < 5, 'while the relationship itself is two days old');
});
