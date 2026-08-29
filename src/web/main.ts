/**
 * The website's wiring.
 *
 * Reading order, roughly the order things happen:
 *
 *   1. Connect to the local server and paint whatever it says.
 *   2. When she talks, play it; when she is cut off, stop instantly.
 *   3. Tell the server periodically whether anyone is still sitting here, which
 *      is the only thing a browser can honestly report about presence and is
 *      what the three-minute rule reasons about.
 *
 * Waking her is a click and not automatic, and it has to stay that way:
 * browsers will not start audio without a gesture, and a companion who opens
 * the microphone the moment a tab loads is a companion nobody should install.
 *
 * Since v2.0 the senses are not switches. v1 had three toggles in the header,
 * which put the user in the position of granting her a sense at a time and made
 * "can she hear me" a question with a wrong answer. Now hearing comes up with
 * her, on the same gesture, and it goes down when she sleeps — so the honest
 * statement is the simple one: while she is awake she is listening, and while
 * she is asleep she is not. The camera comes up on the same gesture, because
 * `getUserMedia` asks once and then remembers.
 *
 * The screen depends on where the page is running, and the split is honest
 * rather than tidy. In the desktop application Electron's display-media handler
 * grants a remembered source with no prompt, so the screen comes up with her
 * like the other two. In a browser tab `getDisplayMedia` shows the operating
 * system's picker on **every** call and never remembers, so a dialog every time
 * she wakes is the alternative — which for somebody who wakes her several times
 * a day is worse than not having the sense. There she can still be shown a
 * screen; it is `run("screencapture …")` on demand rather than a live feed.
 *
 * The `ready` message carries which case this is.
 */

import './styles.css';

import type { ServerMessage } from '../shared/protocol.ts';
import { MediaKind } from '../shared/protocol.ts';
import { Connection } from './connection.ts';
import { Microphone } from './audio/mic.ts';
import { Player } from './audio/player.ts';
import { Vision } from './vision.ts';
import { Ui } from './ui.ts';

/** How often presence is reported. Cheap, and the server only needs the shape. */
const PRESENCE_INTERVAL_MS = 15_000;

let lastInteractionAt = Date.now();
let awake = false;

const ui = new Ui({
  onWake: () => void toggleWake(),
  onClaim: () => connection.connect(),
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

const player = new Player({ onLevel: (level) => ui.setHerLevel(level) });

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

/**
 * Whether she watches the screen: the application, and only when asked.
 *
 * Read off the `ready` message rather than sniffed out of the user agent,
 * because the server is the half that knows and a user agent is a string
 * somebody else controls.
 */
let screenWanted = false;

function onMessage(message: ServerMessage): void {
  if (message.t === 'ready') {
    screenWanted = message.desktop && message.screenFps > 0;
  }
  if (message.t === 'interrupted') {
    player.flush();
  }
  if (message.t === 'state') {
    const was = awake;
    awake = message.state !== 'asleep' && message.state !== 'error';
    /*
     * She reached her own bedtime, so the hardware goes off here too.
     *
     * The server closing its session is not enough: the microphone and the
     * camera belong to this tab, and leaving them open would light the camera
     * indicator for a companion who is asleep. That is the one thing the
     * indicator must never do — a light that is on while the product says
     * nothing is watching is worse than no light at all.
     *
     * Driven by the state message rather than a message of its own, because
     * `asleep` already means exactly this and a second way of saying it is a
     * second thing that can disagree.
     */
    if (was && !awake) {
      mic.stop();
      vision.stop();
      player.flush();
    }
  }
  ui.apply(message);
}

const mic = new Microphone({
  onChunk: (pcm) => connection.sendMedia(MediaKind.MIC_PCM16, pcm),
  onLevel: (level) => ui.setMicLevel(level),
});

const vision = new Vision({
  onFrame: (kind, jpeg) =>
    connection.sendMedia(
      kind === 'camera' ? MediaKind.CAMERA_JPEG : MediaKind.SCREEN_JPEG,
      jpeg,
    ),
  onScreenActivity: (activity, stillSeconds) =>
    connection.send({ t: 'screen', activity, stillSeconds }),
  onEnded: () => undefined,
});

async function toggleWake(): Promise<void> {
  if (awake) {
    connection.send({ t: 'sleep' });
    player.flush();
    mic.stop();
    vision.stop();
    awake = false;
    return;
  }

  // Both inside the gesture. `player.unlock()` and `getUserMedia` each require
  // one, and awaiting anything else first spends it.
  await player.unlock();
  try {
    await mic.start();
  } catch (error) {
    ui.toast(
      error instanceof Error && error.name === 'NotAllowedError'
        ? 'She cannot hear you until the microphone is allowed.'
        : 'The microphone would not open.',
    );
  }
  // Deliberately not awaited into the same failure path. A refused camera is a
  // companion who cannot see, which is a smaller thing than one who cannot
  // hear, and it must not stop her waking.
  void vision.startCamera().catch(() => undefined);
  /*
   * The screen, in the application only.
   *
   * On by default there, at the half a frame a second `HERS_SCREEN_FPS`
   * defaults to, and it is the largest recurring cost of running her — a frame
   * every two seconds for every waking hour, on sessions whose two-minute
   * audio-plus-video cap only `contextWindowCompression` removes.
   * `HERS_SCREEN_FPS=0` turns it off, and that is the only switch: an earlier
   * version of this comment named a `HERS_SCREEN` that never existed in the
   * code, so the one instruction it gave a reader was one that did nothing.
   */
  if (screenWanted) void vision.startScreen().catch(() => undefined);
  connection.send({ t: 'wake' });
  awake = true;
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

connection.connect();
ui.setState('asleep');
