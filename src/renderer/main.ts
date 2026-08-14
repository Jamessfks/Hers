/**
 * The body's entry point.
 *
 * This process draws Anna, plays her voice, and reports what the camera and
 * microphone picked up. It holds no keys, touches no disk, and makes no network
 * calls of its own — every provider request happens in main. See
 * docs/ARCHITECTURE.md for why the line is drawn there.
 */

import type { AnnaConfig, PerformanceEvent } from '../shared/protocol.ts';
import { Body } from './avatar/body.ts';
import { SpeechPlayer } from './audio/player.ts';
import { createPlaceholder, type Placeholder } from './avatar/placeholder.ts';
import { createStage, frameFullBody, frameHeight, loadVrm } from './avatar/stage.ts';
import { Microphone } from './audio/microphone.ts';
import { Vision } from './senses/vision.ts';

declare global {
  interface Window {
    anna: import('../preload/index.ts').AnnaApi;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const subtitleEl = document.querySelector<HTMLDivElement>('#subtitle')!;
const composerEl = document.querySelector<HTMLDivElement>('#composer')!;
const inputEl = document.querySelector<HTMLInputElement>('#say')!;
const troubleEl = document.querySelector<HTMLDivElement>('#trouble')!;
const appEl = document.querySelector<HTMLDivElement>('#app')!;

const stage = createStage(canvas);
window.addEventListener('error', (event) =>
  window.anna.report('error-uncaught', { message: String(event.message).slice(0, 200) }),
);
window.addEventListener('unhandledrejection', (event) =>
  window.anna.report('error-rejection', { message: String(event.reason).slice(0, 200) }),
);
const player = new SpeechPlayer();

let body: Body | null = null;
let placeholder: Placeholder | null = null;
let config: AnnaConfig | null = null;

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

async function loadCharacter(path: string): Promise<void> {
  if (!path) {
    placeholder = createPlaceholder(stage.scene);
    frameHeight(stage.camera, placeholder.height);
    showTrouble('Drop a .vrm character onto this window to give Anna a body.');
    return;
  }
  try {
    window.anna.report('character-loading', { bytes: path.length });
    const vrm = await loadVrm(path);
    stage.scene.add(vrm.scene);
    // World matrices are stale until the scene is updated, and frameFullBody
    // measures the head's world position — without this it can measure zero and
    // put the camera inside her.
    vrm.scene.updateWorldMatrix(true, true);
    frameFullBody(stage.camera, vrm);
    body = new Body(vrm);
    body.setViewer(stage.camera.position);
    body.setExpression('warm', 0.6);
    placeholder?.dispose();
    placeholder = null;
    hideTrouble();
    window.anna.report('character-ready', {
      meta: vrm.meta?.metaVersion ?? '?',
      cameraZ: Math.round(stage.camera.position.z * 100) / 100,
    });
  } catch (error) {
    placeholder = createPlaceholder(stage.scene);
    frameHeight(stage.camera, placeholder.height);
    const message = error instanceof Error ? error.message : 'That character would not load.';
    window.anna.report('error-character', { message: message.slice(0, 200) });
    showTrouble(message);
  }
}

// Dropping a .vrm on the window is the whole setup flow for the avatar.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file || !file.name.toLowerCase().endsWith('.vrm')) return;

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Show it immediately from a blob URL, then hand the bytes to main to be
  // stored. A blob URL cannot be persisted — it dies with the window — so the
  // config records the id main gives back, not the URL.
  await loadCharacter(URL.createObjectURL(new Blob([bytes as BlobPart])));

  const saved = await window.anna.saveCharacter(file.name, bytes);
  if ('error' in saved) {
    showTrouble(`She is wearing that for now, but I could not save it: ${saved.error}`);
    return;
  }
  await window.anna.setConfig({ avatar: { modelPath: saved.id } });
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
      body?.playGesture(event.name, event.intensity ?? 1);
      break;
    case 'expression':
      body?.setExpression(event.name, event.weight ?? 1);
      break;
    case 'gaze':
      body?.setGaze(event.target);
      break;
    case 'turn-end':
      scheduleSubtitleFade(2600);
      break;
    case 'barge-in':
      player.stop();
      body?.silence();
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

inputEl.addEventListener('focus', () => body?.setAttention('listening'));
inputEl.addEventListener('input', () => body?.setAttention('listening'));

inputEl.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  await player.resume();
  window.anna.sense({ kind: 'user-typed', text, at: Date.now() });
});

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let previous = performance.now();

function frame(now: number): void {
  const delta = Math.min(0.1, (now - previous) / 1000);
  previous = now;

  const energy = player.energy();
  body?.setSpeechEnergy(energy, player.viseme());
  body?.update(delta);
  placeholder?.update(delta, energy);

  stage.renderer.render(stage.scene, stage.camera);
  requestAnimationFrame(frame);
}

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
  body?.silence();
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
    // This is the line that makes her react to *you* rather than only to
    // herself: listening, thinking and speaking each carry their own posture,
    // gaze ratio and backchannel behaviour.
    body?.setAttention(state);
  });
  window.anna.onTrouble(showTrouble);
  window.anna.onDemoSaid((text) => {
    // Echo the scripted line in the composer so a viewer can see both halves
    // of the conversation, not just her side of it.
    inputEl.value = text;
    composerEl.dataset['visible'] = 'true';
    body?.setAttention('listening');
    window.setTimeout(() => {
      inputEl.value = '';
    }, 2000);
  });
  window.anna.onVisibility((visible) => {
    // Clear the fade when she is brought back, or the window would reappear
    // still transparent and untouchable.
    if (visible) delete appEl.dataset['leaving'];
  });

  // Always ask: main answers with the chosen character, or with the bundled
  // CC0 default, or with nothing. The renderer has no filesystem access, so
  // bytes plus a blob URL is the only route the loader can take.
  const stored = await window.anna.loadCharacter();
  await loadCharacter(stored ? URL.createObjectURL(new Blob([stored as BlobPart])) : '');

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
   * Start drawing BEFORE the sensors, and never await them.
   *
   * This ordering is not a preference, it is a bug fix. `getUserMedia` blocks
   * while macOS shows its permission prompt — and if the user never answers,
   * or the prompt is suppressed, the promise simply never settles. With the
   * render loop behind that await, Anna's panel drew its frame and then stayed
   * completely empty: no avatar, no placeholder, nothing, with no error to
   * explain it. It only appeared once the camera was switched on, which is
   * exactly when it is hardest to attribute.
   *
   * The body has nothing to do with the sensors. It should be on screen the
   * instant it can be.
   */
  requestAnimationFrame(frame);
  void applySenses(config);
}

void boot();
