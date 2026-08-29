import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_RHYTHM,
  isAsleep,
  isGroggy,
  readRhythm,
  rhythmLine,
  wokenLine,
} from './rhythm.ts';

const NIGHT_OWL = { sleepHour: 2, wakeHour: 10, why: 'They are up late.' };
const EARLY = { sleepHour: 22, wakeHour: 6, why: 'They start early.' };

test('a sleep window that crosses midnight is still a window', () => {
  // The case that is easy to get exactly backwards, and reads as malice when
  // it is: awake for precisely the hours she meant to sleep.
  assert.equal(isAsleep(EARLY, 23), true);
  assert.equal(isAsleep(EARLY, 2), true);
  assert.equal(isAsleep(EARLY, 5), true);
  assert.equal(isAsleep(EARLY, 6), false);
  assert.equal(isAsleep(EARLY, 21), false);
});

test('a sleep window that does not cross midnight works the ordinary way', () => {
  assert.equal(isAsleep(NIGHT_OWL, 3), true);
  assert.equal(isAsleep(NIGHT_OWL, 9), true);
  assert.equal(isAsleep(NIGHT_OWL, 10), false);
  assert.equal(isAsleep(NIGHT_OWL, 1), false);
  assert.equal(isAsleep(NIGHT_OWL, 23), false);
});

test('hours that are the same mean she never sleeps', () => {
  const always = { sleepHour: 3, wakeHour: 3, why: '' };
  for (let hour = 0; hour < 24; hour += 1) assert.equal(isAsleep(always, hour), false);
});

test('she is groggy for the first two hours and merely asleep after', () => {
  assert.equal(isGroggy(EARLY, 22), true);
  assert.equal(isGroggy(EARLY, 23), true);
  assert.equal(isGroggy(EARLY, 0), false);
  assert.equal(isGroggy(EARLY, 4), false);
  assert.equal(isGroggy(EARLY, 12), false, 'awake is not groggy');
});

test('being woken early sounds different from being woken at four', () => {
  assert.match(wokenLine(EARLY, 22), /just woken you/);
  assert.match(wokenLine(EARLY, 4), /middle of your night/);
  // Neither version may send her looking for an explanation.
  assert.match(wokenLine(EARLY, 22), /do not ask why/);
});

test('an hour a language model made up does not become her bedtime', () => {
  assert.deepEqual(readRhythm({ sleep: 'about eleven', wake: 25 }), DEFAULT_RHYTHM);
  assert.equal(readRhythm({ sleep: -1, wake: 7 }).sleepHour, DEFAULT_RHYTHM.sleepHour);
  assert.equal(readRhythm({ sleep: 23.5, wake: 7 }).sleepHour, DEFAULT_RHYTHM.sleepHour);
});

test('an hour written as a string is still an hour', () => {
  assert.deepEqual(readRhythm({ sleep: '23', wake: '7' }, 'They stop at eleven.'), {
    sleepHour: 23,
    wakeHour: 7,
    why: 'They stop at eleven.',
  });
});

test('a missing file gives ordinary hours rather than none', () => {
  const rhythm = readRhythm({});
  assert.equal(isAsleep(rhythm, 3), true);
  assert.equal(isAsleep(rhythm, 12), false);
});

test('the prompt line closes the conversation about her hours', () => {
  const line = rhythmLine(EARLY);
  assert.match(line, /10pm to 6am/);
  assert.match(line, /not up for discussion/);
});

test('midnight and noon are named the way a person says them', () => {
  assert.match(rhythmLine({ sleepHour: 0, wakeHour: 12, why: '' }), /12am to 12pm/);
});
