/**
 * Anna's voice, coming out of the speakers.
 *
 * Audio arrives as a stream of small PCM chunks with no timing information, and
 * the job is to play them back-to-back with no seam. The way that is done here
 * — and the reason it is not simply "play each chunk when it arrives" — is a
 * running `#nextStartAt` cursor in the audio clock's own timebase. Each chunk is
 * scheduled to begin exactly where the previous one ends, so gaps cannot open
 * up between them however irregularly they arrive off the network.
 *
 * Two failure modes it has to handle, both of which are audible:
 *
 *   underrun   The network fell behind and the cursor is now in the past.
 *              Scheduling there plays everything at once. The cursor is pushed
 *              back to now plus a small cushion instead, which costs a beat of
 *              silence and is the only correct answer.
 *   barge-in   She was cut off. Everything scheduled and not yet heard has to
 *              stop immediately — a companion who finishes her sentence over
 *              you is worse than one who says nothing.
 */

import { OUTPUT_SAMPLE_RATE } from '../../shared/protocol.ts';

/** Cushion between "now" and the earliest thing scheduled, in seconds. */
const LATENCY_PAD = 0.08;

export interface PlayerOptions {
  /** 0..1 amplitude of what is playing right now, for the UI. */
  onLevel(level: number): void;
}

export class Player {
  readonly #options: PlayerOptions;
  #context: AudioContext | null = null;
  #gain: GainNode | null = null;
  #analyser: AnalyserNode | null = null;
  #playing = new Set<AudioBufferSourceNode>();
  #nextStartAt = 0;
  #levelTimer: number | null = null;

  constructor(options: PlayerOptions) {
    this.#options = options;
  }

  /**
   * Must be called from a user gesture the first time.
   *
   * Browsers will not let audio start otherwise, and the failure is silent —
   * the context exists, sources schedule, nothing is heard.
   */
  async unlock(): Promise<void> {
    const context = this.#ensureContext();
    if (context.state === 'suspended') await context.resume();
  }

  enqueue(pcm: ArrayBuffer): void {
    if (pcm.byteLength < 2) return;
    const context = this.#ensureContext();
    const gain = this.#gain;
    if (!gain) return;

    const samples = new Int16Array(pcm);
    const buffer = context.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      channel[i] = (samples[i] ?? 0) / 0x8000;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);

    const earliest = context.currentTime + LATENCY_PAD;
    const startAt = Math.max(this.#nextStartAt, earliest);
    source.start(startAt);
    this.#nextStartAt = startAt + buffer.duration;

    this.#playing.add(source);
    source.onended = () => this.#playing.delete(source);
  }

  /** She was interrupted. Drop everything not yet heard. */
  flush(): void {
    for (const source of this.#playing) {
      try {
        source.stop();
      } catch {
        // Already finished between the check and the call.
      }
    }
    this.#playing.clear();
    this.#nextStartAt = 0;
  }

  get speaking(): boolean {
    return this.#playing.size > 0;
  }

  async close(): Promise<void> {
    this.flush();
    if (this.#levelTimer !== null) {
      clearInterval(this.#levelTimer);
      this.#levelTimer = null;
    }
    await this.#context?.close().catch(() => undefined);
    this.#context = null;
    this.#gain = null;
    this.#analyser = null;
  }

  #ensureContext(): AudioContext {
    if (this.#context) return this.#context;

    const context = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    const gain = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;

    gain.connect(analyser);
    analyser.connect(context.destination);

    this.#context = context;
    this.#gain = gain;
    this.#analyser = analyser;
    this.#nextStartAt = 0;
    this.#startLevelMeter();
    return context;
  }

  #startLevelMeter(): void {
    const analyser = this.#analyser;
    if (!analyser || this.#levelTimer !== null) return;
    const samples = new Float32Array(analyser.fftSize);

    this.#levelTimer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      this.#options.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3.5));
    }, 50);
  }
}
