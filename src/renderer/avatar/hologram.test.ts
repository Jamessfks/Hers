/**
 * The playback state machine, under a DOM small enough to reason about.
 *
 * These tests exist because of a failure with no symptom: a gesture that is
 * never played produces no error, no log line and no visible change — she
 * simply stops moving, and the only evidence is a screenshot of a window that
 * is content-protected and therefore photographs as black. It was found by
 * reading, not by running, which is precisely the situation a test is for.
 *
 * The fake DOM is deliberately thin. Everything in it is a property `Hologram`
 * actually touches, and the one piece of real behaviour it models — `src`
 * assignment eventually firing `loadeddata` — is the piece the class waits on.
 * A heavier fake would start being a second implementation of a video element,
 * and a bug in *that* is not worth finding.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

type Listener = () => void;

class FakeElement {
  hidden = false;
  id = '';
  alt = '';
  className = '';
  decoding = '';
  readonly children: FakeElement[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #once = new WeakSet<Listener>();

  addEventListener(type: string, fn: Listener, options?: { once?: boolean }): void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(fn);
    if (options?.once) this.#once.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.#listeners.get(type)?.delete(fn);
  }

  emit(type: string): void {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) {
      if (this.#once.has(fn)) this.#listeners.get(type)?.delete(fn);
      fn();
    }
  }

  append(...kids: FakeElement[]): void {
    this.children.push(...kids);
  }

  remove(): void {}
}

class FakeVideo extends FakeElement {
  muted = false;
  playsInline = false;
  preload = '';
  loop = false;
  currentTime = 0;
  paused = true;
  /** Set to make `play()` reject, as it does under an autoplay policy. */
  refusePlay = false;
  #src = '';

  get src(): string {
    return this.#src;
  }

  /** Assignment schedules `loadeddata`, which is the event `play()` waits on. */
  set src(value: string) {
    this.#src = value;
    if (value) queueMicrotask(() => this.emit('loadeddata'));
  }

  async play(): Promise<void> {
    if (this.refusePlay) throw new Error('NotAllowedError');
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {}

  removeAttribute(name: string): void {
    if (name === 'src') this.#src = '';
  }

  /** Playback reaching the end of a non-looping clip. */
  end(): void {
    if (!this.loop) this.emit('ended');
  }

  /** The other way a clip stops: a decode failure, a source that will not load. */
  fail(): void {
    this.emit('error');
  }
}

const created: FakeElement[] = [];

function installDom(): void {
  created.length = 0;
  const globals = globalThis as Record<string, unknown>;
  globals['document'] = {
    createElement(tag: string): FakeElement {
      const made = tag === 'video' ? new FakeVideo() : new FakeElement();
      created.push(made);
      return made;
    },
  };
  let issued = 0;
  globals['URL'] = {
    createObjectURL: () => `blob:fake/${(issued += 1)}`,
    revokeObjectURL: () => {},
  };
}

let restore: { document: unknown; URL: unknown };

beforeEach(() => {
  const globals = globalThis as Record<string, unknown>;
  restore = { document: globals['document'], URL: globals['URL'] };
  installDom();
});

afterEach(() => {
  const globals = globalThis as Record<string, unknown>;
  globals['document'] = restore.document;
  globals['URL'] = restore.URL;
});

/**
 * Runs everything that is ready to run, including timers.
 *
 * A fixed count of microtask turns was not enough and was not honest about it:
 * the await depth of a `play()` varies with which branch it takes, so a test
 * could pass or fail on whether the budget happened to cover its path. This
 * drains until the loop is quiet — `setImmediate` sits behind every pending
 * microtask *and* every expired timer, so a round of it that changes nothing
 * means nothing more is coming.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Rig {
  hologram: import('./hologram.ts').Hologram;
  videos: FakeVideo[];
  played: string[];
  asked: string[];
}

async function rig(present: readonly string[]): Promise<Rig> {
  const { Hologram } = await import('./hologram.ts');
  // Only the elements this rig makes. A test that builds two Holograms would
  // otherwise see the first one's still-visible idle video as "on screen" for
  // the second, which is a way to make an assertion pass or fail for reasons
  // that have nothing to do with the class.
  const before = created.length;
  const mount = new FakeElement();
  const played: string[] = [];
  const asked: string[] = [];
  const hologram = new Hologram({
    mount: mount as unknown as HTMLElement,
    loadClip: async (slot) => {
      asked.push(slot);
      return present.includes(slot) ? new Uint8Array([1, 2, 3]) : null;
    },
    report: (event, detail) => {
      if (event === 'clip-played') played.push(String(detail?.['slot']));
    },
  });
  return {
    hologram,
    videos: created
      .slice(before)
      .filter((element): element is FakeVideo => element instanceof FakeVideo),
    played,
    asked,
  };
}

/** The element currently on screen, or null when she is the photograph. */
function onScreen(videos: FakeVideo[]): FakeVideo | null {
  return videos.find((video) => !video.hidden) ?? null;
}

