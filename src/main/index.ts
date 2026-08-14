/**
 * Anna, assembled.
 *
 * The main process owns everything that must not be reachable from a window
 * that loads remote assets: API keys, the memory database, the sensors, and the
 * turn loop. The renderer is a body — it draws, it plays audio, it reports what
 * the camera and microphone heard. It cannot reach a key or the disk.
 */

import { BrowserWindow, app, ipcMain } from 'electron';
import { join } from 'node:path';

import { Attention, SituationTracker } from '../core/senses/attention.ts';
import { Companion } from '../core/orchestrator/companion.ts';
import { Config } from './config.ts';
import { Memory } from '../core/memory/memory.ts';
import { MemoryStore } from '../core/memory/store.ts';
import { Secrets, type SecretName } from './secrets.ts';
import { createLlmProvider } from '../core/llm/index.ts';
import { createSttProvider } from '../core/speech/stt.ts';
import { createTtsProvider } from '../core/speech/index.ts';
import { describePerson } from '../core/llm/vision.ts';
import {
  createGoogleEmbedder,
  createLexicalEmbedder,
  createOpenAiEmbedder,
} from '../core/memory/embedder.ts';
import { createAnnaWindow } from './window.ts';
import { readActivity, readNextEvent } from './senses/macos.ts';
import { IPC, type SenseEvent } from '../shared/protocol.ts';

/** How often the cheap sensors are read. */
const ACTIVITY_POLL_MS = 20_000;
/** How often the calendar is read. Expensive; the trigger fires at 12 minutes. */
const CALENDAR_POLL_MS = 10 * 60_000;
/** How often Anna is asked whether she wants to say something. */
const ATTENTION_TICK_MS = 30_000;
/** No keypress for this long means they are not at the machine. */
const PRESENCE_IDLE_SECONDS = 240;

