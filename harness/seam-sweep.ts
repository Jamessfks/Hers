/**
 * Sweeps every frame of a clip against the source photograph.
 *
 * `verify.ts` only searches the back 45% of a clip for a cut point, on the
 * reasoning that the gesture happens early and the hold happens late. This page
 * exists to test that reasoning against the actual clips rather than assume it:
 * it measures *every* frame, so the shape of the drift curve is visible and the
 * question "is there any cut point at all" gets an answer instead of an
 * inference.
 *
 * Deliberately not a unit test. It needs a real decoder and multi-megabyte
 * fixtures that are not in the repo, so it is a page you open rather than
 * something CI can run.
 *
 * The sweep seeks and measures one frame at a time rather than calling
 * `extractClipFrames` with 120 samples, because that holds every decoded frame
 * — 3.7MB each at 720x1280 — until it returns, and a hundred of those is half a
 * gigabyte of RGBA for numbers that could have been taken on the way past. To
 * keep the two honest, the run starts by calling `extractClipFrames` for real
 * and checks that the streaming loop reproduces its first and last frames.
 */

import { ASSUMED_FPS, extractClipFrames } from '../src/renderer/avatar/clip-frames.ts';
import { measureSeam, closesCleanly, SEAM_THRESHOLD, type Frame } from '../src/core/avatar/seam.ts';

const out = document.getElementById('out') as HTMLPreElement;
const lines: string[] = [];
function say(line: string): void {
  lines.push(line);
  out.textContent = lines.join('\n');
}

async function sourceAt(url: string, width: number, height: number): Promise<Frame> {
  const image = new Image();
  image.src = url;
  // `load`, not `decode()`. A detached image in a hidden document never
  // resolves `decode()` — this page runs in a background pane, and that is
  // exactly where the first version of it hung with no error.
  await new Promise<void>((resolve) => image.addEventListener('load', () => resolve()));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  // Stretched, not letterboxed — matching Hologram.sourceFrame exactly, since
  // the point is to reproduce what the app measures.
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height);
  return { width: data.width, height: data.height, data: data.data };
}

/** The seek used by clip-frames.ts, kept in step with it deliberately. */
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
      setTimeout(done, 120);
    };
    video.addEventListener('seeked', () => afterPaint(), { once: true });
    video.currentTime = time;
    setTimeout(afterPaint, 400);
  });
}

interface Row {
  index: number;
  seconds: number;
  meanDelta: number;
  worstBlockDelta: number;
  changedFraction: number;
  exposureShift: number;
  closes: boolean;
}

