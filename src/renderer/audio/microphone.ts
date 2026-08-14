/**
 * Listening, with a voice-activity detector.
 *
 * Always-on transcription of an open mic is both expensive and creepy: it ships
 * every sound in the room to a vendor. Instead the renderer watches the input
 * level locally, starts recording when someone actually speaks, and stops after
 * a beat of silence. Nothing leaves the machine unless there was speech, and
 * what leaves is one utterance rather than a continuous stream.
 *
 * The detector is an energy gate with hysteresis, not a neural VAD. Two
 * thresholds rather than one is what stops it flickering on and off through the
 * natural gaps inside a sentence — the single most common bug in a homemade
 * VAD, and the reason so many voice UIs cut you off mid-thought.
 */

import { encodeWav, mixToMono } from '../../core/speech/wav.ts';

const OPEN_THRESHOLD = 0.035;
const CLOSE_THRESHOLD = 0.018;
/**
 * Silence this long ends the utterance.
 *
 * This sits directly in front of everything else Anna does, so it is spent
 * before the model has seen a single word. At 850ms it exceeded the entire
 * reply budget on its own. 420ms is short enough to stay out of the way and
 * long enough to survive the gap between clauses in ordinary speech; the
 * hysteresis in the gate below is what makes that safe.
 */
const HANG_MS = 420;
/** Ignore blips shorter than this: a cough, a keyboard, a chair. */
const MIN_UTTERANCE_MS = 320;

export interface MicrophoneOptions {
  onUtterance(audio: Uint8Array, mimeType: string): void;
  /**
   * Fired once speech is *confirmed*, so Anna can be interrupted.
   *
   * Deliberately not fired on the first loud sample. A keystroke, a chair or
   * her own voice through the speakers all cross the open threshold, and the
   * gate below discards anything shorter than MIN_UTTERANCE_MS — so firing
   * early meant she stopped dead mid-word with no transcript ever arriving,
   * leaving the session stuck in `listening` until the user typed.
   */
  onSpeechStarted(): void;
  /** True while Anna is speaking, so the room's echo of her is not a barge-in. */
  isSelfSpeaking?(): boolean;
}

export class Microphone {
  readonly #options: MicrophoneOptions;
  #stream: MediaStream | null = null;
  #context: AudioContext | null = null;
  #recorder: MediaRecorder | null = null;
  #chunks: Blob[] = [];
  #speaking = false;
  #confirmed = false;
  #startedAt = 0;
  #silenceSince = 0;
  #raf = 0;

