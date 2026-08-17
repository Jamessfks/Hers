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
  /** Injectable so a test for the deadline does not have to wait it out. */
  connectTimeoutMs?: number;
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

/**
 * How long transcription must go quiet before a turn counts as finished.
 *
 * Google documents no ordering between `outputTranscription` and
 * `turnComplete`, and in practice chunks do arrive after it. Emitting the
 * moment the turn closed therefore cut sentences mid-word — a real one, out of
 * a real conversation: "Thought you might still be buried under that prese".
 *
 * Waiting for the text to stop arriving is the only correct rule when the
 * ordering is undefined. A third of a second is imperceptible in a chat and is
 * far longer than the gap between consecutive chunks.
 */
const SETTLE_MS = 350;

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

/**
 * How long to wait for a socket to finish opening.
 *
 * Not belt and braces — this is load-bearing. When the server refuses a session
 * outright it closes during the handshake, and the SDK's connect promise then
 * neither resolves nor rejects: there was never an `onopen` to resolve it and
 * the close arrives on a callback instead. `#doOpen` awaited it forever, which
 * meant `#connecting` was never cleared, every later reconnect returned that
 * same dead promise, and `wake()` never settled.
 *
 * The visible version of that: type to her with a key whose project has hit its
 * spending cap and the interface says "reconnecting" until you close the tab.
 * No error, no retry, nothing in the log. Found by the audit, which exited
 * silently for exactly this reason rather than reporting a failure.
 */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Reasons that will not be fixed by trying again in four hundred milliseconds.
 *
 * A spending cap, a revoked key or an exhausted quota are states of the world,
 * not blips, and backing off quietly for thirty seconds before saying anything
 * is thirty seconds of the user believing she is broken. Matched on the message
 * because that is where the API puts it — over a socket these arrive as a 1011
 * close carrying the same text a 429 would have had in its body.
 */
