/**
 * The body's entry point.
 *
 * This process draws Anna, plays her voice, and reports what the camera and
 * microphone picked up. It holds no keys, touches no disk, and makes no network
 * calls of its own — every provider request happens in main. See
 * docs/ARCHITECTURE.md for why the line is drawn there.
 */

import type { AnnaConfig, LibraryView, PerformanceEvent } from '../shared/protocol.ts';
import { SpeechPlayer } from './audio/player.ts';
import { Hologram } from './avatar/hologram.ts';
import { LibraryPresenter } from './avatar/library-view.ts';
import { verifyPending } from './avatar/verify.ts';
import { Thread } from './chat.ts';
import { fitComposer, showListening } from './composer.ts';
import { Microphone } from './audio/microphone.ts';
import { Vision } from './senses/vision.ts';

declare global {
  interface Window {
    anna: import('../preload/index.ts').AnnaApi;
  }
}

const backdropEl = document.querySelector<HTMLDivElement>('#backdrop')!;
const threadEl = document.querySelector<HTMLDivElement>('#thread')!;
const inputEl = document.querySelector<HTMLTextAreaElement>('#say')!;
const composerEl = document.querySelector<HTMLElement>('#composer')!;
const voiceEl = document.querySelector<HTMLButtonElement>('#voice')!;
const troubleEl = document.querySelector<HTMLDivElement>('#trouble')!;

window.addEventListener('error', (event) =>
  window.anna.report('error-uncaught', { message: String(event.message).slice(0, 200) }),
);
window.addEventListener('unhandledrejection', (event) =>
  window.anna.report('error-rejection', { message: String(event.reason).slice(0, 200) }),
);
const player = new SpeechPlayer();

const hologram = new Hologram({
  mount: backdropEl,
  loadClip: (slot) => window.anna.getClip(slot),
  report: (event, detail) => window.anna.report(event, detail),
});

const thread = new Thread({ mount: threadEl });

let config: AnnaConfig | null = null;

// ---------------------------------------------------------------------------
// The photograph
// ---------------------------------------------------------------------------

/**
 * Shows whichever photograph main is holding, and whatever clips exist for it.
 *
 * Called at boot and again whenever the library changes, because the two
 * interesting moments — a photograph being chosen, and the first clip finishing
 * — both happen while the window is already open. Reloading the app to see your
 * own avatar appear would be a strange thing to ask.
 */
async function showAvatar(): Promise<void> {
  const bytes = await window.anna.getPortrait();
  if (!bytes) {
    void hologram.setPortrait(null);
    showTrouble('Drop a photo onto this window to give Anna a face.');
    return;
  }

  await hologram.setPortrait(URL.createObjectURL(new Blob([bytes as BlobPart])));
  hideTrouble();
  await applyLibrary(await window.anna.libraryStatus());
}

/*
 * The window no longer follows the photograph.
 *
 * `fitPanelTo` used to measure her frame and ask main for a matching height, so
 * the well was exactly her shape and nothing letterboxed. That was the correct
 * answer to `object-fit: contain`, and it is the wrong one for a conversation:
 * the window's proportions are now the thread's — tall, phone-shaped, fixed —
 * and the clip fills it by cropping instead. A window that resized itself every
 * time the avatar changed would also mean the whole layout reflowed underneath
 * a live conversation, which is precisely the kind of motion this design is
 * trying not to have. `window.anna.fitHeight` is left in the bridge; nothing
 * calls it.
 */

/**
 * Everything that happens when the library changes, and the identity it
 * happens for. See library-view.ts for why that is not written here.
 */
const presenter = new LibraryPresenter({
  hologram,
  status: () => window.anna.libraryStatus(),
  alive: (alive) => {
    document.body.dataset['alive'] = String(alive);
  },
  verify: (slots, abandoned) =>
    verifyPending(slots, {
      loadClip: (slot) => window.anna.getClip(slot),
      sourceFrame: (width, height) => hologram.sourceFrame(width, height),
      report: (slot, seam) => window.anna.reportSeam(slot, seam),
      note: (event, detail) => window.anna.report(event, detail),
      abandoned,
    }),
});

function applyLibrary(view: LibraryView): Promise<void> {
  return presenter.apply(view);
}

/*
 * Dropping a photo on the window is the whole setup flow for the avatar.
 *
 * The extension is not checked here. It was, and the first real photograph
 * handed to this app is named `.png` and contains JPEG — main sniffs the bytes
 * and is the only thing entitled to an opinion.
 */
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;

  const saved = await window.anna.setPortrait(new Uint8Array(await file.arrayBuffer()));
  if ('error' in saved) {
    showTrouble(saved.error);
    return;
  }
  await showAvatar();
  if (saved.note) showTrouble(saved.note);
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

