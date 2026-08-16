/**
 * Her voice, packaged as a Telegram voice message.
 *
 * Telegram's `sendVoice` accepts `.OGG` encoded with Opus, `.MP3` or `.M4A`,
 * and only Ogg/Opus is rendered natively as a voice note — the round bubble
 * with a waveform, rather than a file attachment. So Ogg/Opus it is.
 *
 * The Live API hands us raw PCM, 24kHz signed 16-bit little-endian mono, which
 * is a rate Opus encodes natively. What is missing is the container, and a
 * container is exactly the kind of thing that either matches the specification
 * byte for byte or is rejected with no explanation. Every field below was read
 * out of the specifications rather than remembered:
 *
 *   RFC 3533 / xiph.org/ogg/doc/framing.html
 *     Page header layout, lacing values, and the checksum: "32 bit CRC value
 *     (direct algorithm, initial val and final XOR = 0, generator
 *     polynomial=0x04c11db7)", computed "over the entire header (with the CRC
 *     field in the header set to zero) and then continued over the page".
 *     Multi-byte fields are least significant byte first.
 *
 *   RFC 7845
 *     The OpusHead and OpusTags packets, and the rule that decides granule
 *     positions: they are counted "in units of PCM audio samples at a fixed
 *     rate of 48 kHz (per channel)" — regardless of the rate the audio was
 *     actually encoded at. Getting that wrong yields a file that plays at the
 *     wrong speed or reports the wrong duration rather than one that fails.
 *
 *     The ID header must be "placed alone (without any other packet data) on
 *     the first page", with the beginning-of-stream flag set, and the stream
 *     "ends with a page with the 'end of stream' flag set".
 */

import OpusScript from 'opusscript';

/**
 * What Gemini Live produces, and a rate Opus encodes without resampling.
 *
 * Typed as the literal so it satisfies opusscript's own union of valid rates —
 * Opus accepts 8, 12, 16, 24 and 48 kHz and nothing else.
 */
export const VOICE_SAMPLE_RATE = 24_000 as const;
/** Opus frame size. 20ms is the default and what every decoder handles best. */
const FRAME_MS = 20;
/** Granule positions are always in 48kHz samples, whatever the input rate is. */
const GRANULE_RATE = 48_000;
/**
 * Samples the decoder discards at the start.
 *
 * 312 at 48kHz is the figure `opusenc` writes for a 20ms frame at this
 * complexity, and it exists because the encoder's first frames carry filter
 * warm-up rather than audio. Too small and the clip starts with a click.
 */
const PRE_SKIP = 312;

// ---------------------------------------------------------------------------
// Ogg framing
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  // Direct, non-reflected, initial value and final XOR both zero.
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 0x80000000 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) & 0xff) ^ byte] ?? 0)) >>> 0;
  }
  return crc >>> 0;
}

interface PageOptions {
  packets: Uint8Array[];
  granule: bigint;
  serial: number;
  sequence: number;
  beginning?: boolean;
  end?: boolean;
}

/**
 * One Ogg page.
 *
 * Callers keep each page to at most 255 segments, which is the format's own
 * limit — a page's segment table is a single byte of count followed by that
 * many lacing values.
 */
function page(options: PageOptions): Buffer {
  const lacing: number[] = [];
  for (const packet of options.packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    // A packet whose length is a multiple of 255 is terminated by a zero, or
    // the decoder would keep reading into the next one.
    lacing.push(remaining);
  }

  const body = Buffer.concat(options.packets.map((packet) => Buffer.from(packet)));
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'ascii');
  header.writeUInt8(0, 4); // stream structure version
  header.writeUInt8((options.beginning ? 0x02 : 0) | (options.end ? 0x04 : 0), 5);
  header.writeBigUInt64LE(options.granule, 6);
  header.writeUInt32LE(options.serial, 14);
  header.writeUInt32LE(options.sequence, 18);
  header.writeUInt32LE(0, 22); // checksum, zero while computing
  header.writeUInt8(lacing.length, 26);
  for (const [index, value] of lacing.entries()) header.writeUInt8(value, 27 + index);

  const whole = Buffer.concat([header, body]);
  whole.writeUInt32LE(crc32(whole), 22);
  return whole;
}

/** RFC 7845 §5.1. */
function opusHead(channels: number, inputRate: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head.writeUInt8(1, 8); // version, MUST be 1
  head.writeUInt8(channels, 9);
  head.writeUInt16LE(PRE_SKIP, 10);
  head.writeUInt32LE(inputRate, 12);
  head.writeInt16LE(0, 16); // output gain, Q7.8 dB
  head.writeUInt8(0, 18); // channel mapping family 0: mono or stereo, no table
  return head;
}

/** RFC 7845 §5.2. */
function opusTags(): Buffer {
  const vendor = Buffer.from('anna', 'utf8');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length); // no user comments
  return tags;
}

// ---------------------------------------------------------------------------

/**
 * Turns raw PCM into an Ogg Opus file.
 *
 * `pcm` must be signed 16-bit little-endian mono at {@link VOICE_SAMPLE_RATE}.
 * Returns null rather than throwing: a voice note that cannot be built should
 * cost a voice note, and the text is sent either way.
 */
export function encodeOggOpus(
  pcm: Buffer,
  sampleRate: typeof VOICE_SAMPLE_RATE = VOICE_SAMPLE_RATE,
): Buffer | null {
  const samplesPerFrame = Math.round((sampleRate * FRAME_MS) / 1000);
  const bytesPerFrame = samplesPerFrame * 2;
  if (pcm.length < bytesPerFrame) return null;

  let encoder: OpusScript | null = null;
  try {
    encoder = new OpusScript(sampleRate, 1, OpusScript.Application.AUDIO);

    const frames: Uint8Array[] = [];
    for (let at = 0; at + bytesPerFrame <= pcm.length; at += bytesPerFrame) {
      // `subarray` would share the buffer; the encoder wants its own bytes.
      const frame = Buffer.from(pcm.subarray(at, at + bytesPerFrame));
      frames.push(Uint8Array.from(encoder.encode(frame, samplesPerFrame)));
    }
    if (frames.length === 0) return null;

    const serial = (Math.random() * 0xffffffff) >>> 0;
    const pages: Buffer[] = [
      // The ID header is alone on the first page, which carries `bos`.
      page({ packets: [opusHead(1, sampleRate)], granule: 0n, serial, sequence: 0, beginning: true }),
      page({ packets: [opusTags()], granule: 0n, serial, sequence: 1 }),
    ];

    // Granule positions count 48kHz samples however the audio was encoded.
    const granulePerFrame = BigInt(Math.round((GRANULE_RATE * FRAME_MS) / 1000));
    let sequence = 2;
    let granule = 0n;

    // 50 frames is one second of audio per page, comfortably inside the
    // 255-segment ceiling and small enough that a page stays a sane size.
    for (let at = 0; at < frames.length; at += 50) {
      const batch = frames.slice(at, at + 50);
      granule += granulePerFrame * BigInt(batch.length);
      const last = at + 50 >= frames.length;
      pages.push(page({ packets: batch, granule, serial, sequence, end: last }));
      sequence += 1;
    }

    return Buffer.concat(pages);
  } catch {
    return null;
  } finally {
    try {
      encoder?.delete();
    } catch {
      // Already released.
    }
  }
}

/** Seconds of audio in a PCM buffer, for Telegram's `duration` field. */
export function pcmSeconds(pcm: Buffer, sampleRate: number = VOICE_SAMPLE_RATE): number {
  return Math.max(1, Math.round(pcm.length / 2 / sampleRate));
}
