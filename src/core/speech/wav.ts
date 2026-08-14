/**
 * WAV, because CoreAudio has never heard of WebM.
 *
 * The renderer records with `MediaRecorder`, and on macOS that means
 * WebM/Opus — the only container Chromium reliably offers. macOS's own
 * recogniser reads audio through `AVAudioFile`, and CoreAudio's format table has
 * no Matroska parser at all:
 *
 *     $ afconvert -f WAVE -d LEI16@16000 -c 1 recording.webm out.wav
 *     Error: Couldn't open input file ('typ?')     # kAudioFileUnsupportedFileTypeError
 *
 * So the obvious fix — pipe the blob through `afconvert` in the main process —
 * cannot work, no matter which flags it is given. Something has to decode Opus,
 * and the only Opus decoder on the machine that is already loaded is the one
 * inside the renderer. `decodeAudioData` gives back raw samples; this turns them
 * into the plainest possible container, and everything downstream stops caring
 * what was recorded.
 *
 * 16-bit PCM rather than float: it is what every speech recogniser wants, it
 * halves what crosses IPC, and no ASR model on earth can hear the difference.
 */

/**
 * Wraps mono samples in a canonical 44-byte RIFF header.
 *
 * Samples outside -1..1 are clamped rather than allowed to wrap. Overflow in
 * two's complement turns a loud vowel into an inverted spike, which sounds like
 * a click to a person and reads as a consonant to a recogniser — a rare bug that
 * only shows up on the utterances someone shouted, which are exactly the ones
 * they most want understood.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // fmt chunk length
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    // Asymmetric on purpose: the signed 16-bit range is -32768..32767, so the
    // two directions genuinely have different headroom.
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Uint8Array(bytes);
}

/**
 * Averages channels down to one.
 *
 * `getUserMedia` usually hands back mono, but "usually" is doing a lot of work:
 * an aggregate device, a USB interface or a Continuity mic can all produce two,
 * and a stereo buffer written into a header that claims mono plays back at
 * double speed — which a recogniser hears as chipmunk noise and transcribes as
 * nothing at all.
 */
export function mixToMono(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;

  const mono = new Float32Array(first.length);
  for (let i = 0; i < mono.length; i += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    mono[i] = sum / channels.length;
  }
  return mono;
}
