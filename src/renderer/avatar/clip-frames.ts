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
/**
 * The frame rate the sampling grid assumes.
 *
 * Exported because  is a frame number derived from it, and a
 * caller turning that index back into a timestamp — which is what a cut point
 * is — needs the same constant. Reconstructing time from the *ordinal* of a
 * sample instead gives a number that looks plausible and is wrong by whatever
 * fraction of the clip the hold window covers.
 */
export const ASSUMED_FPS = 24;

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
 *
 * Waits for `loadeddata` rather than `loadedmetadata`: metadata gives the
 * duration but no decoded frame, so the first `grab(0)` would draw an empty
 * canvas and report a seam against nothing.
 */
function loadDuration(video: HTMLVideoElement): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('That clip could not be decoded.'));
    video.addEventListener('error', fail, { once: true });

    video.addEventListener(
      'loadeddata',
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
 * How long to wait for a presented-frame callback before painting anyway.
 *
 * Two frames at 60Hz is 33ms; 120ms is generous for a decode that has already
 * completed its seek, and short enough that nineteen clips do not add up to a
 * visible stall.
 */
const PRESENT_TIMEOUT_MS = 120;

/**
 * How long to wait for `seeked` before assuming it is never coming.
 *
 * Long enough that a genuine seek on a large clip is never cut short, short
 * enough that nineteen of them is a pause rather than a hang.
 */
const SEEK_TIMEOUT_MS = 400;

/**
 * Seeks, and waits until the frame is actually available to draw.
 *
 * `seeked` means the seek completed, not that the new frame has been painted —
 * drawing on `seeked` alone intermittently captures the previous frame. So the
 * original version waited for `requestVideoFrameCallback`, which fires when a
 * frame is genuinely presented.
 *
 * That was wrong in a way that only shows up at runtime, and it hung this
 * module forever. **`requestVideoFrameCallback` does not fire for a paused
 * video after a seek** — it is tied to presentation, and a paused element
 * presents nothing. Measured here against a real clip: `seeked` fires in 36ms
 * and the callback never arrives at all, attached to the document or not. Since
 * the whole point of this module is to seek a paused video, the one signal it
 * waited on was the one signal it could never get.
 *
 * Now it races: the callback if it comes, an rAF pair otherwise, and a timeout
 * behind both. The frame data is already decoded once `seeked` has fired — the
 * wait is only to let the compositor catch up, so painting slightly early is a
 * far smaller risk than never painting at all.
 */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const afterPaint = (): void => {
      requestAnimationFrame(() => requestAnimationFrame(done));
      setTimeout(done, PRESENT_TIMEOUT_MS);
    };

    video.addEventListener(
      'seeked',
      () => {
        const withCallback = video as HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number;
        };
        withCallback.requestVideoFrameCallback?.(done);
        afterPaint();
      },
      { once: true },
    );

    video.currentTime = time;

    /*
     * The unconditional safety net, and it is not belt-and-braces.
     *
     * Assigning `currentTime` a value it already holds fires no `seeked` event
     * at all — and the very first frame this module asks for is time 0 on a
     * video whose `currentTime` is already 0. So the most common call was the
     * one guaranteed to wait forever.
     *
     * Guarding on `readyState` instead was tried and is not enough: after
     * `loadedmetadata` the element is at HAVE_METADATA, so the guard reads as
     * "not ready", falls through to the assignment, and hangs anyway. A timer
     * that always runs is the only version that cannot deadlock.
     */
    setTimeout(afterPaint, SEEK_TIMEOUT_MS);
  });
}
