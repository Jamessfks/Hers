/**
 * Microphone capture, in the audio thread.
 *
 * Plain JavaScript and loaded by URL rather than bundled, because that is what
 * `AudioWorklet.addModule` takes — the file is evaluated in a separate global
 * scope with no DOM, no modules and no bundler runtime.
 *
 * Two things it does that a naive version does not:
 *
 *  1. **It batches.** `process` is called every 128 frames, which at 16kHz is
 *     every 8 milliseconds. Posting a message that often means 125 structured
 *     clones and 125 WebSocket frames a second, and the overhead of that is
 *     larger than the audio. Frames accumulate here until there are enough for
 *     a chunk worth sending.
 *
 *  2. **It converts to 16-bit here.** The conversion has to happen somewhere,
 *     and doing it in the audio thread halves the bytes crossing to the main
 *     thread and keeps the main thread free for rendering.
 */

/** Samples per message. 1024 at 16kHz is 64ms — small enough to feel live. */
const CHUNK = 1024;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(CHUNK);
    this.filled = 0;
    this.muted = false;
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.muted === 'boolean') this.muted = event.data.muted;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input is normal for a frame or two while a track is starting; it is
    // not a reason to tear the node down.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      // Clamped before scaling: a sample slightly outside [-1, 1] is legal in
      // Web Audio and would wrap to the opposite sign as an int16, which is
      // heard as a loud click rather than as clipping.
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.filled += 1;

      if (this.filled === CHUNK) {
        if (!this.muted) {
          const copy = this.buffer.slice(0);
          this.port.postMessage(copy.buffer, [copy.buffer]);
        }
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
