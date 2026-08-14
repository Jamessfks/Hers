/**
 * Voice.
 *
 * The interface is a stream of PCM rather than a finished audio file, for two
 * reasons that both come down to the same thing — a companion cannot pause.
 *
 *  1. Time to first audio. A file endpoint returns nothing until the last
 *     sample is generated. A stream returns the first 40ms almost immediately,
 *     and Anna starts talking while the rest is still being made.
 *  2. Lip sync. Raw samples give the renderer an amplitude envelope for free.
 *     Deriving mouth shapes from a decoded MP3 means decoding the whole MP3
 *     first, which puts us back at (1).
 *
 * Every adapter normalises to mono `Float32Array` in [-1, 1] and declares its
 * sample rate. Nothing above this layer knows about base64, s16le, or which
 * vendor charges extra for PCM.
 */

export interface AudioChunk {
  pcm: Float32Array;
  sampleRate: number;
}

export interface SynthesisRequest {
  text: string;
  /** Provider-specific voice identifier, chosen in settings. */
  voiceId: string;
  /**
   * A hint about delivery, derived from Anna's expression directives. Providers
   * that cannot honour it ignore it; none of them fail because of it.
   */
  emotion?: string;
  /** Cancelled when the user interrupts. */
  signal?: AbortSignal;
}

export interface TtsProvider {
  readonly id: string;
  readonly label: string;
  /** Roughly how long until the first sample, from the vendor's own numbers. */
  readonly typicalFirstByteMs: number;
  synthesize(request: SynthesisRequest): AsyncIterable<AudioChunk>;
  /** Voices to offer in settings. Fetched live where the API allows it. */
  listVoices(): Promise<Array<{ id: string; name: string; description?: string }>>;
}

export class TtsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly provider?: string,
  ) {
    super(message);
    this.name = 'TtsError';
  }
}

// ---------------------------------------------------------------------------
// Sample-format helpers, shared by every adapter
// ---------------------------------------------------------------------------

/** Signed 16-bit little-endian to float. The most common vendor wire format. */
export function s16leToFloat32(bytes: Uint8Array): Float32Array {
  const usable = bytes.length - (bytes.length % 2);
  const out = new Float32Array(usable / 2);
  for (let i = 0; i < out.length; i += 1) {
    const lo = bytes[i * 2] ?? 0;
    const hi = bytes[i * 2 + 1] ?? 0;
    const value = (hi << 8) | lo;
    // Interpret as signed, then scale. 0x8000 maps to -1.
    out[i] = ((value & 0x8000) !== 0 ? value - 0x10000 : value) / 0x8000;
  }
  return out;
}

/** 32-bit float little-endian, copied to guarantee alignment. */
export function f32leToFloat32(bytes: Uint8Array): Float32Array {
  const usable = bytes.length - (bytes.length % 4);
  const copy = new Uint8Array(usable);
  copy.set(bytes.subarray(0, usable));
  return new Float32Array(copy.buffer);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Buffers a byte stream and hands back only whole frames.
 *
 * A chunked HTTP response splits wherever the network feels like it, which for
 * 16-bit audio means a chunk can end on the low byte of a sample. Decoding that
 * chunk in isolation drops a sample and shifts every subsequent one by a byte,
 * which sounds like loud static rather than like a missing sample — an
 * unmistakable bug that is very easy to write.
 */
export class FrameAligner {
  #carry = new Uint8Array(0);

  constructor(private readonly frameBytes: number) {}

  push(bytes: Uint8Array): Uint8Array {
    const joined = new Uint8Array(this.#carry.length + bytes.length);
    joined.set(this.#carry);
    joined.set(bytes, this.#carry.length);
    const usable = joined.length - (joined.length % this.frameBytes);
    this.#carry = joined.subarray(usable);
    return joined.subarray(0, usable);
  }
}
