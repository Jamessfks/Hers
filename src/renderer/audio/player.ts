/**
 * Gapless PCM playback with an amplitude tap for lip sync.
 *
 * Chunks arrive from the main process faster than real time and out of step
 * with the clause boundaries, so each one is scheduled against a running
 * playhead rather than played on arrival. Scheduling on arrival produces
 * audible gaps between chunks — the classic "streaming TTS stutter" — because
 * the browser cannot start a source at exactly the moment the previous one
 * ended when the decision is made from a timer callback.
 *
 * The playhead is nudged forward if it ever falls behind the clock, which
 * happens when the network stalls mid-sentence. Without that guard the audio
 * would try to schedule in the past and every subsequent chunk would pile up at
 * `currentTime`, playing all at once.
 */

const LOOKAHEAD_SECONDS = 0.04;

export class SpeechPlayer {
  #context: AudioContext | null = null;
  #gain: GainNode | null = null;
  #analyser: AnalyserNode | null = null;
  #envelopeBuffer = new Float32Array(1024);
  #playhead = 0;
  #sources = new Set<AudioBufferSourceNode>();

  /** Created lazily: an AudioContext made before a user gesture starts suspended. */
  #ensure(): { context: AudioContext; gain: GainNode; analyser: AnalyserNode } {
    if (this.#context && this.#gain && this.#analyser) {
      return { context: this.#context, gain: this.#gain, analyser: this.#analyser };
    }
    const context = new AudioContext();
    const gain = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    gain.connect(analyser);
    analyser.connect(context.destination);
    this.#context = context;
    this.#gain = gain;
    this.#analyser = analyser;
    this.#envelopeBuffer = new Float32Array(analyser.fftSize);
    return { context, gain, analyser };
  }

  async resume(): Promise<void> {
    const { context } = this.#ensure();
    if (context.state === 'suspended') await context.resume();
  }

  enqueue(pcm: Float32Array, sampleRate: number): void {
    if (pcm.length === 0) return;
    const { context, gain } = this.#ensure();

    const buffer = context.createBuffer(1, pcm.length, sampleRate);
    // The PCM crosses an IPC boundary, so its backing buffer is typed as
    // ArrayBufferLike; copyToChannel wants a plain ArrayBuffer view.
    buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);

    const startAt = Math.max(this.#playhead, context.currentTime + LOOKAHEAD_SECONDS);
    source.start(startAt);
    this.#playhead = startAt + buffer.duration;

    this.#sources.add(source);
    source.onended = () => this.#sources.delete(source);
  }

  /** Cuts playback instantly. Called on barge-in. */
  stop(): void {
    for (const source of this.#sources) {
      try {
        source.stop();
      } catch {
        // Already finished; nothing to do.
      }
    }
    this.#sources.clear();
    this.#playhead = this.#context?.currentTime ?? 0;
  }

  get speaking(): boolean {
    if (!this.#context) return false;
    return this.#sources.size > 0 && this.#playhead > this.#context.currentTime;
  }

  /**
   * Current loudness, 0 to 1, shaped for a mouth rather than for a VU meter.
   *
   * Raw RMS on speech sits low and barely moves — a mouth driven by it opens
   * about a fifth of the way and stays there. The curve below expands the range
   * that speech actually occupies and clips the rest.
   */
  energy(): number {
    const analyser = this.#analyser;
    if (!analyser || !this.speaking) return 0;
    analyser.getFloatTimeDomainData(this.#envelopeBuffer);

    let sum = 0;
    for (const sample of this.#envelopeBuffer) sum += sample * sample;
    const rms = Math.sqrt(sum / this.#envelopeBuffer.length);

    // Speech RMS lives roughly in [0.01, 0.25]. Map that onto [0, 1].
    const normalised = (rms - 0.01) / 0.24;
    return Math.min(1, Math.max(0, normalised) ** 0.65);
  }
}
