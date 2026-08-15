/**
 * Pulling frames out of a clip so the seam can be measured.
 *
 * This lives in the renderer because the renderer is the only process with a
 * video decoder. `core/avatar/seam.ts` does the arithmetic on decoded RGBA and
 * stays testable under plain Node; this is the part that needs Chromium.
 *
 * Seeking a `<video>` is fiddlier than it looks, and the fiddliness is the
 * reason this is a module rather than four lines at the call site:
 *
 *  - `duration` is `Infinity` until enough of the container has been parsed,
 *    and for a WebM written by MediaRecorder it can stay that way until you
 *    seek past the end once. Asking for "the last frame" before that gives you
 *    a seek to `Infinity`, which silently does nothing.
 *  - `seeked` fires before the new frame is necessarily painted. Drawing on the
 *    `seeked` handler alone can capture the *previous* frame, which for this
 *    purpose is a measurement of the wrong thing — and it is intermittent, so
 *    it looks like drift rather than like a bug.
 *  - The very last frame is not at `duration`; seeking there often lands past
 *    the final sample and yields a blank. Backing off one frame is required.
 */

import type { Frame } from '../../core/avatar/seam.ts';

/** Assumed frame rate when the container does not say. Only used for the back-off. */
const ASSUMED_FPS = 24;

export interface ClipFrames {
  first: Frame;
  last: Frame;
  /** Frames sampled across the hold window, for {@link bestCutFrame}. */
  hold: Array<{ index: number; frame: Frame }>;
  durationSeconds: number;
}

export interface ExtractOptions {
  /** Where the hold begins, as a fraction of the clip. */
  holdStart?: number;
  /** How many frames to sample from the hold when searching for a cut point. */
  holdSamples?: number;
}

/**
 * Decodes the frames needed to judge a clip.
 *
 * The URL must be same-origin or a blob; a cross-origin video taints the canvas
 * and `getImageData` throws, which would turn a measurement into an exception
 * at the worst possible moment.
 */
export async function extractClipFrames(
  url: string,
  options: ExtractOptions = {},
): Promise<ClipFrames> {
  const holdStart = options.holdStart ?? 0.55;
  const holdSamples = Math.max(1, options.holdSamples ?? 6);

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    const duration = await loadDuration(video);
    const step = 1 / ASSUMED_FPS;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not get a 2D context to read clip frames.');

    const grab = async (time: number): Promise<Frame> => {
      await seekTo(video, Math.max(0, Math.min(duration - step / 2, time)));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      return { width: image.width, height: image.height, data: image.data };
    };

    const first = await grab(0);
    // One frame back from the end: seeking to `duration` itself frequently
    // lands past the final sample and paints nothing.
    const last = await grab(duration - step);

    const hold: Array<{ index: number; frame: Frame }> = [];
    const from = duration * holdStart;
    const span = Math.max(0, duration - step - from);
    for (let i = 0; i < holdSamples; i += 1) {
      const at = from + (span * i) / Math.max(1, holdSamples - 1);
      hold.push({ index: Math.round(at * ASSUMED_FPS), frame: await grab(at) });
    }

    return { first, last, hold, durationSeconds: duration };
  } finally {
    // Release the decoder and the blob's reference promptly; a handful of
    // undisposed videos is tens of megabytes of decoded frames.
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

/**
 * Waits for a real duration.
 *
 * MediaRecorder's WebM reports `Infinity` until it has been seeked past the
 * end. The seek-to-huge trick below is the standard workaround and is why this
 * is not simply `await metadata`.
 */
function loadDuration(video: HTMLVideoElement): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('That clip could not be decoded.'));
    video.addEventListener('error', fail, { once: true });

    video.addEventListener(
      'loadedmetadata',
      () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          resolve(video.duration);
          return;
        }
        const onSeeked = (): void => {
          video.removeEventListener('seeked', onSeeked);
          video.currentTime = 0;
          resolve(Number.isFinite(video.duration) ? video.duration : 0);
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = Number.MAX_SAFE_INTEGER;
      },
      { once: true },
    );
  });
}

/**
 * Seeks, and waits until the frame is actually on screen.
 *
 * `seeked` means the seek completed, not that the new frame has been painted —
 * drawing on `seeked` alone intermittently captures the previous frame.
 * `requestVideoFrameCallback` fires when a frame is genuinely presented, which
 * is the guarantee this needs; the rAF pair is the fallback where it is absent.
 */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve();
    video.addEventListener(
      'seeked',
      () => {
        const withCallback = video as HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
        };
        if (typeof withCallback.requestVideoFrameCallback === 'function') {
          withCallback.requestVideoFrameCallback(done);
        } else {
          requestAnimationFrame(() => requestAnimationFrame(done));
        }
      },
      { once: true },
    );
    video.currentTime = time;
  });
}
