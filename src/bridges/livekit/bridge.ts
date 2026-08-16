/**
 * Calling Anna from a phone.
 *
 * ## Why LiveKit is here and `@livekit/agents` is not
 *
 * A phone cannot reach this server. The server binds to localhost by design,
 * and the alternative — opening a port, or running a tunnel — is a worse thing
 * to ask of someone than a free LiveKit project. LiveKit solves the part that
 * is genuinely hard about a phone call: NAT traversal, jitter, echo
 * cancellation, and a browser on cellular that changes IP mid-sentence. Both
 * ends dial *out* to it, so nothing is ever listening on the user's machine.
 *
 * What it is not used for is the model. `@livekit/agents` has a Gemini realtime
 * plugin, and on Node it cannot take video input — that is Python only, and
 * documented as such. Video is half of what a phone call to Anna is *for*, so
 * the agent framework is not usable here. Instead this bridge uses the plain
 * LiveKit media SDK as a pipe and feeds the same {@link Companion} the browser
 * uses. One brain, one Gemini session type, one language.
 *
 * ## Why Anna joins first
 *
 * There is no webhook, because a webhook needs an address the internet can
 * reach and that is the thing being avoided. So the flow is inverted: issuing a
 * call link makes Anna join the room and wait in it. If nobody arrives she
 * leaves again. It costs a few minutes of an idle participant and it removes
 * the entire class of inbound-connectivity problems.
 */

import { AccessToken } from 'livekit-server-sdk';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoStream,
  dispose,
} from '@livekit/rtc-node';
import type { RemoteTrack } from '@livekit/rtc-node';
import { encode as encodeJpeg } from 'jpeg-js';

import { Companion } from '../../core/session/companion.ts';
import type { Brain } from '../../core/session/brain.ts';
import { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE } from '../../shared/protocol.ts';

/** How long Anna waits in an empty room before giving up on the call. */
const WAIT_FOR_CALLER_MS = 3 * 60 * 1000;
/** How long a call may run before it is closed regardless. */
const MAX_CALL_MS = 60 * 60 * 1000;
/** Token lifetime. Long enough to walk to a quiet room, short enough to matter. */
const TOKEN_TTL = '15m';
/** Frames per second lifted out of the caller's video. The Live API's ceiling. */
const VIDEO_FPS = 1;
/** JPEG quality for frames sent to Gemini. Above this is bytes nobody sees. */
const JPEG_QUALITY = 72;

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  callPageUrl: string;
}

export interface CallInvite {
  url: string;
  room: string;
  expiresInMinutes: number;
}

export class CallBridge {
  readonly #brain: Brain;
  readonly #config: LiveKitConfig;
  #active: ActiveCall | null = null;

  constructor(options: { brain: Brain; livekit: LiveKitConfig }) {
    this.#brain = options.brain;
    this.#config = options.livekit;
  }

  get busy(): boolean {
    return this.#active !== null;
  }

