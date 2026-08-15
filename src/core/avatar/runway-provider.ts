/**
 * Runway Gen-4 Turbo: a photograph and a written instruction, into a clip.
 *
 * Read off Runway's published OpenAPI document at
 * `https://docs.dev.runwayml.com/openapi.json` — every path, header, enum value
 * and status string below came from there, and the two numbers came from the
 * pricing guide. Nothing here is remembered or inferred.
 *
 * ## Why a second provider at all
 *
 * Not redundancy. Hedra and Runway are different machines, and the difference
 * decides which one a given library should use:
 *
 * | | Hedra | Runway gen4_turbo |
 * |---|---|---|
 * | driven by | a waveform | a written prompt |
 * | audio | **required** | not accepted |
 * | billed on | seconds of driving audio | seconds of video |
 * | price known before submit | no — refuses to quote | yes, 5 credits/second |
 *
 * Eighteen of the nineteen slots in a library are *silent* gesture loops. Hedra
 * cannot render one without being handed a synthetic silent track, and charges
 * for its duration anyway; Runway renders exactly that from the prompt
 * prompts.ts already writes. Conversely, nothing here can lip-sync a line Anna
 * is about to say, and Hedra can.
 *
 * So the honest framing for the settings screen is not "pick your favourite" —
 * it is that one of them animates a body and the other animates a mouth.
 */

import {
  VideoClipError,
  type ClipCostModel,
  type ClipJobHandle,
  type ClipJobState,
  type ClipRequest,
  type SucceededState,
  type VideoClipProvider,
} from './video-provider.ts';
import { nearestAspectRatio, sniffImage } from './image-info.ts';

const BASE_URL = 'https://api.dev.runwayml.com';

/**
 * Pinned, and required on every request.
 *
 * Runway's spec declares this header as a `const`, not a free string: it is how
 * they ship breaking changes without breaking callers. Sending a version means
 * a future field rename is their problem rather than an outage here.
 */
const API_VERSION = '2024-11-06';

/** The model. `gen4_turbo` takes an image and a prompt, and no audio. */
const MODEL = 'gen4_turbo';

/**
 * Output shapes `gen4_turbo` accepts, verbatim from its request schema.
 *
 * Expressed as pixel pairs rather than `16:9`-style ratios, which is why they
 * are passed through {@link nearestAspectRatio} unchanged — it divides the two
 * halves, so `960:960` and `1:1` compare identically. `960:960` is the one that
 * matters for a square portrait.
 */
const RATIOS = ['1280:720', '720:1280', '1104:832', '832:1104', '960:960', '1584:672'] as const;

/** `promptText` is capped at 1000 UTF-16 code units, which is what `.length` counts. */
const PROMPT_LIMIT = 1000;

/** `duration` is an integer number of seconds, from 2 to 10. */
const MIN_SECONDS = 2;
const MAX_SECONDS = 10;

/**
 * A data URI may be at most 5MB *encoded*. Base64 inflates by 4/3, so the
 * binary ceiling is about 3.75MB.
 */
const MAX_DATA_URI_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);

/**
 * Published rates, from docs.dev.runwayml.com/guides/pricing.
 *
 * Two separate facts, kept separate: what a credit costs, and how many credits
 * a second of this model costs. Runway reports job cost in credits, so both are
 * needed to turn a finished job into the dollar figure the settings screen
 * shows next to a spend.
 */
export const USD_PER_CREDIT = 0.01;
export const CREDITS_PER_SECOND = 5;

/**
 * $0.25 for a five-second clip, and a nineteen-slot library for about $4.75.
 *
 * `basis: 'published'` rather than `'observed'`: this is arithmetic on Runway's
 * own rate card, which is a far better number than a guess and still not an
 * invoice. The real charge is read back off each finished task.
 */
export const RUNWAY_COST: ClipCostModel = {
  usdPerClip: 5 * CREDITS_PER_SECOND * USD_PER_CREDIT,
  assumedUsdPerClip: 5 * CREDITS_PER_SECOND * USD_PER_CREDIT,
  pricingUrl: 'https://docs.dev.runwayml.com/guides/pricing/',
  basis: 'published',
  verified: true,
};

export interface RunwayOptions {
  apiKey: string;
  /** Injected by tests. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  /** Overrides the shape derived from the photograph. */
  ratio?: string;
}

interface SubmitAck {
  id: string;
  estimatedCost?: { credits?: number };
}

interface TaskView {
  id: string;
  status: 'PENDING' | 'THROTTLED' | 'RUNNING' | 'CANCELLED' | 'FAILED' | 'SUCCEEDED';
  progress?: number;
  failure?: string;
  failureCode?: string;
  output?: string[];
  cost?: { credits?: number };
}