async function sweep(name: string, clipUrl: string): Promise<void> {
  say(`\n=== ${name} ===`);

  // The reference pass, through the code the app actually runs. Its numbers are
  // what the streaming loop below has to agree with.
  const reference = await extractClipFrames(clipUrl, { holdStart: 0.99, holdSamples: 1 });
  const seconds = reference.durationSeconds;
  const { width, height } = reference.last;
  say(`${width}x${height}, ${seconds.toFixed(3)}s`);

  const source = await sourceAt('/harness/anna.jpg', width, height);
  say('source decoded');
  const referenceFirst = measureSeam(source, reference.first).meanDelta;
  const referenceLast = measureSeam(source, reference.last).meanDelta;
  say('reference measured');

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = clipUrl;
  await new Promise<void>((resolve) => video.addEventListener('loadeddata', () => resolve()));
  say('clip open');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;

  const step = 1 / ASSUMED_FPS;
  const count = Math.max(2, Math.round(seconds * ASSUMED_FPS));
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = Math.min(seconds - step / 2, i * step);
    await seekTo(video, at);
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const measurement = measureSeam(source, {
      width: image.width,
      height: image.height,
      data: image.data,
    });
    rows.push({
      index: i,
      seconds: at,
      ...measurement,
      closes: closesCleanly(measurement),
    });
    if (i % 10 === 0) out.textContent = `${lines.join('\n')}\n… frame ${i}/${count}`;
  }
  video.removeAttribute('src');
  video.load();

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  say(
    `agreement with extractClipFrames: first ${first.meanDelta.toFixed(4)} vs ` +
      `${referenceFirst.toFixed(4)}, last ${last.meanDelta.toFixed(4)} vs ${referenceLast.toFixed(4)}`,
  );

  let best = first;
  for (const row of rows) if (row.meanDelta < best.meanDelta) best = row;
  const closing = rows.filter((row) => row.closes);

  say(`best mean ${best.meanDelta.toFixed(4)} @frame ${best.index} (${best.seconds.toFixed(2)}s)`);
  say(`frames that close cleanly: ${closing.length}/${rows.length}` +
    (closing.length ? ` → ${closing.map((r) => r.index).join(',')}` : ''));
  say(`frames under mean ${SEAM_THRESHOLD}: ${rows.filter((r) => r.meanDelta <= SEAM_THRESHOLD).length}`);
  say('idx    t     mean   worstBlk changed  exposure closes');
  for (const row of rows) {
    say(
      `${String(row.index).padStart(4)} ${row.seconds.toFixed(2).padStart(5)} ` +
        `${row.meanDelta.toFixed(4)} ${row.worstBlockDelta.toFixed(4)}   ` +
        `${row.changedFraction.toFixed(4)} ${row.exposureShift.toFixed(4).padStart(8)} ${row.closes ? 'YES' : ''}`,
    );
  }
}

/**
 * What the numbers from a sweep are worth, established against known pairs.
 *
 * A single meanDelta says nothing on its own — it needs a floor ("what does an
 * identical frame score, given JPEG on one side and H.264 on the other") and a
 * reference for the comparison the app does not currently make: two clips
 * against *each other*, which is what a viewer actually sees at a cut.
 */
async function control(): Promise<void> {
  say('\n=== control ===');
  const nod = await extractClipFrames('/harness/nod.mp4', { holdStart: 0.99, holdSamples: 1 });
  const tilt = await extractClipFrames('/harness/tilt.mp4', { holdStart: 0.99, holdSamples: 1 });
  const idle = await extractClipFrames('/harness/anna.mp4', { holdStart: 0.99, holdSamples: 1 });

  const line = (label: string, a: Frame, b: Frame): void => {
    const m = measureSeam(a, b);
    say(
      `${label.padEnd(34)} mean ${m.meanDelta.toFixed(4)} worstBlk ${m.worstBlockDelta.toFixed(4)} ` +
        `changed ${m.changedFraction.toFixed(4)} ${closesCleanly(m) ? 'CLOSES' : ''}`,
    );
  };

  const atHedra = await sourceAt('/harness/anna.jpg', nod.last.width, nod.last.height);
  const atIdle = await sourceAt('/harness/anna.jpg', idle.last.width, idle.last.height);

  line('source -> idle first (same size)', atIdle, idle.first);
  line('source -> nod first', atHedra, nod.first);
  line('source -> tilt first', atHedra, tilt.first);
  line('nod first -> tilt first', nod.first, tilt.first);
  line('nod last -> tilt first', nod.last, tilt.first);
  line('nod last -> nod first', nod.last, nod.first);
}

async function main(): Promise<void> {
  const clips: Record<string, string> = {
    nod: '/harness/nod.mp4',
    tilt: '/harness/tilt.mp4',
    idle: '/harness/anna.mp4',
  };
  const asked = new URLSearchParams(location.search).get('clip') ?? 'nod';
  try {
    if (asked === 'control') {
      await control();
    } else {
      for (const name of asked === 'all' ? Object.keys(clips) : [asked]) {
        await sweep(name, clips[name]!);
      }
    }
    say('\ndone');
  } catch (error) {
    say(`\nFAILED: ${String(error)}`);
  }
}

void main();