async function main(): Promise<void> {
  await app.whenReady();

  const config = new Config();
  const secrets = new Secrets();
  const { window, setInteractiveRegion } = createAnnaWindow();

  const situation = new SituationTracker();
  const attention = new Attention(config.get().presence);
  const store = new MemoryStore({ path: join(app.getPath('userData'), 'memory.db') });

  /**
   * Built lazily and rebuilt whenever keys or provider choices change, so that
   * adding a key in settings takes effect on the next turn rather than on the
   * next launch.
   */
  let companion: Companion | null = null;

  function buildCompanion(): Companion | null {
    const settings = config.get();
    const llmKey = secrets.get(`llm.${settings.llm.provider}` as SecretName);
    const ttsKey = secrets.get(`tts.${settings.tts.provider}` as SecretName);
    if (!llmKey || !ttsKey) return null;

    const llm = createLlmProvider(settings.llm.provider, llmKey);
    const tts = createTtsProvider(settings.tts.provider, ttsKey);

    // Semantic recall needs an embedding endpoint. Anthropic has none, so use
    // whichever of the other two the user happens to have a key for, and fall
    // back to the offline lexical embedder rather than losing memory entirely.
    const openAiKey = secrets.get('llm.openai');
    const googleKey = secrets.get('llm.google');
    const embedder = openAiKey
      ? createOpenAiEmbedder(openAiKey)
      : googleKey
        ? createGoogleEmbedder(googleKey)
        : createLexicalEmbedder();

    const memory = new Memory({ store, embedder, llm, consolidationModel: settings.llm.model });

    return new Companion({
      llm,
      tts,
      memory,
      attention,
      situation,
      model: settings.llm.model,
      voiceId: settings.tts.voiceId,
      sinks: {
        perform: (event) => send(IPC.perform, event),
        audio: (clauseId, chunk) =>
          send(IPC.audio, {
            clauseId,
            pcm: chunk ? chunk.pcm : null,
            sampleRate: chunk?.sampleRate ?? 44100,
          }),
        state: (state) => send(IPC.state, state),
        trouble: (message) => {
          console.error('[anna]', message);
          send(IPC.trouble, message);
        },
      },
    });
  }

  function send(channel: string, payload: unknown): void {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }

  function refresh(): void {
    attention.setPolicy(config.get().presence);
    companion = buildCompanion();
  }

  refresh();

  // -- IPC ------------------------------------------------------------------

  ipcMain.on(IPC.sense, (_event, sensed: SenseEvent) => {
    situation.observe(sensed);

    if (sensed.kind === 'user-speech' && !sensed.final) {
      // They started talking over her. Stop immediately; the transcript for
      // what they said arrives separately, once they finish.
      companion?.bargeIn();
      return;
    }

    if (sensed.kind === 'user-speech' || sensed.kind === 'user-typed') {
      void companion?.respondTo(sensed.text);
      return;
    }

    if (sensed.kind === 'user-audio') {
      void transcribeAndRespond(sensed.audio, sensed.mimeType);
      return;
    }

    if (sensed.kind === 'camera-frame') {
      void look(sensed.jpegBase64);
    }
  });

  /** Turns a recorded utterance into a turn. */
  async function transcribeAndRespond(audio: Uint8Array, mimeType: string): Promise<void> {
    const settings = config.get();
    const key = secrets.get(`stt.${settings.stt.provider}` as SecretName);
    if (!key) return;
    try {
      const { text } = await createSttProvider(settings.stt.provider, key).transcribe(
        audio,
        mimeType,
      );
      if (!text) return;
      situation.observe({ kind: 'user-speech', text, final: true, at: Date.now() });
      await companion?.respondTo(text);
    } catch (error) {
      send(IPC.trouble, error instanceof Error ? error.message : 'I did not catch that.');
    }
  }

  /**
   * Turns a camera frame into a one-clause read of the user.
   *
   * The frame is used and dropped. Only the sentence reaches the situation, and
   * only the situation reaches the model that Anna talks with.
   */
  async function look(jpegBase64: string): Promise<void> {
    const settings = config.get();
    const key = secrets.get(`llm.${settings.llm.provider}` as SecretName);
    if (!key || !settings.senses.camera) return;
    const read = await describePerson({
      provider: settings.llm.provider,
      apiKey: key,
      jpegBase64,
    });
    situation.observe({
      kind: 'presence',
      present: read !== null,
      ...(read && { read }),
      at: Date.now(),
    });
  }

  ipcMain.handle(IPC.configGet, () => config.get());
  ipcMain.handle(IPC.configSet, (_event, patch) => {
    const next = config.update(patch);
    refresh();
    return next;
  });

  ipcMain.handle(IPC.keySet, (_event, name: SecretName, value: string) => {
    try {
      secrets.set(name, value);
      refresh();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC.keyStatus, () => secrets.status());

  ipcMain.on(IPC.window, (_event, message: { action: string; value: boolean }) => {
    if (message.action === 'interactive') setInteractiveRegion(message.value);
  });

  // -- Sensor loops ---------------------------------------------------------

  const timers: NodeJS.Timeout[] = [];

  timers.push(
    setInterval(async () => {
      if (!config.get().senses.screenActivity) return;
      const activity = await readActivity();
      if (!activity) return;
      const at = Date.now();
      situation.observe({ kind: 'activity', ...activity, at });
      situation.observe({
        kind: 'presence',
        present: activity.idleSeconds < PRESENCE_IDLE_SECONDS,
        at,
      });
    }, ACTIVITY_POLL_MS),
  );

  timers.push(
    setInterval(async () => {
      if (!config.get().senses.calendar) return;
      const next = await readNextEvent();
      if (next) situation.observe({ kind: 'calendar', ...next, at: Date.now() });
    }, CALENDAR_POLL_MS),
  );

  timers.push(
    setInterval(() => {
      void companion?.tick();
    }, ATTENTION_TICK_MS),
  );

  // -- Lifecycle ------------------------------------------------------------

  if (process.env['ELECTRON_RENDERER_URL']) {
    await window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  app.on('window-all-closed', () => {
    for (const timer of timers) clearInterval(timer);
    store.close();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void main();
  });
}

void main();
