/**
 * The field's height.
 *
 * Split out of main.ts so the screenshot harness can call the same function the
 * app does. The harness exists to be judged in place of a window that refuses
 * to be photographed, and that only works if it is running this code rather
 * than a copy of it — a copy is a thing that drifts, and the drift shows up as
 * a critic signing off on geometry the app does not have.
 */

/**
 * Shows whether Anna is listening, on the handset in the composer.
 *
 * Lives here rather than in main.ts so the harness drives the real thing. It
 * was setting `data-on` by hand, which meant the page used to review this
 * carried a green button with `aria-pressed` unset and a label still reading
 * "Talk to her" — the accessibility half of the state was never once looked at,
 * because the only place it existed was the one file the harness did not run.
 *
 * The colour is not the whole signal. A green handset is the universal *place a
 * call* affordance, so on its own it reads as an invitation to start rather
 * than as a microphone that is already open, and a dead microphone and a live
 * one are then distinguishable only by hue. The pulse in `styles.css` says
 * "now"; this says it to a screen reader.
 */
export function showListening(voice: HTMLElement, on: boolean): void {
  voice.dataset['on'] = String(on);
  voice.setAttribute('aria-pressed', String(on));
  voice.setAttribute('aria-label', on ? 'Stop listening' : 'Listen');
  voice.title = on ? 'She is listening — click to stop' : 'Let her hear you';
}

/** Line height of the field, in reference points. Matches `#say` in styles.css. */
const LINE = 23;
/** Its block padding, top plus bottom. Also from `#say`. */
const PAD = 23;
/**
 * How tall it is allowed to get.
 *
 * Five lines is where every messaging app this is drawn from stops growing and
 * starts scrolling. An uncapped composer eventually eats the conversation it
 * belongs to.
 */
const MAX_LINES = 5;

/**
 * Grows the field to fit its content and publishes the row's height.
 *
 * The height is snapped to whole lines rather than taken from `scrollHeight`
 * directly, and that is not tidiness. `scrollHeight` is an integer number of
 * CSS pixels and rounds *up*, so at one line it reports about half a point more
 * than the field actually needs: the first keystroke bumped the field from 50
 * to 50.5, the thread gave up half a point to match, and neither came back when
 * the field was cleared. Every subsequent edit could only ratchet it further.
 * Rounding to the nearest line makes the height a function of the content
 * rather than of its own history.
 */
export function fitComposer(input: HTMLTextAreaElement, composer: HTMLElement): void {
  const s = Math.min(window.innerWidth / 393, window.innerHeight / 852);

  // Collapse first, or `scrollHeight` reports the tallest the box has ever been
  // and the field can never shrink.
  input.style.height = 'auto';
  const content = input.scrollHeight - PAD * s;
  const lines = Math.min(MAX_LINES, Math.max(1, Math.round(content / (LINE * s))));

  /*
   * One line hands the height back to the stylesheet rather than computing it.
   *
   * `(PAD + LINE) * s` is the same number `calc(46 * var(--s))` resolves to in
   * exact arithmetic and not the same number after it has been through a
   * JavaScript float, a `px` string and the engine's own rounding — the field
   * came to rest half a point taller than it started, every time, and stayed
   * there. The empty composer is the state the user sees most, so it is the one
   * that should be exactly right.
   */
  if (lines === 1) input.style.height = '';
  else input.style.height = `${(PAD + lines * LINE) * s}px`;

  document.documentElement.style.setProperty(
    '--composer-h',
    `${composer.getBoundingClientRect().height}px`,
  );
}