function perform(event: PerformanceEvent): void {
  switch (event.kind) {
    case 'say':
      thread.say(event.text);
      break;
    case 'gesture':
      // Intensity is dropped. A generated clip has one performance baked into
      // it; there is no dial. Pretending otherwise by, say, scaling playback
      // rate would just make her move at the wrong speed.
      void hologram.play(event.name);
      break;
    case 'expression':
    case 'gaze':
      // Both were rig controls. A photograph looks where it looks, and its
      // expression is whichever clip is playing.
      break;
    case 'turn-end':
      // Close the bubble she is mid-sentence in, so her next turn starts a new
      // one rather than being glued onto the end of this one.
      thread.seal();
      break;
    case 'barge-in':
      player.stop();
      hologram.silence();
      thread.seal();
      break;
  }
}

function showTrouble(message: string): void {
  troubleEl.textContent = message;
  troubleEl.hidden = false;
}

function hideTrouble(): void {
  troubleEl.hidden = true;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/*
 * The panel is always interactive, so there is no pointer tracking any more.
 *
 * The old version hit-tested the pointer against a guess at her silhouette on
 * every mousemove, to decide whether the window should swallow the click —
 * necessary when a transparent window covered half the screen, and pure
 * complexity now that she lives in a bounded panel.
 */

const fitField = (): void => fitComposer(inputEl, composerEl);

inputEl.addEventListener('input', fitField);
// The field is sized in reference points, so it has to be re-snapped whenever
// the window changes what a reference point is worth.
window.addEventListener('resize', fitField);

inputEl.addEventListener('keydown', async (event) => {
  // Shift+Enter is a newline; Enter alone sends. The other way round — a send
  // button and Enter for newline — is a chat app pretending to be a form.
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  fitField();
  // The bubble goes up before the send, not after an acknowledgement. A message
  // that waits for the brain to admit it exists is the single most common way a
  // chat UI feels slow, and this one has an LLM on the other end of it.
  thread.said(text);
  await player.resume();
  window.anna.sense({ kind: 'user-typed', text, at: Date.now() });
});

/*
 * There is no frame loop any more.
 *
 * The VRM renderer ran `requestAnimationFrame` forever: it composited an idle
 * layer, a gesture layer and a speech layer into a skeleton, then drew a WebGL
 * frame, sixty times a second, whether or not anything had changed. A video
 * element decodes itself. The panel now costs nothing when she is still, which
 * for something left running all day is the difference that matters.
 */

// ---------------------------------------------------------------------------
// The four buttons
// ---------------------------------------------------------------------------

/*
 * These were lost once already.
 *
 * They used to sit inside the block that did click-through hit-testing, and
 * when that block was deleted — correctly, since a bounded panel is always
 * interactive — both handlers went with it. Nothing failed: the buttons still
 * rendered, still highlighted on hover, and did nothing at all when clicked.
 * They live in their own section now so the next deletion has to be deliberate.
 */

/*
 * Her name and the gear both open Settings, and that is not an oversight.
 *
 * Everything the name pill implies you can change about her — what she is
 * called, her voice, her model, what she remembers — is on that one window.
 * Splitting it into a profile sheet and a preferences sheet would be two
 * screens for one page of content.
 */
for (const id of ['#who', '#settings']) {
  document
    .querySelector<HTMLButtonElement>(id)!
    .addEventListener('click', () => window.anna.openSettings());
}

/*
 * `+` is where you change her face.
 *
 * Dropping a photograph on the window still works and is still the fastest
 * path, but it is undiscoverable — nothing on screen says the window accepts a
 * file. This is the same operation with a native picker in front of it.
 */
document.querySelector<HTMLButtonElement>('#plus')!.addEventListener('click', async () => {
  const picked = await window.anna.pickPortrait();
  if (!picked) return; // Cancelled.
  if ('error' in picked) {
    showTrouble(picked.error);
    return;
  }
  await showAvatar();
  if (picked.note) showTrouble(picked.note);
});

/*
 * The handset toggles her microphone.
 *
 * In the app this layout comes from that button starts a voice call, which is a
 * mode this app does not have and does not need — Anna is always listening when
 * the microphone is on, so "call" and "hang up" are just that switch. The
 * button carries the state so it is a control rather than a decoration.
 */
voiceEl.addEventListener('click', async () => {
  if (!config) return;
  const next = await window.anna.setConfig({ senses: { microphone: !config.senses.microphone } });
  config = next;
  showListening(voiceEl, next.senses.microphone);
});

/*
 * Keyboard focus is only drawn for people using a keyboard.
 *
 * The four round controls use `:focus-visible`, which is exactly right for
 * them. A text field is the exception: it matches `:focus-visible` when it is
 * clicked as well as when it is tabbed to, so gating the composer's ring on
 * that alone would ring it on every click into the box. Tracking whether the
 * last input was a Tab is the only way to give a keyboard user the same ring on
 * all five and a mouse user none — and without it they get four rings and then
 * nothing on the one control they were heading for.
 */
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Tab') document.body.dataset['kbd'] = 'true';
  },
  { capture: true },
);
window.addEventListener('pointerdown', () => delete document.body.dataset['kbd'], {
  capture: true,
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  config = await window.anna.getConfig();

  window.anna.onPerform(perform);
  window.anna.onAudio((message) => {
    if (message.pcm) player.enqueue(new Float32Array(message.pcm), message.sampleRate);
  });
  window.anna.onState((state) => {
    document.body.dataset['state'] = state;
  });
  window.anna.onTrouble(showTrouble);
  window.anna.onDemoSaid((text) => {
    // Put the scripted line in the thread as though the viewer typed it, so a
    // demo shows both halves of the conversation rather than only her side.
    thread.said(text);
  });

  // Spoken input, once main has transcribed it. The typed path adds its own
  // bubble immediately; this is the other half of the same job.
  window.anna.onHeard((text) => thread.said(text));
  window.anna.onVisibility((visible) => {
    /*
     * Release the camera while she is away.
     *
     * Dismissing her used to leave the green light on and frames flowing, which
     * is the single worst thing this app could do: the user has explicitly sent
     * her away and the camera stays on. Main also refuses the paid call in that
     * state, but the light is the part that matters.
     */
    if (!visible) vision.stop();
    else if (config?.senses.camera) void vision.start();
  });

  window.anna.onLibrary((view) => void applyLibrary(view));
  await showAvatar();

  const microphone = new Microphone({
    onUtterance: (audio, mimeType) =>
      window.anna.sense({ kind: 'user-audio', audio, mimeType, at: Date.now() }),
    // Reported once speech is confirmed rather than on the first loud sample,
    // so a keystroke or a chair does not cut her off with nothing following.
    onSpeechStarted: () =>
      window.anna.sense({ kind: 'user-speech', text: '', final: false, at: Date.now() }),
    isSelfSpeaking: () => player.speaking,
  });

  const vision = new Vision({
    intervalSeconds: config.senses.cameraIntervalSeconds,
    onFrame: (jpegBase64) =>
      window.anna.sense({ kind: 'camera-frame', jpegBase64, at: Date.now() }),
  });

  /**
   * Start and stop the sensors to match the settings, now and whenever they
   * change.
   *
   * These used to be started once at boot and never revisited, so turning the
   * camera on mid-session did nothing until a relaunch — and turning it *off*
   * left the green light on and frames flowing over IPC, with the main process
   * quietly discarding them. For a permission the user just revoked, that is
   * the worst possible behaviour.
   */
  async function applySenses(next: AnnaConfig): Promise<void> {
    showListening(voiceEl, next.senses.microphone);

    try {
      if (next.senses.microphone) await microphone.start();
      else microphone.stop();
    } catch (error) {
      showTrouble(error instanceof Error ? error.message : 'The microphone would not start.');
    }

    try {
      vision.setInterval(next.senses.cameraIntervalSeconds);
      if (next.senses.camera) await vision.start();
      else vision.stop();
    } catch (error) {
      showTrouble(error instanceof Error ? error.message : 'The camera would not start.');
    }
  }

  window.anna.onCameraCapture(() => vision.captureNow());

  window.anna.onConfigChanged((next) => {
    config = next;
    void applySenses(next);
  });

  /*
   * The sensors start last, and are never awaited.
   *
   * This ordering is not a preference, it is a bug fix that outlived the code it
   * was written for. `getUserMedia` blocks while macOS shows its permission
   * prompt — and if the user never answers, or the prompt is suppressed, the
   * promise simply never settles. With the avatar behind that await, Anna's
   * panel drew its frame and then stayed completely empty, with no error to
   * explain it, and only filled in once the camera was switched on: exactly when
   * it is hardest to attribute.
   *
   * Her body has nothing to do with the sensors. It should be on screen the
   * instant it can be, which is why `showAvatar()` is above and this is here.
   */
  void applySenses(config);
}

void boot();
