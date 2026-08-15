/**
 * The provider-agnostic image-to-video interface, plus the registry.
 *
 * Same shape as core/llm and core/speech — an interface, one adapter per
 * vendor, a registry, and a `*_PROVIDER_INFO` table for the settings screen —
 * but the operation being abstracted is a different animal, and the interface
 * has to admit it:
 *
 *  - **It is a job, not a request.** Every image-to-video product on the market
 *    works the same way: POST an image and a prompt, get an id, poll it until
 *    it is done, then fetch the file from a URL that expires. Modelling that as
 *    `generate(): Promise<bytes>` would work right up to the first five-minute
 *    render, at which point the promise is a socket held open across a laptop
 *    lid closing. Submit, poll and download are three separate calls here so a
 *    job can outlive the process that started it — see `ClipJobRef` in
 *    clips.ts for why that is worth the extra surface.
 *  - **It costs money per call.** Voice and text bill in fractions of a cent
 *    and nobody asks first. A clip is $0.10–$0.50 and a full library is a few
 *    dollars, so the cost is part of the interface ({@link ClipCostModel}) and
 *    the UI is expected to show a number before the first submit rather than
 *    after the last one.
 *  - **It is not on the conversation path.** Nothing here runs while she is
 *    talking. Latency is a progress bar, not a design constraint, which is the
 *    entire reason this approach is viable where the per-minute streaming
 *    avatars in docs/adr/0003-avatar-renderer.md were not.
 *
 * Three of the four adapters below are stubs. That is deliberate and it is
 * stated rather than hidden: the endpoint paths, request field names and prices
 * for these vendors could not be verified from here, and a plausible-looking
 * wrong URL costs more to debug than an honest `throw`. Each stub lists exactly
 * what has to be filled in. The fourth — `manual` — is real, needs no key, and
 * is what makes the rest of this module testable and usable today.
 */

import type { ClipSlotName } from './clips.ts';
import { createHedraProvider } from './hedra-provider.ts';
import { createManualProvider } from './manual-provider.ts';
import { createRunwayProvider } from './runway-provider.ts';

/**
 * Video providers are a different axis from `AvatarRendererId` in
 * shared/protocol.ts, and deliberately not folded into it. That union names the
 * thing that *draws* Anna (`vrm`, and the two unimplemented streaming heads);
 * this one names the thing that *made the clips*, once, at setup. A clip
 * library rendered by Runway is played back by the same local renderer as one
 * rendered by hand, so collapsing the two would mean the renderer id no longer
 * tells you what code draws the screen.
 */
export type VideoProviderId = 'manual' | 'hedra' | 'runway' | 'luma' | 'kling';

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface ClipRequest {
  slot: ClipSlotName;
  /**
   * The source photograph, as bytes.
   *
   * Every clip in a library is generated from these exact bytes — not from a
   * re-encode, not from a resized copy. The whole loop-closing argument in
   * prompts.ts depends on all nineteen clips sharing one first frame, and a
   * JPEG re-encoded at a different quality is a different first frame.
   */
  image: Uint8Array;
  imageMimeType: string;
  prompt: string;
  /** For the vendor's negative-prompt field. See prompts.ts on why it is separate. */
  avoid: string;
  /** Requested length. Vendors quantise; the prompt does not depend on the exact value. */
  seconds: number;
  /**
   * Driving audio, for the vendors that are audio-driven rather than
   * prompt-driven.
   *
   * Optional because it is meaningless to half the providers here and mandatory
   * to the other half. The two families are genuinely different machines: Runway
   * and Luma read a prompt and invent motion, while Hedra and OmniHuman read a
   * waveform and derive mouth, head and body from it — they have no prompt-only
   * mode at all.
   *
   * Left unset, an audio-driven provider supplies its own silence (see
   * `silentWav` in hedra-provider.ts), which is the right default for the idle
   * and gesture clips that make up most of a library. Set, it is how a clip gets
   * lip-synced to a specific line Anna is about to say.
   */
  audio?: { bytes: Uint8Array; mimeType: string };
  signal?: AbortSignal;
}

export interface ClipJobHandle {
  providerId: VideoProviderId;
  id: string;
  submittedAt: number;
}

