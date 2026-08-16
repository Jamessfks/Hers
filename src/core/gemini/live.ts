/**
 * One live conversation with Gemini.
 *
 * This is the only place in Anna that talks to a model in real time. The
 * browser and the phone are two transports in front of it, not two
 * implementations of it — which is the whole reason the LiveKit bridge does not
 * use `@livekit/agents`: the Node build of its Gemini plugin cannot take video
 * input, and video is half the product.
 *
 * ## What this class is actually for
 *
 * Not "wrap the SDK". The SDK is already a thin wrapper. What is genuinely hard
 * about the Live API is that **the session ends, repeatedly, in normal
 * operation**, and everything above here has to be unable to tell:
 *
 *   - An audio+video session is capped at about two minutes, and audio-only at
 *     fifteen. `contextWindowCompression` removes that cap, but the socket can
 *     still go at any time.
 *   - The server sends `goAway` with a `timeLeft` shortly before it drops you.
 *     Waiting for the drop wastes that warning; a session rebuilt during it is
 *     seamless, one rebuilt after it eats a sentence.
 *   - `sessionResumption` hands back a rolling handle. Reconnecting with the
 *     newest handle continues the same conversation; reconnecting without one
 *     starts a stranger who has never met the user.
 *
 * So: hold the handle, rebuild eagerly on `goAway`, rebuild with backoff on
 * anything else, and drop realtime media on the floor while there is no socket.
 * Buffering realtime audio across a reconnect would be worse than losing it —
 * the user would hear Anna answer a question from thirty seconds ago.
 */

import { GoogleGenAI, MediaResolution, Modality, StartSensitivity, EndSensitivity } from '@google/genai';
import type {
  FunctionDeclaration,
  LiveConnectConfig,
  LiveServerMessage,
  Session,
} from '@google/genai';

import { capabilitiesOf } from './models.ts';

export type LiveState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error';

export interface LiveHandlers {
  /** Anna's voice: raw PCM, signed 16-bit little-endian, 24kHz mono. */
  onAudio(pcm: Buffer): void;
  /** Running transcription of the user's speech. */
  onUserText(text: string, final: boolean): void;
  /** Running transcription of Anna's speech. */
  onAnnaText(text: string, final: boolean): void;
  /** A turn finished cleanly. */
  onTurnComplete(): void;
  /** Anna was cut off. Anything queued for playback is now stale. */
  onInterrupted(): void;
  /** Resolve to the value the model should see as the function's result. */
  onToolCall(name: string, args: Record<string, unknown>): Promise<unknown>;
  onState(state: LiveState): void;
  /** Worth telling a human about, in the words you would use to a human. */
  onTrouble(message: string): void;
}

export interface LiveOptions {
  apiKey: string;
  model: string;
  voice: string;
  languageCode?: string;
  /** The whole of who Anna is. Rebuilt from scratch on every reconnect. */
  systemInstruction: () => string;
  tools?: FunctionDeclaration[];
  /** Lower costs fewer tokens per frame. Screen text needs at least MEDIUM. */
  mediaResolution?: MediaResolution;
  handlers: LiveHandlers;
  /** Injectable so tests do not open sockets. */
  connect?: LiveConnector;
}

/** The seam tests replace. Matches `ai.live.connect`. */
export type LiveConnector = (params: {
  model: string;
  config: LiveConnectConfig;
  callbacks: {
    onopen?: () => void;
    onmessage: (message: LiveServerMessage) => void;
    onerror?: (error: unknown) => void;
    onclose?: (event: unknown) => void;
  };
}) => Promise<LiveSocket>;

/** The part of the SDK's `Session` this class uses. */
export interface LiveSocket {
  sendClientContent(params: { turns?: unknown; turnComplete?: boolean }): void;
  sendRealtimeInput(params: Record<string, unknown>): void;
  sendToolResponse(params: { functionResponses: unknown }): void;
  close(): void;
}

/**
 * Compression is what removes the session duration cap, so it is not optional
 * and there is no configuration for turning it off. The trigger is set well
 * inside the 131k input window so that compaction happens during a pause rather
 * than at the moment the window fills.
 */
const COMPRESSION_TRIGGER_TOKENS = '96000';
const COMPRESSION_TARGET_TOKENS = '32000';

/** Backoff between reconnect attempts, in milliseconds. */
const BACKOFF_MS = [400, 900, 2000, 4000, 8000, 15000];

/**
 * Rebuild this long before the server says it will hang up.
 *
 * `goAway.timeLeft` is a duration string like "8.5s". Reconnecting immediately
 * on the warning is simplest and costs nothing: the old socket is still open
 * while the new one sets up, so nothing is dropped in between.
 */
const GO_AWAY_GRACE_MS = 500;

export class LiveConversation {
  readonly #options: LiveOptions;
  readonly #connect: LiveConnector;
  #socket: LiveSocket | null = null;
  #state: LiveState = 'idle';
  /** Newest resumption handle. This is the conversation's continuity. */
  #handle: string | undefined;
  #attempt = 0;
  #closing = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #connecting: Promise<void> | null = null;
  /** Transcript fragments waiting for the turn to close. */
  #userBuffer = '';
  #annaBuffer = '';
  /** Guards against a stale socket's callbacks reaching a live session. */
  #generation = 0;

