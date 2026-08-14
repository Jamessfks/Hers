/**
 * IPC handlers for the settings window.
 *
 * Kept out of `index.ts` because they share one property that is easy to lose
 * in a big file: **a key goes in and never comes out**. The settings window can
 * submit a key for validation, ask whether one is stored, and delete one. There
 * is deliberately no handler that returns a key, not even the one just typed —
 * so a compromised settings renderer has nothing to steal.
 *
 * Everything here is `handle`, not `on`: settings is a request/response
 * surface, and a promise that rejects gives the UI something to show. The
 * conversational channels in `index.ts` are fire-and-forget for the opposite
 * reason.
 */

import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { basename, join } from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';

import type { Config } from './config.ts';
import type { MemoryStore } from '../core/memory/store.ts';
import type { Secrets, SecretName } from './secrets.ts';
import { createLlmProvider } from '../core/llm/index.ts';
import { createSttProvider } from '../core/speech/stt.ts';
import { createTtsProvider } from '../core/speech/index.ts';
import { readPermissions } from './senses/permissions.ts';
import {
  IPC,
  type KeyKind,
  type LlmProviderId,
  type MemoryFactView,
  type MemoryStats,
  type SttProviderId,
  type TtsProviderId,
  type VoiceOption,
} from '../shared/protocol.ts';

/** The line Anna says when you audition a voice. */
const PREVIEW_LINE = "Hey. It's me. This is what I sound like.";

export interface SettingsDeps {
  config: Config;
  secrets: Secrets;
  store: MemoryStore;
  charactersDir: string;
  /** Called after anything that should rebuild the companion. */
  onChanged(): void;
  /** Bring up the settings window. */
  openSettings(): void;
  /** The window to parent native dialogs to, when there is one. */
  parentWindow(): BrowserWindow | null;
}

