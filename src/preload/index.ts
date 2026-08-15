/**
 * The bridge between Anna's body and her brain.
 *
 * The renderer runs with `contextIsolation` on and no Node access, so this is
 * the complete list of things her body is able to do. Two rules govern what
 * gets added here:
 *
 *   1. No raw handles. The renderer gets functions, never an ipcRenderer, never
 *      a file path, never a key.
 *   2. Nothing that reads a secret. The renderer can ask whether a key is
 *      present; it can never ask what one is.
 */

import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC,
  type AnnaConfig,
  type BrainState,
  type LibraryView,
  type MemoryFactView,
  type MemoryStats,
  type PerformanceEvent,
  type PermissionReport,
  type SenseEvent,
  type VideoProviderView,
  type VoiceOption,
} from '../shared/protocol.ts';

export interface AudioMessage {
  clauseId: number;
  /** Interleaved mono samples, or null to mark the clause finished. */
  pcm: Float32Array | null;
  sampleRate: number;
}

const api = {
  /** A beat of performance. Returns an unsubscribe function. */
  onPerform(handler: (event: PerformanceEvent) => void): () => void {
    const listener = (_: unknown, event: PerformanceEvent) => handler(event);
    ipcRenderer.on(IPC.perform, listener);
    return () => ipcRenderer.off(IPC.perform, listener);
  },

  onAudio(handler: (message: AudioMessage) => void): () => void {
    const listener = (_: unknown, message: AudioMessage) => handler(message);
    ipcRenderer.on(IPC.audio, listener);
    return () => ipcRenderer.off(IPC.audio, listener);
  },

  onState(handler: (state: BrainState) => void): () => void {
    const listener = (_: unknown, state: BrainState) => handler(state);
    ipcRenderer.on(IPC.state, listener);
    return () => ipcRenderer.off(IPC.state, listener);
  },

  onTrouble(handler: (message: string) => void): () => void {
    const listener = (_: unknown, message: string) => handler(message);
    ipcRenderer.on(IPC.trouble, listener);
    return () => ipcRenderer.off(IPC.trouble, listener);
  },

  /** Report a problem or a milestone from the body, for the diagnostics log. */
  report(event: string, detail?: Record<string, unknown>): void {
    ipcRenderer.send(IPC.bodyReport, event, detail ?? {});
  },

  /** Report something the senses picked up, including the user's own words. */
  sense(event: SenseEvent): void {
    ipcRenderer.send(IPC.sense, event);
  },

  /**
   * Hand a dropped photograph to main. Returns the hash that names her library.
   *
   * The renderer cannot write to disk, so a blob: URL is all it has — and a
   * blob URL dies with the window, which is why a dropped avatar used to vanish
   * on restart. Rejections come back as `{error}` rather than a throw: "that
   * photo is too small" is something to show under the drop target, not an
   * exception.
   */
  setPortrait(bytes: Uint8Array): Promise<{ hash: string; note?: string } | { error: string }> {
    return ipcRenderer.invoke(IPC.portraitSet, bytes);
  },

  /** Open a native picker for a photograph. Null when cancelled. */
  pickPortrait(): Promise<{ hash: string; note?: string } | { error: string } | null> {
    return ipcRenderer.invoke(IPC.portraitPick);
  },

  /** The stored photograph's bytes. Null before one is chosen. */
  getPortrait(): Promise<Uint8Array | null> {
    return ipcRenderer.invoke(IPC.portraitGet);
  },

  /** One generated clip's bytes. Null when that slot is not ready. */
  getClip(slot: string): Promise<Uint8Array | null> {
    return ipcRenderer.invoke(IPC.clipGet, slot);
  },

  /** What exists in the clip library right now. */
  libraryStatus(): Promise<LibraryView> {
    return ipcRenderer.invoke(IPC.libraryStatus);
  },

  /** The video providers, each with what a full library would cost. */
  videoProviders(): Promise<VideoProviderView[]> {
    return ipcRenderer.invoke(IPC.videoProviders);
  },

  /** Choose the folder hand-made clips are dropped into. Null when cancelled. */
  pickClipFolder(): Promise<{ folder: string } | null> {
    return ipcRenderer.invoke(IPC.clipFolderPick);
  },

  /**
   * Render up to `max` clips. This is the only call in this bridge that spends
   * money, which is why the ceiling is explicit at every call site rather than
   * defaulted somewhere out of sight.
   */
  buildLibrary(max: number): Promise<LibraryView> {
    return ipcRenderer.invoke(IPC.libraryBuild, max);
  },

  /** Ask for a panel height that fits her frame. Main clamps it. */
  fitHeight(height: number): void {
    ipcRenderer.send(IPC.windowFit, height);
  },

  onLibrary(handler: (view: LibraryView) => void): () => void {
    const listener = (_: unknown, view: LibraryView) => handler(view);
    ipcRenderer.on(IPC.libraryChanged, listener);
    return () => ipcRenderer.off(IPC.libraryChanged, listener);
  },

  // -- settings -------------------------------------------------------------

  /** Config changed in another window or from the menu bar. */
  onConfigChanged(handler: (config: AnnaConfig) => void): () => void {
    const listener = (_: unknown, config: AnnaConfig) => handler(config);
    ipcRenderer.on(IPC.configChanged, listener);
    return () => ipcRenderer.off(IPC.configChanged, listener);
  },

  /** Deep-link into the exact System Settings privacy pane. */
  openPrivacyPane(pane: string): Promise<void> {
    return ipcRenderer.invoke('anna:open-privacy-pane', pane);
  },

  openSettings(): void {
    ipcRenderer.send(IPC.settingsOpen);
  },

  /**
   * Check a key with the provider, then store it if it works.
   *
   * Validation happens in main because the key never comes back out of main.
   * The settings window sends a key in and gets a verdict out; it cannot read
   * one back, even the one it just typed.
   */
  validateAndSetKey(
    kind: string,
    provider: string,
    key: string,
  ): Promise<{ ok: true; note?: string } | { ok: false; reason: string }> {
    return ipcRenderer.invoke(IPC.keyValidate, kind, provider, key);
  },

  /** Warn about a key that looks like it belongs in a different box. */
  keyShape(slot: string, key: string): Promise<string | null> {
    return ipcRenderer.invoke('anna:key:shape', slot, key);
  },

  deleteKey(name: string): Promise<void> {
    return ipcRenderer.invoke(IPC.keyDelete, name);
  },

  /**
   * The models this key can use. Empty when the list could not be fetched, in
   * which case the picker falls back to the built-in catalogue.
   */
  listModels(provider: string): Promise<Array<{ id: string; label: string }>> {
    return ipcRenderer.invoke(IPC.modelsList, provider);
  },

  listVoices(provider: string): Promise<VoiceOption[]> {
    return ipcRenderer.invoke(IPC.voicesList, provider);
  },

  /** Synthesise a sample line so a voice can be auditioned before choosing. */
  previewVoice(
    provider: string,
    voiceId: string,
  ): Promise<{ pcm: Float32Array; sampleRate: number } | { error: string }> {
    return ipcRenderer.invoke(IPC.voicePreview, provider, voiceId);
  },

  memoryStats(): Promise<MemoryStats> {
    return ipcRenderer.invoke(IPC.memoryStats);
  },

  memoryFacts(limit?: number): Promise<MemoryFactView[]> {
    return ipcRenderer.invoke(IPC.memoryFacts, limit);
  },

  forgetFact(id: number): Promise<void> {
    return ipcRenderer.invoke(IPC.memoryForget, id);
  },

  wipeMemory(): Promise<void> {
    return ipcRenderer.invoke(IPC.memoryWipe);
  },

  permissions(): Promise<PermissionReport> {
    return ipcRenderer.invoke(IPC.permissions);
  },

  getConfig(): Promise<AnnaConfig> {
    return ipcRenderer.invoke(IPC.configGet);
  },

  setConfig(patch: unknown): Promise<AnnaConfig> {
    return ipcRenderer.invoke(IPC.configSet, patch);
  },

  /** Store a provider key. The renderer never reads one back. */
  setKey(name: string, value: string): Promise<{ ok: boolean; reason?: string }> {
    return ipcRenderer.invoke(IPC.keySet, name, value);
  },

  keyStatus(): Promise<Record<string, { present: boolean; hint: string }>> {
    return ipcRenderer.invoke(IPC.keyStatus);
  },

  /**
   * Send her away. She stops mid-sentence, fades out, and stays quiet until
   * she is brought back — from the menu bar or with the global shortcut.
   */
  hide(): void {
    ipcRenderer.send(IPC.window, { action: 'hide', value: true });
  },

  /** Demo mode only: what the script just "typed" on your behalf. */
  onDemoSaid(handler: (text: string) => void): () => void {
    const listener = (_: unknown, text: string) => handler(text);
    ipcRenderer.on(IPC.demoSaid, listener);
    return () => ipcRenderer.off(IPC.demoSaid, listener);
  },

  /**
   * Anna wants to look right now.
   *
   * Fired when the conversation needs eyes — "can you see me?" — rather than
   * waiting up to 45 seconds for the next scheduled frame.
   */
  onCameraCapture(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on(IPC.cameraCapture, listener);
    return () => ipcRenderer.off(IPC.cameraCapture, listener);
  },

  /** Fires when she is hidden or brought back, so the body can fade. */
  onVisibility(handler: (visible: boolean) => void): () => void {
    const listener = (_: unknown, visible: boolean) => handler(visible);
    ipcRenderer.on(IPC.visibility, listener);
    return () => ipcRenderer.off(IPC.visibility, listener);
  },

  /**
   * Toggle click-through. The renderer calls this as the pointer enters and
   * leaves Anna's silhouette, so the rest of her window stays invisible to the
   * mouse.
   */
  setInteractive(interactive: boolean): void {
    ipcRenderer.send(IPC.window, { action: 'interactive', value: interactive });
  },
};

export type AnnaApi = typeof api;

contextBridge.exposeInMainWorld('anna', api);
