/**
 * The website's wiring.
 *
 * Reading order, roughly the order things happen:
 *
 *   1. Connect to the local server and paint whatever it says.
 *   2. When a sense is switched on, open the device and start pushing media.
 *   3. When she talks, play it; when she is cut off, stop instantly.
 *   4. Tell the server periodically whether anyone is still sitting here, which
 *      is the only thing a browser can honestly report about presence and is
 *      what the three-minute rule reasons about.
 *
 * Waking her is a click and not automatic, and it has to stay that way:
 * browsers will not start audio without a gesture, and a companion who opens
 * the microphone the moment a tab loads is a companion nobody should install.
 */

import './styles.css';

import { MediaKind } from '../shared/protocol.ts';
import type { SenseName, ServerMessage } from '../shared/protocol.ts';
import { Connection } from './connection.ts';
import { Microphone } from './audio/mic.ts';
import { Player } from './audio/player.ts';
import { Vision } from './vision.ts';
import { Ui } from './ui.ts';
import type { KnowledgeView, ScanOutcomeView } from './ui.ts';

/** How often presence is reported. Cheap, and the server only needs the shape. */
const PRESENCE_INTERVAL_MS = 15_000;

const senses: Record<SenseName, boolean> = { hearing: false, sight: false, screen: false };
let lastInteractionAt = Date.now();
let awake = false;

