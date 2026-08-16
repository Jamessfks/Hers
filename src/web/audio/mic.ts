/**
 * The hearing sense.
 *
 * The `AudioContext` is created at exactly 16kHz, which is the rate the Live
 * API wants. Browsers resample in the audio thread when the hardware differs,
 * and their resampler is better than anything worth writing here — so asking
 * for the right rate up front removes every line of resampling code from the
 * project, along with the clicks and the off-by-one buffer bugs that come with
 * it.
 *
 * Echo cancellation is left to the browser and is the reason Anna does not hear
 * herself. It works because her voice goes out through the same output device
 * the browser is cancelling against; a user on headphones gets it for free
 * either way.
 */

import workletUrl from './pcm-worklet.js?url';

import { INPUT_SAMPLE_RATE } from '../../shared/protocol.ts';

export interface MicOptions {
  /** Called with each chunk of PCM signed 16-bit little-endian, 16kHz mono. */
  onChunk(pcm: ArrayBuffer): void;
  /** 0..1, for the UI. Smoothed, not instantaneous. */
  onLevel(level: number): void;
}

export class Microphone {
  readonly #options: MicOptions;
  #context: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #node: AudioWorkletNode | null = null;
  #analyser: AnalyserNode | null = null;
  #levelTimer: number | null = null;
  #level = 0;

  constructor(options: MicOptions) {
    this.#options = options;
  }

  get active(): boolean {
    return this.#stream !== null;
  }

  async start(): Promise<void> {
    if (this.#stream) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    // Chrome starts a context suspended when there has been no user gesture.
    // Turning the microphone on is one, but resuming explicitly costs nothing
    // and covers the case where it was not.
    if (context.state === 'suspended') await context.resume();

    await context.audioWorklet.addModule(workletUrl);

    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => this.#options.onChunk(event.data);

    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;

    source.connect(node);
    source.connect(analyser);

    this.#stream = stream;
    this.#context = context;
    this.#node = node;
    this.#analyser = analyser;
    this.#startLevelMeter();

    // The user can also revoke the microphone from the browser's own UI, which
    // ends the track without telling us any other way.
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => void this.stop());
    }
  }

  async stop(): Promise<void> {
    if (this.#levelTimer !== null) {
      clearInterval(this.#levelTimer);
      this.#levelTimer = null;
    }
    this.#node?.port.close();
    this.#node?.disconnect();
    this.#analyser?.disconnect();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    await this.#context?.close().catch(() => undefined);

    this.#node = null;
    this.#analyser = null;
    this.#stream = null;
    this.#context = null;
    this.#level = 0;
    this.#options.onLevel(0);
  }

  #startLevelMeter(): void {
    const analyser = this.#analyser;
    if (!analyser) return;
    const samples = new Float32Array(analyser.fftSize);

    this.#levelTimer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      // Attack fast, release slow — a meter that falls as fast as it rises
      // flickers on every syllable.
      const target = Math.min(1, rms * 4);
      this.#level = target > this.#level ? target : this.#level * 0.82 + target * 0.18;
      this.#options.onLevel(this.#level);
    }, 50);
  }
}
