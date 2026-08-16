/**
 * The two seeing senses: the camera, and the screen.
 *
 * Both are ordinary browser APIs, which is the whole reason this version runs
 * the same on macOS and on Windows with no native code, no accessibility
 * permissions and no code signing. `getDisplayMedia` is the screen sense and it
 * is better than the thing it replaces: the user picks exactly one window or
 * one screen, in the browser's own picker, and can see at a glance that they
 * are sharing.
 *
 * ## One picture, not two streams
 *
 * When both are on they are composited into a single frame — the screen, with
 * the camera inset in a corner of it — rather than sent as two interleaved
 * streams. The Live API takes still images on one video channel with no way to
 * label which camera they came from, so two sources alternating on that channel
 * reads to the model as one very confusing source. Compositing also halves the
 * frames, and frames are the expensive part.
 */

const SCREEN_WIDTH = 1024;
const CAMERA_WIDTH = 640;
/** Inset size as a fraction of the composited frame's width. */
const INSET_SCALE = 0.24;
const JPEG_QUALITY = 0.72;

export type VisionSource = 'camera' | 'screen';

export interface VisionOptions {
  onFrame(kind: VisionSource, jpeg: ArrayBuffer): void;
  /** The user stopped a share from the browser's own UI rather than ours. */
  onEnded(source: VisionSource): void;
}

export class Vision {
  readonly #options: VisionOptions;
  readonly #canvas = document.createElement('canvas');
  readonly #camera = createVideoElement();
  readonly #screen = createVideoElement();
  #cameraStream: MediaStream | null = null;
  #screenStream: MediaStream | null = null;
  #timer: number | null = null;
  #cameraFps = 1;
  #screenFps = 0.5;
  #busy = false;

  constructor(options: VisionOptions) {
    this.#options = options;
  }

  setRates(cameraFps: number, screenFps: number): void {
    this.#cameraFps = clampFps(cameraFps);
    this.#screenFps = clampFps(screenFps);
    if (this.#timer !== null) this.#restartLoop();
  }

  get cameraElement(): HTMLVideoElement {
    return this.#camera;
  }

  get screenElement(): HTMLVideoElement {
    return this.#screen;
  }

  async startCamera(): Promise<void> {
    if (this.#cameraStream) return;
    this.#cameraStream = await this.#open('camera', () =>
      navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      }),
    );
    this.#camera.srcObject = this.#cameraStream;
    await play(this.#camera);
    this.#restartLoop();
  }

  async startScreen(): Promise<void> {
    if (this.#screenStream) return;
    this.#screenStream = await this.#open('screen', () =>
      navigator.mediaDevices.getDisplayMedia({
        // The frame rate here is a hint to the compositor, not our sample rate:
        // asking for 60fps of a mostly static screen wastes the machine's time
        // encoding frames nobody will ever look at.
        video: { frameRate: { ideal: 2, max: 5 } },
        audio: false,
      }),
    );
    this.#screen.srcObject = this.#screenStream;
    await play(this.#screen);
    this.#restartLoop();
  }

  stopCamera(): void {
    for (const track of this.#cameraStream?.getTracks() ?? []) track.stop();
    this.#cameraStream = null;
    this.#camera.srcObject = null;
    this.#restartLoop();
  }

  stopScreen(): void {
    for (const track of this.#screenStream?.getTracks() ?? []) track.stop();
    this.#screenStream = null;
    this.#screen.srcObject = null;
    this.#restartLoop();
  }

  stop(): void {
    this.stopCamera();
    this.stopScreen();
  }

  // -------------------------------------------------------------------------

  async #open(source: VisionSource, request: () => Promise<MediaStream>): Promise<MediaStream> {
    const stream = await request();
    for (const track of stream.getTracks()) {
      // Chrome's "Stop sharing" bar and macOS revoking camera access both end
      // the track without any other signal, and a UI still showing the sense as
      // on after that is lying to the user about what Anna can see.
      track.addEventListener('ended', () => {
        if (source === 'camera') this.stopCamera();
        else this.stopScreen();
        this.#options.onEnded(source);
      });
    }
    return stream;
  }

  #restartLoop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (!this.#cameraStream && !this.#screenStream) return;

    const fps = this.#screenStream ? this.#screenFps : this.#cameraFps;
    this.#timer = window.setInterval(() => void this.#capture(), Math.round(1000 / fps));
    // One immediately, so turning a sense on does not leave her blind for the
    // first second of it.
    void this.#capture();
  }

  async #capture(): Promise<void> {
    // Encoding is async, and on a slow machine a tick can arrive before the
    // last one finished. Dropping is right: the newer frame is the useful one.
    if (this.#busy) return;
    this.#busy = true;
    try {
      const frame = this.#screenStream ? await this.#composite() : await this.#cameraOnly();
      if (frame) this.#options.onFrame(this.#screenStream ? 'screen' : 'camera', frame);
    } catch {
      // A frame that failed to encode is one frame. The next one is 1-2s away.
    } finally {
      this.#busy = false;
    }
  }

  async #composite(): Promise<ArrayBuffer | null> {
    const screen = this.#screen;
    if (!ready(screen)) return null;

    const scale = SCREEN_WIDTH / screen.videoWidth;
    const width = SCREEN_WIDTH;
    const height = Math.round(screen.videoHeight * scale);
    const context = this.#prepare(width, height);
    if (!context) return null;

    context.drawImage(screen, 0, 0, width, height);

    const camera = this.#camera;
    if (this.#cameraStream && ready(camera)) {
      const insetWidth = Math.round(width * INSET_SCALE);
      const insetHeight = Math.round((insetWidth * camera.videoHeight) / camera.videoWidth);
      const x = width - insetWidth - 16;
      const y = height - insetHeight - 16;

      // A hairline border so the inset reads as a separate picture rather than
      // as something that is on their screen.
      context.fillStyle = 'rgba(0,0,0,0.85)';
      context.fillRect(x - 2, y - 2, insetWidth + 4, insetHeight + 4);
      context.drawImage(camera, x, y, insetWidth, insetHeight);
    }

    return this.#encode();
  }

  async #cameraOnly(): Promise<ArrayBuffer | null> {
    const camera = this.#camera;
    if (!this.#cameraStream || !ready(camera)) return null;

    const width = CAMERA_WIDTH;
    const height = Math.round((camera.videoHeight * width) / camera.videoWidth);
    const context = this.#prepare(width, height);
    if (!context) return null;

    context.drawImage(camera, 0, 0, width, height);
    return this.#encode();
  }

  #prepare(width: number, height: number): CanvasRenderingContext2D | null {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return null;
    this.#canvas.width = width;
    this.#canvas.height = height;
    return this.#canvas.getContext('2d', { alpha: false });
  }

  #encode(): Promise<ArrayBuffer | null> {
    return new Promise((resolve) => {
      this.#canvas.toBlob(
        (blob) => {
          if (!blob) resolve(null);
          else void blob.arrayBuffer().then(resolve, () => resolve(null));
        },
        'image/jpeg',
        JPEG_QUALITY,
      );
    });
  }
}

// ---------------------------------------------------------------------------

function createVideoElement(): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  return video;
}

/** Dimensions are zero until the first frame decodes; drawing before then throws. */
function ready(video: HTMLVideoElement): boolean {
  return video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
}

async function play(video: HTMLVideoElement): Promise<void> {
  try {
    await video.play();
  } catch {
    // Muted playback is allowed without a gesture; if it is somehow refused the
    // element still decodes frames, which is all the canvas needs.
  }
}

function clampFps(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? Math.min(fps, 1) : 1;
}
