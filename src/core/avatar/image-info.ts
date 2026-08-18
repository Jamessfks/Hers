/**
 * What a photograph actually is, read from its bytes.
 *
 * The format and the shape both have to be read from the bytes, and neither can
 * be taken on trust from the file name. The first photograph handed to this app
 * had a `.png` name and contained JPEG bytes — `ffd8ffe0`, JFIF, baseline. That
 * is not an exotic case, it is what happens every time someone renames a file or
 * saves one out of a tool that ignores the extension, and everything local that
 * believes the extension breaks on it, starting with the `<img>` the photograph
 * is displayed in. The dimensions are needed for the same reason: the interface
 * sizes her portrait from them, and a wrong pair is a visibly wrong shape.
 *
 * Parsing headers by hand rather than adding an image library: this reads a few
 * dozen bytes from the front of three formats, it runs in main with no DOM, and
 * the alternative is a dependency and a native build step for information that
 * is sitting in the first sixteen bytes of the file.
 */

/** The formats worth accepting as a source photograph. */
export type ImageFormat = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ImageInfo {
  mimeType: ImageFormat;
  width: number;
  height: number;
}

/**
 * Reads the format and pixel dimensions, or null when these are not the bytes
 * of an image this app can use.
 *
 * Null is a real answer and callers must handle it: someone will drop a PDF, a
 * HEIC straight off an iPhone, or a 40-byte truncated download.
 */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  return readJpeg(bytes) ?? readPng(bytes) ?? readWebp(bytes);
}

/**
 * JPEG: walk the segment chain to the frame header.
 *
 * The dimensions are not at a fixed offset — they live in the SOFn segment,
 * which sits after a variable number of other segments (JFIF, EXIF, quantisation
 * tables, and in a photo out of a generator, often a large comment). So the
 * markers have to be walked. The alternative — assuming SOF0 is at offset 158,
 * which holds for a lot of files — is exactly the kind of thing that works on
 * every test image and fails on the user's.
 */
function readJpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1; // Fill byte or padding; resynchronise on the next marker.
      continue;
    }
    const marker = bytes[at + 1]!;
    // Standalone markers: no length field, so do not try to skip one.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // End of image, or scan data.

    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;

    // SOF0..SOF15 carry the dimensions. C4, C8 and CC are in that numeric range
    // but are Huffman tables, extensions and arithmetic-coding tables, not
    // frames — reading dimensions out of one gives plausible garbage.
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return {
        mimeType: 'image/jpeg',
        height: (bytes[at + 5]! << 8) | bytes[at + 6]!,
        width: (bytes[at + 7]! << 8) | bytes[at + 8]!,
      };
    }

    if (length < 2) return null; // Malformed: would loop forever.
    at += 2 + length;
  }
  return null;
}

function readPng(bytes: Uint8Array): ImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((byte, index) => bytes[index] !== byte)) return null;
  // IHDR is required by the spec to be the first chunk, so this offset is safe.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24) return null;
  return {
    mimeType: 'image/png',
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}

/**
 * WebP: three sub-formats, three different places to find the size.
 *
 * Included because it is what a right-click-save from most of the web now
 * produces, and getting a lossless or animated one wrong means reporting the
 * dimensions of a lossy file that is not there.
 */
function readWebp(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 30) return null;
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = tag(12);

  if (kind === 'VP8 ') {
    return { mimeType: 'image/webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (kind === 'VP8L') {
    // 14 bits each, packed across four bytes, and one less than the real size.
    const packed = view.getUint32(21, true);
    return {
      mimeType: 'image/webp',
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    };
  }
  if (kind === 'VP8X') {
    const dimension = (at: number): number =>
      (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)) + 1;
    return { mimeType: 'image/webp', width: dimension(24), height: dimension(27) };
  }
  return null;
}
