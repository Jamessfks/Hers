/**
 * Hedra v3: image plus audio to a photoreal clip.
 *
 * Every endpoint, field name and status value here was read from Hedra's own
 * machine-readable spec at https://api.hedra.com/v3/openapi.json, not inferred.
 * The rest of this directory left vendor adapters as documented stubs precisely
 * so that nobody would ship a plausible-looking guess; this one is filled in
 * because the spec was actually fetched and checked against a live key.
 *
 * ## What this is not
 *
 * It is not realtime. Hedra's streaming avatar product is gone — the endpoint
 * answers `410 Gone` with "The Hedra realtime avatar service is no longer
 * available", and LiveKit's plugin for it is now a single line that throws.
 * Generation here takes minutes, so this drives a *render*, never a reply.
 *
 * ## Why the model is a parameter
 *
 * The same request shape serves `hedra-character-3`, `omnihuman-15` and
 * `kling-ai-avatar-v2`. They differ in price and in whether they accept a
 * prompt and an aspect ratio, not in how they are called — so choosing between
 * them is configuration rather than three near-identical adapters.
 *
 * Notably `aspect_ratio` is a real parameter here. The "512x512, cropped around
 * the face" constraint that made streaming avatars useless for a standing
 * figure belonged to the *realtime* product; offline, a portrait full-body
 * render is a request field.
 */

import {
  VideoClipError,
  type ClipJobHandle,
  type ClipJobState,
  type ClipRequest,
  type SucceededState,
  type VideoClipProvider,
} from './video-provider.ts';

const BASE_URL = 'https://api.hedra.com/v3';

/** Models that take a start image and driving audio. */
export const HEDRA_AVATAR_MODELS = [
  'hedra-character-3',
  'omnihuman-15',
  'kling-ai-avatar-v2',
] as const;
export type HedraAvatarModel = (typeof HEDRA_AVATAR_MODELS)[number];

/** Hedra's job lifecycle, verbatim from the spec's status enum. */
type HedraStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface HedraOptions {
  apiKey: string;
  model?: HedraAvatarModel;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  /** Portrait by default: a companion stands, she is not a thumbnail. */
  aspectRatio?: string;
  resolution?: string;
}

interface SubmitAck {
  job_id: string;
  status: HedraStatus;
  status_url?: string;
}

interface JobView {
  job_id: string;
  status: HedraStatus;
  error?: string | null;
  cost?: number | null;
  outputs?: Array<{ url?: string }> | null;
}

export function createHedraProvider(options: HedraOptions): VideoClipProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const root = (options.baseUrl ?? BASE_URL).replace(/\/$/, '');
  const model = options.model ?? 'hedra-character-3';
  const aspectRatio = options.aspectRatio ?? '9:16';
  const resolution = options.resolution ?? '720p';
  const headers = { 'X-API-Key': options.apiKey };

  /** Uploads bytes and returns the URL the model will read them from. */
  async function upload(bytes: Uint8Array, filename: string, type: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([bytes as unknown as BlobPart], { type }), filename);
    const response = await doFetch(`${root}/files`, { method: 'POST', headers, body: form });
    if (!response.ok) throw await failure(response, 'uploading a file');
    const body = (await response.json()) as { url?: string };
    if (!body.url) throw new VideoClipError('Hedra accepted the upload but returned no URL.');
    return body.url;
  }

  return {
    id: 'hedra',
    label: 'Hedra (offline render)',
    cost: {
      // Deliberately not a made-up number. Hedra bills per job and reports the
      // actual cost on the finished job, which is what gets recorded.
      usdPerClip: null,
      verified: false,
      note: 'Billed per job; the real figure is read back from the finished job.',
    },
    // Observed generation times run to several minutes; the ceiling is generous
    // because abandoning a job that is merely slow means paying for it twice.
    timeoutMs: 15 * 60_000,

    async submit(request: ClipRequest): Promise<ClipJobHandle> {
      const [startImage, audio] = await Promise.all([
        upload(request.sourceImage, 'source.jpg', 'image/jpeg'),
        upload(request.audio, 'audio.wav', 'audio/wav'),
      ]);

      const input: Record<string, unknown> = {
        start_image: startImage,
        audio,
        resolution,
        aspect_ratio: aspectRatio,
      };
      // Only character-3 requires a prompt; sending one where it is not
      // accepted is a 422 rather than a harmless extra field.
      if (model === 'hedra-character-3') input['prompt'] = request.prompt;

      const response = await doFetch(`${root}/models/${model}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          input,
          // Hedra replays the original acknowledgement for a repeated key, so a
          // retried submit after a dropped connection cannot double-charge.
          idempotency_key: request.idempotencyKey,
        }),
      });

      if (!response.ok) throw await failure(response, 'starting a render');
      const ack = (await response.json()) as SubmitAck;
      return { provider: 'hedra', id: ack.job_id, submittedAt: Date.now() };
    },

    async poll(job: ClipJobHandle, signal?: AbortSignal): Promise<ClipJobState> {
      const response = await doFetch(`${root}/jobs/${encodeURIComponent(job.id)}`, {
        headers,
        signal: signal ?? null,
      });
      if (!response.ok) throw await failure(response, 'checking a render');

      const view = (await response.json()) as JobView;
      switch (view.status) {
        case 'COMPLETED': {
          const url = view.outputs?.[0]?.url;
          if (!url) {
            return { status: 'failed', reason: 'Hedra reported success but returned no output.' };
          }
          return {
            status: 'succeeded',
            url,
            ...(typeof view.cost === 'number' && { costUsd: view.cost }),
          };
        }
        case 'FAILED':
          return { status: 'failed', reason: view.error ?? 'Hedra did not say why.' };
        case 'IN_QUEUE':
          return { status: 'queued' };
        default:
          return { status: 'running' };
      }
    },

    async download(job, state, signal): Promise<Uint8Array> {
      const response = await doFetch(state.url, { signal: signal ?? null });
      if (!response.ok) throw await failure(response, 'downloading a finished render');
      return new Uint8Array(await response.arrayBuffer());
    },

    /**
     * Checks the key and the balance in one call.
     *
     * Balance matters as much as validity here: a perfectly good key with no
     * credit fails at submit time, several screens after the point where the
     * user could have understood why. Asking now means the setup screen can say
     * "top up" instead of the render failing later with a 402.
     */
    async validateKey() {
      const response = await doFetch(`${root}/balance`, { headers });
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
          reason: 'That key works, but the Hedra account has no credit. Top it up to render.',
        };
      }
      return { ok: true as const };
    },
  };
}

async function failure(response: Response, doing: string): Promise<VideoClipError> {
  const text = await response.text().catch(() => '');
  let detail = text.slice(0, 200);
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) detail = parsed.error;
  } catch {
    // Not JSON; the raw text is the best available detail.
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
    // A rate limit or a server fault is worth retrying; a bad key is not.
    retryable: response.status === 429 || response.status >= 500,
  });
}
