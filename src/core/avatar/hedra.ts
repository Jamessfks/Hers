/**
 * Hedra: a photograph plus driving audio, rendered into a clip.
 *
 * Every path, field name and enum below was read from Hedra's own
 * machine-readable spec (`https://api.hedra.com/v3/openapi.json`) and checked
 * against a live key.
 *
 * ## This is not a realtime avatar
 *
 * Hedra's streaming product has been withdrawn — `POST
 * /public/livekit/v1/session` answers `410 Gone`. What is left is an offline job
 * queue measured in minutes, and that is a hard constraint on the design rather
 * than a detail: **nothing here can run while she is talking.** It builds a
 * library of short clips ahead of time, and the conversation picks from what has
 * already been rendered.
 *
 * ## Audio is mandatory, and audio is the meter
 *
 * Every avatar model requires a driving audio track; there is no prompt-only
 * mode. And billing is by the second of that audio, not per clip — so a
 * two-second clip of silence costs the same as two seconds of speech. That is
 * why {@link silentWav} exists and why clip length is the budget dial.
 *
 * ## The three ways this used to lose money
 *
 * An audit of the previous implementation found three, all confirmed. They are
 * designed out here rather than fixed later:
 *
 *  1. **A transient poll error threw away a job already paid for.** The old
 *     `awaitClip` had no `try`/`catch` around `poll()`, so a 429 or a slept
 *     laptop marked the slot failed while the job kept running and kept being
 *     billed. Here, {@link HedraClient.wait} retries anything retryable and only
 *     gives up on a terminal answer.
 *  2. **A crash between submit and completion re-charged the user.** The job
 *     handle only became visible when the whole promise resolved, so a crash in
 *     between left a slot that looked un-started. Here `submit` and `wait` are
 *     separate calls, and the caller is required to persist the handle between
 *     them — see {@link AvatarStudio}.
 *  3. **There was no spend ceiling at all.** Now every submit is gated on
 *     Hedra's own `/usage` figure, which is the only number that cannot be
 *     wrong.
 */

import { sniffImage, nearestAspectRatio } from './image-info.ts';

const BASE_URL = 'https://api.hedra.com/v3';

/**
 * `hedra-character-3` rather than the better-known `omnihuman-15`.
 *
 * One reason: omnihuman's `aspect_ratio` enum contains exactly one value,
 * `16:9`. A landscape frame cannot hold a portrait of a person at the size the
 * avatar panel wants, so choosing it would quietly cost the whole premise.
 */
export const MODEL = 'hedra-character-3';
export const ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '9:21', '21:9'] as const;
export const RESOLUTIONS = ['540p', '720p', '1080p'] as const;

/** Hedra's job lifecycle, verbatim from the spec's `JobStatus` enum. */
export type HedraStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface HedraJob {
  id: string;
  status: HedraStatus;
  /** USD, as reported by Hedra once the job has been ingested. */
  cost: number | null;
  /** Present only on COMPLETED. */
  videoUrl: string | null;
  error: string | null;
}

export class HedraError extends Error {
  readonly retryable: boolean;
  readonly status: number;

  constructor(message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'HedraError';
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? 0;
  }
}

export interface HedraOptions {
  /** The whole `k_live_…:sk_…` string. Both halves are the key. */
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface ClipRequest {
  image: Uint8Array;
  imageMimeType: string;
  /** What the movement should be. Reaches the model as `prompt`. */
  prompt: string;
  seconds: number;
  resolution?: (typeof RESOLUTIONS)[number];
  signal?: AbortSignal;
}

export class HedraClient {
  readonly #apiKey: string;
  readonly #root: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HedraOptions) {
    this.#apiKey = options.apiKey.trim();
    this.#root = (options.baseUrl ?? BASE_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * The documented scheme is `Authorization: Key <key_id>:<secret>`.
   *
   * Both halves, colon included. `X-API-Key` and `Bearer` are also accepted
   * live, but the documented one is the least likely to be withdrawn.
   */
  get #auth(): Record<string, string> {
    return { authorization: `Key ${this.#apiKey}` };
  }

