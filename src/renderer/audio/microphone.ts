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
      const bytes = new Uint8Array(await blob.arrayBuffer());
      this.#options.onUtterance(bytes, mimeType);
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
