/**
 * The camera.
 *
 * This is the most invasive thing Anna can do, so it is also the most
 * constrained:
 *
 *  - off by default, and only started when the user turns it on;
 *  - sampled on a slow timer — 45 seconds by default, never faster than 15 —
 *    because the question being answered is "how are they doing", which does
 *    not change frame to frame;
 *  - one frame at a time, downscaled to 512px, JPEG at moderate quality. Enough
 *    for a model to say "slumped, rubbing their eyes", not enough to read the
 *    screen behind them;
 *  - nothing is written to disk, here or in main. The frame goes to the vision
 *    model and what is kept is the sentence that comes back.
 *
 * The visible camera indicator is not defeated: the stream stays open while
 * enabled so the macOS green light stays on. Opening and closing the device
 * around each frame would make the light blink once a minute, which is
 * technically the same access with a less honest signal.
 */

const MIN_INTERVAL_SECONDS = 15;
const FRAME_WIDTH = 512;
const JPEG_QUALITY = 0.72;

export interface VisionOptions {
  intervalSeconds: number;
  onFrame(jpegBase64: string): void;
}

export class Vision {
  readonly #options: VisionOptions;
  #stream: MediaStream | null = null;
  #video: HTMLVideoElement | null = null;
  #timer: number | undefined;

  constructor(options: VisionOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#stream !== null;
  }

  async start(): Promise<void> {
    if (this.#stream) return;
    this.#stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });

    const video = document.createElement('video');
    video.srcObject = this.#stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    this.#video = video;

    const interval = Math.max(MIN_INTERVAL_SECONDS, this.#options.intervalSeconds) * 1000;
    this.#timer = window.setInterval(() => this.#capture(), interval);
    // Take one immediately so Anna is not blind for the first minute.
    window.setTimeout(() => this.#capture(), 1500);
  }

  stop(): void {
    window.clearInterval(this.#timer);
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#video?.remove();
    this.#stream = null;
    this.#video = null;
  }

  /**
   * Take a frame now.
   *
   * Used when the conversation needs eyes rather than when the timer says so.
   * No-ops when the camera is off — she says she cannot see rather than
   * silently switching the camera on to answer a question.
   */
  captureNow(): void {
    this.#capture();
  }

  #capture(): void {
    const video = this.#video;
    if (!video || video.videoWidth === 0) return;

    const scale = FRAME_WIDTH / video.videoWidth;
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_WIDTH;
    canvas.height = Math.round(video.videoHeight * scale);

    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    this.#options.onFrame(dataUrl.slice(dataUrl.indexOf(',') + 1));
  }
}
