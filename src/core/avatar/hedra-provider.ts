/**
 * Hedra v3 — a photograph plus driving audio, rendered into a clip.
 *
 * Unlike the three stubs in video-provider.ts, every path, field name, enum
 * value and error shape below was read out of Hedra's own machine-readable spec
 * (`https://api.hedra.com/v3/openapi.json`) and then checked against a live key.
 * Where the spec and the live service disagreed, the live service won and the
 * disagreement is noted.
 *
 * ## This is not the realtime product
 *
 * Hedra's streaming avatar — the one that made "she talks back with a real
 * face" sound plausible — has been withdrawn. `POST /public/livekit/v1/session`
 * answers `410 Gone` with "The Hedra realtime avatar service is no longer
 * available", and LiveKit's plugin for it now throws on construction. What
 * remains is this: an offline job queue measured in minutes.
 *
 * That is a hard constraint on how it can be used, not a detail. Nothing here
 * can run while she is talking. It builds a clip *library* ahead of time, which
 * is exactly the shape video-provider.ts already assumes.
 *
 * ## Audio is mandatory, and audio is the meter
 *
 * Every avatar model here requires a driving audio track — there is no
 * prompt-only mode. And the price is not per clip: asked for an estimate, the
 * service replies that "the price is the driving audio's duration, which is not
 * known until the audio is ingested at submit". So a four-second clip of
 * silence costs the same as four seconds of speech, and `POST
 * /models/{model}/estimate` refuses to quote for these models at all. That is
 * why {@link HEDRA_COST} carries no per-clip figure and is not marked verified:
 * there is no per-clip figure to carry.
 *
 * For the silent gesture clips the library is made of, {@link silentWav}
 * supplies the required track. See its comment for what that does and does not
 * establish.
 */

import type { ClipSlotName } from './clips.ts';
import { nearestAspectRatio, sniffImage } from './image-info.ts';
import {
  VideoClipError,
  type ClipCostModel,
  type ClipJobHandle,
  type ClipJobState,
  type ClipRequest,
  type SucceededState,
  type VideoClipProvider,
} from './video-provider.ts';

const BASE_URL = 'https://api.hedra.com/v3';

/**
 * The avatar models: the ones that take a start frame plus driving audio.
 *
 * Hedra publishes eighty-odd models. The rest are text-to-image, text-to-video
 * or speech, and none of them can be pointed at a photograph of a person and
 * asked to move it, so listing them here would only invite a wrong choice.
 */
export type HedraAvatarModel = 'hedra-character-3' | 'hedra-avatar' | 'omnihuman-15';

interface ModelCapability {
  /** Accepted `aspect_ratio` values, from the model's own request schema. */
  aspectRatios: readonly string[];
  resolutions: readonly string[];
  /** Whether the model's input schema has a `prompt` field at all. */
  takesPrompt: boolean;
  /** Whether the clip length can be pinned, rather than following the audio. */
  takesDuration: boolean;
}

/**
 * Per-model capabilities, transcribed from each model's request schema.
 *
 * This table is the reason `omnihuman-15` is not the default despite being the
 * better-known name: its `aspect_ratio` enum contains exactly one value,
 * `16:9`. A landscape frame cannot hold a standing figure at the size Anna's
 * 420x680 panel needs, so choosing it silently would cost the whole full-body
 * premise. `hedra-character-3` accepts `9:16` and is the default for that one
 * reason.
 */
export const HEDRA_MODELS: Readonly<Record<HedraAvatarModel, ModelCapability>> = {
  'hedra-character-3': {
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '9:21', '21:9'],
    resolutions: ['540p', '720p', '1080p'],
    takesPrompt: true,
    takesDuration: true,
  },
  'hedra-avatar': {
    aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '9:21', '21:9'],
    resolutions: ['540p', '720p', '1080p'],
    takesPrompt: true,
    takesDuration: true,
  },
  'omnihuman-15': {
    aspectRatios: ['16:9'],
    resolutions: ['720p', '1080p'],
    takesPrompt: true,
    takesDuration: false,
  },
};

