/**
 * One conversation with Anna.
 *
 * A `Companion` is created per conversation and thrown away at the end of it —
 * one at the desk, one per phone call, one for Telegram. Each owns a live
 * socket, a clock and a situation. All of them share a single {@link Brain}, so
 * there is one memory and one mood no matter how many ways she is being talked
 * to.
 *
 * The interesting work here is ordering, and it is worth being explicit about
 * because getting it wrong is invisible until it is embarrassing:
 *
 *   - **Memory is written from transcripts, not from audio.** A turn is
 *     recorded when its transcription is final, which is after she has already
 *     said it. Recording earlier would mean recording sentences she was
 *     interrupted out of.
 *   - **Recall happens at wake, not per turn.** The Live API fixes its system
 *     instruction at setup, so the facts she starts with are the facts she has.
 *     Anything learned mid-conversation reaches her through `⟦context⟧`, which
 *     is why `remember` is a tool she can call rather than a background job she
 *     has to wait for.
 *   - **Video is rate-limited here as well as in the browser.** The browser
 *     throttle saves bandwidth; this one is the cost control, and it is the one
 *     that cannot be bypassed by a client that has been modified or has a bug.
 */

import type { ConnectionState, MoodReadout, SenseName } from '../../shared/protocol.ts';
import type { GalleryItem } from '../gallery/gallery.ts';
import { LiveConversation } from '../gemini/live.ts';
import type { LiveConnector, LiveState } from '../gemini/live.ts';
import { FACT_KINDS, FEEL, MOVE, REMEMBER, SHOW, annaTools } from '../gemini/tools.ts';
import { Initiative } from '../initiative/initiative.ts';
import type { FactKind } from '../memory/types.ts';
import { buildSystemInstruction, moodUpdate, senseUpdate } from '../persona/prompt.ts';
import { isGesture } from '../avatar/studio.ts';
import { Situation, isLateNight } from '../senses/situation.ts';
import type { Brain } from './brain.ts';

export interface CompanionSink {
  /** Anna's voice: PCM signed 16-bit little-endian, 24kHz mono. */
  audio(pcm: Buffer): void;
  transcript(who: 'user' | 'anna', text: string, final: boolean): void;
  state(state: ConnectionState): void;
  mood(mood: MoodReadout): void;
  /** Drop queued audio: she was cut off. */
  interrupted(): void;
  /** She chose to send a picture or a clip. */
  show(item: GalleryItem): void;
  /** Play a gesture clip. Only ever called with one that has been rendered. */
  move(gesture: string): void;
  trouble(message: string): void;
}

export interface CompanionOptions {
  brain: Brain;
  sink: CompanionSink;
  channel: 'desktop' | 'phone' | 'telegram';
  /** Senses that are on from the start. Telegram and phone differ from the desk. */
  senses?: Partial<Record<SenseName, boolean>>;
  now?: () => number;
  /** Injected by tests so nothing opens a socket. */
  connect?: LiveConnector;
}

/** How far her mood has to move before it is worth telling her about. */
const MOOD_NOTIFY_DELTA = 0.25;
/** Facts pulled into the system instruction at wake. */
const RECALL_LIMIT = 8;

export class Companion {
  readonly #brain: Brain;
  readonly #sink: CompanionSink;
  readonly #channel: 'desktop' | 'phone' | 'telegram';
  readonly #now: () => number;
  readonly situation: Situation;
  readonly #initiative: Initiative;
  #live: LiveConversation | null = null;
  #connect: LiveConnector | undefined;
  /** Timestamps of the last frame accepted, per source. */
  #lastFrameAt = 0;
  /** True between a `⟦director⟧` cue and the turn it produces. */
  #openerInFlight = false;
  #speaking = false;
  #userTalking = false;
  #lastNotifiedMood: MoodReadout | null = null;
  #memories: string[] = [];
  #closed = false;
  /** Guards the opening picture: one per conversation, not one per message. */
  #greeted = false;

