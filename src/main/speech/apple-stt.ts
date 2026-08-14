/**
 * Hearing that costs nothing and goes nowhere.
 *
 * Deepgram and OpenAI both want an account, a card and a key, on top of the
 * language key and voice key Anna already asks for. macOS ships a speech
 * recogniser that runs on the machine, needs no key at all, and works on a
 * plane. That makes it the right default, and this is the adapter that puts it
 * behind the same {@link SttProvider} interface as the two paid ones.
 *
 * It lives in `main/` rather than `core/speech/` for one reason: it spawns a
 * process. `core/` is deliberately free of Node imports so it can be reasoned
 * about — and tested — without a runtime, and the moment `node:child_process`
 * appears in there that property is gone for good.
 *
 * The transcript never leaves this machine and no network call is made. See
 * native/transcribe.swift for the recogniser itself, and why it is a separate
 * executable.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { SttProvider, Transcript } from '../../core/speech/stt.ts';

/** Exit codes from native/transcribe.swift. Kept in step by hand. */
export const EXIT = {
  usage: 2,
  fileMissing: 3,
  notAuthorized: 4,
  noRecognizer: 5,
  modelUnavailable: 6,
  recognitionFailed: 7,
  timedOut: 8,
  /** Not from the helper: the shell's "no such executable". */
  notInstalled: 127,
  /**
   * Not an exit code at all — the helper died on a signal and never got to
   * choose one. Negative so it can never collide with a real status.
   */
  killed: -1,
} as const;

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

/**
 * Containers CoreAudio will open, and the extension it recognises each by.
 *
 * `afconvert` picks its parser from the file extension as much as from the
 * bytes, so a WAV written to `utterance.tmp` is refused by the same command that
 * accepts `utterance.wav`. This table is the reason the temp file is named
 * rather than random.
 */
const CONTAINERS: Record<string, { extension: string; linear: boolean }> = {
  'audio/wav': { extension: 'wav', linear: true },
  'audio/wave': { extension: 'wav', linear: true },
  'audio/x-wav': { extension: 'wav', linear: true },
  'audio/vnd.wave': { extension: 'wav', linear: true },
  'audio/aiff': { extension: 'aiff', linear: true },
  'audio/x-aiff': { extension: 'aiff', linear: true },
  'audio/x-caf': { extension: 'caf', linear: true },
  'audio/mp4': { extension: 'm4a', linear: false },
  'audio/x-m4a': { extension: 'm4a', linear: false },
  'audio/aac': { extension: 'm4a', linear: false },
  'audio/mpeg': { extension: 'mp3', linear: false },
  'audio/flac': { extension: 'flac', linear: false },
  'audio/ogg': { extension: 'ogg', linear: false },
  'audio/opus': { extension: 'opus', linear: false },
};

export type Conversion =
  /** Hand this straight to the recogniser. */
  | { kind: 'ready'; extension: string }
  /** CoreAudio can read it, but decode it to plain PCM first. */
  | { kind: 'convert'; extension: string }
  | { kind: 'unsupported'; reason: string };

/**
 * What has to happen to these bytes before macOS will listen to them.
 *
 * Compressed containers are normalised through `afconvert` rather than passed
 * along. `AVAudioFile` would open an m4a perfectly well, so this is not about
 * capability — it is that the recogniser wants 16kHz mono and quietly does its
 * own resampling otherwise, and a conversion we control is a conversion we can
 * see in a bug report.
 */
export function conversionFor(mimeType: string): Conversion {
  // `audio/webm;codecs=opus` — the parameters say nothing useful about the
  // container, and leaving them on turns every lookup into a miss.
  const type = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const container = CONTAINERS[type];

  if (container) {
    return container.linear
      ? { kind: 'ready', extension: container.extension }
      : { kind: 'convert', extension: container.extension };
  }

  if (type === 'audio/webm' || type === 'video/webm' || type === 'audio/x-matroska') {
    return {
      kind: 'unsupported',
      reason:
        'That recording is WebM, which macOS cannot decode — CoreAudio has no Matroska parser, so afconvert refuses it too. The renderer converts to WAV before sending; this recording did not get converted.',
    };
  }

  return {
    kind: 'unsupported',
    reason: `macOS cannot read ${type || 'that audio format'}. Anna records WAV for on-device transcription.`,
  };
}

