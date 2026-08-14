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
import { createStage, frameFullBody, loadVrm } from './avatar/stage.ts';
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
    showTrouble('Drop a .vrm character onto this window to give Anna a body.');
    return;
  }
  try {
    const vrm = await loadVrm(path);
    stage.scene.add(vrm.scene);
    frameFullBody(stage.camera, vrm);
    body = new Body(vrm);
    body.setExpression('warm', 0.6);
    placeholder?.dispose();
    placeholder = null;
    hideTrouble();
  } catch (error) {
    placeholder = createPlaceholder(stage.scene);
    showTrouble(error instanceof Error ? error.message : 'That character would not load.');
  }
}

// Dropping a .vrm on the window is the whole setup flow for the avatar.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file || !file.name.toLowerCase().endsWith('.vrm')) return;
  const url = URL.createObjectURL(file);
  await loadCharacter(url);
  await window.anna.setConfig({ avatar: { modelPath: url } });
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
  body?.setSpeechEnergy(energy);
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
  });
  window.anna.onTrouble(showTrouble);

  await loadCharacter(config.avatar.modelPath);
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
