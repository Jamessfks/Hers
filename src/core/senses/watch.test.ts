import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPTION_INTERVAL_MS, CHANGE_THRESHOLD, CameraWatcher, distance } from './watch.ts';
import { UNTRUSTED_OPEN } from './untrusted.ts';

const FRAME = Buffer.from('jpeg');

function watcher(captions: string[]): {
  watcher: CameraWatcher;
  notes: string[];
  tick: (ms: number) => void;
  asked: () => number;
} {
  let now = CAPTION_INTERVAL_MS;
  let index = 0;
  const notes: string[] = [];
  let busy = false;
  const w = new CameraWatcher({
    caption: async () => captions[index++] ?? '',
    onChange: (note) => notes.push(note),
    isBusy: () => busy,
    now: () => now,
  });
  return {
    watcher: w,
    notes,
    tick: (ms) => {
      now += ms;
    },
    asked: () => index,
  };
}

test('two captions of an unchanged room are the same caption', () => {
  assert.ok(
    distance(
      'A man is sitting at a desk in front of two monitors.',
      'The man sits at his desk with two monitors in front of him.',
    ) < 0.5,
  );
});

test('a room that has actually changed reads as changed', () => {
  assert.ok(
    distance(
      'A man is sitting at a desk in front of two monitors.',
      'A woman is standing in a kitchen holding a kettle.',
    ) >= CHANGE_THRESHOLD,
  );
});

/**
 * The pair the threshold was actually set by.
 *
 * Same person, same desk, different verb. It is the most common thing a camera
 * sees and the least worth saying, and a change detector that fires on it is
 * worse than no change detector at all.
 */
test('the same person doing a slightly different thing is not a change', () => {
  assert.ok(
    distance(
      'A man sitting at a desk with two monitors.',
      'The man is at the desk, typing on a keyboard.',
    ) < CHANGE_THRESHOLD,
  );
});

test('the first caption sets the baseline and says nothing', async () => {
  const { watcher: w, notes } = watcher(['A man at a desk.']);
  await w.see(FRAME);
  assert.equal(notes.length, 0);
  assert.equal(w.caption, 'A man at a desk.');
});

test('she speaks up when the room changes and stays quiet when it does not', async () => {
  const { watcher: w, notes, tick } = watcher([
    'A man sitting at a desk with two monitors.',
    'The man is at the desk, typing on a keyboard.',
    'A man lying on a sofa in a dark room with a blanket.',
  ]);

  await w.see(FRAME);
  tick(CAPTION_INTERVAL_MS);
  await w.see(FRAME);
  assert.equal(notes.length, 0, 'the same room is not news');

  tick(CAPTION_INTERVAL_MS);
  await w.see(FRAME);
  assert.equal(notes.length, 1);
});

test('what she noticed arrives labelled as something she saw', async () => {
  const { watcher: w, notes, tick } = watcher([
    'A man sitting at a desk with two monitors.',
    'A woman standing in a kitchen holding a kettle.',
  ]);
  await w.see(FRAME);
  tick(CAPTION_INTERVAL_MS);
  await w.see(FRAME);
  assert.match(notes[0] ?? '', new RegExp(UNTRUSTED_OPEN));
  assert.match(notes[0] ?? '', /kettle/);
  assert.match(notes[0] ?? '', /not every time/);
});

test('frames arriving faster than the interval are dropped, not queued', async () => {
  const { watcher: w, asked, tick } = watcher(['one', 'two', 'three']);
  await w.see(FRAME);
  await w.see(FRAME);
  await w.see(FRAME);
  assert.equal(asked(), 1);

  tick(CAPTION_INTERVAL_MS);
  await w.see(FRAME);
  assert.equal(asked(), 2);
});

test('a caption that fails costs its interval rather than becoming a retry loop', async () => {
  let calls = 0;
  let now = CAPTION_INTERVAL_MS;
  const w = new CameraWatcher({
    caption: async () => {
      calls += 1;
      throw new Error('402');
    },
    onChange: () => undefined,
    isBusy: () => false,
    now: () => now,
  });
  await w.see(FRAME);
  await w.see(FRAME);
  assert.equal(calls, 1);
  now += CAPTION_INTERVAL_MS;
  await w.see(FRAME);
  assert.equal(calls, 2);
});

test('she does not interrupt herself mid-sentence', async () => {
  let busy = false;
  let now = CAPTION_INTERVAL_MS;
  const notes: string[] = [];
  const w = new CameraWatcher({
    caption: async () => (notes.length === 0 ? 'A man at a desk with monitors.' : 'x'),
    onChange: (note) => notes.push(note),
    isBusy: () => busy,
    now: () => now,
  });
  await w.see(FRAME);
  busy = true;
  now += CAPTION_INTERVAL_MS;
  await w.see(FRAME);
  assert.equal(notes.length, 0);
});

test('going to sleep forgets what she was looking at', async () => {
  const { watcher: w } = watcher(['A man at a desk.']);
  await w.see(FRAME);
  w.reset();
  assert.equal(w.caption, '');
});