test('a gesture plays over a looping idle clip', async () => {
  const { hologram, played } = await rig(['idle', 'nod']);
  await hologram.setIdle('idle');
  await settle();
  await hologram.play('nod');
  await settle();
  assert.deepEqual(played, ['idle', 'nod']);
});

test('a gesture still plays after the idle clip is taken away', async () => {
  /*
   * The bug this file was written for.
   *
   * `setIdle(null)` happens whenever the library stops offering `idle` — it is
   * evicted, its file goes missing, a measurement demotes it. The loop kept
   * running, `#playing` kept naming it, and the "is a gesture in progress"
   * test — `#playing !== #idle` — started answering yes forever. Every
   * subsequent gesture was filed as "next" behind a video that loops, and a
   * looping video never fires `ended`, so nothing ever drained it. No error,
   * no log, no gesture, for the rest of the session.
   */
  const { hologram, played } = await rig(['idle', 'nod']);
  await hologram.setIdle('idle');
  await settle();
  await hologram.setIdle(null);
  await settle();

  await hologram.play('nod');
  await settle();
  assert.deepEqual(played, ['idle', 'nod'], 'the gesture reached the screen');
});

test('losing the idle clip takes it off screen rather than looping a clip that is gone', async () => {
  const { hologram, videos } = await rig(['idle']);
  await hologram.setIdle('idle');
  await settle();
  assert.ok(onScreen(videos), 'she is animated');

  await hologram.setIdle(null);
  await settle();
  assert.equal(onScreen(videos), null, 'the photograph shows through again');
});

test('a gesture in progress is not interrupted; the next one waits for it', async () => {
  const { hologram, videos, played } = await rig(['idle', 'nod', 'wave']);
  await hologram.setIdle('idle');
  await settle();

  await hologram.play('nod');
  await settle();
  await hologram.play('wave');
  await settle();
  assert.deepEqual(played, ['idle', 'nod'], 'wave waits its turn');

  onScreen(videos)!.end();
  await settle();
  assert.deepEqual(played, ['idle', 'nod', 'wave']);
});

test('two directives in the same breath do not both drive the same element', async () => {
  /*
   * `[lean_in][nod]` is parsed with no gap between them, so both calls used to
   * pass the "is anything playing" check before either had recorded itself.
   * Both then loaded into the same back element and both flipped `#front`,
   * which left it pointing at the hidden video — after which every swap
   * reassigned `src` on the element that was on screen, reintroducing the
   * black frame that having two elements exists to prevent.
   */
  const { hologram, videos, played } = await rig(['idle', 'nod', 'wave']);
  await hologram.setIdle('idle');
  await settle();

  await Promise.all([hologram.play('nod'), hologram.play('wave')]);
  await settle();

  const visible = videos.filter((video) => !video.hidden);
  assert.equal(visible.length, 1, 'exactly one element is on screen');
  assert.equal(played[played.length - 1], 'wave', 'the later call supersedes the earlier');
  assert.equal(visible[0]!.loop, false, 'and a gesture does not loop');
  assert.equal(visible[0]!.paused, false, 'and is actually running');

  /*
   * The damage from the double flip showed on the *next* swap, not this one —
   * two flips still leave one element visible. So the check that matters is
   * that the element the next clip loads into is the hidden one.
   */
  visible[0]!.end();
  await settle();
  const nowVisible = videos.filter((video) => !video.hidden);
  assert.equal(nowVisible.length, 1);
  assert.equal(played[played.length - 1], 'idle');
  assert.notEqual(nowVisible[0], visible[0], 'the swap used the other element');
  assert.equal(nowVisible[0]!.loop, true, 'and idle loops');
});