export type ClipJobState =
  | { status: 'queued' | 'running'; progress: number | null }
  | { status: 'succeeded'; seconds: number | null; costUsd: number | null }
  | { status: 'failed'; reason: string; retryable: boolean };

export type SucceededState = Extract<ClipJobState, { status: 'succeeded' }>;

export interface ClipCostModel {
  /** USD per clip, when there is a number worth trusting. `null` when there is not. */
  usdPerClip: number | null;
  /**
   * The figure warnings fall back to. A planning bound taken from the observed
   * spread across this category, not a quote from anyone — which is why it is
   * named differently from `usdPerClip` and why {@link estimateLibraryCost}
   * reports whether the estimate is confident.
   */
  assumedUsdPerClip: number;
  /** Where a human goes to confirm the real number. */
  pricingUrl: string | null;
  /**
   * Where {@link usdPerClip} came from.
   *
   * Added because the two wired providers land in genuinely different places and
   * a single boolean flattened them into the same "unverified" bucket. Runway
   * publishes a rate card — 5 credits per second, one credit a cent — so a clip
   * costs $0.25 and that is arithmetic, not a guess. Hedra bills by the second
   * of driving audio and *refuses* to quote before ingest, so no figure exists
   * to state at all. Showing "$0.25" and "somewhere between $2 and $10" with the
   * same confidence would be the misleading part.
   */
  basis: 'observed' | 'published' | 'unknown';
  /**
   * Whether {@link usdPerClip} is good enough to show as a figure rather than a
   * range. True for a published rate card as well as for an observed invoice —
   * both beat the category envelope.
   */
  verified: boolean;
}

