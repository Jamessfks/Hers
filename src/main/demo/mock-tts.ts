/**
 * A voice that costs nothing: macOS's own speech synthesiser.
 *
 * This exists so the whole pipeline can be run, watched and demonstrated
 * without a single API key — and, less obviously, so it can be *developed*
 * without one. Every change to the turn loop, the clause chunking, the audio
 * scheduler or the lip sync used to need a paid Cartesia request per iteration.
 *
 * It is a real `TtsProvider`, not a stub: it returns genuine PCM with genuine
 * spectral content, which means the amplitude envelope and the formant-band
 * viseme estimation both work exactly as they do against a paid voice. A silent
 * or tone-generated mock would have proved neither.
 *
 * It is deliberately *not* offered in the settings window. `say` sounds like
 * 2005 and Anna deserves better; this is a development and demonstration
 * backend, reached with ANNA_DEMO=1.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { s16leToFloat32, type AudioChunk, type SynthesisRequest, type TtsProvider } from '../../core/speech/types.ts';

const run = promisify(execFile);

/** `say` emits 16-bit little-endian at whatever rate we ask for. */
const SAMPLE_RATE = 22050;
/** Samples per yielded chunk — about 90ms, close to a real provider's frame. */
const CHUNK_SAMPLES = 2048;

/**
 * Delivery notes, mapped from Anna's own expression directives.
 *
 * `say` has no emotion model, but it does take a rate, and the difference
 * between a line delivered at 190 and one at 155 words per minute is the
 * difference between amused and tender. It is a crude instrument played
 * honestly.
 */
const RATE_FOR_EMOTION: Record<string, number> = {
  amused: 200,
  playful: 205,
  surprised: 210,
  smirk: 185,
  warm: 175,
  happy: 195,
  neutral: 185,
  thoughtful: 160,
  skeptical: 170,
  concerned: 158,
  sad: 150,
  tender: 148,
};

export function createSayTts(defaultVoice = 'Samantha'): TtsProvider {
  return {
    id: 'macos-say',
    label: 'macOS system voice (demo)',
    typicalFirstByteMs: 220,

    async *synthesize(request: SynthesisRequest): AsyncIterable<AudioChunk> {
      const text = request.text.trim();
      if (!text) return;

      const dir = await mkdtemp(join(tmpdir(), 'anna-say-'));
      const file = join(dir, 'clause.wav');
      const rate = RATE_FOR_EMOTION[request.emotion ?? 'neutral'] ?? 185;

      try {
        await run('/usr/bin/say', [
          '-v',
          request.voiceId || defaultVoice,
          '-r',
          String(rate),
          '-o',
          file,
          '--data-format',
          `LEI16@${SAMPLE_RATE}`,
          // `--` so a line beginning with a hyphen is not read as a flag.
          '--',
          text,
        ]);

        if (request.signal?.aborted) return;
        const pcm = decodeWav(await readFile(file));

        // Yielded in frames rather than as one buffer, so the demo exercises
        // the same streaming path a real provider does — including the
        // scheduler's gapless handoff between chunks.
        for (let offset = 0; offset < pcm.length; offset += CHUNK_SAMPLES) {
          if (request.signal?.aborted) return;
          yield {
            pcm: pcm.subarray(offset, Math.min(offset + CHUNK_SAMPLES, pcm.length)),
            sampleRate: SAMPLE_RATE,
          };
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },

    async listVoices() {
      try {
        const { stdout } = await run('/usr/bin/say', ['-v', '?']);
        return stdout
          .split('\n')
          .map((line) => /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#\s*(.*)$/.exec(line))
          .filter((match): match is RegExpExecArray => match !== null)
          .filter((match) => match[2]?.startsWith('en'))
          .map((match) => ({
            id: match[1]!.trim(),
            name: `${match[1]!.trim()} (${match[2]})`,
            description: match[3]?.trim() ?? '',
          }));
      } catch {
        return [{ id: defaultVoice, name: defaultVoice }];
      }
    },
  };
}

/**
 * Pulls the samples out of a WAV file.
 *
 * Deliberately finds the `data` chunk rather than assuming it starts at byte
 * 44. That assumption holds for the simplest writers and quietly produces a
 * burst of noise at the start of every clause for anything that emits a `LIST`
 * or `fact` chunk first — which macOS sometimes does.
 */
export function decodeWav(buffer: Uint8Array): Float32Array {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(...buffer.subarray(offset, offset + 4));

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    // Not a WAV at all: treat it as raw samples rather than throwing, since the
    // only caller is a demo and silence is friendlier than a crash.
    return s16leToFloat32(buffer);
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'data') {
      return s16leToFloat32(buffer.subarray(body, Math.min(body + size, buffer.length)));
    }
    // Chunks are word-aligned; an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }
  return new Float32Array(0);
}