  constructor(options: CompanionOptions) {
    this.#brain = options.brain;
    this.#sink = options.sink;
    this.#channel = options.channel;
    this.#now = options.now ?? (() => Date.now());
    this.#connect = options.connect;
    this.situation = new Situation(this.#now);

    for (const [sense, on] of Object.entries(options.senses ?? {})) {
      this.situation.setSense(sense as SenseName, Boolean(on));
    }

    this.#initiative = new Initiative({
      maxSilenceMs: this.#brain.config.maxSilenceMs,
      minSilenceMs: this.#brain.config.minSilenceMs,
      isBusy: () => this.#speaking || this.#userTalking,
      observe: () => this.situation.snapshot(),
      onOpen: (reason) => this.#open(reason),
      now: this.#now,
    });
  }

  get live(): LiveConversation | null {
    return this.#live;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async wake(): Promise<void> {
    if (this.#live) return;
    this.#closed = false;

    const brain = this.#brain;
    if (!brain.config.geminiApiKey) {
      this.#sink.trouble('No Gemini API key. Set GEMINI_API_KEY and restart.');
      this.#sink.state('error');
      return;
    }

    this.#memories = await this.#recall();
    if (isLateNight(this.situation.snapshot().hour)) brain.mood.feel('late-night');

    const live = new LiveConversation({
      apiKey: brain.config.geminiApiKey,
      model: brain.config.model,
      voice: brain.profile.voice.voice,
      languageCode: brain.profile.voice.languageCode,
      tools: annaTools(this.#brain.avatar.readyGestures()),
      // Rebuilt rather than captured, so a reconnect picks up her current mood
      // and the senses that are on now rather than the ones that were on when
      // the conversation started.
      systemInstruction: () => this.#systemInstruction(),
      handlers: {
        onAudio: (pcm) => this.#sink.audio(pcm),
        onUserText: (text, final) => this.#onUserText(text, final),
        onAnnaText: (text, final) => this.#onAnnaText(text, final),
        onTurnComplete: () => this.#onTurnComplete(),
        onInterrupted: () => this.#onInterrupted(),
        onToolCall: (name, args) => this.#onToolCall(name, args),
        onState: (state) => this.#onLiveState(state),
        onTrouble: (message) => this.#sink.trouble(message),
      },
      ...(this.#connect ? { connect: this.#connect } : {}),
    });

    this.#live = live;
    await live.start();
    await this.#showHerself();
    this.#initiative.start();
    this.#emitMood(true);
  }

  /**
   * The picture she opens with.
   *
   * Generated fresh every conversation rather than picked from the gallery —
   * the point is that it is *new*, so reaching for something on disk would
   * defeat it. It is built from the avatar photograph when there is one, which
   * the gallery arranges for every generation rather than this one; a greeting
   * is a picture of her in a place, so unlike "show me you" it has a scene and
   * has to be made.
   *
   * Fired and never awaited. It takes several seconds, and a companion who says
   * nothing until her portrait finishes rendering is a companion who feels
   * broken. Her words go out immediately; the picture catches up.
   */
  #greet(): void {
    if (this.#greeted || !this.#brain.config.greetingImage) return;
    if (!this.#brain.config.geminiApiKey) return;
    this.#greeted = true;

    void (async () => {
      try {
        const mood = this.#brain.mood.read();
        const snapshot = this.situation.snapshot();
        const item = await this.#brain.gallery.generate(
          `${describeSetting(snapshot.hour)}, ${mood.label}, looking at the camera`,
          {
            apiKey: this.#brain.config.geminiApiKey,
            },
        );
        if (item && !this.#closed) this.#sink.show(item);
      } catch {
        // A greeting that does not arrive costs a picture. It must not cost the
        // conversation it was greeting.
      }
    })();
  }

  /**
   * Shows her her own face, once, at the start of the conversation.
   *
   * This replaces the paragraph that used to describe her. A photograph cannot
   * disagree with itself, and the written version did — when both were in the
   * prompt, generated pictures took the face from the photograph and the hair
   * from the prose.
   *
   * Sent as context rather than as a realtime frame: a frame describes this
   * moment and is meant to age out, and what she looks like should still be
   * true an hour in.
   */
  async #showHerself(): Promise<void> {
    const face = await this.#brain.avatar.sourceImage();
    if (!face || !this.#live) return;
    this.#live.showImage(
      face.data,
      face.mimeType,
      'This is you. Not a picture of you — you. It is what you look like.',
    );
  }

  async sleep(): Promise<void> {
    this.#closed = true;
    this.#initiative.stop();
    const live = this.#live;
    this.#live = null;
    await live?.close();
    this.#sink.state('asleep');
    // Distil what just happened while the transcript is still fresh. Failures
    // here are already swallowed inside `consolidate`.
    void this.#brain.memory.consolidate();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /** Microphone audio: PCM signed 16-bit little-endian, 16kHz mono. */
  hear(pcm: Buffer): void {
    if (!this.situation.senses.hearing) return;
    this.#live?.sendAudio(pcm);
  }

  /**
   * A still frame. `kind` is what the browser composited, not what is on.
   *
   * Dropped rather than queued when it arrives too soon: a frame from 900ms ago
   * is worth nothing next to the one that will arrive in 100ms, and the Live
   * API bills for both.
   */
  see(jpeg: Buffer, kind: 'camera' | 'screen'): void {
    const sense: SenseName = kind === 'camera' ? 'sight' : 'screen';
    if (!this.situation.senses[sense]) return;

    const fps = kind === 'camera' ? this.#brain.config.cameraFps : this.#brain.config.screenFps;
    const now = this.#now();
    if (now - this.#lastFrameAt < 1000 / Math.max(fps, 0.01) - 20) return;
    this.#lastFrameAt = now;
    this.#live?.sendImage(jpeg);
  }

  /**
   * A picture they deliberately sent, as opposed to a frame off a camera.
   *
   * Exempt from the frame rate limit and from the sense switches, because it is
   * neither: someone attaching a photo to a message has asked her to look at
   * it, and dropping it to stay under a budget would read as ignoring them.
   */
  look(bytes: Buffer, mimeType: string): void {
    this.#live?.sendImage(bytes, mimeType);
  }

  /** Something the user typed. */
  say(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.#userTalking = false;
    this.situation.noteUserSpoke();
    this.#brain.memory.record('user', trimmed);
    this.#brain.mood.feel('exchange');
    this.#initiative.poke();
    this.#live?.sendText(trimmed);
    this.#greet();
  }

  setSense(sense: SenseName, on: boolean): void {
    if (this.situation.senses[sense] === on) return;
    this.situation.setSense(sense, on);
    this.#live?.inject(senseUpdate(sense, on));
    if (sense === 'sight' && on) this.#emitMood(false, () => this.#brain.mood.feel('seen'));
  }

  notePresence(idleSeconds: number, tabVisible: boolean): void {
    const before = this.situation.snapshot();
    this.situation.notePresence(idleSeconds, tabVisible);

    const wasAway = !before.presence.tabVisible || before.presence.idleSeconds > 10 * 60;
    const isBack = tabVisible && idleSeconds < 30;
    if (wasAway && isBack && before.presence.at > 0) {
      this.#emitMood(false, () => this.#brain.mood.feel('returned'));
    }
  }

  /** The user started speaking over her. */
  interrupt(): void {
    this.#userTalking = true;
    this.#initiative.poke();
  }

  // -------------------------------------------------------------------------
  // Model output
  // -------------------------------------------------------------------------

  #onUserText(text: string, final: boolean): void {
    this.#sink.transcript('user', text, final);
    if (!final) {
      this.#userTalking = true;
      return;
    }
    this.#userTalking = false;
    this.#greet();
    this.situation.noteUserSpoke();
    this.#brain.memory.record('user', text);
    this.#emitMood(false, () => this.#brain.mood.feel('exchange'));
    this.#initiative.poke();
  }

  #onAnnaText(text: string, final: boolean): void {
    this.#sink.transcript('anna', text, final);
    if (!final) {
      this.#speaking = true;
      return;
    }
    this.situation.noteAnnaSpoke();
    this.#brain.memory.record('anna', text);
  }

  #onTurnComplete(): void {
    this.#speaking = false;
    const wasOpener = this.#openerInFlight;
    this.#openerInFlight = false;
    this.#initiative.noteAnnaFinished(wasOpener);

    const turns = this.situation.snapshot().turns;
    if (turns > 0 && turns % 12 === 0) {
      this.#emitMood(false, () => this.#brain.mood.feel('sustained'));
    }
    if (this.#brain.memory.needsConsolidation) void this.#brain.memory.consolidate();
    if (!this.#closed) this.#sink.state('listening');
  }

  #onInterrupted(): void {
    this.#speaking = false;
    this.#sink.interrupted();
    this.#emitMood(false, () => this.#brain.mood.feel('interrupted'));
  }

  #onLiveState(state: LiveState): void {
    const mapped: Record<LiveState, ConnectionState> = {
      idle: 'asleep',
      connecting: 'connecting',
      live: 'listening',
      reconnecting: 'reconnecting',
      closed: 'asleep',
      error: 'error',
    };
    this.#sink.state(mapped[state]);
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  async #onToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case FEEL: {
        const mood = this.#brain.mood.nudge({
          valence: num(args.valence),
          energy: num(args.energy),
          warmth: num(args.warmth),
          interest: num(args.interest),
        });
        this.#sink.mood(mood);
        this.#lastNotifiedMood = mood;
        return { ok: true, now: mood.label };
      }

      case REMEMBER: {
        const kind = String(args.kind ?? '').toLowerCase();
        const text = String(args.text ?? '').trim();
        if (!text) return { ok: false, reason: 'nothing to remember' };
        const valid = (FACT_KINDS as readonly string[]).includes(kind)
          ? (kind as FactKind)
          : 'event';
        const result = await this.#brain.memory.remember(valid, text, {
          confidence: clamp01(num(args.confidence) ?? 0.7),
        });
        return { ok: true, result };
      }

      case MOVE: {
        const gesture = String(args.gesture ?? '');
        if (!isGesture(gesture) || !this.#brain.avatar.has(gesture)) {
          return { ok: false, reason: 'that one has not been rendered' };
        }
        this.#sink.move(gesture);
        return { ok: true };
      }

      case SHOW: {
        const description = String(args.description ?? '').trim();
        if (!description) return { ok: false, reason: 'no description' };
        const item = await this.#brain.gallery.pick(description, {
          allowNew: args.allowNew === true,
          apiKey: this.#brain.config.geminiApiKey,
        });
        if (!item) return { ok: false, reason: 'nothing in the gallery fits and none was made' };
        this.#sink.show(item);
        return { ok: true, sent: item.caption };
      }

      default:
        return { ok: false, reason: `no such tool: ${name}` };
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #open(reason: string): void {
    if (!this.#live?.isLive) return;
    this.#openerInFlight = true;
    this.#emitMood(false, () => this.#brain.mood.feel('long-silence', 0.5));
    this.#live.prompt(reason);
  }

  async #recall(): Promise<string[]> {
    const summary = this.#brain.memory.runningSummary() ?? '';
    const recent = this.#brain.memory
      .liveTranscript(6)
      .map((turn) => turn.text)
      .join(' ');
    const query = `${recent} ${summary}`.trim() || 'what matters to them';
    try {
      return await this.#brain.memory.recall(query, RECALL_LIMIT);
    } catch {
      return [];
    }
  }

  #systemInstruction(): string {
    const snapshot = this.situation.snapshot();
    return buildSystemInstruction({
      profile: this.#brain.profile,
      mood: this.#brain.mood.read(),
      memories: this.#memories,
      ...(this.#brain.memory.runningSummary()
        ? { summary: this.#brain.memory.runningSummary() }
        : {}),
      senses: snapshot.senses,
      localTime: snapshot.localTime,
      channel: this.#channel,
      returning: this.#brain.hasHistory,
      // Only the desktop shows a face; a phone call and Telegram have nowhere
      // to put one, and offering her a movement nobody can see is noise.
      gestures: this.#channel === 'desktop' ? this.#brain.avatar.readyGestures() : [],
      hasFace: this.#brain.avatar.face() !== null,
    });
  }

  /**
   * Applies a mood change and tells her about it only if it was big enough.
   *
   * The threshold is the whole point. Injecting a `⟦context⟧` line for every
   * 0.03 nudge would put a hundred of them into a long conversation, all of
   * them costing context and none of them changing anything she would say.
   */
  #emitMood(force: boolean, change?: () => MoodReadout): void {
    const mood = change ? change() : this.#brain.mood.read();
    this.#sink.mood(mood);

    const previous = this.#lastNotifiedMood;
    const moved =
      !previous ||
      Math.max(
        Math.abs(mood.current.valence - previous.current.valence),
        Math.abs(mood.current.energy - previous.current.energy),
        Math.abs(mood.current.warmth - previous.current.warmth),
        Math.abs(mood.current.interest - previous.current.interest),
      ) >= MOOD_NOTIFY_DELTA;

    if (!force && !moved) return;
    this.#lastNotifiedMood = mood;
    if (!force) this.#live?.inject(moodUpdate(mood));
  }
}

/** Somewhere plausible for her to be, given the hour. */
function describeSetting(hour: number): string {
  if (hour < 5) return 'awake far too late, one lamp on';
  if (hour < 11) return 'morning light, coffee somewhere nearby';
  if (hour < 17) return 'afternoon, by a window';
  if (hour < 22) return 'evening, warm indoor light';
  return 'late evening, soft light';
}

function num(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp01(value: number | undefined): number {
  if (value === undefined) return 0.7;
  return Math.min(1, Math.max(0, value));
}
