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

const stage = createStage(canvas);
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
    const vrm = await loadVrm(path);
    stage.scene.add(vrm.scene);
    frameFullBody(stage.camera, vrm);
    body = new Body(vrm);
    body.setViewer(stage.camera.position);
    body.setExpression('warm', 0.6);
    placeholder?.dispose();
    placeholder = null;
    hideTrouble();
  } catch (error) {
    placeholder = createPlaceholder(stage.scene);
    frameHeight(stage.camera, placeholder.height);
    showTrouble(error instanceof Error ? error.message : 'That character would not load.');
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

/**
 * Click-through management.
 *
 * The window covers a tall strip of the screen but Anna occupies a fraction of
 * it, so the main process is told to swallow the mouse only while the pointer
 * is over her or over the composer. Anything else and the user cannot click the
 * editor behind her.
 */
function trackPointer(): void {
  let interactive = false;
  window.addEventListener('mousemove', (event) => {
    const overComposer = composerEl.contains(event.target as Node);
    const overAnna = isOverCharacter(event.clientX, event.clientY);
    const next = overComposer || overAnna;
    if (next !== interactive) {
      interactive = next;
      window.anna.setInteractive(next);
      composerEl.dataset['visible'] = next ? 'true' : 'false';
    }
  });
}

/**
 * Cheap hit test: the lower-centre column of the window, where a standing
 * figure is. A per-pixel alpha read would be exact but costs a GPU readback
 * every mouse move, and being wrong by a few pixels at the edge of a silhouette
 * has no consequence.
 */
function isOverCharacter(x: number, y: number): boolean {
  const { innerWidth: width, innerHeight: height } = window;
  const withinX = Math.abs(x - width / 2) < width * 0.34;
  const withinY = y > height * 0.18;
  return withinX && withinY;
}

document
  .querySelector<HTMLButtonElement>('#settings')!
  .addEventListener('click', () => window.anna.openSettings());

/**
 * Send her away.
 *
 * The fade runs here and the window is hidden by main once it finishes, so she
 * leaves rather than blinking out. ⌥⌘A brings her back, and so does the menu
 * bar item — the button deliberately does not quit anything.
 */
const appEl = document.querySelector<HTMLDivElement>('#app')!;
const LEAVE_MS = 240;

document.querySelector<HTMLButtonElement>('#dismiss')!.addEventListener('click', () => {
  appEl.dataset['leaving'] = 'true';
  player.stop();
  body?.silence();
  window.setTimeout(() => window.anna.hide(), LEAVE_MS);
});

// She looks up the moment you start typing, not when the reply comes back.
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
  trackPointer();

  const microphone = new Microphone({
    onUtterance: (audio, mimeType) =>
      window.anna.sense({ kind: 'user-audio', audio, mimeType, at: Date.now() }),
    // Reported the instant speech is detected, before the utterance ends, so
    // main can cut Anna off mid-sentence rather than after it.
    onSpeechStarted: () =>
      window.anna.sense({ kind: 'user-speech', text: '', final: false, at: Date.now() }),
  });
  if (config.senses.microphone) await microphone.start();

  const vision = new Vision({
    intervalSeconds: config.senses.cameraIntervalSeconds,
    onFrame: (jpegBase64) =>
      window.anna.sense({ kind: 'camera-frame', jpegBase64, at: Date.now() }),
  });
  if (config.senses.camera) await vision.start();

  requestAnimationFrame(frame);
}

void boot();