const FATAL_REASON = /spend|spending cap|quota|exceeded|api key|permission|unauthor|forbidden/i;

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
  /** Pending settle: see `#settle`. */
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  #turnEnded = false;
  /** True between a completion signal and the settle it scheduled. */
  #awaitingSettle = false;
  /** Guards against a stale socket's callbacks reaching a live session. */
  #generation = 0;
  /** Why the last attempt was refused, if the server said. */
  #refused: string | null = null;

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
   * Puts a picture into context, silently and for good.
   *
   * Not `sendRealtimeInput` — that channel is for the live stream, a frame that
   * describes this moment and is meant to age out. This is for a fact about the
   * conversation that should still be true an hour in: what she looks like.
   *
   * `Part.inlineData` and `sendClientContent`'s `Content[]` are both in the
   * SDK's own type definitions, and `turnComplete: false` is what keeps her
   * from answering a photograph out loud.
   */
  showImage(bytes: Buffer, mimeType: string, note: string): void {
    if (bytes.length === 0 || !this.#socket) return;
    this.#guard(() =>
      this.#socket?.sendClientContent({
        turns: [
          {
            role: 'user',
            parts: [
              { inlineData: { data: bytes.toString('base64'), mimeType } },
              { text: `⟦context⟧ ${note}` },
            ],
          },
        ],
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
      const socket = await withDeadline(
        this.#connect({
          model: this.#options.model,
          config: this.#buildConfig(),
          callbacks: {
            onmessage: (message) => {
              if (generation === this.#generation) this.#handleMessage(message);
            },
            onerror: (error) => {
              if (generation !== this.#generation || this.#closing) return;
              this.#refused = describeError(error);
              this.#scheduleReconnect(this.#refused);
            },
            onclose: (event) => {
              if (generation !== this.#generation || this.#closing) return;
              // Remembered so that if the connect promise then hangs — which is
              // what a refusal during the handshake does — the deadline can
              // report the real reason instead of "it never opened".
              this.#refused = describeClose(event);
              this.#scheduleReconnect(this.#refused);
            },
          },
        }),
        this.#options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
        () => this.#refused ?? 'the connection never opened',
      );

      // A close() that landed while we were connecting wins.
      if (generation !== this.#generation || this.#closing) {
        socket.close();
        return;
      }

      this.#socket = socket;
      this.#attempt = 0;
      this.#discardPartial();
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
      if (caps.toolsWithAudio) {
        config.tools = [{ functionDeclarations: this.#options.tools }];
      } else {
        /*
         * Deliberately dropped rather than sent.
         *
         * On a model where tools and audio input cannot coexist, attaching them
         * does not degrade the session — it closes it with a 1011 the instant
         * the user speaks, over and over. A companion who cannot use her tools
         * is diminished; one who disconnects whenever she is spoken to does not
         * work at all.
         */
        this.#options.handlers.onTrouble(
          `${this.#options.model} drops the connection when tools are used with speech, so she is running without them. Use ANNA_MODEL=gemini-3.1-flash-live-preview to get them back.`,
        );
      }
    }
    if (caps.affectiveDialog) config.enableAffectiveDialog = true;

    return config;
  }

  /**
   * `ANNA_DEBUG=1` prints what the session is doing behind the conversation.
   *
   * Off by default because a single reconnect is routine and not worth a line
   * in someone's terminal. On, because the alternative is what happened here:
   * a model-specific server fault closing the socket on every spoken turn,
   * which from the outside was indistinguishable from "she just doesn't
   * answer". The reason string is the whole diagnosis.
   */
  #debug(message: string): void {
    if (process.env.ANNA_DEBUG) console.error(`[live] ${message}`);
  }

  #scheduleReconnect(reason: string): void {
    this.#debug(`reconnecting — ${reason}`);
    if (this.#closing || this.#reconnectTimer) return;
    this.#socket = null;
    this.#discardPartial();
    this.#setState('reconnecting');

    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 15000;
    this.#attempt += 1;

    // A blip is worth waiting out before saying anything; a spending cap is
    // not, and thirty seconds of silent retrying is thirty seconds of somebody
    // deciding she is broken.
    if (FATAL_REASON.test(reason)) {
      if (this.#attempt === 1) this.#options.handlers.onTrouble(`Gemini refused: ${reason}`);
    } else if (this.#attempt === 3) {
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

    /*
     * A second completion signal is a hard boundary.
     *
     * Trailing transcription and the opening words of the next turn look
     * identical — both are text arriving after a completion flag — so the
     * settle window cannot tell them apart on its own. What it can tell apart
     * is another *flag*: if one turn has already ended and a new one is ending
     * too, whatever is buffered belonged to the first. Flushing here keeps two
     * turns from merging into "firstsecond" while still letting a few
     * milliseconds of trailing text land where it belongs.
     */
    if (this.#awaitingSettle && (content.generationComplete || content.turnComplete)) {
      this.#settle();
    }

    if (content.interrupted) {
      if (this.#settleTimer) clearTimeout(this.#settleTimer);
      this.#settleTimer = null;
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
      // More text means the turn was not over after all.
      if (this.#awaitingSettle) this.#scheduleSettle();
    }

    const said = content.outputTranscription?.text;
    if (said) {
      this.#annaBuffer += said;
      this.#options.handlers.onAnnaText(spoken(this.#annaBuffer), false);
      if (this.#awaitingSettle) this.#scheduleSettle();
    }

    /*
     * A finished *generation* closes an utterance; a finished *turn* closes the
     * exchange. They are usually the same moment, and when they are not, the
     * difference is visible to the user.
     *
     * One turn can contain several generations — she answers, then the
     * initiative asks her to carry on, and both land before `turnComplete`.
     * Flushing only on the turn ran them together: transcription chunks carry
     * their own leading spaces *within* a generation, but the first chunk of
     * the next one does not, which produced "What's up?You know, you look like"
     * in a real Telegram message, and stored it in memory that way too.
     *
     * Splitting here also gets the chat right: two things she said become two
     * messages rather than one wall.
     */
    if (content.turnComplete) this.#turnEnded = true;
    if (content.generationComplete || content.turnComplete) {
      this.#awaitingSettle = true;
      this.#scheduleSettle();
    }
  }

  /**
   * Emits the finished lines once the transcript has stopped moving.
   *
   * Scheduled rather than immediate, and rescheduled by every chunk that
   * arrives — so a turn ends when the words end, not when a flag says so.
   */
  #scheduleSettle(): void {
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null;
      this.#settle();
    }, SETTLE_MS);
    this.#settleTimer.unref?.();
  }

  #settle(): void {
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
    this.#awaitingSettle = false;

    // The user finished speaking before she started answering, so their line is
    // recorded first — memory replays the transcript in order, and an exchange
    // stored answer-then-question reads as her talking to herself.
    if (this.#userBuffer.trim()) {
      this.#options.handlers.onUserText(this.#userBuffer, true);
    }
    this.#userBuffer = '';

    const said = spoken(this.#annaBuffer);
    if (said.trim()) {
      this.#options.handlers.onAnnaText(said, true);
    }
    this.#annaBuffer = '';

    if (this.#turnEnded) {
      this.#turnEnded = false;
      this.#options.handlers.onTurnComplete();
    }
  }

  /**
   * Everything half-said, dropped.
   *
   * Called whenever the socket underneath changes. A partial turn belongs to
   * the connection that was carrying it: kept across a reconnect it becomes the
   * *prefix* of the next thing she says, which is how "a picture of you" ended
   * up glued to the front of "I did. Playing coy on screen like that, huh?" in
   * a real conversation.
   *
   * ("a picture of you" was itself a thing she said out loud, not a leak from
   * anywhere — the `show` tool used to tell her to *say* that phrase when it
   * meant pass it as an argument. Two separate faults, one sentence.)
   */
  #discardPartial(): void {
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
    this.#userBuffer = '';
    this.#annaBuffer = '';
    this.#turnEnded = false;
    this.#awaitingSettle = false;
  }

  /**
   * Tool results go back in one message, to the socket that asked for them.
   *
   * Every call gets a response even when the handler throws, because a model
   * waiting on a function response that never arrives simply stops talking, and
   * from the outside that is indistinguishable from Anna ignoring you.
   *
   * ## Why the socket is captured rather than read at the end
   *
   * Responses are matched to calls by `id` — that is the documented mechanism,
   * and an id is only meaningful to the session that issued it. This handler is
   * async, and some of the tools behind it are slow: `show` lists a directory,
   * embeds every caption and can generate a picture. Reconnects, meanwhile, are
   * routine rather than exceptional; a session carrying video is capped at about
   * two minutes.
   *
   * So the window between a call arriving and its answer being ready regularly
   * contains a socket swap, and reading `this.#socket` at the end delivered the
   * answer to a session that had never asked the question. This is what that
   * looked like in a real transcript, glued to the front of the sentence she
   * actually said:
   *
   *     "response:feel{now:calm,ok:true…"
   *
   * Dropping the answer is right: the new session never asked it, and whatever
   * the tool *did* — the mood moved, the picture was sent — already happened.
   */
  async #runTools(calls: readonly { id?: string; name?: string; args?: Record<string, unknown> }[]) {
    const socket = this.#socket;
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
    if (!socket || this.#socket !== socket) {
      this.#debug(`dropped ${responses.length} tool response(s): the session moved on`);
      return;
    }
    this.#guard(() => socket.sendToolResponse({ functionResponses: responses }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A promise that is not allowed to hang forever.
 *
 * `reason` is a function rather than a string so the message can be decided
 * when the deadline fires: by then a close callback has usually explained what
 * actually happened, and "your project has exceeded its monthly spending cap"
 * is a far better thing to report than "timed out".
 */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  reason: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason())), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Machinery filed off the front of a line before anyone reads it.
 *
 * A last line of defence, and it is here because the thing it catches is
 * permanent: whatever comes out of a turn is written into her memory, and a
 * transcript is not something anyone goes back and edits. This is real, from a
 * real conversation:
 *
 *     "response:feel{now:calm,ok:trueThe one across your chest…"
 *
 * That prefix is a rendering of a function response, and it is not something a
 * person could have said — no speech transcription produces `{`. The cause is
 * fixed upstream (a tool answer can no longer be delivered to a session that
 * did not ask the question, and answers no longer carry prose to read out), so
 * this should never fire. It stays because the cost of it firing is a sentence
 * that is slightly short, and the cost of it not being here was a permanent
 * record of Anna saying something no one can parse.
 *
 * Deliberately narrow, in two ways. It only looks at the *start* of a line, so
 * braces mid-sentence are left alone — she is allowed to talk about code. And
 * when the fragment has no closing brace, as the real one did not, it stops at
 * the first capital letter rather than running to the end: a rule that can eat
 * a whole sentence is worse than the fragment it was written to remove.
 */
const TOOL_ARTEFACT = /^\s*\w+\s*:\s*\w*\s*\{(?:[^}]*\}|[^}A-Z]*)/;

function spoken(text: string): string {
  return text.replace(TOOL_ARTEFACT, '').trimStart();
}

/**
 * A close event, in enough detail to act on.
 *
 * The code and reason are the only thing that distinguishes "the server is
 * rotating you" from "your setup was rejected" from "the network went away",
 * and they arrive on the close event. Discarding them — which this did — leaves
 * every disconnection looking identical in the logs, which is exactly the
 * situation where you most need them to differ.
 */
function describeClose(event: unknown): string {
  if (!isRecord(event)) return 'the connection closed';
  const code = Number(event.code);
  const reason = typeof event.reason === 'string' ? event.reason.trim() : '';
  const parts = [reason || 'the connection closed'];
  if (Number.isFinite(code) && code !== 0) parts.push(`(code ${code})`);
  return parts.join(' ');
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