  /**
   * USD spent on this account over Hedra's rolling window.
   *
   * This is the only spend figure that cannot be wrong, because it is theirs.
   * A local tally of what we think we submitted would miss a job that was
   * billed and then failed, which is exactly the case a budget exists for.
   */
  async spentUsd(signal?: AbortSignal): Promise<number> {
    const response = await this.#fetch(`${this.#root}/usage`, {
      headers: this.#auth,
      signal: signal ?? null,
    });
    if (!response.ok) throw await this.#failure(response, 'reading usage');
    const body = (await response.json()) as { total_spent?: number };
    const spent = Number(body.total_spent);
    return Number.isFinite(spent) ? spent : 0;
  }

  /**
   * Uploads bytes and returns the handle the model reads them from.
   *
   * The returned URL is presigned and must be passed back verbatim, query
   * string included — it is the handle, not merely a location. It lapses an
   * hour after upload, which is why uploads happen per submit rather than once
   * for a whole library build.
   */
  async #upload(bytes: Uint8Array, filename: string, type: string): Promise<string> {
    const form = new FormData();
    // A copy rather than a view: a Blob over a shared ArrayBuffer can be
    // mutated out from under the upload, and the caller owns these bytes.
    form.append('file', new Blob([Uint8Array.from(bytes)], { type }), filename);
    const response = await this.#fetch(`${this.#root}/files`, {
      method: 'POST',
      headers: this.#auth,
      body: form,
    });
    if (!response.ok) throw await this.#failure(response, 'uploading a file');
    const body = (await response.json()) as { url?: string };
    if (!body.url) throw new HedraError('Hedra accepted the upload but returned no handle.');
    return body.url;
  }

  /**
   * Starts a render. Returns as soon as the job has an id.
   *
   * Deliberately does *not* wait. The caller has to be able to write the id
   * down before anything else can go wrong, because from the moment this
   * resolves the job is billable whether or not anyone is still watching it.
   */
  async submit(request: ClipRequest): Promise<string> {
    // The declared MIME type is a hint, not evidence: a file named `.png` may
    // contain JPEG, and Hedra sniffs the bytes regardless.
    const info = sniffImage(request.image);
    const imageType = info?.mimeType ?? request.imageMimeType;

    const [startImage, audio] = await Promise.all([
      this.#upload(request.image, `source${extensionFor(imageType)}`, imageType),
      this.#upload(silentWav(request.seconds), 'drive.wav', 'audio/wav'),
    ]);

    /*
     * The frame is taken from the photograph rather than pinned.
     *
     * Defaulting to a fixed ratio is the wrong instinct even though the panel
     * is portrait: `aspect_ratio` decides the frame the clip is generated into,
     * and a frame that is not the photograph's own makes the first frame a crop
     * or a pad of the source rather than the source. Every clip has to be able
     * to cut back to the still without a jump, and that is what pays for it.
     */
    const ratio = info
      ? nearestAspectRatio(info.width, info.height, [...ASPECT_RATIOS])
      : '1:1';

    const response = await this.#fetch(`${this.#root}/models/${MODEL}`, {
      method: 'POST',
      headers: { ...this.#auth, 'content-type': 'application/json' },
      signal: request.signal ?? null,
      body: JSON.stringify({
        input: {
          start_image: { source: 'url', url: startImage },
          audio: { source: 'url', url: audio },
          aspect_ratio: ratio,
          resolution: request.resolution ?? '540p',
          duration_ms: Math.round(request.seconds * 1000),
          prompt: request.prompt,
        },
      }),
    });

    if (!response.ok) throw await this.#failure(response, 'starting a render');
    const body = (await response.json()) as { job_id?: string };
    if (!body.job_id) throw new HedraError('Hedra started a job but returned no id.');
    return body.job_id;
  }

  async job(id: string, signal?: AbortSignal): Promise<HedraJob> {
    const response = await this.#fetch(`${this.#root}/jobs/${encodeURIComponent(id)}`, {
      headers: this.#auth,
      signal: signal ?? null,
    });
    if (!response.ok) throw await this.#failure(response, 'reading a job');

    const body = (await response.json()) as {
      status?: HedraStatus;
      error?: { message?: string } | string | null;
      cost?: number | null;
      outputs?: Array<{ url?: string | null; error?: string | null }> | null;
    };

    const output = body.outputs?.[0];
    return {
      id,
      status: body.status ?? 'IN_PROGRESS',
      cost: typeof body.cost === 'number' ? body.cost : null,
      videoUrl: output?.url ?? null,
      error:
        (typeof body.error === 'string' ? body.error : body.error?.message) ??
        output?.error ??
        null,
    };
  }

  /**
   * Polls until the job is finished.
   *
   * **A transient failure here must never abandon the job.** It has already
   * been billed; giving up on a 429 means paying for a clip and then not having
   * it. So anything the service marks retryable is retried, and only a terminal
   * answer — COMPLETED, FAILED, or a 4xx that is not 429 — ends the loop.
   */
  async wait(
    id: string,
    options: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (status: HedraStatus) => void } = {},
  ): Promise<HedraJob> {
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
    let consecutiveErrors = 0;

    for (;;) {
      if (options.signal?.aborted) throw new HedraError('The render was cancelled.');

      let job: HedraJob;
      try {
        job = await this.job(id, options.signal);
        consecutiveErrors = 0;
      } catch (error) {
        const retryable = error instanceof HedraError && error.retryable;
        consecutiveErrors += 1;
        // Ten consecutive retryable failures is a service that is down, not a
        // blip — but the job id has been persisted, so a later run can pick it
        // back up rather than re-rendering it.
        if (!retryable || consecutiveErrors >= 10) throw error;
        await sleep(Math.min(2000 * consecutiveErrors, 15_000));
        continue;
      }

      options.onProgress?.(job.status);
      if (job.status === 'COMPLETED') return job;
      if (job.status === 'FAILED') {
        throw new HedraError(job.error ?? 'Hedra could not render that image.');
      }
      if (Date.now() > deadline) {
        throw new HedraError(
          `The render is still going after ${Math.round((options.timeoutMs ?? 900_000) / 60_000)} minutes. Job ${id} is saved and will be picked up next time.`,
        );
      }
      await sleep(5000);
    }
  }

  /** Fetches the finished clip. Hedra's output URLs are presigned and expire. */
  async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.#fetch(url, { signal: signal ?? null });
    if (!response.ok) {
      throw new HedraError(`Could not download the finished clip (${response.status}).`, {
        retryable: response.status >= 500,
        status: response.status,
      });
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Turns a failed response into an error that knows whether repeating it could
   * possibly help. The service knows which of its failures are worth retrying;
   * this preserves that rather than guessing later.
   */
  async #failure(response: Response, what: string): Promise<HedraError> {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // A body we cannot read does not change the status code.
    }
    const retryable = response.status === 429 || response.status >= 500;
    const human =
      response.status === 401 || response.status === 403
        ? 'Hedra rejected the API key.'
        : response.status === 402
          ? 'The Hedra account is out of credit.'
          : response.status === 422
            ? `Hedra refused that image: ${detail}`
            : `Hedra failed while ${what} (${response.status}). ${detail}`;
    return new HedraError(human, { retryable, status: response.status });
  }
}

