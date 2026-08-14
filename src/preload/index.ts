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
  type MemoryFactView,
  type MemoryStats,
  type PerformanceEvent,
  type PermissionReport,
  type SenseEvent,
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

  /** Report something the senses picked up, including the user's own words. */
  sense(event: SenseEvent): void {
    ipcRenderer.send(IPC.sense, event);
  },

  /**
   * Hand a dropped .vrm to main to be stored. Returns the id to put in config.
   *
   * The renderer cannot write to disk, so a blob: URL is all it has — and a
   * blob URL dies with the window, which is why a dropped character used to
   * vanish on restart.
   */
  saveCharacter(name: string, bytes: Uint8Array): Promise<{ id: string } | { error: string }> {
    return ipcRenderer.invoke(IPC.characterSave, name, bytes);
  },

  /** Read the stored character back. Null when none is set. */
  loadCharacter(): Promise<Uint8Array | null> {
    return ipcRenderer.invoke(IPC.characterLoad);
  },

  /** Open a native picker for a .vrm. Returns the stored id, or null. */
  pickCharacter(): Promise<{ id: string } | { error: string } | null> {
    return ipcRenderer.invoke(IPC.characterPick);
  },

  // -- settings -------------------------------------------------------------

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
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return ipcRenderer.invoke(IPC.keyValidate, kind, provider, key);
  },

  deleteKey(name: string): Promise<void> {
    return ipcRenderer.invoke(IPC.keyDelete, name);
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