  /**
   * Mints a caller token, opens the room, and puts Anna in it.
   *
   * The token goes in the URL *fragment*. A fragment is never sent to the
   * server that hosts the page, never appears in its logs, and does not survive
   * into a `Referer` header — which matters because the page is static hosting
   * we do not control.
   */
  async invite(callerName = 'you'): Promise<CallInvite> {
    if (!this.#config.callPageUrl) {
      throw new Error('ANNA_CALL_PAGE_URL is not set, so there is nowhere to send the call.');
    }
    await this.hangUp();

    const room = `anna-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const caller = new AccessToken(this.#config.apiKey, this.#config.apiSecret, {
      identity: `caller-${Math.random().toString(36).slice(2, 8)}`,
      name: callerName,
      ttl: TOKEN_TTL,
    });
    caller.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      // No data channel: nothing in this design sends any, and a capability
      // that is not used is a capability that cannot be misused.
      canPublishData: false,
    });

    const anna = new AccessToken(this.#config.apiKey, this.#config.apiSecret, {
      identity: 'anna',
      name: this.#brain.profile.identity.name,
      ttl: TOKEN_TTL,
    });
    anna.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });

    const call = new ActiveCall({
      brain: this.#brain,
      url: this.#config.url,
      token: await anna.toJwt(),
      onEnded: () => {
        if (this.#active === call) this.#active = null;
      },
    });
    this.#active = call;
    await call.join();

    const link = new URL(this.#config.callPageUrl);
    link.hash = new URLSearchParams({
      url: this.#config.url,
      token: await caller.toJwt(),
      name: this.#brain.profile.identity.name,
    }).toString();

    return { url: link.toString(), room, expiresInMinutes: 15 };
  }

  async hangUp(): Promise<void> {
    const call = this.#active;
    this.#active = null;
    await call?.close();
  }

  async close(): Promise<void> {
    await this.hangUp();
    try {
      await dispose();
    } catch {
      // The FFI runtime may already be down; nothing left to release.
    }
  }
}

// ---------------------------------------------------------------------------

class ActiveCall {
  readonly #brain: Brain;
  readonly #url: string;
  readonly #token: string;
  readonly #onEnded: () => void;
  readonly #room = new Room();
  #companion: Companion | null = null;
  #speaker: AudioSource | null = null;
  #closed = false;
  #callerArrived = false;
  #timers: ReturnType<typeof setTimeout>[] = [];

  constructor(options: { brain: Brain; url: string; token: string; onEnded: () => void }) {
    this.#brain = options.brain;
    this.#url = options.url;
    this.#token = options.token;
    this.#onEnded = options.onEnded;
  }

  async join(): Promise<void> {
    const speaker = new AudioSource(OUTPUT_SAMPLE_RATE, 1);
    this.#speaker = speaker;

    this.#companion = new Companion({
      brain: this.#brain,
      channel: 'phone',
      // A phone call is ears and eyes by definition; there is no screen to
      // share and no toggle to offer, so both start on and neither can be
      // turned off from that end.
      senses: { hearing: true, sight: true, screen: false },
      sink: {
        audio: (pcm) => void this.#play(pcm),
        transcript: () => undefined,
        state: () => undefined,
        mood: () => undefined,
        interrupted: () => speaker.clearQueue(),
        show: () => undefined,
        // A phone call carries her voice, not her face. Rendering a gesture
        // clip nobody can see would be money spent on nothing.
        move: () => undefined,
        trouble: (message) => console.warn(`call: ${message}`),
      },
    });

    this.#room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => this.#onTrack(track))
      .on(RoomEvent.ParticipantConnected, () => {
        this.#callerArrived = true;
      })
      .on(RoomEvent.ParticipantDisconnected, () => void this.close())
      .on(RoomEvent.Disconnected, () => void this.close());

    await this.#room.connect(this.#url, this.#token, { autoSubscribe: true, dynacast: true });

    const track = LocalAudioTrack.createAudioTrack('anna', speaker);
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await this.#room.localParticipant?.publishTrack(track, publishOptions);

    await this.#companion.wake();

    this.#timers.push(
      setTimeout(() => {
        if (!this.#callerArrived) void this.close();
      }, WAIT_FOR_CALLER_MS),
      setTimeout(() => void this.close(), MAX_CALL_MS),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];

    await this.#companion?.sleep();
    this.#companion = null;
    try {
      await this.#room.disconnect();
    } catch {
      // Already gone.
    }
    try {
      await this.#speaker?.close();
    } catch {
      // Same.
    }
    this.#speaker = null;
    this.#onEnded();
  }

  // -------------------------------------------------------------------------

  #onTrack(track: RemoteTrack): void {
    if (track.kind === TrackKind.KIND_AUDIO) void this.#pumpAudio(track);
    else if (track.kind === TrackKind.KIND_VIDEO) void this.#pumpVideo(track);
  }

  /**
   * The caller's voice.
   *
   * `AudioStream` resamples to whatever is asked for, so asking for exactly
   * what the Live API wants means there is no resampling code anywhere in Anna
   * — which is one fewer place for a click, a pitch shift or an off-by-one in a
   * ring buffer to live.
   */
  async #pumpAudio(track: RemoteTrack): Promise<void> {
    const stream = new AudioStream(track, { sampleRate: INPUT_SAMPLE_RATE, numChannels: 1 });
    try {
      for await (const frame of stream) {
        if (this.#closed) break;
        this.#companion?.hear(
          Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
        );
      }
    } catch {
      // The track ended. That is how tracks end.
    }
  }

  /**
   * The caller's camera, sampled down to one frame a second and JPEG-encoded.
   *
   * Encoding in pure JavaScript is fine precisely because of that rate: one
   * 640-wide frame per second is a couple of milliseconds of work, and it keeps
   * the install free of a native image library that would need a toolchain on
   * Windows.
   */
  async #pumpVideo(track: RemoteTrack): Promise<void> {
    const stream = new VideoStream(track);
    let lastSentAt = 0;

    try {
      for await (const event of stream) {
        if (this.#closed) break;
        const now = Date.now();
        if (now - lastSentAt < 1000 / VIDEO_FPS) continue;
        lastSentAt = now;

        const jpeg = toJpeg(event.frame);
        if (jpeg) this.#companion?.see(jpeg, 'camera');
      }
    } catch {
      // Same: the caller turned the camera off, or hung up.
    }
  }

  async #play(pcm: Buffer): Promise<void> {
    const speaker = this.#speaker;
    if (!speaker || this.#closed || pcm.length < 2) return;
    // A Buffer from base64 has no alignment guarantee, so the samples are
    // copied rather than viewed — an odd byteOffset would throw on Int16Array.
    const samples = new Int16Array(pcm.length >> 1);
    for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readInt16LE(i * 2);
    try {
      await speaker.captureFrame(
        new AudioFrame(samples, OUTPUT_SAMPLE_RATE, 1, samples.length),
      );
    } catch {
      // The call ended while a frame was in flight.
    }
  }
}

/** Converts a LiveKit frame to JPEG bytes, or null if the frame is unusable. */
function toJpeg(frame: { convert(type: VideoBufferType): { data: Uint8Array; width: number; height: number } }): Buffer | null {
  try {
    const rgba = frame.convert(VideoBufferType.RGBA);
    const encoded = encodeJpeg(
      { data: Buffer.from(rgba.data), width: rgba.width, height: rgba.height },
      JPEG_QUALITY,
    );
    return Buffer.from(encoded.data);
  } catch {
    return null;
  }
}