// ---------------------------------------------------------------------------

/**
 * The driving audio for a clip with no speech in it.
 *
 * Two details here were expensive to learn and are not obvious:
 *
 *  - **Hedra's floor is 500ms.** Asking for less is a 422, not a short clip.
 *  - **It must not be digital silence.** An all-zero track makes the model
 *    hallucinate mouth movement, which is precisely wrong for a gesture clip.
 *    A noise floor at peak amplitude 16/32768 — about -66 dBFS, below any
 *    microphone's own noise — is enough to stop it.
 */
export function silentWav(seconds: number): Uint8Array {
  const rate = 16_000;
  const frames = Math.max(rate / 2, Math.round(Math.max(0, seconds) * rate));
  const dataBytes = frames * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let state = 0x2f6e2b1 >>> 0;
  for (let i = 0; i < frames; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    view.setInt16(44 + i * 2, ((state >>> 16) % 33) - 16, true);
  }

  return new Uint8Array(buffer);
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('webp')) return '.webp';
  return '.jpg';
}

/**
 * Deliberately does **not** `unref` the timer.
 *
 * This is the sleep inside the poll loop, and the job it is waiting on has
 * already been billed. An unref'd timer lets the process exit while a paid
 * render is in flight, which is exactly the "abandon a job that has been paid
 * for" failure the audit found — reintroduced by a habit that is correct
 * everywhere else in this codebase. Caught by the first live render, which
 * exited after submitting and cost $0.05 for nothing.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
