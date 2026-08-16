/**
 * Which library the window is showing, and which one it is measuring.
 *
 * Both failures here are silent. A photograph swapped for another one whose
 * library also holds an `idle` clip left the *previous* person's clip looping
 * over the new face, because `setIdle` is asked for a slot name and the name
 * had not changed. And a verification pass had no identity at all, so a swap
 * partway through left it measuring the new library's clips against a frame
 * decoded from the old one's, and writing the results into the new one's
 * manifest — where a wrong verdict costs a re-render to clear.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LibraryPresenter, type PresenterDeps } from './library-view.ts';
import type { LibraryView } from '../../shared/protocol.ts';

function view(portrait: string, extra: Partial<LibraryView> = {}): LibraryView {
  return {
    portrait,
    ready: ['idle'],
    building: null,
    failed: [],
    unverified: [],
    total: 19,
    alive: true,
    spentUsd: 0,
    ...extra,
  };
}

interface Rig {
  presenter: LibraryPresenter;
  idles: Array<string | null>;
  passes: Array<{ slots: readonly string[]; abandoned: () => boolean; finish: () => void }>;
}

function rig(overrides: Partial<PresenterDeps> = {}): Rig {
  const idles: Array<string | null> = [];
  const passes: Rig['passes'] = [];
  const presenter = new LibraryPresenter({
    hologram: {
      invalidate: () => {},
      setAvailable: () => {},
      setIdle: async (slot) => {
        idles.push(slot);
      },
    },
    // Held open until the test says so, which is the only way to be inside a
    // pass when the photograph changes.
    verify: (slots, abandoned) =>
      new Promise<void>((resolve) => {
        passes.push({ slots, abandoned, finish: resolve });
      }),
    status: async () => view('b', { unverified: ['nod'] }),
    alive: () => {},
    ...overrides,
  });
  return { presenter, idles, passes };
}

test('a new photograph takes the previous one off the screen before starting its own', async () => {
  const { presenter, idles } = rig();

  await presenter.apply(view('a'));
  assert.deepEqual(idles, ['idle']);

  await presenter.apply(view('b'));
  assert.deepEqual(
    idles,
    ['idle', null, 'idle'],
    'the old clip is retracted rather than left looping under the same slot name',
  );
});

test('the same library twice does not retract anything', async () => {
  // `apply` runs on every library event and a build emits several in a row.
  // Retracting on each would restart the loop from frame 0 every time.
  const { presenter, idles } = rig();
  await presenter.apply(view('a'));
  await presenter.apply(view('a', { ready: ['idle', 'nod'] }));
  assert.deepEqual(idles, ['idle', 'idle']);
});

test('one verification pass at a time', async () => {
  const { presenter, passes } = rig();
  await presenter.apply(view('a', { unverified: ['idle', 'nod'] }));
  await presenter.apply(view('a', { unverified: ['idle', 'nod'] }));
  assert.equal(passes.length, 1);
});

test('a pass is told to abandon itself when the photograph changes', async () => {
  const { presenter, passes } = rig();
  await presenter.apply(view('a', { unverified: ['idle', 'nod'] }));
  assert.equal(passes.length, 1);
  assert.equal(passes[0]!.abandoned(), false);

  await presenter.apply(view('b'));
  assert.equal(passes[0]!.abandoned(), true, 'the pass is measuring a library nobody is showing');
});

test('the library that displaced a pass is measured once that pass lets go', async () => {
  /*
   * The gap the guard leaves. The event that would have started a pass for the
   * new library arrives while the old pass is still running and is swallowed;
   * nothing emits it again, so without asking, a swapped-in library stays
   * unmeasured until something else happens to change it.
   */
  const { presenter, passes } = rig();
  await presenter.apply(view('a', { unverified: ['idle'] }));
  await presenter.apply(view('b', { unverified: ['nod'] }));
  assert.equal(passes.length, 1, 'nothing new starts while the first is running');

  passes[0]!.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passes.length, 2);
  assert.deepEqual(passes[1]!.slots, ['nod']);
});

test('a library with nothing unverified starts no pass', async () => {
  const { presenter, passes } = rig();
  await presenter.apply(view('a'));
  assert.equal(passes.length, 0);
});