export function createRunwayProvider(options: RunwayOptions): VideoClipProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const root = (options.baseUrl ?? BASE_URL).replace(/\/+$/, '');
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    'X-Runway-Version': API_VERSION,
  };

  async function task(id: string, signal: AbortSignal | undefined): Promise<TaskView> {
    const response = await doFetch(`${root}/v1/tasks/${encodeURIComponent(id)}`, {
      headers,
      signal: signal ?? null,
    });
    if (!response.ok) throw await failure(response, 'checking a render');
    return (await response.json()) as TaskView;
  }

  return {
    id: 'runway',
    label: 'Runway',
    cost: RUNWAY_COST,
    // Gen-4 Turbo is the fast one, but a throttled task can sit in PENDING for a
    // long time on a busy account, and abandoning it does not stop the charge.
    timeoutMs: 15 * 60_000,

    async submit(request: ClipRequest): Promise<ClipJobHandle> {
      if (request.image.length > MAX_DATA_URI_BYTES) {
        // Runway does have an ephemeral-upload endpoint for larger files. It is
        // a presigned multipart POST whose field ordering is not something to
        // ship untested, so the limit is reported instead of guessed around.
        const mb = (request.image.length / 1024 / 1024).toFixed(1);
        throw new VideoClipError(
          `That photo is ${mb} MB. Runway accepts up to 3.7 MB inline — use a smaller photo, or switch to Hedra.`,
          { provider: 'runway' },
        );
      }

      const info = sniffImage(request.image);
      const mimeType = info?.mimeType ?? request.imageMimeType;
      const promptImage = `data:${mimeType};base64,${base64(request.image)}`;

      const response = await doFetch(`${root}/v1/image_to_video`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        signal: request.signal ?? null,
        body: JSON.stringify({
          model: MODEL,
          promptImage,
          promptText: promptFor(request),
          ratio: options.ratio ?? ratioFor(request.image),
          duration: Math.max(
            MIN_SECONDS,
            Math.min(MAX_SECONDS, Math.round(request.seconds)),
          ),
          // `seed` is deliberately left out. Runway returns similar results for
          // a repeated seed, and the only reason this app re-renders a slot is
          // that the last attempt drifted off the source pose — so a retry needs
          // to differ, not to reproduce.
        }),
      });

      if (!response.ok) throw await failure(response, 'starting a render');
      const ack = (await response.json()) as SubmitAck;
      return { providerId: 'runway', id: ack.id, submittedAt: Date.now() };
    },

    async poll(job: ClipJobHandle, signal?: AbortSignal): Promise<ClipJobState> {
      const view = await task(job.id, signal);

      switch (view.status) {
        case 'SUCCEEDED': {
          const url = view.output?.[0];
          if (!url) {
            return {
              status: 'failed',
              reason: 'Runway reported success but returned no video.',
              retryable: false,
            };
          }
          return {
            status: 'succeeded',
            // Runway does not report the rendered duration, only what was asked
            // for. Null is the honest answer; the renderer measures the real one
            // off the file it decodes.
            seconds: null,
            costUsd: creditsToUsd(view.cost?.credits),
          };
        }
        case 'FAILED':
          return {
            status: 'failed',
            reason: describeFailure(view),
            // Content moderation and a malformed prompt fail the same way every
            // time, and a retry is another charge. Only a genuinely internal
            // failure is worth repeating, and Runway names those.
            retryable: view.failureCode?.startsWith('INTERNAL') ?? false,
          };
        case 'CANCELLED':
          return { status: 'failed', reason: 'That render was cancelled.', retryable: true };
        case 'RUNNING':
          return {
            status: 'running',
            progress: typeof view.progress === 'number' ? view.progress : null,
          };
        default:
          // PENDING and THROTTLED are both "not started". They are worth
          // distinguishing in a log and not in the UI: the panel says queued.
          return { status: 'queued', progress: null };
      }
    },

    /**
     * Fetches the finished bytes.
     *
     * The task is re-read rather than a URL being carried over from `poll`,
     * because Runway's output URLs "expire within 24-48 hours; fetch the task
     * again to get fresh URLs". A library build that resumes the next morning
     * hits exactly that.
     */
    async download(
      job: ClipJobHandle,
      _state: SucceededState,
      signal?: AbortSignal,
    ): Promise<Uint8Array> {
      const view = await task(job.id, signal);
      const url = view.output?.[0];
      if (!url) {
        throw new VideoClipError(`Runway task ${job.id} has no downloadable output.`, {
          provider: 'runway',
        });
      }
      const response = await doFetch(url, { signal: signal ?? null });
      if (!response.ok) throw await failure(response, 'downloading a finished render');
      return new Uint8Array(await response.arrayBuffer());
    },

    /**
     * Checks the key and the credit balance together.
     *
     * Same reasoning as the Hedra adapter: a valid key on an empty account fails
     * at submit, long after the screen where "buy credits" is a useful sentence.
     * Runway reports a balance in credits, so it is converted here — nobody
     * budgets in credits.
     */
    async validateKey() {
      let response: Response;
      try {
        response = await doFetch(`${root}/v1/organization`, { headers });
      } catch {
        return { ok: false as const, reason: 'Could not reach Runway.' };
      }

      if (response.status === 401 || response.status === 403) {
        return { ok: false as const, reason: 'Runway rejected that key.' };
      }
      if (!response.ok) {
        return { ok: false as const, reason: `Runway returned ${response.status}.` };
      }

      const body = (await response.json()) as { creditBalance?: number };
      const credits = body.creditBalance ?? 0;
      const perClip = 5 * CREDITS_PER_SECOND;
      if (credits < CREDITS_PER_SECOND * MIN_SECONDS) {
        return {
          ok: false as const,
          reason: `That key works, but the account has ${credits} credits — not enough for one clip. A five-second clip costs ${perClip}.`,
        };
      }

      // Credits are Runway's unit; dollars and clips are the user's. All three,
      // because "500 credits" answers nothing on its own.
      const dollars = (credits * USD_PER_CREDIT).toFixed(2);
      const clips = Math.floor(credits / perClip);
      return {
        ok: true as const,
        note: `${credits} credits (about $${dollars}) — roughly ${clips} clip${clips === 1 ? '' : 's'}.`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The prompt, with as much of the negative list as will fit.
 *
 * `gen4_turbo` has no negative-prompt field — only the Veo variants do — so
 * `avoid` has nowhere to go but the end of `promptText`, and `promptText` stops
 * at 1000 code units. Every slot's prompt and avoid list *together* run
 * 982–1164, so this is not a hypothetical overflow: without packing, more than
 * half the library would be rejected outright.
 *
 * Whole clauses only. A budget-truncated tail could end mid-phrase and turn
 * "no extra limbs" into "no extra", which is a request rather than a
 * prohibition. Losing the tail costs little in practice, because the prompt
 * itself already restates the important negatives as positive rules — the
 * camera lock, the single action, the closed mouth and the return to pose are
 * all in SHARED_RULES.
 */
export function promptFor(request: ClipRequest): string {
  const base = request.prompt.trim();
  if (base.length >= PROMPT_LIMIT) return base.slice(0, PROMPT_LIMIT);

  const prefix = ' Avoid: ';
  let out = base + prefix;
  let wrote = false;

  for (const clause of request.avoid.split(',').map((part) => part.trim()).filter(Boolean)) {
    const addition = `${wrote ? ', ' : ''}${clause}`;
    // +1 for the closing full stop, which has to fit too.
    if (out.length + addition.length + 1 > PROMPT_LIMIT) break;
    out += addition;
    wrote = true;
  }

  return wrote ? `${out}.` : base;
}

function ratioFor(image: Uint8Array): string {
  const info = sniffImage(image);
  if (!info) return '960:960';
  return nearestAspectRatio(info.width, info.height, RATIOS);
}

function creditsToUsd(credits: number | undefined): number | null {
  return typeof credits === 'number' ? Math.round(credits * USD_PER_CREDIT * 100) / 100 : null;
}

/**
 * Runway's own words about a failure, with the code kept.
 *
 * Their spec says of `failure`: "We do not recommend returning this to users
 * directly without adding context." So it is prefixed rather than shown raw —
 * "Runway could not render this" in front of their sentence is the context.
 */
function describeFailure(view: TaskView): string {
  const detail = view.failure?.trim();
  const code = view.failureCode ? ` (${view.failureCode})` : '';
  return detail ? `Runway could not render this: ${detail}${code}` : `That render failed${code}.`;
}

function base64(bytes: Uint8Array): string {
  // Chunked: a single spread of a megabyte-scale array blows the call stack,
  // and this runs on real photographs.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function failure(response: Response, doing: string): Promise<VideoClipError> {
  const text = await response.text().catch(() => '');
  let detail = text.slice(0, 200);
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    detail = parsed.error ?? parsed.message ?? detail;
  } catch {
    // Not JSON; the raw body is the best detail available.
  }

  const friendly =
    response.status === 401 || response.status === 403
      ? 'Runway rejected that key.'
      : response.status === 402
        ? 'The Runway account is out of credits.'
        : response.status === 429
          ? 'Runway is rate limiting this account.'
          : `Runway returned ${response.status} while ${doing}.`;

  return new VideoClipError(detail ? `${friendly} ${detail}` : friendly, {
    status: response.status,
    provider: 'runway',
    retryable: response.status === 429 || response.status >= 500,
  });
}
