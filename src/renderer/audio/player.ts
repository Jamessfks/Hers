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

/**
 * Formant bands, in Hz.
 *
 * A mouth driven by loudness alone is a hinge: it opens by the same amount for
 * "ee" as for "oh", which is the single most recognisable tell of a cheap rig.
 * Real viseme extraction needs phonemes, which needs either a forced aligner or
 * a TTS that returns timings — not available across all three voices we
 * support. But the *vowel* is legible in the spectrum without any of that: F1
 * tracks how open the jaw is and F2 tracks how far forward the tongue is, and
 * the ratio between two band energies separates the three mouth shapes a
 * viewer can actually distinguish at conversational distance.
 *
 * This is what browser lip-sync libraries do, and it costs one extra FFT read
 * per frame on an analyser that is already running.
 */
const BAND = {
  /** F1 region: open vs closed jaw. */
  low: [280, 900],
  /** F2 region: front vs back tongue. */
  mid: [900, 2600],
  /** Fricatives and sibilants: s, sh, f, t. */
  high: [3200, 8000],
} as const;

export interface Viseme {
  /** Open jaw, as in "father". */
  aa: number;
  /** Spread and narrow, as in "see". */
  ih: number;
  /** Rounded, as in "boot". */
  ou: number;
  /** Teeth-and-air consonants; mostly closes the jaw without silencing it. */
  ss: number;
}

export class SpeechPlayer {
  #context: AudioContext | null = null;
  #gain: GainNode | null = null;
  #analyser: AnalyserNode | null = null;
  #envelopeBuffer = new Float32Array(1024);
  #spectrumBuffer = new Float32Array(1024);
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
    this.#spectrumBuffer = new Float32Array(analyser.frequencyBinCount);
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

  /**
   * Estimates the mouth shape from the current spectrum.
   *
   * Returns weights that sum to roughly 1 when there is speech and to 0 in
   * silence, so the caller can scale them by the amplitude envelope and get a
   * mouth that both opens the right amount *and* opens the right way.
   *
   * The mapping, in plain terms: energy low in the spectrum and little above it
   * is a rounded "ou"; energy spread up into the F2 band is a spread "ih"; a
   * strong low band with moderate mid is an open "aa"; and a spike in the top
   * band without much below it is a fricative, which closes the jaw to a slit
   * rather than opening it.
   */
  viseme(): Viseme {
    const analyser = this.#analyser;
    const context = this.#context;
    if (!analyser || !context || !this.speaking) return { aa: 0, ih: 0, ou: 0, ss: 0 };

    analyser.getFloatFrequencyData(this.#spectrumBuffer);
    const hzPerBin = context.sampleRate / analyser.fftSize;

    const bandEnergy = ([from, to]: readonly [number, number]): number => {
      const start = Math.max(1, Math.floor(from / hzPerBin));
      const end = Math.min(this.#spectrumBuffer.length - 1, Math.ceil(to / hzPerBin));
      let sum = 0;
      let count = 0;
      for (let i = start; i <= end; i += 1) {
        // getFloatFrequencyData is in dBFS; -100 is the analyser's floor.
        const db = this.#spectrumBuffer[i] ?? -100;
        sum += Math.max(0, (db + 100) / 100);
        count += 1;
      }
      return count > 0 ? sum / count : 0;
    };

    const low = bandEnergy(BAND.low);
    const mid = bandEnergy(BAND.mid);
    const high = bandEnergy(BAND.high);
    const total = low + mid + high;
    if (total < 0.05) return { aa: 0, ih: 0, ou: 0, ss: 0 };

    const lowShare = low / total;
    const midShare = mid / total;
    const highShare = high / total;

    // Fricative: disproportionate top-band energy.
    const ss = clamp01((highShare - 0.28) * 3);
    const voiced = 1 - ss;

    // Among voiced frames, split by where the energy sits.
    const openness = clamp01((lowShare - 0.3) * 2.4);
    const frontness = clamp01((midShare - 0.28) * 2.6);

    const aa = voiced * openness * (1 - frontness);
    const ih = voiced * frontness;
    const ou = voiced * clamp01(1 - openness - frontness);

    const sum = aa + ih + ou + ss;
    if (sum <= 0) return { aa: 0, ih: 0, ou: 0, ss: 0 };
    return { aa: aa / sum, ih: ih / sum, ou: ou / sum, ss: ss / sum };
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
