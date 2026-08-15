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
import { Microphone } from './audio/microphone.ts';
import { Vision } from './senses/vision.ts';

declare global {
  interface Window {
    anna: import('../preload/index.ts').AnnaApi;
  }
}

const wellEl = document.querySelector<HTMLDivElement>('#well')!;
const subtitleEl = document.querySelector<HTMLDivElement>('#subtitle')!;
const composerEl = document.querySelector<HTMLDivElement>('#composer')!;
const inputEl = document.querySelector<HTMLInputElement>('#say')!;
const troubleEl = document.querySelector<HTMLDivElement>('#trouble')!;
const appEl = document.querySelector<HTMLDivElement>('#app')!;

window.addEventListener('error', (event) =>
  window.anna.report('error-uncaught', { message: String(event.message).slice(0, 200) }),
);
window.addEventListener('unhandledrejection', (event) =>
  window.anna.report('error-rejection', { message: String(event.reason).slice(0, 200) }),
);
const player = new SpeechPlayer();

const hologram = new Hologram({
  mount: wellEl,
  loadClip: (slot) => window.anna.getClip(slot),
  report: (event, detail) => window.anna.report(event, detail),
});

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
  await fitPanelTo(hologram.shape);
  await applyLibrary(await window.anna.libraryStatus());
}

/**
 * Sizes the panel so the well is exactly the photograph's shape.
 *
 * The window height is asked for rather than the well being constrained, and
 * the difference matters. Putting an `aspect-ratio` on the well makes the well
 * the right shape inside a panel that is still the wrong height — which is what
 * a 1024x1024 portrait in a 420x680 frame looked like: a square photograph
 * sitting above 260px of empty bezel.
 *
 * The chrome — bezel padding, the gap, the composer — is *measured* rather than
 * written down, because all of it lives in CSS and any of it can change. The
 * difference between the panel's height and the well's is exactly that chrome,
 * whatever it currently happens to be.
 */
function fitPanelTo(shape: { width: number; height: number } | null): void {
  if (!shape || shape.height === 0) return;

  const chrome = appEl.clientHeight - wellEl.clientHeight;
  const wanted = (wellEl.clientWidth * shape.height) / shape.width;
  window.anna.fitHeight(chrome + wanted);
}

async function applyLibrary(view: LibraryView): Promise<void> {
  // The cache has to be dropped before idle is re-checked: this module records
  // which slots are missing so it stops asking, and the whole point of this
  // call is that one of them may have just stopped being missing.
  hologram.invalidate();
  await hologram.setIdle(view.ready.includes('idle') ? 'idle' : null);
  document.body.dataset['alive'] = String(view.alive);
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

let subtitleTimer: number | undefined;

function perform(event: PerformanceEvent): void {
  switch (event.kind) {
    case 'say':
      showSubtitle(event.text);
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
      scheduleSubtitleFade(2600);
      break;
    case 'barge-in':
      player.stop();
      hologram.silence();
      scheduleSubtitleFade(0);
      break;
  }
}

function showSubtitle(text: string): void {
  window.clearTimeout(subtitleTimer);
  subtitleEl.textContent = text;
  subtitleEl.dataset['visible'] = 'true';
}

function scheduleSubtitleFade(afterMs: number): void {
  window.clearTimeout(subtitleTimer);
  subtitleTimer = window.setTimeout(() => {
    subtitleEl.dataset['visible'] = 'false';
  }, afterMs);
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

inputEl.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
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
// The two buttons
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

document
  .querySelector<HTMLButtonElement>('#settings')!
  .addEventListener('click', () => window.anna.openSettings());

/** How long the leaving animation runs before the window is actually hidden. */
const LEAVE_MS = 240;

document.querySelector<HTMLButtonElement>('#dismiss')!.addEventListener('click', () => {
  // Fade first, hide once it finishes, so she leaves rather than blinking out.
  appEl.dataset['leaving'] = 'true';
  player.stop();
  hologram.silence();
  window.setTimeout(() => window.anna.hide(), LEAVE_MS);
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
    // Echo the scripted line in the composer so a viewer can see both halves
    // of the conversation, not just her side of it.
    inputEl.value = text;
    composerEl.dataset['visible'] = 'true';
    window.setTimeout(() => {
      inputEl.value = '';
    }, 2000);
  });
  window.anna.onVisibility((visible) => {
    // Clear the fade when she is brought back, or the window would reappear
    // still transparent and untouchable.
    if (visible) delete appEl.dataset['leaving'];

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