// ---------------------------------------------------------------------------
// Reading the helper's answer
// ---------------------------------------------------------------------------

export function parseTranscript(stdout: string, stderr: string): Transcript {
  const match = /confidence=([0-9.]+)/.exec(stderr);
  const parsed = match ? Number(match[1]) : Number.NaN;
  return {
    text: stdout.trim(),
    // A missing or unreadable score must never suppress a good transcript, so
    // anything unparseable means "no opinion", which is 1 — the same answer the
    // Deepgram adapter gives when the vendor omits it.
    confidence: Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 1,
  };
}

/**
 * Turns an exit code into a sentence a person can act on.
 *
 * The helper's own stderr is preferred whenever there is any, because it is
 * written next to the API call that failed and knows things this side does not —
 * which locale, which CoreAudio error. The per-code fallbacks exist for the case
 * where the process died before it could say anything, which is precisely when
 * a generic "transcription failed" is least useful.
 */
export function describeFailure(code: number, stderr: string): string {
  const said = stderr.trim();
  if (said) return said;

  switch (code) {
    case EXIT.killed:
      /*
       * Nearly always TCC. macOS kills a process that touches speech
       * recognition without an `NSSpeechRecognitionUsageDescription` reachable
       * from the *responsible* app, and it does it before the helper's own code
       * runs, so there is never anything on stderr to quote.
       */
      return 'macOS stopped the transcriber before it could start, which usually means the app is missing its speech-recognition permission description. Reinstall Anna, or choose a different transcription provider in settings.';
    case EXIT.notInstalled:
      return 'The on-device transcriber is missing from this build. Run `npm run build:native`, or choose a different transcription provider in settings.';
    case EXIT.notAuthorized:
      return 'Anna needs permission to use speech recognition. Grant it in System Settings > Privacy & Security > Speech Recognition.';
    case EXIT.modelUnavailable:
      return 'The offline speech model is not installed. Open System Settings > Keyboard > Dictation and switch it on, then try again.';
    case EXIT.noRecognizer:
      return 'macOS has no speech recogniser available for this language.';
    case EXIT.fileMissing:
      return 'The recording went missing before it could be transcribed.';
    case EXIT.timedOut:
      return 'Speech recognition took too long and was given up on.';
    default:
      return `On-device transcription failed (exit ${code}).`;
  }
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected in tests so the whole adapter can be exercised off a Mac. */
export type Run = (file: string, args: string[]) => Promise<RunResult>;

/**
 * Never rejects.
 *
 * `execFile` treats a non-zero exit as an error, which would collapse the
 * helper's carefully distinct exit codes into one thrown object and lose the
 * stderr that goes with them. Everything here is a result.
 *
 * The three failure shapes it hands back are genuinely different and the first
 * draft of this conflated them: `error.code` is a *number* for a normal exit, a
 * *string* errno when the process could not be started at all, and absent when
 * the process was killed by a signal. Reading it as a number in all three cases
 * turned a killed helper into `code: 0` with empty output — which the caller
 * reads as "the room was quiet". A transcriber that TCC is executing every time
 * would have looked exactly like a user who never speaks.
 */
const spawn: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });

      const failure = error as Error & { code?: number | string; signal?: string };
      if (typeof failure.code === 'number') {
        return resolve({ code: failure.code, stdout, stderr });
      }
      if (failure.signal) {
        return resolve({ code: EXIT.killed, stdout, stderr: `${stderr}`.trim() });
      }
      resolve({
        code: EXIT.notInstalled,
        stdout,
        // ENOENT is the ordinary case and its default sentence is the right
        // one, so say nothing extra. Anything else (EACCES on a file that lost
        // its executable bit, say) needs the errno to be diagnosable at all.
        stderr: failure.code === 'ENOENT' ? '' : `Could not run the on-device transcriber (${failure.code}).`,
      });
    });
  });

export interface AppleSttOptions {
  /**
   * Where the helper might be, most likely first.
   *
   * A list rather than a path for the same reason the character loader takes
   * one: packaged it sits beside the asar, and in development it depends on
   * whether Electron was started as `electron .` or `electron out/main`.
   */
  binaryPaths: string[];
  /** BCP-47. Whatever the user dictates in, not whatever the UI is in. */
  locale?: string;
  run?: Run;
  afconvertPath?: string;
}

