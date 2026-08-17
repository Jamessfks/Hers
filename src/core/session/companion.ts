/**
 * One conversation with her.
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

import type {
  ConnectionState,
  MoodReadout,
  ScreenActivity,
  SenseName,
} from '../../shared/protocol.ts';
import type { GalleryItem } from '../gallery/gallery.ts';
import { LiveConversation } from '../gemini/live.ts';
import type { LiveConnector, LiveState } from '../gemini/live.ts';
import { FACT_KINDS, FEEL, MOVE, REMEMBER, SHOW, companionTools } from '../gemini/tools.ts';
import { Initiative } from '../initiative/initiative.ts';
import type { FactKind } from '../memory/types.ts';
import { buildSystemInstruction, moodUpdate, senseUpdate } from '../persona/prompt.ts';
import { asksToSeeHer } from '../gallery/gallery.ts';
import { isGesture } from '../avatar/studio.ts';
import { Situation, isLateNight } from '../senses/situation.ts';
import type { Brain } from './brain.ts';

export interface CompanionSink {
  /** Her voice: PCM signed 16-bit little-endian, 24kHz mono. */
  audio(pcm: Buffer): void;
  transcript(who: 'user' | 'her', text: string, final: boolean): void;
  state(state: ConnectionState): void;
  mood(mood: MoodReadout): void;
  /**
   * She has just chosen her own name, during this wake.
   *
   * Fired rather than left to the next `ready`, because the socket that is
   * watching her wake up connected before the choice existed. Without this she
   * introduces herself as Maya on a page whose header still says Anna, which is
   * the inconsistency the feature was supposed to remove.
   */
  named(name: string): void;
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
/**
 * How long a frame is still a fair description of the room.
 *
 * Past this she says "you look tired" about a chair. Screen frames arrive every
 * two seconds and camera frames every second while a sense is on, so the only
 * way to have one this old is for the sense to have just been switched off — in
 * which case it should not be used at all.
 */
