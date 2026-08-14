import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';

import {
  EXIT,
  conversionFor,
  createAppleStt,
  describeFailure,
  parseTranscript,
  type Run,
  type RunResult,
} from './apple-stt.ts';
import { encodeWav } from '../../core/speech/wav.ts';

const ok = (stdout: string, stderr = ''): RunResult => ({ code: 0, stdout, stderr });

/** Records what was spawned so the arguments can be asserted on. */
function recorder(reply: (file: string, args: string[]) => RunResult): {
  run: Run;
  calls: Array<{ file: string; args: string[] }>;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push({ file, args });
      return reply(file, args);
    },
  };
}

// ---------------------------------------------------------------------------
// Format conversion
// ---------------------------------------------------------------------------

test('WAV goes straight to the recogniser', () => {
  assert.deepEqual(conversionFor('audio/wav'), { kind: 'ready', extension: 'wav' });
});

test('the codecs parameter does not turn a known container into an unknown one', () => {
  // MediaRecorder reports `audio/webm;codecs=opus`, and the WAV the renderer
  // produces can pick up parameters the same way.
  assert.equal(conversionFor('audio/wav;codecs=1').kind, 'ready');
  assert.equal(conversionFor('AUDIO/WAV').kind, 'ready');
  assert.equal(conversionFor(' audio/wav ').kind, 'ready');
});

test('a compressed container is normalised before transcription', () => {
  assert.deepEqual(conversionFor('audio/mp4'), { kind: 'convert', extension: 'm4a' });
  assert.deepEqual(conversionFor('audio/mpeg'), { kind: 'convert', extension: 'mp3' });
});

test('WebM is rejected by name, because that is the one macOS truly cannot read', () => {
  const plan = conversionFor('audio/webm;codecs=opus');
  assert.equal(plan.kind, 'unsupported');
  // The whole reason the renderer converts. A generic "unsupported format" here
  // would send the next person to debug this straight to afconvert, which
  // cannot help: CoreAudio has no Matroska parser at all.
  assert.match(plan.kind === 'unsupported' ? plan.reason : '', /WebM/);
  assert.match(plan.kind === 'unsupported' ? plan.reason : '', /Matroska|afconvert/);
});

test('an unrecognised type is refused rather than guessed at', () => {
  const plan = conversionFor('application/octet-stream');
  assert.equal(plan.kind, 'unsupported');
  assert.match(plan.kind === 'unsupported' ? plan.reason : '', /application\/octet-stream/);
});

test('conversion runs afconvert to 16kHz mono and hands over its output', async () => {
  const { run, calls } = recorder((file) =>
    file.endsWith('afconvert') ? ok('') : ok('converted words'),
  );
  const stt = createAppleStt({ binaryPaths: ['/nowhere/anna-transcribe'], run });

  const result = await stt.transcribe(new Uint8Array([1, 2, 3]), 'audio/mp4');

  assert.equal(result.text, 'converted words');
  assert.equal(calls.length, 2, 'afconvert then the recogniser');
  const [conversion, recognition] = calls;
  assert.deepEqual(conversion?.args.slice(0, 6), ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']);
  assert.match(conversion?.args[6] ?? '', /utterance\.m4a$/);
  // The recogniser must be given the *converted* file, not the original.
  assert.match(recognition?.args[0] ?? '', /\.wav$/);
  assert.equal(recognition?.args[0], conversion?.args[7]);
});

test('WAV skips afconvert entirely', async () => {
  const { run, calls } = recorder(() => ok('already fine'));
  const stt = createAppleStt({ binaryPaths: ['/nowhere/anna-transcribe'], run });

  await stt.transcribe(encodeWav(new Float32Array(16), 16000), 'audio/wav');

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.args[0] ?? '', /utterance\.wav$/);
});

