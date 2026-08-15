/**
 * The field's height.
 *
 * Split out of main.ts so the screenshot harness can call the same function the
 * app does. The harness exists to be judged in place of a window that refuses
 * to be photographed, and that only works if it is running this code rather
 * than a copy of it — a copy is a thing that drifts, and the drift shows up as
 * a critic signing off on geometry the app does not have.
 */

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
  input.style.height = `${(PAD + lines * LINE) * s}px`;

  document.documentElement.style.setProperty(
    '--composer-h',
    `${composer.getBoundingClientRect().height}px`,
  );
}
