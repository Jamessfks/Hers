/**
 * Anna, assembled.
 *
 * The main process owns everything that must not be reachable from a window
 * that loads remote assets: API keys, the memory database, the sensors, and the
 * turn loop. The renderer is a body — it draws, it plays audio, it reports what
 * the camera and microphone heard. It cannot reach a key or the disk.
 */

import { BrowserWindow, Menu, app, dialog, globalShortcut, ipcMain } from 'electron';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { CLIP_SLOT_NAMES, type ClipSlotName } from '../core/avatar/clips.ts';
import { ClipLibraryStore } from '../core/avatar/library-store.ts';
import {
  VIDEO_PROVIDER_INFO,
  createVideoClipProvider,
  estimateLibraryCost,
} from '../core/avatar/video-provider.ts';
import { PortraitLibrary } from './avatar/portrait.ts';

import { Attention, SituationTracker } from '../core/senses/attention.ts';
import { Companion } from '../core/orchestrator/companion.ts';
import { Config } from './config.ts';
import { Memory } from '../core/memory/memory.ts';
import { MemoryStore } from '../core/memory/store.ts';
import { Secrets, type SecretName } from './secrets.ts';
import { createLlmProvider } from '../core/llm/index.ts';
import { createSttProvider, type SttProvider } from '../core/speech/stt.ts';
import { createAppleStt } from './speech/apple-stt.ts';
import { createTtsProvider } from '../core/speech/index.ts';
import { describePerson } from '../core/llm/vision.ts';
import {
  createGoogleEmbedder,
  createLexicalEmbedder,
  createOpenAiEmbedder,
} from '../core/memory/embedder.ts';
import { createAnnaWindow, createSettingsWindow } from './window.ts';
import { Diagnostics } from './diagnostics.ts';
import { needsFreshLook, readChanged } from '../core/senses/sight.ts';
import { createMockLlm } from './demo/mock-llm.ts';
import { createSayTts } from './demo/mock-tts.ts';
import { createTray } from './tray.ts';
import { registerSettingsHandlers } from './settings-ipc.ts';
import { readActivity, readNextEvent } from './senses/macos.ts';
import {
  IPC,
  type LibraryView,
  type SenseEvent,
  type VideoProviderView,
} from '../shared/protocol.ts';

/**
 * The app is called Anna in development too.
 *
 * Unpackaged, Electron names the app after the entry point's package.json — and
 * `out/main` has none, so it falls back to "Electron". That name decides two
 * things that must match the packaged build or nothing works: `userData`
 * (`~/Library/Application Support/<name>`), and the Keychain item `safeStorage`
 * encrypts against (`<name> Safe Storage`).
 *
 * With them mismatched, a development run has its own empty settings *and*
 * cannot decrypt a key saved by the real app — which reads as "my keys
 * vanished" rather than as two apps with the same icon. Must be called before
 * `whenReady`, because the first `getPath('userData')` fixes it.
 */