test('a failed conversion says so instead of blaming the recogniser', async () => {
  const { run } = recorder((file) =>
    file.endsWith('afconvert') ? { code: 1, stdout: '', stderr: "Couldn't open input file" } : ok(''),
  );
  const stt = createAppleStt({ binaryPaths: ['/nowhere/anna-transcribe'], run });

  await assert.rejects(
    () => stt.transcribe(new Uint8Array([1]), 'audio/mp4'),
    /convert.*Couldn't open input file/s,
  );
});

test('WebM never reaches a subprocess at all', async () => {
  const { run, calls } = recorder(() => ok(''));
  const stt = createAppleStt({ binaryPaths: ['/nowhere/anna-transcribe'], run });

  await assert.rejects(() => stt.transcribe(new Uint8Array([1]), 'audio/webm;codecs=opus'), /WebM/);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// The "not available" paths
// ---------------------------------------------------------------------------

test('a missing offline model explains how to install it', () => {
  const message = describeFailure(EXIT.modelUnavailable, '');
  assert.match(message, /offline speech model/i);
  assert.match(message, /Dictation/);
});

test('the helper voice wins over the generic one, because it knows the locale', () => {
  const said = 'The offline speech model for fr-FR is not installed.';
  assert.equal(describeFailure(EXIT.modelUnavailable, `${said}\n`), said);
});

test('a missing binary points at the build step rather than at the user', () => {
  assert.match(describeFailure(EXIT.notInstalled, ''), /build:native|different transcription/);
});

test('denied permission names the exact settings pane', () => {
  assert.match(describeFailure(EXIT.notAuthorized, ''), /Speech Recognition/);
});

test('an unknown exit code still produces a sentence', () => {
  assert.match(describeFailure(99, ''), /exit 99/);
});

test('the model-unavailable exit is surfaced as a rejection, not an empty transcript', async () => {
  const { run } = recorder(() => ({
    code: EXIT.modelUnavailable,
    stdout: '',
    stderr: 'The offline speech model for en-US is not installed.',
  }));
  const stt = createAppleStt({ binaryPaths: ['/nowhere/anna-transcribe'], run });

  // Silently returning "" would look identical to a quiet room, and Anna would
  // sit there saying nothing forever with no clue why.
  await assert.rejects(
    () => stt.transcribe(encodeWav(new Float32Array(16), 16000), 'audio/wav'),
    /offline speech model/,
  );
});

// ---------------------------------------------------------------------------
// Reading the transcript back
// ---------------------------------------------------------------------------

test('parseTranscript takes the words from stdout and the score from stderr', () => {
  assert.deepEqual(parseTranscript('Hello Anna, can you hear me?\n', 'confidence=0.93342143\n'), {
    text: 'Hello Anna, can you hear me?',
    confidence: 0.93342143,
  });
});

test('a missing score means no opinion, not no confidence', () => {
  // Reporting 0 here would let a caller discard a perfectly good transcript.
  assert.equal(parseTranscript('words', '').confidence, 1);
  assert.equal(parseTranscript('words', 'confidence=banana').confidence, 1);
});

test('a score outside 0..1 is clamped into the range the interface promises', () => {
  assert.equal(parseTranscript('x', 'confidence=1.4').confidence, 1);
});

test('an empty transcript is a normal answer', () => {
  // The VAD is an energy gate, so it fires on doors and coughs. The helper
  // exits 0 with nothing on stdout for those.
  assert.deepEqual(parseTranscript('\n', ''), { text: '', confidence: 1 });
});

test('stray log lines around the score do not confuse it', () => {
  assert.equal(parseTranscript('hi', 'some warning\nconfidence=0.5\n').confidence, 0.5);
});

// ---------------------------------------------------------------------------
// The real spawn
//
// These use no injected `run`, so they cover the execFile wiring itself — the
// part that has to tell a normal exit from a failed launch from a killed
// process, and that got all three wrong the first time.
// ---------------------------------------------------------------------------

/** Writes an executable stand-in for the Swift helper. */
async function fakeHelper(body: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'anna-fake-helper-'));
  const path = join(dir, 'anna-transcribe');
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('a real subprocess is spawned, read and parsed', async () => {
  const helper = await fakeHelper('echo "Hello Anna, can you hear me?"\necho "confidence=0.93" >&2');
  try {
    const stt = createAppleStt({ binaryPaths: [helper.path] });
    assert.deepEqual(await stt.transcribe(encodeWav(new Float32Array(8), 16000), 'audio/wav'), {
      text: 'Hello Anna, can you hear me?',
      confidence: 0.93,
    });
  } finally {
    await helper.cleanup();
  }
});

test('the temp file is cleaned up even when the helper fails', async () => {
  const helper = await fakeHelper('echo "$1" > "$TMPDIR/anna-stt-lastpath"\nexit 7');
  try {
    const stt = createAppleStt({ binaryPaths: [helper.path] });
    await assert.rejects(() => stt.transcribe(new Uint8Array([1]), 'audio/wav'));
    const leaked = (await readFile(join(tmpdir(), 'anna-stt-lastpath'), 'utf8')).trim();
    assert.ok(leaked.length > 0);
    // Utterances are the most private thing this app touches; none may survive
    // a failure.
    assert.equal(existsSync(leaked), false, `the recording was left at ${leaked}`);
  } finally {
    await helper.cleanup();
  }
});

test('a helper that cannot be launched is reported as missing, not as silence', async () => {
  const stt = createAppleStt({ binaryPaths: [join(tmpdir(), 'definitely-not-here-anna')] });
  await assert.rejects(
    () => stt.transcribe(encodeWav(new Float32Array(8), 16000), 'audio/wav'),
    /build:native|different transcription/,
  );
});

test('a helper killed by a signal is reported, not read as an empty room', async () => {
  // The TCC failure mode exactly: killed before it can print anything. Exit
  // code is absent here, and treating that as 0 made a hard failure look like
  // a user who never spoke.
  const helper = await fakeHelper('kill -ABRT $$');
  try {
    const stt = createAppleStt({ binaryPaths: [helper.path] });
    await assert.rejects(
      () => stt.transcribe(encodeWav(new Float32Array(8), 16000), 'audio/wav'),
      /permission description|stopped the transcriber/,
    );
  } finally {
    await helper.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

const BINARY = join(
  import.meta.dirname,
  '../../../native/build/anna-transcribe.app/Contents/MacOS/anna-transcribe',
);

/**
 * Opt-in, and not only because of the binary.
 *
 * TCC resolves a speech-recognition request against the *responsible* process,
 * which for anything started from a shell is the terminal — and no terminal
 * declares `NSSpeechRecognitionUsageDescription`, so the helper is killed with
 * SIGABRT before it runs a line. Packaged, the responsible process is Anna.app,
 * which does declare one, and it works. There is no way to make this pass on a
 * CI runner, so it is gated on a variable rather than left to fail mysteriously:
 *
 *     ANNA_NATIVE_STT_TEST=1 npm test
 *
 * run from a terminal that has itself been granted Speech Recognition.
 */
const runNative = process.env['ANNA_NATIVE_STT_TEST'] === '1' && existsSync(BINARY);

test(
  'the real recogniser transcribes real speech with no key and no network',
  { skip: runNative ? false : 'set ANNA_NATIVE_STT_TEST=1 and build native/ to run this' },
  async () => {
    // Synthesised rather than committed: a checked-in sample would be the only
    // binary asset in the repo, and `say` is on every Mac this can run on.
    const dir = await mkdtemp(join(tmpdir(), 'anna-stt-fixture-'));
    try {
      const spoken = join(dir, 'spoken.wav');
      await new Promise<void>((resolve, reject) => {
        execFile(
          'say',
          ['-o', spoken, '--data-format=LEI16@22050', 'hello Anna can you hear me'],
          (error) => (error ? reject(error) : resolve()),
        );
      });

      const stt = createAppleStt({ binaryPaths: [BINARY] });
      const result = await stt.transcribe(await readFile(spoken), 'audio/wav');

      assert.match(result.text, /hear me/i);
      assert.ok(result.confidence > 0.5, `low confidence: ${result.confidence}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