const ui = new Ui({
  onToggleSense: (sense, on) => void toggleSense(sense, on),
  onWake: () => void toggleWake(),
  onSay: (text) => {
    connection.send({ t: 'say', text });
    ui.line('user', text, true);
    if (!awake) void toggleWake();
  },
  onLoadProfile: () => connection.send({ t: 'profile.load' }),
  onSaveProfile: (files) => connection.send({ t: 'profile.save', files }),
  onUploadFace: (file) => void uploadFace(file),
  onClaim: () => connection.connect(),
  onLoadMemory: () => connection.send({ t: 'memory.load' }),
  onEditMemory: (id, text) => connection.send({ t: 'memory.edit', id, text }),
  onForgetMemory: (id) => connection.send({ t: 'memory.forget', id }),
  onAddMemory: (text) => connection.send({ t: 'memory.add', text }),
  onRenderGesture: (gesture) => {
    connection.send({ t: 'avatar.render', gesture });
    ui.toast(`Rendering ${gesture.replace('_', ' ')}. This takes a few minutes.`, 6000);
  },
  onPinIntimacy: (score) => connection.send({ t: 'intimacy.pin', score }),
  onAutoIntimacy: () => connection.send({ t: 'intimacy.auto' }),
  onLoadKnowledge: async () => {
    try {
      const response = await fetch('/api/knowledge');
      return response.ok ? ((await response.json()) as KnowledgeView) : {};
    } catch {
      return {};
    }
  },
  onScan: async (folders) => {
    try {
      const response = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folders }),
      });
      return (await response.json()) as ScanOutcomeView;
    } catch (error) {
      return {
        error: `Could not reach the server: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
  onSaveKey: (key) => post('/api/key', { key }),
  onSaveBotToken: async (token) => {
    // Unlike the other setup posts, the interesting part of the answer is the
    // body: the page needs the bot's username to build the link the user opens.
    const response = await fetch('/api/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }).catch(() => null);

    if (!response) return { error: 'Could not reach the server.' };
    const body = (await response.json().catch(() => null)) as
      | { error?: string; username?: string; link?: string }
      | null;
    if (!response.ok) return { error: body?.error ?? `The server said no (HTTP ${response.status}).` };
    return {
      ...(body?.username ? { username: body.username } : {}),
      ...(body?.link ? { link: body.link } : {}),
    };
  },
  onReset: async (confirm) => {
    // Whatever is playing is about to belong to somebody who no longer exists.
    player.flush();
    awake = false;
    return post('/api/reset', { confirm });
  },
});

/**
 * A small JSON POST. Resolves to null when it worked, or to why it did not.
 *
 * The server's own wording is passed straight through: it is the end that knows
 * whether Google refused the key, whether the file could not be written, or
 * whether a directory was in the way, and a message invented here would be a
 * guess at all three.
 */
async function post(url: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => null)) as { error?: string } | null;
    if (response.ok) return null;
    return parsed?.error ?? `That failed (HTTP ${response.status}).`;
  } catch (error) {
    return `Could not reach the server: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Sends the picture as the raw request body.
 *
 * Not multipart: a `File` is a `Blob`, `fetch` will send it verbatim with its
 * own type as the content-type, and the server needs no parser for it. The
 * size is checked here as well as on the server — not for safety, which is the
 * server's job, but so that choosing a 40MB photograph fails instantly instead
 * of after uploading 40MB to be told no.
 */
async function uploadFace(file: File): Promise<void> {
  const MAX_BYTES = 12 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    ui.toast(`That picture is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 12 MB.`);
    return;
  }

  ui.toast('Uploading…', 2500);
  try {
    const response = await fetch('/api/avatar', {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      ui.toast(body.error ?? 'That picture could not be used.');
      return;
    }
    // The server announces the new state over the socket, so there is one path
    // that updates the interface rather than two that can disagree.
    ui.toast('That is her now. Render "idle" to bring her to life.', 6000);
  } catch (error) {
    ui.toast(`The upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const player = new Player({ onLevel: (level) => ui.setHerLevel(level) });

const microphone = new Microphone({
  onChunk: (pcm) => connection.sendMedia(MediaKind.MIC_PCM16, pcm),
  onLevel: (level) => ui.setMicLevel(level),
});

const vision = new Vision({
  onFrame: (kind, jpeg) => {
    connection.sendMedia(
      kind === 'camera' ? MediaKind.CAMERA_JPEG : MediaKind.SCREEN_JPEG,
      jpeg,
    );
  },
  onScreenActivity: (activity, stillSeconds) => {
    connection.send({ t: 'screen', activity, stillSeconds });
  },
  onEnded: (source) => {
    const sense: SenseName = source === 'camera' ? 'sight' : 'screen';
    senses[sense] = false;
    ui.setSense(sense, false);
    ui.attachPreview(source, source === 'camera' ? vision.cameraElement : vision.screenElement, false);
    connection.send({ t: 'sense', sense, on: false });
  },
});

const connection = new Connection({
  // Only worth saying after a drop. Announcing a successful first connection is
  // telling someone the thing they are looking at is on screen.
  onOpen: (reconnected) => {
    ui.setSuperseded(false);
    if (reconnected) ui.toast('Reconnected.', 1800);
  },
  onClose: () => ui.setState('asleep'),
  onSuperseded: () => ui.setSuperseded(true),
  onAudio: (pcm) => player.enqueue(pcm),
  onMessage: (message) => onMessage(message),
});

function onMessage(message: ServerMessage): void {
  if (message.t === 'ready') {
    vision.setRates(message.cameraFps, message.screenFps);
    /*
     * Tell the server about any device that is actually open.
     *
     * `ready` carries the server's view of the senses, and after a reconnect or
     * a reset that view is a fresh one — while this page still has the camera
     * light on. The device is the fact; the server's record of it is not. Left
     * alone, the buttons would go dark on a page that is still sharing, which
     * is the worst possible way for that to be wrong.
     */
    for (const [sense, on] of Object.entries(senses) as [SenseName, boolean][]) {
      if (on && !message.senses[sense]) connection.send({ t: 'sense', sense, on: true });
    }
  }
  if (message.t === 'interrupted') {
    player.flush();
  }
  if (message.t === 'state') {
    awake = message.state !== 'asleep' && message.state !== 'error';
  }
  ui.apply(message);
}

// ---------------------------------------------------------------------------
// Senses
// ---------------------------------------------------------------------------

async function toggleSense(sense: SenseName, on: boolean): Promise<void> {
  try {
    if (sense === 'hearing') {
      if (on) {
        // Unlocking playback here is the point of the gesture: the first time
        // anyone turns a sense on is reliably a click, and an AudioContext
        // created outside one stays suspended and silent forever.
        await player.unlock();
        await microphone.start();
      } else {
        await microphone.stop();
      }
    } else if (sense === 'sight') {
      if (on) await vision.startCamera();
      else vision.stopCamera();
      ui.attachPreview('camera', vision.cameraElement, on);
    } else {
      if (on) await vision.startScreen();
      else vision.stopScreen();
      ui.attachPreview('screen', vision.screenElement, on);
    }
  } catch (error) {
    // A denied permission arrives here as an exception, and it is the single
    // most common thing that will go wrong on a first run. Saying so plainly
    // beats a sense button that silently refuses to light up.
    ui.toast(explainMediaError(error, sense));
    ui.setSense(sense, false);
    senses[sense] = false;
    connection.send({ t: 'sense', sense, on: false });
    return;
  }

  senses[sense] = on;
  ui.setSense(sense, on);
  connection.send({ t: 'sense', sense, on });

  // Turning a sense on is the moment someone means to start talking.
  if (on && !awake) await toggleWake();
}

async function toggleWake(): Promise<void> {
  if (awake) {
    connection.send({ t: 'sleep' });
    player.flush();
    awake = false;
    return;
  }
  await player.unlock();
  connection.send({ t: 'wake' });
  awake = true;
}

function explainMediaError(error: unknown, sense: SenseName): string {
  const name = error instanceof Error ? error.name : '';
  const thing = sense === 'hearing' ? 'the microphone' : sense === 'sight' ? 'the camera' : 'screen sharing';
  switch (name) {
    case 'NotAllowedError':
      return `Permission for ${thing} was refused. Allow it in the address bar and try again.`;
    case 'NotFoundError':
      return `No device found for ${thing}.`;
    case 'NotReadableError':
      return `Something else is using ${thing} right now.`;
    case 'AbortError':
      return `${thing[0]?.toUpperCase()}${thing.slice(1)} was cancelled.`;
    default:
      return `Could not start ${thing}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
  window.addEventListener(event, () => {
    lastInteractionAt = Date.now();
  }, { passive: true });
}

document.addEventListener('visibilitychange', () => reportPresence());

function reportPresence(): void {
  connection.send({
    t: 'presence',
    idleSeconds: Math.round((Date.now() - lastInteractionAt) / 1000),
    tabVisible: document.visibilityState === 'visible',
  });
}

setInterval(reportPresence, PRESENCE_INTERVAL_MS);

// ---------------------------------------------------------------------------

window.addEventListener('beforeunload', () => {
  // The conversation deliberately survives a reload — the server keeps the
  // companion — so this only releases the devices this page is holding.
  vision.stop();
  void microphone.stop();
});

connection.connect();
ui.setState('asleep');
ui.focusInput();
