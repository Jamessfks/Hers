/**
 * Anna, assembled.
 *
 * The main process owns everything that must not be reachable from a window
 * that loads remote assets: API keys, the memory database, the sensors, and the
 * turn loop. The renderer is a body — it draws, it plays audio, it reports what
 * the camera and microphone heard. It cannot reach a key or the disk.
 */

import { BrowserWindow, Menu, app, globalShortcut, ipcMain } from 'electron';
import { basename, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

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
import { createAnnaWindow, createSettingsWindow } from './window.ts';
import { Diagnostics } from './diagnostics.ts';
import { createMockLlm } from './demo/mock-llm.ts';
import { createSayTts } from './demo/mock-tts.ts';
import { createTray } from './tray.ts';
import { registerSettingsHandlers } from './settings-ipc.ts';
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
  const charactersDir = join(app.getPath('userData'), 'characters');
  const diag = new Diagnostics(join(app.getPath('userData'), 'diagnostics.jsonl'));
  if (diag.enabled) console.log('[anna] diagnostics ->', join(app.getPath('userData'), 'diagnostics.jsonl'));

  /**
   * Where the bundled default character might be.
   *
   * It lives beside the asar rather than inside it — 15MB that is never
   * imported by code, only read as a file. Packaged, that is a single known
   * path. In development it depends on how Electron was invoked:
   * `app.getAppPath()` is the project root under `electron .` but `out/main`
   * under `electron out/main/index.js`, which is exactly the sort of difference
   * that produces "works on my machine". Both are tried rather than guessed.
   */
  const defaultCharacterPaths = (): string[] =>
    app.isPackaged
      ? [join(process.resourcesPath, 'characters', 'anna-default.vrm')]
      : [
          join(__dirname, '..', '..', 'resources', 'characters', 'anna-default.vrm'),
          join(app.getAppPath(), 'resources', 'characters', 'anna-default.vrm'),
        ];
  const store = new MemoryStore({ path: join(app.getPath('userData'), 'memory.db') });

  /**
   * Built lazily and rebuilt whenever keys or provider choices change, so that
   * adding a key in settings takes effect on the next turn rather than on the
   * next launch.
   */
  let companion: Companion | null = null;

  function buildCompanion(): Companion | null {
    const settings = config.get();

    /**
     * Demo mode: a scripted model and the macOS system voice, so the whole
     * product runs end to end with no API key. Both are real implementations of
     * their interfaces rather than stubs, so the streaming path, the clause
     * chunking, the audio scheduler and the formant-based lip sync are all
     * genuinely exercised — which is what makes this useful for development and
     * not only for a demonstration. See src/main/demo/.
     */
    const demo = process.env['ANNA_DEMO'] === '1';

    const llmKey = secrets.get(`llm.${settings.llm.provider}` as SecretName);
    const ttsKey = secrets.get(`tts.${settings.tts.provider}` as SecretName);
    if (!demo && (!llmKey || !ttsKey)) return null;

    const llm = demo || !llmKey ? createMockLlm() : createLlmProvider(settings.llm.provider, llmKey);
    const tts =
      demo || !ttsKey
        ? createSayTts(settings.tts.voiceId || 'Samantha')
        : createTtsProvider(settings.tts.provider, ttsKey);

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
        perform: (event) => {
          diag.noteEvent(event.kind);
          if (event.kind === 'turn-end') diag.endTurn();
          send(IPC.perform, event);
        },
        audio: (clauseId, chunk) => {
          if (chunk) diag.noteAudio();
          send(IPC.audio, {
            clauseId,
            pcm: chunk ? chunk.pcm : null,
            sampleRate: chunk?.sampleRate ?? 44100,
          });
        },
        state: (state) => send(IPC.state, state),
        trouble: (message) => {
          console.error('[anna]', message);
          diag.noteError(message);
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

  /**
   * Reads the live companion.
   *
   * A plain `companion` reference inside a later closure gets narrowed to
   * `never` by the launch-time null check above, and is stale anyway — the
   * companion is rebuilt whenever a key or provider changes.
   */
  const currentCompanion = (): Companion | null => companion;

  refresh();

  // -- IPC ------------------------------------------------------------------

  ipcMain.on(IPC.sense, (_event, sensed: SenseEvent) => {
    situation.observe(sensed);

    if (sensed.kind === 'user-speech' && !sensed.final) {
      // They started talking. Stop her if she was mid-sentence — the transcript
      // arrives separately once they finish — and either way put her into a
      // listening posture now rather than when the words land.
      companion?.bargeIn();
      send(IPC.state, 'listening');
      return;
    }

    if (sensed.kind === 'user-speech' || sensed.kind === 'user-typed') {
      diag.startTurn('user', config.get().llm.model, sensed.text.length);
      void companion?.respondTo(sensed.text);
      return;
    }

    if (sensed.kind === 'user-audio') {
      void transcribeAndRespond(sensed.audio, sensed.mimeType);
      return;
    }

    if (sensed.kind === 'camera-frame') {
      diag.note('camera-frame', { bytes: sensed.jpegBase64.length });
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
    diag.note('vision-read', { got: read !== null, chars: read?.length ?? 0 });
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
    notifySettingsChanged();
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
    if (message.action === 'hide') setVisible(false);
  });

  /**
   * Send her away, or bring her back.
   *
   * Hiding is not just a window state. She stops mid-sentence, because audio
   * continuing from an invisible window is a haunting rather than a companion,
   * and she stops speaking first while away — being ambushed by a voice from
   * something you deliberately dismissed is the fastest way to lose someone's
   * trust in an always-on app.
   */
  function setVisible(visible: boolean): void {
    if (visible) {
      window.showInactive();
    } else {
      companion?.bargeIn();
      window.hide();
    }
    send(IPC.visibility, visible);
    tray.refresh();
  }

  /**
   * Character storage.
   *
   * The renderer gets a dropped file as a Blob and can only make a `blob:` URL
   * from it, and a blob URL dies with the window — so persisting one in config
   * means the character silently vanishes on the next launch. Main copies the
   * bytes into the app's data directory and hands them back on request, which
   * keeps the renderer off the filesystem and keeps the character across
   * restarts.
   */
  ipcMain.handle(IPC.characterSave, async (_event, name: string, bytes: Uint8Array) => {
    try {
      // Never trust a filename from a drag-and-drop; it is attacker-influenced.
      const safe = `${basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-64)}`;
      const id = safe.toLowerCase().endsWith('.vrm') ? safe : `${safe}.vrm`;
      await mkdir(charactersDir, { recursive: true });
      await writeFile(join(charactersDir, id), bytes);
      return { id };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not save that character.' };
    }
  });

  /**
   * Hand the renderer the character bytes.
   *
   * Falls back to the bundled default when the user has not chosen one. The
   * default is a CC0 VRoid sample — see scripts/fetch-character.mjs for why
   * that licence and no other — and it is what makes the first run show a
   * person rather than a placeholder. If it is absent, because the build-time
   * fetch was skipped or offline, the renderer draws the stand-in figure.
   */
  ipcMain.handle(IPC.characterLoad, async () => {
    const id = config.get().avatar.modelPath;
    const candidates = id
      ? [join(charactersDir, basename(id)), ...defaultCharacterPaths()]
      : defaultCharacterPaths();

    for (const path of candidates) {
      try {
        return await readFile(path);
      } catch {
        // Try the next candidate; a missing character is never fatal.
      }
    }
    return null;
  });

  // -- Settings window and menu bar ----------------------------------------

  let settingsWindow: BrowserWindow | null = null;

  function openSettings(): void {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    settingsWindow = createSettingsWindow();
    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
  }

  /**
   * The way back.
   *
   * The menu bar item is the discoverable route, but macOS silently hides menu
   * bar items when the bar is full — which is common on a notched display — and
   * an app you can dismiss but not recall is a bug wearing a feature's clothes.
   * A global shortcut is the guarantee.
   */
  const TOGGLE_SHORTCUT = 'Alt+Command+A';
  if (!globalShortcut.register(TOGGLE_SHORTCUT, () => setVisible(!window.isVisible()))) {
    console.warn(`[anna] could not register ${TOGGLE_SHORTCUT}; something else owns it`);
  }

  const tray = createTray({
    window,
    setVisible,
    config: () => config.get(),
    setConfig: (patch) => {
      config.update(patch);
      refresh();
      notifySettingsChanged();
    },
    openSettings,
    isConfigured: () => companion !== null,
  });

  /** Keep both windows in step when either one changes something. */
  function notifySettingsChanged(): void {
    const next = config.get();
    for (const target of [window, settingsWindow]) {
      if (target && !target.isDestroyed()) target.webContents.send(IPC.configChanged, next);
    }
    tray.refresh();
  }

  registerSettingsHandlers({
    config,
    secrets,
    store,
    charactersDir,
    onChanged: () => {
      refresh();
      notifySettingsChanged();
    },
    openSettings,
    parentWindow: () => settingsWindow,
  });

  // Anna has no menu of her own, but the standard edit menu is what makes
  // copy and paste work in the key fields. Without it, pasting a key fails.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  );

  // With a menu bar item there is no reason to keep a dock icon: she is not an
  // app you switch to, she is just there.
  app.dock?.hide();

  if (!companion && process.env['ANNA_DEMO'] !== '1') openSettings();

  /**
   * Demo script.
   *
   * ANNA_DEMO_SCRIPT is a `|`-separated list of things to say to her, played in
   * with a gap between each so a whole exchange can be watched without anyone
   * touching the keyboard. Driving it from inside the process rather than by
   * simulating keystrokes matters: synthetic key events go to whichever window
   * has focus, which is a good way to type into somebody's unrelated app.
   */
  const script = process.env['ANNA_DEMO_SCRIPT'];
  if (script) {
    const lines = script.split('|').map((line) => line.trim()).filter(Boolean);
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      for (const line of lines) {
        const active = currentCompanion();
        if (!active) break;
        situation.observe({ kind: 'user-typed', text: line, at: Date.now() });
        send(IPC.demoSaid, line);
        await active.respondTo(line);
        await new Promise((resolve) => setTimeout(resolve, 2200));
      }
    })();
  }

  // -- Sensor loops ---------------------------------------------------------

  const timers: NodeJS.Timeout[] = [];

  timers.push(
    setInterval(async () => {
      if (!config.get().senses.screenActivity) return;
      const activity = await readActivity();
      if (!activity) {
        diag.note('activity-blocked', { reason: 'accessibility denied or osascript failed' });
        return;
      }
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
      // She does not speak first while she is hidden. See setVisible.
      if (!window.isVisible()) return;
      void (async () => {
        const active = currentCompanion();
        if (!active) return;
        diag.startTurn('opener', config.get().llm.model, 0);
        const opened = await active.tick();
        if (!opened) diag.endTurn();
      })();
    }, ATTENTION_TICK_MS),
  );

  // -- Lifecycle ------------------------------------------------------------

  if (process.env['ELECTRON_RENDERER_URL']) {
    await window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  app.on('before-quit', () => {
    for (const timer of timers) clearInterval(timer);
    globalShortcut.unregisterAll();
    tray.destroy();
    store.close();
  });

  // Anna lives in the menu bar, so closing her window is "hide", not "quit".
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void main();
  });
}

void main();