export interface VideoClipProvider {
  readonly id: VideoProviderId;
  readonly label: string;
  readonly cost: ClipCostModel;
  /** How long a job may run before it is treated as lost. */
  readonly timeoutMs: number;
  /** Starts a render. Returns as soon as the vendor has accepted the job. */
  submit(request: ClipRequest): Promise<ClipJobHandle>;
  /** One status check. Cheap, and safe to call on a job from a previous run. */
  poll(job: ClipJobHandle, signal?: AbortSignal): Promise<ClipJobState>;
  /** The finished bytes. Only legal once {@link poll} has returned 'succeeded'. */
  download(job: ClipJobHandle, state: SucceededState, signal?: AbortSignal): Promise<Uint8Array>;
  /** Cheap credential check for the setup screen. Never spends anything. */
  validateKey(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export class VideoClipError extends Error {
  readonly status: number | undefined;
  readonly provider: string | undefined;
  /** Whether submitting the same request again might work. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; provider?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'VideoClipError';
    this.status = options.status;
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
  }
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * The spread this category charges for a single short clip, as of the research
 * behind this module. Used only to warn, never to bill, and only when a
 * provider has no verified price of its own.
 */
export const CLIP_PRICE_ENVELOPE = { low: 0.1, high: 0.5 } as const;

export interface CostEstimate {
  low: number;
  high: number;
  /** False when this is the envelope rather than a real price. Say so in the UI. */
  confident: boolean;
}

/**
 * What building `clipCount` clips will cost.
 *
 * This exists to be shown *before* the first submit. A full nineteen-slot
 * library is somewhere between two and ten dollars, and the difference between
 * a user who was told that and a user who found out afterwards is the
 * difference between a feature and a complaint.
 */
export function estimateLibraryCost(cost: ClipCostModel, clipCount: number): CostEstimate {
  if (cost.usdPerClip !== null && cost.verified) {
    const total = round(cost.usdPerClip * clipCount);
    return { low: total, high: total, confident: true };
  }
  const known = cost.usdPerClip ?? cost.assumedUsdPerClip;
  return {
    low: round(Math.min(known, CLIP_PRICE_ENVELOPE.low) * clipCount),
    high: round(Math.max(known, CLIP_PRICE_ENVELOPE.high) * clipCount),
    confident: false,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// The submit / poll / download driver
// ---------------------------------------------------------------------------

export interface ClipRunOptions {
  /** First gap between polls. Grows from here. */
  pollIntervalMs?: number;
  /** Overrides the provider's own timeout. */
  timeoutMs?: number;
  /** Injected so tests can run the whole loop without waiting or mocking timers. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onState?: (state: ClipJobState) => void;
  signal?: AbortSignal;
}

export interface ClipResult {
  bytes: Uint8Array;
  seconds: number | null;
  costUsd: number | null;
  job: ClipJobHandle;
}

const DEFAULT_POLL_MS = 5_000;
/**
 * Polling backs off because the two failure modes pull in opposite directions:
 * a job that finishes in 30 seconds should not be discovered 60 seconds late,
 * and a job that takes five minutes should not cost 300 status requests against
 * a rate limit that is usually much tighter than the generation quota.
 */
const POLL_BACKOFF = 1.5;
const MAX_POLL_MS = 30_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Submit, then wait. The whole lifecycle for a clip that starts here. */
export async function generateClip(
  provider: VideoClipProvider,
  request: ClipRequest,
  options: ClipRunOptions = {},
): Promise<ClipResult> {
  const job = await provider.submit(request);
  return awaitClip(provider, job, options);
}

/**
 * Wait on a job, wherever it came from.
 *
 * Split from {@link generateClip} because the interesting caller is the other
 * one: a job recovered from the manifest after a restart re-enters here with no
 * submit, which is what makes a crash mid-build free rather than expensive.
 */
export async function awaitClip(
  provider: VideoClipProvider,
  job: ClipJobHandle,
  options: ClipRunOptions = {},
): Promise<ClipResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? provider.timeoutMs);
  let wait = options.pollIntervalMs ?? DEFAULT_POLL_MS;

  for (;;) {
    options.signal?.throwIfAborted();

    const state = await provider.poll(job, options.signal);
    options.onState?.(state);

    if (state.status === 'succeeded') {
      const bytes = await provider.download(job, state, options.signal);
      return { bytes, seconds: state.seconds, costUsd: state.costUsd, job };
    }

    if (state.status === 'failed') {
      throw new VideoClipError(state.reason, { provider: provider.id, retryable: state.retryable });
    }

    if (now() >= deadline) {
      // Retryable: a job that has run past the deadline is usually a queue that
      // is backed up rather than a request that was wrong, and the handle is
      // still on disk, so the next run re-polls it instead of paying again.
      throw new VideoClipError(
        `${provider.label} did not finish ${job.id} in time.`,
        { provider: provider.id, retryable: true },
      );
    }

    await sleep(wait);
    wait = Math.min(MAX_POLL_MS, Math.round(wait * POLL_BACKOFF));
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface VideoProviderOptions {
  apiKey?: string;
  /**
   * Where the `manual` provider looks for clips a human rendered elsewhere.
   * Ignored by the hosted providers.
   */
  dropDir?: string;
}

/**
 * The signature differs from `createTtsProvider(id, key)` on purpose: one of
 * these providers has no key at all, and giving it a parameter it must ignore
 * would mean callers inventing a value to satisfy a type. An options bag says
 * what is true — different backends need different things.
 */
const FACTORIES: Record<VideoProviderId, (options: VideoProviderOptions) => VideoClipProvider> = {
  manual: (options) => createManualProvider(options.dropDir ?? ''),
  hedra: (options) => createHedraProvider({ apiKey: options.apiKey ?? '' }),
  runway: (options) => createRunwayProvider({ apiKey: options.apiKey ?? '' }),
  luma: (options) => createLumaProvider(options.apiKey ?? ''),
  kling: (options) => createKlingProvider(options.apiKey ?? ''),
};

export function createVideoClipProvider(
  id: VideoProviderId,
  options: VideoProviderOptions = {},
): VideoClipProvider {
  const factory = FACTORIES[id];
  if (!factory) throw new Error(`Unknown video provider: ${id}`);
  return factory(options);
}

/** Metadata for the setup screen, without instantiating anything. */
export const VIDEO_PROVIDER_INFO: ReadonlyArray<{
  id: VideoProviderId;
  label: string;
  why: string;
  /**
   * The vendor's own site — where to start reading. **Not an API base.** No
   * endpoint is recorded anywhere in this module because none was verified.
   */
  site: string | null;
  status: 'wired' | 'stub';
}> = [
  {
    id: 'manual',
    label: 'Bring your own clips',
    why: 'Render the nineteen clips yourself, in whichever tool you already pay for, and drop them in a folder. No key, no API, no surprises on a bill.',
    site: null,
    status: 'wired',
  },
  {
    id: 'hedra',
    label: 'Hedra',
    why: 'Audio-driven: hand it a waveform and it lip-syncs the photograph to it. The only one here that can make her mouth match a line she is about to say. Bills by the second of driving audio and will not quote a price beforehand.',
    site: 'https://www.hedra.com',
    status: 'wired',
  },
  {
    id: 'runway',
    label: 'Runway',
    why: 'Prompt-driven rather than audio-driven, so a silent gesture clip is what it does natively. Publishes its rate, so a library costs a knowable $4.75 rather than a surprise.',
    site: 'https://dev.runwayml.com',
    status: 'wired',
  },
  {
    id: 'luma',
    label: 'Luma Dream Machine',
    why: 'Fast and cheap per clip, with an explicit keyframe/loop concept that maps unusually well onto the loop-closing requirement.',
    site: 'https://lumalabs.ai',
    status: 'stub',
  },
  {
    id: 'kling',
    label: 'Kling',
    why: 'The most convincing human body motion in the category, which matters here because half the library is limbs rather than heads.',
    site: 'https://klingai.com',
    status: 'stub',
  },
];

// ---------------------------------------------------------------------------
// Stub adapters
// ---------------------------------------------------------------------------

/**
 * What every stub below still needs, and why it is not guessed at here.
 *
 * These are not hard integrations — each is perhaps forty lines — but every
 * line of them is a detail that has to be read off a live API reference:
 *
 *   1. the API base URL and the version prefix;
 *   2. the auth header (`Authorization: Bearer` is common but not universal;
 *      Cartesia in this same codebase uses `X-API-Key`, and Kling is
 *      documented as using a signed JWT rather than a static key);
 *   3. the submit path, and the field names for the init image, the prompt, the
 *      negative prompt and the duration — including whether the image goes as a
 *      URL, as base64, or as multipart;
 *   4. the poll path and the exact status strings;
 *   5. which field on a finished job holds the video URL, and how long that URL
 *      stays valid;
 *   6. the real price per clip, and whether failed jobs are billed.
 *
 * Writing plausible values for any of those produces something that compiles,
 * type-checks, passes review and then fails at runtime against a live account
 * with a 404 that looks like an outage. An honest `throw` fails in the one
 * place where the fix is obvious. Fill these in against the vendor's docs, set
 * `verified: true` on the cost model at the same time, and flip `status` in
 * {@link VIDEO_PROVIDER_INFO} to `'wired'`.
 */
function notWired(
  id: VideoProviderId,
  label: string,
  cost: ClipCostModel,
): VideoClipProvider {
  const unwired = (): never => {
    throw new VideoClipError(
      `The ${label} adapter is not wired up yet. Use "Bring your own clips", or fill in the endpoints in core/avatar/video-provider.ts.`,
      { provider: id },
    );
  };

  return {
    id,
    label,
    cost,
    // Generous: these renders are documented in minutes, not seconds, and a
    // timeout that fires early throws away a clip that was already paid for.
    timeoutMs: 10 * 60_000,
    async submit() {
      return unwired();
    },
    async poll() {
      return unwired();
    },
    async download() {
      return unwired();
    },
    async validateKey() {
      return { ok: false, reason: `${label} is not wired up in this build.` };
    },
  };
}

// TODO(video): fill in the six items listed above from Luma's API reference.
function createLumaProvider(_apiKey: string): VideoClipProvider {
  return notWired('luma', 'Luma Dream Machine', {
    usdPerClip: null,
    assumedUsdPerClip: CLIP_PRICE_ENVELOPE.low,
    pricingUrl: null,
    basis: 'unknown',
    verified: false,
  });
}

// TODO(video): fill in the six items listed above from Kling's API reference.
// Note the auth difference called out in item 2 before copying another adapter.
function createKlingProvider(_apiKey: string): VideoClipProvider {
  return notWired('kling', 'Kling', {
    usdPerClip: null,
    assumedUsdPerClip: CLIP_PRICE_ENVELOPE.low,
    pricingUrl: null,
    basis: 'unknown',
    verified: false,
  });
}