/** Hedra's job lifecycle, verbatim from the spec's `JobStatus` enum. */
type HedraStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

/**
 * No verified per-clip price, and `verified: false` says so.
 *
 * Not an oversight and not laziness: Hedra bills audio-driven models by the
 * second of driving audio and declines to quote before ingest, so a number here
 * would be a fabrication. `assumedUsdPerClip` is the category envelope from
 * video-provider.ts, used only to warn.
 */
export const HEDRA_COST: ClipCostModel = {
  usdPerClip: null,
  assumedUsdPerClip: 0.25,
  pricingUrl: 'https://www.hedra.com/pricing',
  basis: 'unknown',
  verified: false,
};

export interface HedraOptions {
  apiKey: string;
  model?: HedraAvatarModel;
  /** Portrait by default: the panel is taller than it is wide, and so is she. */
  aspectRatio?: string;
  resolution?: string;
  /** Injected by tests. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

interface SubmitAck {
  job_id: string;
  status: HedraStatus;
}

interface JobEnvelope {
  job_id: string;
  status: HedraStatus;
  error?: { message?: string } | string | null;
  cost?: number | null;
  outputs?: Array<{
    url?: string | null;
    duration_ms?: number | null;
    error?: string | null;
  }> | null;
}

interface StatusView {
  status: HedraStatus;
  progress?: number | null;
}

export function createHedraProvider(options: HedraOptions): VideoClipProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const root = (options.baseUrl ?? BASE_URL).replace(/\/+$/, '');
  const model = options.model ?? 'hedra-character-3';
  const capability = HEDRA_MODELS[model];

  // Clamped rather than passed through: an unsupported enum value is a 422 five
  // seconds after the user pressed the button, and the honest fallback — the
  // model's first advertised ratio — at least renders.
  const configuredRatio = options.aspectRatio ? pick(options.aspectRatio, capability.aspectRatios) : null;
  const resolution = pick(options.resolution ?? '720p', capability.resolutions);

  /**
   * The output shape, taken from the photograph unless someone insisted.
   *
   * Defaulting to a fixed ratio is the wrong instinct here even though the panel
   * is portrait. `aspect_ratio` decides the frame the clip is generated into,
   * and a frame that is not the photograph's own means the first frame is a crop
   * or a pad of the source rather than the source — which is precisely the
   * property seam.ts measures and prompts.ts is built around. The first real
   * photograph handed to this app is 1024x1024; a 9:16 default would have cost
   * the seam on all nineteen clips.
   */
  function ratioFor(image: Uint8Array): string {
    if (configuredRatio) return configuredRatio;
    const info = sniffImage(image);
    if (!info) return pick('1:1', capability.aspectRatios);
    return nearestAspectRatio(info.width, info.height, capability.aspectRatios);
  }

  // The spec names `Authorization: Key <key_id>:<secret>` as the primary scheme.
  // `X-API-Key` and `Bearer` are also accepted live, but the documented one is
  // the one least likely to be withdrawn.
  const auth = { authorization: `Key ${options.apiKey}` };