interface RawResult {
  code: number;
  transcript?: string;
  confidence?: number;
  error?: string;
}

/**
 * The `.app` around the helper binary.
 *
 * `open` takes a bundle, not an executable. The binary always lives at
 * `<name>.app/Contents/MacOS/<name>`, so the bundle is two directories up —
 * derived rather than configured, so the two cannot drift apart.
 */
export function bundleFor(binaryPath: string): string {
  const marker = '.app/Contents/MacOS/';
  const at = binaryPath.indexOf(marker);
  return at === -1 ? binaryPath : binaryPath.slice(0, at + '.app'.length);
}

export function createAppleStt(options: AppleSttOptions): SttProvider {
  const run = options.run ?? spawn;
  const afconvert = options.afconvertPath ?? '/usr/bin/afconvert';
  const locale = options.locale ?? 'en-US';

  return {
    id: 'apple',

    async transcribe(audio, mimeType): Promise<Transcript> {
      const plan = conversionFor(mimeType);
      if (plan.kind === 'unsupported') throw new Error(plan.reason);

      const binary = options.binaryPaths.find((path) => existsSync(path));
      /*
       * Checked here rather than left to `open`, which reports a missing bundle
       * as a raw NSCocoaErrorDomain 260 with a temp path in it. That is a
       * sentence about Apple's file API, not about what the user should do —
       * and "run the native build step" is something they can act on.
       */
      if (!binary) throw new Error(describeFailure(EXIT.notInstalled, ''));

      /*
       * A temp directory, not a temp file.
       *
       * The recogniser takes a URL, so the bytes have to land on disk however
       * much one would rather they did not — but a directory of our own means
       * the conversion output lands there too, and one `rm -r` in `finally`
       * cannot miss a file. Utterances are not left behind in /tmp for whatever
       * indexes it next.
       */
      const dir = await mkdtemp(join(tmpdir(), 'anna-stt-'));
      try {
        const source = join(dir, `utterance.${plan.extension}`);
        await writeFile(source, audio);

        let target = source;
        if (plan.kind === 'convert') {
          target = join(dir, 'utterance.converted.wav');
          const converted = await run(afconvert, [
            '-f', 'WAVE',
            '-d', 'LEI16@16000',
            '-c', '1',
            source,
            target,
          ]);
          if (converted.code !== 0) {
            throw new Error(
              `Could not convert that recording for on-device transcription: ${
                converted.stderr.trim() || `afconvert exited ${converted.code}`
              }`,
            );
          }
        }

        /*
         * Launched through `open`, not spawned directly.
         *
         * macOS resolves speech-recognition permission against the
         * **responsible process**, which for an ordinary child is whatever
         * launched the app — a terminal, an IDE, a build tool. TCC then looks
         * for `NSSpeechRecognitionUsageDescription` in *that* bundle, does not
         * find one, and aborts the helper with SIGABRT before its first line
         * runs. Confirmed from the crash report: `responsibleProc` was the
         * launching tool every time, never Anna, no matter how the helper was
         * signed or bundled.
         *
         * `open` hands the launch to launchd, so the helper becomes its own
         * responsible process and its own Info.plist is what TCC reads. That
         * also detaches it from our pipes, which is why the transcript comes
         * back through a file rather than stdout.
         */
        const resultFile = join(dir, 'result.json');
        const opened = await run('/usr/bin/open', [
          '-W',
          '-a',
          bundleFor(binary),
          '--args',
          target,
          resultFile,
          locale,
        ]);

        let payload: RawResult | null = null;
        try {
          payload = JSON.parse(await readFile(resultFile, 'utf8')) as RawResult;
        } catch {
          // No result file: the helper never got far enough to write one.
        }

        if (!payload) {
          const code = opened.code === 0 ? EXIT.killed : opened.code;
          throw new Error(describeFailure(code, opened.stderr));
        }
        if (payload.code !== 0) {
          throw new Error(payload.error ?? describeFailure(payload.code, ''));
        }
        return {
          text: (payload.transcript ?? '').trim(),
          confidence: payload.confidence ?? 1,
        };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {
          // A temp directory that outlives us is untidy, not broken, and
          // throwing here would replace a good transcript with a disk error.
        });
      }
    },
  };
}