export function registerSettingsHandlers(deps: SettingsDeps): void {
  const { config, secrets, store } = deps;

  ipcMain.on(IPC.settingsOpen, () => deps.openSettings());

  // -- keys ----------------------------------------------------------------

  /**
   * Validate against the provider, and only store a key that works.
   *
   * Storing first and discovering later is the usual shape, and it produces the
   * worst possible failure: the app looks configured, then goes mute the first
   * time you talk to it, with the real error buried in a log. One round trip
   * here turns that into a sentence under the input field.
   */
  ipcMain.handle(
    IPC.keyValidate,
    async (_event, kind: KeyKind, provider: string, key: string) => {
      const trimmed = key.trim();
      if (!trimmed) return { ok: false as const, reason: 'That field is empty.' };

      try {
        const verdict = await validate(kind, provider, trimmed);
        if (!verdict.ok) return verdict;
        secrets.set(`${kind}.${provider}` as SecretName, trimmed);
        deps.onChanged();
        return { ok: true as const };
      } catch (error) {
        return {
          ok: false as const,
          reason: error instanceof Error ? error.message : 'Could not reach that provider.',
        };
      }
    },
  );

  ipcMain.handle(IPC.keyDelete, (_event, name: SecretName) => {
    secrets.set(name, '');
    deps.onChanged();
  });

  // -- voices --------------------------------------------------------------

  ipcMain.handle(IPC.voicesList, async (_event, provider: TtsProviderId): Promise<VoiceOption[]> => {
    const key = secrets.get(`tts.${provider}` as SecretName);
    if (!key) return [];
    try {
      return await createTtsProvider(provider, key).listVoices();
    } catch {
      return [];
    }
  });

  /**
   * Synthesise one line so a voice can be auditioned before it is chosen.
   *
   * Returned as a single assembled buffer rather than streamed. This is the one
   * place where waiting is fine — nobody is in a conversation — and a buffer
   * the settings window can replay on a click beats holding a stream open while
   * someone scrolls a list of two hundred voices.
   */
  ipcMain.handle(IPC.voicePreview, async (_event, provider: TtsProviderId, voiceId: string) => {
    const key = secrets.get(`tts.${provider}` as SecretName);
    if (!key) return { error: 'No key stored for that voice provider yet.' };

    try {
      const chunks: Float32Array[] = [];
      let sampleRate = 44100;
      for await (const chunk of createTtsProvider(provider, key).synthesize({
        text: PREVIEW_LINE,
        voiceId,
      })) {
        chunks.push(chunk.pcm);
        sampleRate = chunk.sampleRate;
      }

      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (total === 0) return { error: 'That voice returned nothing.' };

      const pcm = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
      return { pcm, sampleRate };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'That voice would not speak.' };
    }
  });

  // -- memory --------------------------------------------------------------

  ipcMain.handle(IPC.memoryStats, (): MemoryStats => {
    const oldest = store.recentTurns(100_000)[0];
    return {
      turns: store.countTurns(),
      facts: store.allFacts().length,
      since: oldest?.at ?? null,
      summary: store.latestSummary()?.text ?? null,
    };
  });

  /**
   * What Anna remembers, most recently useful first.
   *
   * A companion that cannot be inspected cannot be trusted, and "what does it
   * know about me" is the first question anyone sensible asks. Every fact here
   * is removable individually, which matters more than a wipe button: people
   * want to delete the one wrong thing, not start again.
   */
  ipcMain.handle(IPC.memoryFacts, (_event, limit = 200): MemoryFactView[] =>
    store
      .allFacts()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.recallCount - a.recallCount)
      .slice(0, limit)
      .map((fact) => ({
        id: fact.id,
        kind: fact.kind,
        text: fact.text,
        confidence: fact.confidence,
        lastSeenAt: fact.lastSeenAt,
        recallCount: fact.recallCount,
      })),
  );

  ipcMain.handle(IPC.memoryForget, (_event, id: number) => {
    store.forgetFact(id);
  });

  ipcMain.handle(IPC.memoryWipe, () => {
    store.wipe();
    deps.onChanged();
  });

  // -- character -----------------------------------------------------------

  ipcMain.handle(IPC.characterPick, async () => {
    const parent = deps.parentWindow();
    const result = await (parent
      ? dialog.showOpenDialog(parent, PICK_OPTIONS)
      : dialog.showOpenDialog(PICK_OPTIONS));

    const source = result.filePaths[0];
    if (result.canceled || !source) return null;

    try {
      // Copy rather than reference. A character living in ~/Downloads is one
      // tidy-up away from Anna losing her body on next launch.
      const id = basename(source).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-64);
      await mkdir(deps.charactersDir, { recursive: true });
      await copyFile(source, join(deps.charactersDir, id));
      return { id };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not copy that file.' };
    }
  });

  // -- permissions ---------------------------------------------------------

  ipcMain.handle(IPC.permissions, () =>
    readPermissions({ probeCalendar: config.get().senses.calendar }),
  );

  /**
   * Deep links into the exact System Settings panes.
   *
   * "Grant accessibility access" is a five-step journey through System Settings
   * that most people abandon. These URLs land on the right pane.
   */
  ipcMain.handle('anna:open-privacy-pane', (_event, pane: string) => {
    const panes: Record<string, string> = {
      accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      calendar: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
      camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
      microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
    };
    const url = panes[pane];
    if (url) void shell.openExternal(url);
  });
}

const PICK_OPTIONS = {
  title: 'Choose a character for Anna',
  filters: [{ name: 'VRM character', extensions: ['vrm'] }],
  properties: ['openFile' as const],
};

/** Cheapest real credential check each provider offers. */
async function validate(
  kind: KeyKind,
  provider: string,
  key: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (kind === 'llm') {
    return createLlmProvider(provider as LlmProviderId, key).validateKey();
  }

  if (kind === 'tts') {
    // No vendor offers a dedicated check, but every one of them lists voices,
    // and a voice list is both a credential test and the thing the next screen
    // needs anyway.
    const voices = await createTtsProvider(provider as TtsProviderId, key).listVoices();
    return voices.length > 0
      ? { ok: true }
      : { ok: false, reason: 'That key works, but the account has no voices on it.' };
  }

  // Transcription has no free health endpoint, so send it 100ms of silence.
  // It costs a fraction of a cent and it is a genuine end-to-end check.
  const silence = wavOfSilence(0.1);
  await createSttProvider(provider as SttProviderId, key).transcribe(silence, 'audio/wav');
  return { ok: true };
}

/** A minimal 16-bit mono WAV, used only as a credential probe. */
function wavOfSilence(seconds: number, sampleRate = 16000): Uint8Array {
  const samples = Math.floor(seconds * sampleRate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);

  return new Uint8Array(buffer);
}