app.setName('Anna');

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
  const { window, setInteractiveRegion, fitHeight } = createAnnaWindow();

  const situation = new SituationTracker();
  const attention = new Attention(config.get().presence);
  const diag = new Diagnostics(join(app.getPath('userData'), 'diagnostics.jsonl'));
  if (diag.enabled) console.log('[anna] diagnostics ->', join(app.getPath('userData'), 'diagnostics.jsonl'));

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
      // Live, not captured: a clip that finishes mid-conversation should be
      // usable on the next turn. See PersonaContext.readyGestures.
      readyGestures: () => portraits.readyGestures(),
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
    /*
     * Stop the outgoing companion first.
     *
     * Any config change rebuilds this — a menu-bar toggle, a settings write, a
     * new key. Without the barge-in the old instance keeps streaming audio and
     * writing memory while the new one takes over, so a toggle mid-sentence
     * gives you two Annas talking, and the new one's bargeIn() cannot stop the
     * old one because it holds a different AbortController.
     */
    companion?.bargeIn();
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
      const text = sensed.text;
      diag.startTurn('user', config.get().llm.model, text.length);
      void (async () => {
        // "Can you see me?" deserves a look now, not whatever the timer caught
        // up to forty-five seconds ago.
        if (needsFreshLook(text)) {
          diag.note('fresh-look-requested');
          await lookNow();
        }
        await currentCompanion()?.respondTo(text);
      })();
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

  /**
   * Where the on-device transcriber might be.
   *
   * Same two-world problem as the default character above: packaged it sits
   * beside the asar, and in development the answer depends on how Electron was
   * invoked. It is not inside the asar because a binary cannot be executed from
   * an archive.
   *
   * It is a nested .app rather than a bare executable, which is why the path
   * has three components. That wrapper is not what grants it speech
   * recognition — TCC resolves that against Anna.app, as the process that
   * spawned it. See scripts/build-native.sh for the measurement.
   */
  const TRANSCRIBER = join('anna-transcribe.app', 'Contents', 'MacOS', 'anna-transcribe');
  const transcriberPaths = (): string[] =>
    app.isPackaged
      ? [join(process.resourcesPath, TRANSCRIBER)]
      : [
          join(__dirname, '..', '..', 'native', 'build', TRANSCRIBER),
          join(app.getAppPath(), 'native', 'build', TRANSCRIBER),
        ];

  /**
   * The transcriber for the current setting, or null if it cannot be built.
   *
   * The key lookup used to be unconditional, and returning early without one was
   * correct while every option was a paid API. It is exactly wrong for the
   * default: `apple` runs on this machine and has no account to have a key for,
   * so the old guard would have silently swallowed every utterance — the same
   * dead microphone this whole path exists to fix, just with a different cause.
   */
  function currentStt(): SttProvider | null {
    const settings = config.get();
    if (settings.stt.provider === 'apple') {
      return createAppleStt({ binaryPaths: transcriberPaths() });
    }

    const key = secrets.get(`stt.${settings.stt.provider}` as SecretName);
    if (key) return createSttProvider(settings.stt.provider, key);

    /*
     * The configured transcriber has no key, so fall back to the on-device one
     * rather than returning null.
     *
     * Returning null meant the microphone was silently dead: the VAD recorded,
     * the audio crossed IPC, and the turn was dropped with nothing shown. That
     * is the state anyone upgrading lands in — a stored `stt.provider` from
     * before the on-device option existed wins over the new default, so their
     * config points at a provider they never had a key for.
     *
     * Falling back is safe precisely because this provider needs no key and no
     * network. Config is left alone: the user's stated preference still stands
     * if they ever add that key.
     */
    diag.note('stt-fallback', { from: settings.stt.provider, to: 'apple' });
    return createAppleStt({ binaryPaths: transcriberPaths() });
  }

  /** Turns a recorded utterance into a turn. */
  async function transcribeAndRespond(audio: Uint8Array, mimeType: string): Promise<void> {
    const stt = currentStt();
    if (!stt) return;
    try {
      const { text } = await stt.transcribe(audio, mimeType);
      if (!text) return;
      situation.observe({ kind: 'user-speech', text, final: true, at: Date.now() });
      // The window cannot know what it heard: it sent audio, main sent it to a
      // recogniser. Without this the thread shows her replies to nothing.
      send(IPC.heard, text);
      diag.startTurn('user', config.get().llm.model, text.length);

      /*
       * The same fresh-look check the typed path does.
       *
       * This branch used to skip it entirely, so asking "can you see me?" out
       * loud — the most natural way anyone would ask — never took a look, while
       * typing the identical words did. Voice is the path most likely to carry
       * that question, so it was missing on exactly the input it was built for.
       */
      if (needsFreshLook(text)) {
        diag.note('fresh-look-requested', { via: 'voice' });
        await lookNow();
      }
      await currentCompanion()?.respondTo(text);
    } catch (error) {
      send(IPC.trouble, error instanceof Error ? error.message : 'I did not catch that.');
    }
  }

  /** Resolvers waiting on the next camera frame. See `lookNow`. */
  let awaitingFrame: Array<() => void> = [];
  let lastRead: string | undefined;
  /** Set for the next capture only, when the user asked her to look. */
  let lookRequested = false;

  /**
   * Ask for a frame and wait for the read, briefly.
   *
   * Bounded on purpose. If the camera is off, denied, or slow, she answers
   * without having looked rather than making the user wait — "I can't see you
   * right now" is a fine answer; a four-second pause is not.
   */
  async function lookNow(timeoutMs = 2500): Promise<void> {
    if (!config.get().senses.camera) return;
    lookRequested = true;
    send(IPC.cameraCapture, true);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        awaitingFrame = awaitingFrame.filter((r) => r !== resolve);
        resolve();
      }, timeoutMs);
      awaitingFrame.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Turns a camera frame into what she has seen.
   *
   * The frame is used and dropped. Only the sentence reaches the situation, and
   * only the situation reaches the model that Anna talks with.
   *
   * Note what this deliberately does NOT do: write `present`. A dark room, a
   * hand over the lens or a failed call is not the user leaving, and treating
   * it as such used to silence every opener she had — including the calendar
   * and late-night ones, which never involved the camera at all.
   */
  async function look(jpegBase64: string): Promise<void> {
    const settings = config.get();
    const key = secrets.get(`llm.${settings.llm.provider}` as SecretName);
    if (!key || !settings.senses.camera) return;

    /*
     * Do not pay to look at an empty chair.
     *
     * Nothing used to gate this: the timer fired every 45 seconds regardless of
     * whether anyone had touched the keyboard in an hour or whether the window
     * was even on screen. That is 80 paid vision calls an hour, indefinitely,
     * for frames of a room with nobody in it — and a camera light on someone's
     * face while they are not there.
     *
     * A look the user explicitly asked for always goes through.
     */
    const snapshot = situation.snapshot(Date.now(), false);
    const away = snapshot.idleSeconds > PRESENCE_IDLE_SECONDS;
    if (!lookRequested && (away || !window.isVisible())) {
      diag.note('vision-skipped', { away, hidden: !window.isVisible() });
      return;
    }

    const requested = lookRequested;
    lookRequested = false;

    const { read, distressed } = await describePerson({
      provider: settings.llm.provider,
      apiKey: key,
      jpegBase64,
      ...(requested && { requested: true }),
    });

    const changed = read !== null && readChanged(lastRead, read);
    diag.note('vision-read', {
      got: read !== null,
      chars: read?.length ?? 0,
      changed,
      distressed,
      requested,
    });

    if (read) {
      /*
       * `lastRead` only advances when the description actually changed.
       *
       * Comparing each read against the immediately previous one let slow drift
       * through unnoticed: upright to collapsed over ten minutes is a large
       * change made of small ones, and every individual step stayed under the
       * similarity threshold. Comparing against the last read she *reported*
       * means the drift accumulates until it is worth saying.
       */
      if (changed) lastRead = read;
      situation.observe({
        kind: 'presence',
        read,
        readChanged: changed,
        distressed,
        at: Date.now(),
      });
    }

    const waiters = awaitingFrame;
    awaitingFrame = [];
    for (const resolve of waiters) resolve();
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
   * The photograph, and the clips made from it.
   *
   * The renderer gets a dropped file as a Blob and can only make a `blob:` URL
   * from it, and a blob URL dies with the window — so persisting one in config
   * means the avatar silently vanishes on the next launch. Main stores the bytes
   * under their own hash and hands them back on request, which keeps the
   * renderer off the filesystem and keeps her across restarts.
   */
  const portraits = new PortraitLibrary({
    store: new ClipLibraryStore({ root: join(app.getPath('userData'), 'libraries') }),
    providerId: () => config.get().avatar.videoProvider,
    apiKey: () =>
      secrets.get(`video.${config.get().avatar.videoProvider}` as SecretName) ?? undefined,
    dropDir: () => config.get().avatar.clipFolder || undefined,
    tier: () => config.get().avatar.generationTier,
  });

  portraits.on('changed', (view: LibraryView) => send(IPC.libraryChanged, view));
  portraits.on('trouble', (message: string) => send(IPC.trouble, message));

  void portraits.resume(config.get().avatar.portrait).then((library: unknown) => {
    diag.note('portrait-resumed', { found: Boolean(library), hash: config.get().avatar.portrait });
  });

  ipcMain.handle(IPC.portraitSet, async (_event, bytes: Uint8Array) => {
    const result = await portraits.adopt(new Uint8Array(bytes));
    if (!result.ok) {
      diag.note('portrait-rejected', { why: result.reason });
      return { error: result.reason };
    }
    config.update({ avatar: { portrait: result.hash } });
    diag.note('portrait-adopted', {
      hash: result.hash.slice(0, 16),
      size: `${result.info.width}x${result.info.height}`,
      type: result.info.mimeType,
    });
    return { hash: result.hash, ...(result.note !== undefined && { note: result.note }) };
  });

  ipcMain.handle(IPC.portraitPick, async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a photograph of Anna',
      // Every clip is generated from this one frame, so the message says what
      // the choice actually commits to rather than just "Open".
      buttonLabel: 'Use this photo',
      properties: ['openFile'],
      filters: [{ name: 'Photographs', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;

    try {
      const bytes = new Uint8Array(await readFile(picked.filePaths[0]));
      const result = await portraits.adopt(bytes);
      if (!result.ok) return { error: result.reason };
      config.update({ avatar: { portrait: result.hash } });
      return { hash: result.hash, ...(result.note !== undefined && { note: result.note }) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not read that file.' };
    }
  });

  ipcMain.on(IPC.windowFit, (_event, height: number) => fitHeight(height));

  ipcMain.handle(IPC.portraitGet, async () => portraits.portraitBytes());
  ipcMain.handle(IPC.clipGet, async (_event, slot: ClipSlotName) => portraits.clipBytes(slot));
  ipcMain.handle(IPC.libraryStatus, () => portraits.view());

  /**
   * The provider menu, priced.
   *
   * The price is computed here rather than written into the UI because it is a
   * property of the adapter — Runway publishes a rate card and Hedra refuses to
   * quote — and a settings screen that hardcoded either would go stale silently.
   */
  ipcMain.handle(IPC.videoProviders, () =>
    VIDEO_PROVIDER_INFO.map((info): VideoProviderView => {
      const provider = createVideoClipProvider(info.id, { apiKey: 'probe', dropDir: '/' });
      return {
        id: info.id,
        label: info.label,
        why: info.why,
        site: info.site,
        wired: info.status === 'wired',
        keyless: info.id === 'manual',
        estimate: estimateLibraryCost(provider.cost, CLIP_SLOT_NAMES.length),
        pricingUrl: provider.cost.pricingUrl,
      };
    }),
  );

  ipcMain.handle(IPC.clipFolderPick, async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Where will you put the clips?',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const folder = picked.canceled ? null : picked.filePaths[0];
    if (!folder) return null;
    config.update({ avatar: { clipFolder: folder } });
    return { folder };
  });

  /**
   * Render clips. This is the one handler in the app that spends money.
   *
   * The ceiling is clamped rather than trusted: the renderer asks for a number,
   * and a renderer bug that asks for a thousand should cost one clip, not a
   * thousand. `libraryBuild` is also the only path here that can take minutes,
   * so it reports through `libraryChanged` instead of making the caller wait.
   */
  ipcMain.handle(IPC.libraryBuild, async (_event, max: unknown) => {
    const ceiling = Math.max(1, Math.min(CLIP_SLOT_NAMES.length, Number(max) || 1));
    try {
      return await portraits.build(ceiling);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'That render did not start.';
      send(IPC.trouble, message);
      return portraits.view();
    }
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
        diag.startTurn('user', config.get().llm.model, line.length);
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
      // Overwrite unconditionally: only reporting a hit meant a finished
      // meeting stayed in her situation for the rest of the day, and the
      // calendar opener re-fired about it every 45 minutes.
      situation.observe({
        kind: 'calendar',
        summary: next?.summary ?? '',
        startsInMinutes: next?.startsInMinutes ?? -1,
        at: Date.now(),
      });
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
        if (!opened) diag.cancelTurn();
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

  /*
   * Re-running main() would call ipcMain.handle twice — which throws — and
   * register a second ipcMain.on(sense) listener, so every message would be
   * answered twice. She lives in the menu bar; showing the existing window is
   * the whole job.
   */
  app.on('activate', () => setVisible(true));
}

void main().catch((error: unknown) => {
  // A failure here means no window and no explanation; at minimum say so.
  console.error('[anna] failed to start:', error);
});