  constructor(options: LiveOptions) {
    this.#options = options;
    this.#connect =
      options.connect ??
      (((params) => {
        const ai = new GoogleGenAI({ apiKey: options.apiKey });
        return ai.live.connect(params as Parameters<typeof ai.live.connect>[0]) as Promise<
          unknown
        > as Promise<LiveSocket>;
      }) as LiveConnector);
  }

  get state(): LiveState {
    return this.#state;
  }

  /** True when media sent right now will actually reach the model. */
  get isLive(): boolean {
    return this.#state === 'live' && this.#socket !== null;
  }

  async start(): Promise<void> {
    this.#closing = false;
    this.#handle = undefined;
    await this.#open('connecting');
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /** Microphone audio: PCM signed 16-bit little-endian, 16kHz mono. */
  sendAudio(pcm: Buffer): void {
    if (pcm.length === 0) return;
    this.#realtime({
      audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
    });
  }

  /**
   * A still image: a camera frame, a screen frame, or a photo they sent.
   *
   * The Live API takes these on the `video` channel whether or not they came
   * from a camera — "video" there means "a picture at a moment", and it accepts
   * JPEG or PNG.
   */
  sendImage(bytes: Buffer, mimeType = 'image/jpeg'): void {
    if (bytes.length === 0) return;
    this.#realtime({ video: { data: bytes.toString('base64'), mimeType } });
  }

  /** Something the user typed. Treated as speech: she answers it. */
  sendText(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.#realtime({ text: trimmed });
  }

  /**
   * Puts something into the conversation's context without asking for a reply.
   *
   * This is how a mood shift or a change in what the senses can see reaches her
   * mid-conversation. `turnComplete: false` is the entire trick: the content
   * lands in context and the model stays quiet, where `sendRealtimeInput({text})`
   * would make her answer a stage direction out loud.
   */
  inject(note: string): void {
    const trimmed = note.trim();
    if (!trimmed || !this.#socket) return;
    this.#guard(() =>
      this.#socket?.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: `⟦context⟧ ${trimmed}` }] }],
        turnComplete: false,
      }),
    );
  }

  /**
   * Asks Anna to speak now, for a stated reason, without the user having said
   * anything. This is the mechanism behind the three-minute rule.
   */
  prompt(note: string): void {
    const trimmed = note.trim();
    if (!trimmed || !this.#socket) return;
    this.#guard(() =>
      this.#socket?.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: `⟦director⟧ ${trimmed}` }] }],
        turnComplete: true,
      }),
    );
  }

  /**
   * Ends the current audio stream.
   *
   * Needed on the Telegram path, where a voice note is a complete utterance
   * with no trailing silence for the automatic detector to find. Without it she
   * waits for an end of speech that has already happened.
   */
  endAudioStream(): void {
    this.#realtime({ audioStreamEnd: true });
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#generation += 1;
    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.close();
    } catch {
      // Already gone. Nothing to do and nothing worth saying.
    }
    this.#setState('closed');
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  #realtime(payload: Record<string, unknown>): void {
    // Deliberately dropped rather than queued while there is no socket. See the
    // note at the top of the file: stale realtime media is worse than none.
    if (!this.isLive) return;
    this.#guard(() => this.#socket?.sendRealtimeInput(payload));
  }

  /**
   * Every send goes through here.
   *
   * The SDK throws synchronously if the underlying socket has closed between
   * our last state update and this call — a race that is unavoidable and
   * completely routine. Treating it as a reconnect rather than an exception is
   * what keeps a dropped connection from surfacing as an unhandled rejection in
   * the middle of a sentence.
   */
  #guard(send: () => void): void {
    try {
      send();
    } catch (error) {
      if (this.#closing) return;
      this.#scheduleReconnect(describeError(error));
    }
  }

  async #open(state: LiveState): Promise<void> {
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#doOpen(state).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #doOpen(state: LiveState): Promise<void> {
    if (this.#closing) return;
    this.#setState(state);

    const generation = ++this.#generation;
    const previous = this.#socket;

    try {
      const socket = await this.#connect({
        model: this.#options.model,
        config: this.#buildConfig(),
        callbacks: {
          onmessage: (message) => {
            if (generation === this.#generation) this.#handleMessage(message);
          },
          onerror: (error) => {
            if (generation !== this.#generation || this.#closing) return;
            this.#scheduleReconnect(describeError(error));
          },
          onclose: () => {
            if (generation !== this.#generation || this.#closing) return;
            this.#scheduleReconnect('the connection closed');
          },
        },
      });

      // A close() that landed while we were connecting wins.
      if (generation !== this.#generation || this.#closing) {
        socket.close();
        return;
      }

      this.#socket = socket;
      this.#attempt = 0;
      this.#setState('live');
    } catch (error) {
      if (generation !== this.#generation || this.#closing) return;
      this.#socket = null;
      this.#scheduleReconnect(describeError(error));
    } finally {
      // Closed after the replacement is up, so a `goAway` rebuild has no gap.
      if (previous && previous !== this.#socket) {
        try {
          previous.close();
        } catch {
          // It was on its way out regardless.
        }
      }
    }
  }

  #buildConfig(): LiveConnectConfig {
    const caps = capabilitiesOf(this.#options.model);
    const config: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: this.#options.systemInstruction(),
      mediaResolution: this.#options.mediaResolution ?? MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.#options.voice } },
        ...(this.#options.languageCode ? { languageCode: this.#options.languageCode } : {}),
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // An empty object opts in; the handle comes back on the first update.
      sessionResumption: this.#handle ? { handle: this.#handle } : {},
      contextWindowCompression: {
        triggerTokens: COMPRESSION_TRIGGER_TOKENS,
        slidingWindow: { targetTokens: COMPRESSION_TARGET_TOKENS },
      },
      realtimeInputConfig: {
        automaticActivityDetection: {
          // Companions get talked over and talk over people. Both sensitivities
          // sit high so she yields fast and starts fast; the cost is the
          // occasional false start, which sounds far more human than a pause.
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
          prefixPaddingMs: 120,
          silenceDurationMs: 600,
        },
      },
    };

    if (this.#options.tools?.length) {
      config.tools = [{ functionDeclarations: this.#options.tools }];
    }
    if (caps.affectiveDialog) config.enableAffectiveDialog = true;

    return config;
  }

  #scheduleReconnect(reason: string): void {
    if (this.#closing || this.#reconnectTimer) return;
    this.#socket = null;
    this.#setState('reconnecting');

    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 15000;
    this.#attempt += 1;

    // Only worth a word to the user once it has stopped being a blip.
    if (this.#attempt === 3) {
      this.#options.handlers.onTrouble(`Losing the connection to Gemini — ${reason}. Retrying.`);
    }

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#open('reconnecting');
    }, delay);
  }

  #setState(state: LiveState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.handlers.onState(state);
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  #handleMessage(message: LiveServerMessage): void {
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.#handle = message.sessionResumptionUpdate.newHandle;
    }

    if (message.goAway) {
      // Rebuild now, while the current socket still works.
      setTimeout(() => {
        if (!this.#closing) void this.#open('reconnecting');
      }, GO_AWAY_GRACE_MS);
    }

    if (message.toolCall?.functionCalls?.length) {
      void this.#runTools(message.toolCall.functionCalls);
    }

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      this.#annaBuffer = '';
      this.#options.handlers.onInterrupted();
    }

    // Read parts directly rather than through `message.data`: that getter logs
    // a console warning for every non-inline part, which on an audio session
    // with transcription enabled means a warning per chunk.
    for (const part of content.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data && inline.mimeType?.startsWith('audio/')) {
        this.#options.handlers.onAudio(Buffer.from(inline.data, 'base64'));
      }
    }

    const heard = content.inputTranscription?.text ?? content.interimInputTranscription?.text;
    if (heard) {
      this.#userBuffer += heard;
      this.#options.handlers.onUserText(this.#userBuffer, false);
    }

    const said = content.outputTranscription?.text;
    if (said) {
      this.#annaBuffer += said;
      this.#options.handlers.onAnnaText(this.#annaBuffer, false);
    }

    if (content.turnComplete) {
      if (this.#userBuffer.trim()) this.#options.handlers.onUserText(this.#userBuffer, true);
      if (this.#annaBuffer.trim()) this.#options.handlers.onAnnaText(this.#annaBuffer, true);
      this.#userBuffer = '';
      this.#annaBuffer = '';
      this.#options.handlers.onTurnComplete();
    }
  }

  /**
   * Tool results go back in one message.
   *
   * Every call gets a response even when the handler throws, because a model
   * waiting on a function response that never arrives simply stops talking, and
   * from the outside that is indistinguishable from Anna ignoring you.
   */
  async #runTools(calls: readonly { id?: string; name?: string; args?: Record<string, unknown> }[]) {
    const responses = await Promise.all(
      calls.map(async (call) => {
        let response: unknown;
        try {
          response = await this.#options.handlers.onToolCall(call.name ?? '', call.args ?? {});
        } catch (error) {
          response = { error: describeError(error) };
        }
        return {
          id: call.id,
          name: call.name,
          response: (isRecord(response) ? response : { result: response ?? null }) as Record<
            string,
            unknown
          >,
        };
      }),
    );
    if (responses.length === 0) return;
    this.#guard(() => this.#socket?.sendToolResponse({ functionResponses: responses }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (isRecord(error)) {
    const message = error.message ?? error.reason ?? error.type;
    if (typeof message === 'string' && message) return message;
  }
  return 'unknown error';
}

/** Re-exported so callers do not have to import from the SDK directly. */
export { MediaResolution, Modality };
export type { FunctionDeclaration, Session };