  constructor(options: MicrophoneOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#stream) return;
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    this.#context = new AudioContext();
    const source = this.#context.createMediaStreamSource(this.#stream);
    const analyser = this.#context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    const mimeType = pickMimeType();

    const tick = (): void => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const sample of buffer) sum += sample * sample;
      const level = Math.sqrt(sum / buffer.length);
      this.#onLevel(level, mimeType);
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.#raf);
    this.#recorder?.state === 'recording' && this.#recorder.stop();
    this.#stream?.getTracks().forEach((track) => track.stop());
    void this.#context?.close();
    this.#stream = null;
    this.#context = null;
    this.#recorder = null;
  }

  #onLevel(level: number, mimeType: string): void {
    const now = performance.now();

    if (!this.#speaking && level > OPEN_THRESHOLD) {
      // Anna's own voice coming back through the speakers is not the user
      // interrupting. Echo cancellation helps but does not survive volume.
      if (this.#options.isSelfSpeaking?.()) return;
      this.#speaking = true;
      this.#confirmed = false;
      this.#startedAt = now;
      this.#silenceSince = 0;
      this.#beginRecording(mimeType);
      return;
    }

    if (!this.#speaking) return;

    if (level > CLOSE_THRESHOLD) {
      this.#silenceSince = 0;
      // Only now is this real speech rather than a cough or a keystroke —
      // and only now is it worth cutting Anna off.
      if (!this.#confirmed && now - this.#startedAt >= MIN_UTTERANCE_MS) {
        this.#confirmed = true;
        this.#options.onSpeechStarted();
      }
      return;
    }

    if (this.#silenceSince === 0) this.#silenceSince = now;
    if (now - this.#silenceSince < HANG_MS) return;

    this.#speaking = false;
    const duration = now - this.#startedAt;
    this.#endRecording(this.#confirmed && duration >= MIN_UTTERANCE_MS, mimeType);
    this.#confirmed = false;
  }

  #beginRecording(mimeType: string): void {
    if (!this.#stream) return;
    this.#chunks = [];
    this.#recorder = new MediaRecorder(this.#stream, mimeType ? { mimeType } : undefined);
    this.#recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.#chunks.push(event.data);
    };
    this.#recorder.start();
  }

  #endRecording(keep: boolean, mimeType: string): void {
    const recorder = this.#recorder;
    if (!recorder) return;
    recorder.onstop = async () => {
      if (!keep) return;
      const blob = new Blob(this.#chunks, { type: mimeType });
      const utterance = await toWav(await blob.arrayBuffer(), mimeType);
      this.#options.onUtterance(utterance.bytes, utterance.mimeType);
    };
    if (recorder.state === 'recording') recorder.stop();
    this.#recorder = null;
  }
}

/** The first container both MediaRecorder and the transcribers accept. */
function pickMimeType(): string {
  for (const candidate of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

/**
 * What the recogniser actually wants. Speech carries nothing above 8kHz that a
 * transcriber uses, so this is the Nyquist floor rather than a compromise, and
 * it is a third of the bytes of the 48kHz the microphone hands us.
 */
const TARGET_SAMPLE_RATE = 16000;

/**
 * Turns the recording into plain PCM before it leaves the renderer.
 *
 * This is the seam that makes free, offline transcription possible at all.
 * MediaRecorder on macOS gives WebM/Opus, and CoreAudio — which is what
 * `SFSpeechRecognizer` reads through — has no Matroska parser, so `afconvert` in
 * the main process cannot rescue it:
 *
 *     Error: Couldn't open input file ('typ?')
 *
 * The alternative was to stop using MediaRecorder and capture raw samples off a
 * ScriptProcessorNode instead. That skips the encode/decode round trip, but it
 * replaces a recording path that works with a deprecated node and a silent
 * gain-zero sink to keep it pulling, for a quality difference no recogniser can
 * hear. Decoding what MediaRecorder produced leaves the VAD and the recorder
 * exactly as they were.
 *
 * `OfflineAudioContext` rather than a plain `AudioContext`: decoding needs no
 * output device, and opening one here would take a hardware audio unit for the
 * length of the decode while Anna may be mid-sentence on the same device.
 *
 * On failure the original bytes go out unchanged. Deepgram and OpenAI both read
 * WebM happily, so a user on a paid provider must not lose their voice input
 * because a decode the on-device path needed did not work.
 */
async function toWav(
  recorded: ArrayBuffer,
  mimeType: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  // Copy first. decodeAudioData *detaches* the buffer it is handed, so reading
  // `recorded` in the catch below would yield zero bytes — a fallback that
  // silently sends an empty utterance is worse than no fallback at all.
  const original = new Uint8Array(recorded.slice(0));
  try {
    const context = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
    const decoded = await context.decodeAudioData(recorded);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
      decoded.getChannelData(index),
    );
    // Read the rate off the buffer rather than assuming the context imposed it.
    // decodeAudioData is specified to resample to the context rate, and Chromium
    // does — but a header that disagrees with its samples is a bug that presents
    // as a chipmunk voice and an empty transcript, and this costs one property.
    return { bytes: encodeWav(mixToMono(channels), decoded.sampleRate), mimeType: 'audio/wav' };
  } catch {
    return { bytes: original, mimeType };
  }
}
