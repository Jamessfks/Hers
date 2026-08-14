import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PerformanceEvent } from '../../shared/protocol.ts';
import {
  PerformanceParser,
  couldBeDirectivePrefix,
  parsePerformance,
  spokenText,
} from './performance.ts';

const say = (events: PerformanceEvent[]) => events.filter((e) => e.kind === 'say');
const kinds = (events: PerformanceEvent[]) => events.map((e) => e.kind);

test('strips directives out of the spoken text', () => {
  const events = parsePerformance('Hey. [smirk] You look wrecked. [tilt_head] Talk to me.');
  assert.equal(spokenText(events), 'Hey. You look wrecked. Talk to me.');
});

test('unknown directives are dropped, never spoken', () => {
  const events = parsePerformance('Hi [teleports behind you] there.');
  assert.equal(spokenText(events), 'Hi there.');
  assert.deepEqual(kinds(events), ['say', 'say']);
});

test('recognises gestures, expressions and gaze', () => {
  const events = parsePerformance('[lean_in][playful][gaze:user]ok');
  assert.deepEqual(events.slice(0, 3), [
    { kind: 'gesture', name: 'lean_in' },
    { kind: 'expression', name: 'playful' },
    { kind: 'gaze', target: 'user' },
  ]);
});

test('parses an intensity argument', () => {
  assert.deepEqual(parsePerformance('[nod x0.4]')[0], {
    kind: 'gesture',
    name: 'nod',
    intensity: 0.4,
  });
  assert.deepEqual(parsePerformance('[happy 0.8]')[0], {
    kind: 'expression',
    name: 'happy',
    weight: 0.8,
  });
});

test('a tag split across chunk boundaries still parses once', () => {
  const parser = new PerformanceParser();
  const events = [
    ...parser.push('Hey there you. [le'),
    ...parser.push('an_'),
    ...parser.push('in] good?'),
    ...parser.end(),
  ];
  const gestures = events.filter((e) => e.kind === 'gesture');
  assert.equal(gestures.length, 1, 'gesture must fire exactly once');
  assert.deepEqual(gestures[0], { kind: 'gesture', name: 'lean_in' });
  assert.equal(spokenText(events), 'Hey there you. good?');
});

test('an unterminated tag at end of stream is discarded, not spoken', () => {
  const parser = new PerformanceParser();
  const events = [...parser.push('All done. [lean_i'), ...parser.end()];
  assert.equal(spokenText(events), 'All done.');
});

test('first clause is emitted early so audio can start', () => {
  const parser = new PerformanceParser({ firstClauseMinChars: 24 });
  const events = parser.push('I have been thinking about what you said earlier and');
  assert.ok(say(events).length >= 1, 'expected an early flush before any punctuation');
});

test('clauses are ordered and uniquely numbered', () => {
  const events = say(parsePerformance('One. Two. Three. Four.'));
  assert.deepEqual(
    events.map((e) => e.clauseId),
    events.map((_, i) => i),
  );
});

test('does not emit empty clauses around back-to-back tags', () => {
  const events = parsePerformance('[nod] [smirk] [wave] hi');
  assert.deepEqual(
    say(events).map((e) => e.text),
    ['hi'],
  );
});

test('long run-on speech is broken up rather than buffered forever', () => {
  const runOn = `${'word '.repeat(60)}`;
  const parser = new PerformanceParser();
  const events = parser.push(runOn);
  assert.ok(say(events).length >= 2, 'expected mid-sentence flushes on a long run-on');
});

test('a stray bracket does not swallow the rest of the reply', () => {
  const events = parsePerformance('I saw a [ and then kept talking about the thing');
  assert.match(spokenText(events), /kept talking about the thing/);
});

test('a long bracketed passage is rescued as prose mid-stream', () => {
  const text = 'I saw a [ and then kept talking about the thing for quite a while longer] ok';
  assert.match(spokenText(parsePerformance(text)), /kept talking about the thing/);
});

test('a bracket followed by a newline is prose, not a directive', () => {
  assert.match(spokenText(parsePerformance('array[\nindex] = 3')), /array/);
});

test('couldBeDirectivePrefix distinguishes truncation from prose', () => {
  assert.equal(couldBeDirectivePrefix('lean_i'), true);
  assert.equal(couldBeDirectivePrefix('ga'), true);
  assert.equal(couldBeDirectivePrefix('nod x0.'), true);
  assert.equal(couldBeDirectivePrefix(' and then kept'), false);
  assert.equal(couldBeDirectivePrefix('teleports behind'), false);
});