  /**
   * Uploads bytes and returns the handle the model reads them from.
   *
   * The returned URL is presigned and must be passed back *verbatim, query
   * string included* — it is the handle, not merely a location. It lapses one
   * hour after upload, which is why uploads happen inside `submit` rather than
   * once at the start of a nineteen-clip library build.
   */
  async function upload(bytes: Uint8Array, filename: string, type: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([bytes as unknown as BlobPart], { type }), filename);
    const response = await doFetch(`${root}/files`, { method: 'POST', headers: auth, body: form });
    if (!response.ok) throw await failure(response, 'uploading a file');
    const body = (await response.json()) as { url?: string };
    if (!body.url) throw new VideoClipError('Hedra accepted the upload but returned no handle.');
    return body.url;
  }

  async function envelope(id: string, signal: AbortSignal | undefined): Promise<JobEnvelope> {
    const response = await doFetch(`${root}/jobs/${encodeURIComponent(id)}`, {
      headers: auth,
      signal: signal ?? null,
    });
    if (!response.ok) throw await failure(response, 'reading a finished job');
    return (await response.json()) as JobEnvelope;
  }

  return {
    id: 'hedra',
    label: 'Hedra',
    cost: HEDRA_COST,
    // Fifteen minutes. Renders are documented and observed in minutes, and the
    // job handle survives on disk, so a timeout that fires early does not lose
    // the clip — but it does mean re-polling later, and the alternative
    // (abandoning a job already paid for) is worse.
    timeoutMs: 15 * 60_000,

    async submit(request: ClipRequest): Promise<ClipJobHandle> {
      const driving = request.audio ?? {
        bytes: silentWav(request.seconds),
        mimeType: 'audio/wav',
      };

      // The declared MIME type is a hint, not evidence: the first photograph
      // this app was given is named `.png` and contains JPEG. Hedra sniffs the
      // bytes anyway, so this is about the local half of the system agreeing
      // with the remote one.
      const info = sniffImage(request.image);
      const imageType = info?.mimeType ?? request.imageMimeType;

      const [startImage, audio] = await Promise.all([
        upload(request.image, 'source' + extensionFor(imageType), imageType),
        upload(driving.bytes, 'drive.wav', driving.mimeType),
      ]);

      const input: Record<string, unknown> = {
        start_image: { source: 'url', url: startImage },
        audio: { source: 'url', url: audio },
        aspect_ratio: ratioFor(request.image),
        resolution,
      };
      if (capability.takesPrompt) input['prompt'] = promptFor(request);
      if (capability.takesDuration) input['duration_ms'] = Math.round(request.seconds * 1000);

      const response = await doFetch(`${root}/models/${model}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        signal: request.signal ?? null,
        body: JSON.stringify({
          input,
          /*
           * Keyed on the request body, not on the slot.
           *
           * It was `anna-<slot>-<hash of prompt>`, which is stable across
           * attempts — and the body is not, because every attempt uploads the
           * image and the audio afresh and gets new presigned URLs. Retrying a
           * failed clip therefore sent a *different* body under a *reused* key,
           * which Hedra correctly refuses with `409 Idempotency-Key already used
           * with a different request body`. The slot became unrenderable.
           *
           * What this does and does not buy, stated plainly because the
           * obvious reading is wrong: it makes retries *legal* — no more 409 —
           * but it cannot dedupe across attempts, because the uploads it hashes
           * are new every time by construction. So if the submit response is
           * lost after Hedra accepted the job, that job is billed and orphaned;
           * the key does not save you. Real cross-attempt dedupe would mean
           * uploading once and reusing the handle for the retry, which the
           * one-hour expiry on those URLs makes its own piece of work.
           */
          idempotency_key: `anna-${request.slot}-${hash(JSON.stringify(input))}`,
        }),
      });

      if (!response.ok) throw await failure(response, 'starting a render');
      const ack = (await response.json()) as SubmitAck;
      return { providerId: 'hedra', id: ack.job_id, submittedAt: Date.now() };
    },

    /**
     * One status check.
     *
     * Deliberately two endpoints. `/status` is the cheap one and is all that is
     * needed for the ninety-odd percent of polls that come back "still going";
     * the full envelope — with the cost, the duration and the failure reason —
     * is fetched only once, when the job has actually stopped.
     */
    async poll(job: ClipJobHandle, signal?: AbortSignal): Promise<ClipJobState> {
      const response = await doFetch(`${root}/jobs/${encodeURIComponent(job.id)}/status`, {
        headers: auth,
        signal: signal ?? null,
      });
      if (!response.ok) throw await failure(response, 'checking a render');
      const status = (await response.json()) as StatusView;

      if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') {
        return {
          status: status.status === 'IN_QUEUE' ? 'queued' : 'running',
          // Hedra reports a fraction; ClipJobState is a fraction too. Null
          // until the job says something, rather than a fake zero.
          progress: typeof status.progress === 'number' ? status.progress : null,
        };
      }

      const view = await envelope(job.id, signal);

      if (view.status === 'FAILED') {
        return {
          status: 'failed',
          reason: reasonFrom(view) ?? 'Hedra did not say why.',
          // A failed render is not retried automatically. Hedra charges on
          // ingest, so an automatic retry of a prompt the model rejected is a
          // way to spend money repeating a mistake.
          retryable: false,
        };
      }

      const output = view.outputs?.[0];
      if (!output?.url) {
        return {
          status: 'failed',
          reason: output?.error ?? 'Hedra reported success but produced no video.',
          retryable: false,
        };
      }

      return {
        status: 'succeeded',
        seconds: typeof output.duration_ms === 'number' ? output.duration_ms / 1000 : null,
        costUsd: typeof view.cost === 'number' ? view.cost : null,
      };
    },

    /**
     * Fetches the finished bytes.
     *
     * Re-reads the envelope rather than caching a URL from `poll`, because the
     * download URL is presigned and short-lived: a handle captured at poll time
     * and used after a queue of other downloads is a 403 that looks like a
     * permissions bug.
     */
    async download(
      job: ClipJobHandle,
      _state: SucceededState,
      signal?: AbortSignal,
    ): Promise<Uint8Array> {
      const view = await envelope(job.id, signal);
      const url = view.outputs?.[0]?.url;
      if (!url) {
        throw new VideoClipError(`Hedra job ${job.id} has no downloadable output.`, {
          provider: 'hedra',
        });
      }
      const response = await doFetch(url, { signal: signal ?? null });
      if (!response.ok) throw await failure(response, 'downloading a finished render');
      return new Uint8Array(await response.arrayBuffer());
    },

    /**
     * Checks the key *and* the balance.
     *
     * Balance belongs in this check, even though the method is named for
     * credentials. A valid key on an empty account fails at submit — after the
     * photo has been chosen, the prompts written and the build started — with a
     * billing error several screens away from anything the user can act on.
     * Asking `GET /balance` costs nothing and moves that message to the one
     * screen where "top up your Hedra account" is a useful sentence.
     */
    async validateKey() {
      let response: Response;
      try {
        response = await doFetch(`${root}/balance`, { headers: auth });
      } catch {
        return { ok: false as const, reason: 'Could not reach Hedra.' };
      }

      if (response.status === 401 || response.status === 403) {
        return { ok: false as const, reason: 'Hedra rejected that key.' };
      }
      if (!response.ok) {
        return { ok: false as const, reason: `Hedra returned ${response.status}.` };
      }

      const body = (await response.json()) as { balance?: number; currency?: string };
      if (typeof body.balance === 'number' && body.balance <= 0) {
        return {
          ok: false as const,
          reason:
            'That key works, but the Hedra account has no credit — every render would fail. Top it up first.',
        };
      }
      const amount = typeof body.balance === 'number' ? body.balance.toFixed(2) : '?';
      // No clip count here, unlike Runway: Hedra bills by the second of driving
      // audio and will not quote before ingest, so any per-clip figure would be
      // invented. The balance is the only honest number available.
      return { ok: true as const, note: `$${amount} on the API wallet.` };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The prompt, with the negative half folded in.
 *
 * prompts.ts keeps `prompt` and `avoid` separate because most vendors have a
 * dedicated negative-prompt field. Hedra does not — its avatar models take one
 * `prompt` string. Dropping `avoid` on the floor would silently discard half of
 * what prompts.ts works hardest at (the instructions that stop the camera
 * drifting and the figure wandering out of frame), so it is appended as a
 * clause instead.
 */
function promptFor(request: ClipRequest): string {
  const base = request.prompt.trim();
  const avoid = request.avoid.trim();
  return avoid ? `${base} Avoid: ${avoid}.` : base;
}

/**
 * A near-silent WAV of the requested length.
 *
 * Hedra's avatar models require driving audio — there is no prompt-only mode,
 * and the minimum accepted length is 0.5s. The library these clips belong to is
 * silent by design: eighteen of the nineteen slots are idle and gesture loops
 * that get played under Anna's own TTS, so anything spoken here would fight it.
 *
 * ## Why this is not digital silence
 *
 * It was, and the first real render failed with:
 *
 * > The audio contains targeted harassment and encourages the listener to
 * > commit suicide.
 *
 * Against a buffer of nothing but zero samples. Hedra moderates the driving
 * audio by transcribing it first, and ASR models of that family are known to
 * hallucinate fluent text out of pure silence — there is nothing to latch onto,
 * so the decoder free-runs on its language prior. The classifier then dutifully
 * flags whatever it invented. Nothing was wrong with the request; the safety
 * layer was reading tea leaves.
 *
 * A floor of low-level noise fixes it by giving the recogniser something that is
 * unambiguously not speech. The amplitude below is about -66 dBFS — two or three
 * bits out of sixteen, inaudible on any real playback, and far under the level
 * that would drive a mouth open.
 *
 * The generator is a seeded LCG rather than `Math.random` so that the same slot
 * produces the same track twice. A clip regenerated after a failed seam check
 * should differ because the *model* re-rolled, not because its driving audio
 * silently changed underneath the comparison.
 *
 * 16-bit PCM, mono, 16 kHz: the smallest thing that is unambiguously a WAV.
 */
export function silentWav(seconds: number): Uint8Array {
  const rate = 16_000;
  // Hedra's floor is 500ms; asking for less is a 422 rather than a short clip.
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
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  // The noise floor. Peak amplitude 16/32768 is about -66 dBFS: below the noise
  // of any microphone, above the digital zero that made the moderator
  // hallucinate. See this function's header for what that cost to find out.
  let state = 0x2f6e2b1 >>> 0;
  for (let i = 0; i < frames; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    view.setInt16(44 + i * 2, ((state >>> 16) % 33) - 16, true);
  }

  return new Uint8Array(buffer);
}

function pick(wanted: string, allowed: readonly string[]): string {
  return allowed.includes(wanted) ? wanted : allowed[0]!;
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

/** A short stable id for the idempotency key. Not a security primitive. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(36);
}

function reasonFrom(view: JobEnvelope): string | null {
  if (typeof view.error === 'string') return view.error;
  if (view.error && typeof view.error === 'object' && view.error.message) return view.error.message;
  return view.outputs?.[0]?.error ?? null;
}

/**
 * Turns a failed response into an error worth reading.
 *
 * Hedra returns a structured envelope — `{error: {code, message, retryable,
 * retry_after}}` — and its own `retryable` flag is used in preference to
 * guessing from the status code. The service knows which of its 400s are worth
 * repeating and this code does not.
 */
async function failure(response: Response, doing: string): Promise<VideoClipError> {
  const text = await response.text().catch(() => '');
  let detail = '';
  let retryable: boolean | undefined;

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; retryable?: boolean };
      message?: string;
    };
    detail = parsed.error?.message ?? parsed.message ?? '';
    if (typeof parsed.error?.retryable === 'boolean') retryable = parsed.error.retryable;
  } catch {
    detail = text.slice(0, 200);
  }

  const friendly =
    response.status === 401 || response.status === 403
      ? 'Hedra rejected that key.'
      : response.status === 402
        ? 'The Hedra account is out of credit.'
        : response.status === 410
          ? 'That Hedra endpoint has been retired.'
          : `Hedra returned ${response.status} while ${doing}.`;

  return new VideoClipError(detail ? `${friendly} ${detail}` : friendly, {
    status: response.status,
    provider: 'hedra',
    retryable: retryable ?? (response.status === 429 || response.status >= 500),
  });
}

/** Re-exported so callers can name a slot without importing two modules. */
export type { ClipSlotName };
