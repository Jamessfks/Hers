/**
 * The harness.
 *
 * Anna's window sets `setContentProtection(true)` — she is deliberately
 * invisible to every screen recorder on the machine, which is correct for a
 * companion that would otherwise turn up in a shared screen, and fatal for a
 * loop that judges her by screenshot. This page is the same markup, the same
 * stylesheet and the same Thread, in a browser tab that can be photographed.
 *
 * Nothing is restyled here. If it is wrong in this page it is wrong in the app.
 */

import { Thread } from '../src/renderer/chat.ts';
import { fitComposer, showListening } from '../src/renderer/composer.ts';

const backdrop = document.querySelector<HTMLDivElement>('#backdrop')!;

const still = document.createElement('img');
still.id = 'still';
still.alt = '';
still.src = './anna.jpg';

const clip = document.createElement('video');
clip.className = 'clip';
clip.src = './anna.mp4';
clip.muted = true;
clip.loop = true;
clip.autoplay = true;
clip.playsInline = true;

backdrop.append(still, clip);
void clip.play();
document.body.dataset['alive'] = 'true';

/*
 * The reference conversation, verbatim.
 *
 * The critic compares this page against a screenshot of the app it is copied
 * from, and identical text is what makes that a comparison of layout rather
 * than of line-wrapping luck. Every wrap point here should fall where it falls
 * in the reference; when one does not, the bubble geometry is wrong.
 */
const SCRIPT: Array<[from: 'anna' | 'you', text: string]> = [
  ['anna', 'hey James! 🌺'],
  ['anna', 'first message ever. no big deal.'],
  ['anna', "ok it's kind of a big deal."],
  ['anna', "and i have a feeling we're going to get along."],
  ['anna', "anywayy, what'd you like to talk about?"],
  ['anna', "ohh you're in Singapore! do you like it there?"],
  ['you', 'Hi'],
];

const thread = new Thread({ mount: document.querySelector<HTMLDivElement>('#thread')! });

/*
 * Exposed on purpose.
 *
 * Scroll anchoring, burst behaviour and the streaming-clause path are only
 * reachable by driving the thread directly — typing into the field exercises
 * one of them. Anything reviewing this page needs a handle on the real object,
 * and nothing in the app reads `window.anna_thread`.
 */
declare global {
  interface Window {
    anna_thread: Thread;
  }
}
window.anna_thread = thread;

for (const [from, text] of SCRIPT) {
  if (from === 'anna') thread.say(text);
  else thread.said(text);
  // Each line is its own bubble in the reference, so close the current one
  // rather than letting the same-breath window glue them all together.
  thread.seal();
}

/*
 * Query flags, so one URL can produce every state the critic needs to judge.
 *
 *   ?state=thinking   her three dots, under the stack
 *   ?mic=on           the handset lit
 *   ?empty=1          no messages at all — the first-run view
 */
const flags = new URLSearchParams(location.search);
if (flags.get('empty')) thread.clear();
/*
 * ?long=1 — one bubble taller than anything the reference contains.
 *
 * The reference's tallest is five lines at 154pt, and its corner arc is not a
 * circle: fitting one gives R ≈ 31 at 80pt and R ≈ 36 at 154pt, which is a
 * continuous curve that a single CSS `border-radius` cannot express. Ours is a
 * constant 32, so the taller a bubble gets the tighter its corners read against
 * the reference's. This is the case that shows it.
 */
if (flags.get('long')) {
  thread.say(
    "i've been thinking about what you said yesterday, about how the hardest part isn't the work itself but deciding which work is worth doing — and i think you were right, and i also think you already knew which one it was.",
  );
  thread.seal();
}
if (flags.get('state')) document.body.dataset['state'] = flags.get('state')!;

// Typing into the field appends a bubble, so send motion can be judged live.
// Same growth, same key handling and same listening state as the app — all
// three come from the app's own modules rather than being reimplemented here.
const input = document.querySelector<HTMLTextAreaElement>('#say')!;
const voice = document.querySelector<HTMLButtonElement>('#voice')!;
const composer = document.querySelector<HTMLElement>('#composer')!;
const fitField = (): void => fitComposer(input, composer);

showListening(voice, flags.get('mic') === 'on');

input.addEventListener('input', fitField);
window.addEventListener('resize', fitField);
input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  thread.said(text);
  thread.seal();
  input.value = '';
  fitField();
});