test('a queued gesture that does not exist returns her to idle rather than freezing', async () => {
  // `play` is silent about a missing slot, which is right at the top of a turn
  // — the still is behind it. After a gesture has ended it is not: its last
  // frame is on screen, and without a fallback she holds it indefinitely.
  const { hologram, videos, played } = await rig(['idle', 'nod']);
  await hologram.setIdle('idle');
  await settle();

  await hologram.play('nod');
  await settle();
  await hologram.play('stretch'); // never rendered
  await settle();

  onScreen(videos)!.end();
  await settle();
  assert.equal(played[played.length - 1], 'idle');
});

test('a missing clip is asked for once, and again after the library changes', async () => {
  const { hologram, asked } = await rig(['idle']);
  await hologram.setIdle('idle');
  await settle();

  await hologram.play('wave');
  await hologram.play('wave');
  await settle();
  assert.deepEqual(asked.filter((slot) => slot === 'wave').length, 1);

  hologram.invalidate();
  await hologram.play('wave');
  await settle();
  assert.deepEqual(
    asked.filter((slot) => slot === 'wave').length,
    2,
    'a slot that was missing is tried again once a clip may have landed',
  );
});

test('barge-in during a gesture returns to idle and drops what was queued', async () => {
  const { hologram, played } = await rig(['idle', 'nod', 'wave']);
  await hologram.setIdle('idle');
  await settle();

  await hologram.play('nod');
  await settle();
  await hologram.play('wave');
  await settle();

  hologram.silence();
  await settle();
  assert.deepEqual(played, ['idle', 'nod', 'idle'], 'wave never happens');
});

test('barge-in while only the idle loop is running leaves it alone', async () => {
  const { hologram, played } = await rig(['idle']);
  await hologram.setIdle('idle');
  await settle();

  hologram.silence();
  await settle();
  assert.deepEqual(played, ['idle'], 'the loop is not restarted');
});

test('a slot the library does not hold is a no-op, without asking for it', async () => {
  const { hologram, played, asked } = await rig(['idle', 'nod']);
  hologram.setAvailable(['idle', 'nod']);
  await hologram.setIdle('idle');
  await settle();

  await hologram.play('tilt_head');
  await settle();
  assert.deepEqual(played, ['idle']);
  assert.ok(!asked.includes('tilt_head'), 'and no round trip was spent finding out');
});

test('a gesture with no clip does not displace one that has a clip', async () => {
  /*
   * Seen in a live run, and it cost a real gesture.
   *
   * `[concerned][nod] Yeah, you look it. [lean_in]` emits two gestures a
   * millisecond apart while a clip is still playing. `nod` had been rendered
   * and `lean_in` had not, but both reached the single queue slot in order, so
   * `lean_in` overwrote `nod` and the turn ended with nothing at all where it
   * could have had a nod.
   */
  const { hologram, videos, played } = await rig(['idle', 'nod', 'wave']);
  hologram.setAvailable(['idle', 'nod', 'wave']);
  await hologram.setIdle('idle');
  await settle();

  await hologram.play('wave');
  await settle();
  await hologram.play('nod');
  await hologram.play('lean_in'); // never rendered
  await settle();

  onScreen(videos)!.end();
  await settle();
  assert.deepEqual(played, ['idle', 'wave', 'nod'], 'the nod survived');
});

test('a clip that errors instead of ending does not wedge the queue', async () => {
  /*
   * `#next` is drained in one place and used to be reachable from one event.
   * A video that stops any other way — a decode failure, a blob URL revoked
   * out from under it — left `#playing` set forever, and every gesture after
   * that was filed behind a clip that was never going to finish. Same wedge as
   * the idle one, different door.
   */
  const { hologram, videos, played } = await rig(['idle', 'nod', 'wave']);
  await hologram.setIdle('idle');
  await settle();
  await hologram.play('nod');
  await settle();

  onScreen(videos)!.fail();
  await settle();
  assert.equal(played[played.length - 1], 'idle', 'she recovers to the loop');

  await hologram.play('wave');
  await settle();
  assert.equal(played[played.length - 1], 'wave', 'and gestures still work afterwards');
});