const FRAME_STILL_TRUE_MS = 20_000;
/** How long after sending her photograph a second copy is a duplicate. */
const DUPLICATE_FACE_MS = 20_000;
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
  /**
   * The most recent frame, kept so she can look again before speaking first.
   *
   * One frame, overwritten — this is not a buffer of the last minute, it is the
   * answer to "what is in front of her right now".
   */
  #lastFrame: { bytes: Buffer; kind: 'camera' | 'screen'; at: number } | null = null;
  /** When the photograph was last sent because they asked for it. */
  #faceSentAt = 0;
  /** Guards the once-a-conversation credit for her having heard them. */
  #heardToday = false;
  /** In flight while a session is opening, so two callers share one. */
  #waking: Promise<void> | null = null;
  /** True between a `⟦director⟧` cue and the turn it produces. */
  #openerInFlight = false;
  #speaking = false;
  #userTalking = false;
  #lastNotifiedMood: MoodReadout | null = null;
  #memories: string[] = [];
  #closed = false;

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

  /**
   * Opens the session, once, however many callers ask at the same moment.
   *
   * The guard used to be `if (this.#live) return`, which is not a guard: there
   * are awaits between it and the assignment — recalling memories is a network
   * call — so two callers arriving together both got past it and both built a
   * session. Two Gemini sockets, two initiative timers, two openers for one
   * thought. A browser opening while the Telegram bot is already running is
   * exactly that pair of callers.
   *
   * The in-flight promise is the guard. It is shared, so the second caller waits
   * for the first one's session rather than starting another.
   */
  async wake(): Promise<void> {
    if (this.#live) return;
    this.#waking ??= this.#doWake().finally(() => {
      this.#waking = null;
    });
    return this.#waking;
  }

  async #doWake(): Promise<void> {
    if (this.#live) return;
    this.#closed = false;

    const brain = this.#brain;
    if (!brain.config.geminiApiKey) {
      this.#sink.trouble('No Gemini API key. Set GEMINI_API_KEY and restart.');
      this.#sink.state('error');
      return;
    }

    // Before anything else, and before the prompt is built: she has to know what
    // she is called. At most one call, once in the life of a profile.
    const named = await brain.ensureNamed();
    if (named) {
      console.log(`  she chose the name ${named}`);
      this.#sink.named(named);
    }

    this.#memories = await this.#recall();
    if (isLateNight(this.situation.snapshot().hour)) brain.mood.feel('late-night');

    const live = new LiveConversation({
      apiKey: brain.config.geminiApiKey,
      model: brain.config.model,
      voice: brain.profile.voice.voice,
      languageCode: brain.profile.voice.languageCode,
      tools: companionTools(this.#brain.avatar.readyGestures()),
      // Rebuilt rather than captured, so a reconnect picks up her current mood
      // and the senses that are on now rather than the ones that were on when
      // the conversation started.
      systemInstruction: () => this.#systemInstruction(),
      handlers: {
        onAudio: (pcm) => this.#sink.audio(pcm),
        onUserText: (text, final) => this.#onUserText(text, final),
        onHerText: (text, final) => this.#onHerText(text, final),
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
    this.#initiative.start();
    this.#emitMood(true);
  }

  /*
   * She no longer opens with a picture of herself.
   *
   * Every conversation used to begin with a freshly generated portrait, on the
   * first thing the user said. It was a nice trick exactly once. After that it
   * was a photograph arriving before the hello, every time, whether or not
   * anyone wanted one — and it cost about four cents a conversation to do it.
   *
   * A picture is worth something when it is chosen. So the only two ways one
   * arrives now are the two that mean something: she reaches for `show`
   * because it fits what is being said, or the user asks — in conversation, or
   * with /me for the photograph they uploaded and /photo for a new one.
   */

  /*
   * Her photograph is deliberately *not* put into the conversation.
   *
   * It used to be, at the start of every session, so that she knew what she
   * looked like. The cost of that was not obvious until it appeared in a real
   * transcript. Her photograph was the only *labelled* image in the session —
   * camera frames stream in unlabelled — so when the conversation turned to
   * what somebody looked like, it was the only thing she had to answer from.
   * She described her own body back to the user as though it were theirs:
   *
   *     "The one across your chest from that sports bra. Looks like you've
   *      been spending time outside."
   *
   * Labelling it harder did not fix it. Measured against the live model with
   * the label "This is a photograph of YOU … not the person you are
   * talking to", asked "do I have a tan?", she still answered from the picture.
   * A vivid image in context beats a sentence saying not to use it, and the
   * documented alternatives are closed: the Live API's own SDK says of
   * `systemInstruction` that "only text should be used in parts".
   *
   * So the image is gone from the session entirely, and the capability it
   * existed for is served better by something that already worked: asked what
   * she looks like, she sends a picture. `show` generates it from this exact
   * photograph, so the answer is more faithful than any description would have
   * been — and there is no longer any image of her for a question about
   * somebody else to land on.
   */

  async sleep(): Promise<void> {
    this.#closed = true;
    this.#waking = null;
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
    this.#heardToday ||= this.#noteHeard();
    this.#live?.sendAudio(pcm);
  }

  /**
   * Being heard counts once a day, not once per twenty milliseconds.
   *
   * Audio arrives in chunks at fifty a second. Crediting each one would be a
   * write per chunk for a fact that changes once.
   */
  #noteHeard(): boolean {
    this.#brain.intimacy.noteSense();
    return true;
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
    this.#lastFrame = { bytes: jpeg, kind, at: now };
    this.situation.noteFrame(kind);
    // A day she could see them counts for a little more than a day of typing.
    this.#brain.intimacy.noteSense();
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
    this.#brain.intimacy.noteTurn();
    this.#initiative.poke();
    this.#live?.sendText(trimmed);
    this.#showFaceIfAsked(trimmed);
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
      // Somebody is here again. If she had given up on the room, that is the
      // reason to look up that a timer running out never was.
      this.#initiative.poke();
    }
  }

  /**
   * The browser's read on what the shared screen is doing.
   *
   * Note what this deliberately does *not* do: poke the initiative on every
   * change. Poking re-arms the clock, so treating each window switch as a
   * conversational event would push her opener further away every time they
   * alt-tabbed — a person who works quickly would silence her entirely. The one
   * case where a switch is worth acting on is when she has already given up on
   * an empty room: somebody moving to something new is proof they are there,
   * and that is the same reason `notePresence` has for looking up again.
   */
  noteScreen(activity: ScreenActivity, stillSeconds: number): void {
    const known = this.situation.snapshot().screen.at > 0;
    this.situation.noteScreen(activity, stillSeconds);
    if (activity === 'switched' && known && this.#initiative.waiting) this.#initiative.poke();
  }

  /**
   * They asked to see her, so she is seen — without the model having to decide.
   *
   * Everything else she sends is her choice, and should be. This one is not,
   * because a direct question deserves a direct answer and asking a model to
   * remember to call a tool is asking for it to be missed. It was: "what do you
   * look like?" came back as "artist Maybe a little punk adjacent? You tell me."
   * — no picture, and worse, invented. She has no written description of
   * herself by design, so when she answers that question in words she is not
   * recalling, she is making it up.
   *
   * The photograph is sent straight from disk. She is told it went, so she can
   * say something about it rather than describing a face she cannot see.
   */
  #showFaceIfAsked(text: string): void {
    if (!asksToSeeHer(text)) return;
    const face = this.#brain.gallery.face();
    if (!face) return;

    this.#faceSentAt = this.#now();
    this.#sink.show(face);
    this.#live?.inject(
      'They asked to see you, so the photograph of you has just been sent to them ' +
        'and they are looking at it now. Say something as you would when someone ' +
        'is looking at a picture of you. Do not describe your own face in words.',
    );
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
    this.situation.noteUserSpoke();
    this.#brain.memory.record('user', text);
    this.#brain.intimacy.noteTurn();
    this.#emitMood(false, () => this.#brain.mood.feel('exchange'));
    this.#initiative.poke();
    this.#showFaceIfAsked(text);
  }

  #onHerText(text: string, final: boolean): void {
    this.#sink.transcript('her', text, final);
    if (!final) {
      this.#speaking = true;
      return;
    }
    this.situation.noteHerSpoke();
    this.#brain.memory.record('her', text);
  }

  #onTurnComplete(): void {
    this.#speaking = false;
    const wasOpener = this.#openerInFlight;
    this.#openerInFlight = false;
    this.#initiative.noteHerFinished(wasOpener);

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

  /*
   * Tool answers are receipts, not content.
   *
   * They used to carry prose — the mood's label, the caption of the picture
   * that was sent — and prose in a tool response is prose that can end up being
   * read out. One did: "response:feel{now:calm,ok:true" appears in a real
   * transcript, welded to the front of a sentence. None of it was needed either:
   * she knows what she asked for, and a mood change reaches her as a ⟦context⟧
   * line anyway. So a success is `{ok: true}` and nothing else.
   *
   * Failures keep their `reason`, because that one *is* needed — it is how she
   * finds out that a gesture has not been rendered, or that nothing in the
   * gallery fits, and adapts instead of repeating herself.
   */
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
        return { ok: true };
      }

      case REMEMBER: {
        const kind = String(args.kind ?? '').toLowerCase();
        const text = String(args.text ?? '').trim();
        if (!text) return { ok: false, reason: 'nothing to remember' };
        const valid = (FACT_KINDS as readonly string[]).includes(kind)
          ? (kind as FactKind)
          : 'event';
        await this.#brain.memory.remember(valid, text, {
          confidence: clamp01(num(args.confidence) ?? 0.7),
        });
        return { ok: true };
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
          fresh: args.fresh === true,
          apiKey: this.#brain.config.geminiApiKey,
        });
        if (!item) return { ok: false, reason: 'nothing in the gallery fits and none was made' };

        /*
         * Not twice for one question.
         *
         * A request to see her is answered from code, and the model often
         * reaches for `show` on the same turn — reasonably, since it was asked.
         * Both resolve to the same file, so two identical photographs arrive
         * seconds apart. She is told it worked, because it did.
         */
        const face = this.#brain.gallery.face();
        const already =
          face &&
          item.name === face.name &&
          this.#now() - this.#faceSentAt < DUPLICATE_FACE_MS;
        if (already) return { ok: true };

        if (item.name === face?.name) this.#faceSentAt = this.#now();
        this.#sink.show(item);
        return { ok: true };
      }

      default:
        return { ok: false, reason: `no such tool: ${name}` };
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * She speaks first.
   *
   * The frame goes in before the note, and that ordering is the whole feature.
   * Realtime video is *realtime*: frames are turn-scoped and age out, so by the
   * time a two-minute silence has run down, the last picture she has any real
   * hold on is two minutes old. Told to "open with something you can see", she
   * would faithfully describe whatever was on screen when they stopped talking.
   *
   * Re-sending the newest frame as context — the same way she is shown her own
   * face — puts *this moment* in front of her, so the specific thing the note
   * asks for is a thing that is actually there. Sent only when a frame is fresh
   * enough to still be true, and it costs one image per opener at most.
   */
  #open(reason: string): void {
    if (!this.#live?.isLive) return;
    this.#openerInFlight = true;
    this.#emitMood(false, () => this.#brain.mood.feel('long-silence', 0.5));
    this.#lookAgain();
    this.#live.prompt(reason);
  }

  #lookAgain(): void {
    const frame = this.#lastFrame;
    if (!frame || !this.#live) return;

    const sense: SenseName = frame.kind === 'camera' ? 'sight' : 'screen';
    if (!this.situation.senses[sense]) return;
    if (this.#now() - frame.at > FRAME_STILL_TRUE_MS) return;

    // "them" was the wrong word: in a two-party conversation there is no third
    // person, and the model resolved it to whichever picture it had. Named
    // outright, and paired with a reminder that the other picture is her.
    this.#live.showImage(
      frame.bytes,
      'image/jpeg',
      frame.kind === 'screen'
        ? 'This is the screen of the person you are talking to, as it is right now, ' +
            'this second. Anything you say about their screen must come from this ' +
            'picture — not from what was on it earlier, and not from the photograph ' +
            'of yourself.'
        : 'This is the person you are talking to, seen through your camera right now, ' +
            'this second. Anything you say about how they look must come from this ' +
            'picture — not from the photograph of yourself, which is you.',
    );
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
      intimacy: this.#brain.intimacy.read(),
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

function num(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp01(value: number | undefined): number {
  if (value === undefined) return 0.7;
  return Math.min(1, Math.max(0, value));
}
