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

/** Lets every queued microtask and timer-free continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

interface Rig {
  hologram: import('./hologram.ts').Hologram;
  videos: FakeVideo[];
  played: string[];
  asked: string[];
}

async function rig(present: readonly string[]): Promise<Rig> {
  const { Hologram } = await import('./hologram.ts');
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
    videos: created.filter((element): element is FakeVideo => element instanceof FakeVideo),
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

  assert.equal(played.length, 2, 'one of the two won outright');
  const visible = videos.filter((video) => !video.hidden);
  assert.equal(visible.length, 1, 'exactly one element is on screen');
  assert.equal(visible[0]!.src, videos.find((v) => !v.hidden)!.src);

  // And the machine is still usable afterwards: the winner ends, and idle
  // comes back rather than the state being wedged.
  visible[0]!.end();
  await settle();
  assert.equal(played[played.length - 1], 'idle');
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