test('a gesture arriving as one ends does not cancel itself through the fallback', async () => {
  /*
   * `#playAfter` falls back to idle when the clip it was given turns out not to
   * exist. It used to detect that by asking whether `#playing` had changed —
   * which is also true when a *newer* directive superseded it, so the fallback
   * fired and its own return-to-idle then superseded the newer directive.
   * `[nod] … [wave]` with a `[bow]` a millisecond later lost both.
   */
  const { hologram, videos, played } = await rig(['idle', 'nod', 'wave', 'shrug']);
  await hologram.setIdle('idle');
  await settle();
  await hologram.play('nod');
  await settle();
  await hologram.play('wave'); // queued behind nod

  onScreen(videos)!.end(); // drains the queue: wave starts
  void hologram.play('shrug'); // and a fresh directive lands in the same tick
  await settle();

  assert.equal(played[played.length - 1], 'shrug', 'the newest gesture wins');
  assert.notEqual(played[played.length - 1], 'idle', 'and is not cancelled by the fallback');
});

test('barge-in stops a gesture that is still loading', async () => {
  // Without cancelling the in-flight start, a gesture that had not yet recorded
  // itself landed a moment after the user began speaking and played over them.
  const { hologram, played } = await rig(['idle', 'nod']);
  await hologram.setIdle('idle');
  await settle();

  void hologram.play('nod');
  hologram.silence();
  await settle();
  assert.deepEqual(played, ['idle'], 'the gesture never reaches the screen');
});

test('barge-in stops the clip on screen rather than waiting for its replacement', async () => {
  const { hologram, videos, played } = await rig(['idle', 'nod']);
  await hologram.setIdle('idle');
  await settle();
  await hologram.play('nod');
  await settle();
  const gesture = onScreen(videos)!;

  hologram.silence();
  assert.equal(gesture.paused, true, 'stopped now, not when idle has decoded');
  await settle();
  assert.equal(played[played.length - 1], 'idle');
});

test('a library change does not revoke the clip that is playing', async () => {
  // invalidate() revoked every cached URL, including the one the visible
  // element was sourced from and the one a load in progress had just been
  // handed. The second is the reliably bad case: no error fires, the element
  // simply never loads, and the wait times out silently.
  const revoked: string[] = [];
  (globalThis as Record<string, unknown>)['URL'] = {
    createObjectURL: (() => {
      let n = 0;
      return () => `blob:fake/${(n += 1)}`;
    })(),
    revokeObjectURL: (url: string) => revoked.push(url),
  };

  const { hologram, videos, played } = await rig(['idle', 'nod']);
  await hologram.setIdle('idle');
  await settle();
  const playing = onScreen(videos)!.src;

  hologram.invalidate();
  assert.ok(!revoked.includes(playing), 'the clip on screen keeps its source');

  await hologram.play('nod');
  await settle();
  assert.equal(played[played.length - 1], 'nod');
});

test('she is only "animated" when something is actually on screen', async () => {
  // `#idle` being set says a slot was named, not that its clip exists.
  const { hologram } = await rig([]);
  await hologram.setIdle('idle');
  await settle();
  assert.equal(hologram.animated, false, 'a named slot with no clip is a photograph');
});

test('disposing while a clip is loading does not put it on screen afterwards', async () => {
  // `#disposed` is checked at every await, but a `#start` between its last
  // check and its assignment to `#front` would still land. The generation bump
  // covers that gap.
  const { hologram, videos, played } = await rig(['idle', 'nod']);
  await hologram.setIdle('idle');
  await settle();

  void hologram.play('nod');
  hologram.dispose();
  await settle();

  assert.deepEqual(played, ['idle'], 'nothing reached the screen after dispose');
  assert.ok(
    videos.every((video) => video.paused),
    'and nothing is still running',
  );
});
