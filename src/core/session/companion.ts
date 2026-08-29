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
 *   - **The facts in the prompt are fixed at wake. The read path is not.** The
 *     Live API fixes its system instruction at setup, so the handful of facts
 *     recalled at wake are the only ones she opens with — and that query is
 *     built from the rolling summary and a transcript that is empty by design,
 *     which makes it a guess about a conversation nobody has had yet. `recall`
 *     exists for that reason: it is the only route by which a fact she was not
 *     handed at wake can reach an answer. What she learns mid-conversation
 *     travels the other way, through `remember` and `⟦context⟧`, rather than a
 *     background job she has to wait for.
 *   - **Video is rate-limited here as well as in the browser.** The browser
 *     throttle saves bandwidth; this one is the cost control, and it is the one
 *     that cannot be bypassed by a client that has been modified or has a bug.
 */

import { SENSE_NAMES } from '../../shared/protocol.ts';
import type {
  ConnectionState,
  MoodReadout,
  ScreenActivity,
  SenseName,
} from '../../shared/protocol.ts';
import { captionFrame } from '../gemini/text.ts';
import { LiveConversation } from '../gemini/live.ts';
import type { LiveConnector, LiveState } from '../gemini/live.ts';
import { FACT_KINDS, FEEL, OPEN, RECALL, REMEMBER, RUN, WRITE, hersTools } from '../gemini/tools.ts';
import { Hands } from '../hands/hands.ts';
import { Initiative } from '../initiative/initiative.ts';
import { lexicalTokens } from '../memory/embedder.ts';
import type { FactKind, RecalledFact } from '../memory/types.ts';
import { buildSystemInstruction, moodUpdate, placeUpdate, senseUpdate } from '../persona/prompt.ts';
import { ForegroundSense, foregroundUpdate } from '../senses/foreground.ts';
import { PlaceSense, WEATHER_TTL_MS, placeLine } from '../senses/place.ts';
import type { Place } from '../senses/place.ts';
import { CameraWatcher } from '../senses/watch.ts';
import type { Captioner } from '../senses/watch.ts';
import { Situation } from '../senses/situation.ts';
import { isAsleep, wokenLine } from '../sleep/rhythm.ts';
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
  /** Injected by tests so nothing reaches a real shell. */
  hands?: Hands;
  /** Injected by tests so nothing asks Open-Meteo for the weather. */
  place?: PlaceSense;
  /** Injected by tests so no frame is sent off for captioning. */
  caption?: Captioner;
  /** Injected by tests so nothing asks the operating system what is in front. */
  foreground?: ForegroundSense;
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
/**
 * How often she looks at which window is in front.
 *
 * Fifteen seconds. Faster produces a running commentary on somebody flicking
 * between two windows; slower and "you have been in that a while" stops being
 * true by the time she says it.
 */
const FOREGROUND_INTERVAL_MS = 15_000;
/** Facts pulled into the system instruction at wake. */
const RECALL_LIMIT = 8;
/**
 * How wide the `recall` tool looks, and how much of it she gets back.
 *
 * Scanning further than she is shown costs nothing — the store ranks every fact
 * on one pass regardless. The intent was that a fact sitting seventh could still
 * reach her once the ones above it had been refused as unrelated.
 *
 * Measured live, that intent did not survive contact. `isAbout`'s absolute floor
 * refuses nothing on the remote embedder: across six tool calls all sixty
 * candidates scored between 0.7797 and 0.9085, because that model puts every
 * short-sentence pair high. So nothing was ever filtered, the widening to ten was
 * inert, and the slice took the raw top five every time.
 *
 * It cost a real answer. Asked why he had been walking everywhere, the fact that
 * answered it — his bike stolen outside the library — sat seventh at 0.7875 and was
 * cut before she saw it. She then said "did you ever tell me why?" and guessed,
 * which are the two things the prompt tells her not to do.
 *
 * So she is handed eight rather than five. Eight is the number that would have
 * included it, and it is the same budget the wake-time recall already spends, so
 * it is a size this prompt is known to tolerate. The filter stays because it earns
 * its place on the offline embedder, where unrelated facts really do sit below the
 * floor — it is simply not load-bearing on the remote one, and pretending
 * otherwise is what hid this.
 */
const RECALL_TOOL_CANDIDATES = 12;
const RECALL_TOOL_FACTS = 8;
/**
 * Below this a recalled fact is not an answer, it is the top of the pile.
 *
 * `MemoryStore.recall` always returns its best `limit` facts, however little
 * they have to do with the question — ranking is what it is for. So a question
 * with nothing behind it comes back holding the newest, most confident thing in
 * the store, and handing her that is how a companion asserts a coffee
 * preference nobody ever told her.
 *
 * The number comes out of the scoring: with `usage` at zero, a fact with no
 * semantic overlap at all scores `0.18·recency + 0.12·confidence`, which tops
 * out at 0.30 for one that is brand new and perfectly certain. Anything above
 * 0.30 therefore has some of the question in it. Measured on the offline
 * embedder against eleven facts stored together: every unrelated fact sat at
 * 0.288, while "He hates cilantro." came back at 0.557 for `food he hates` and
 * still 0.386 with the fact two months old. 0.34 sits in that gap.
 *
 * What it is not is a measure of relevance, and reading it as one would be a
 * mistake in two directions. The recency term means an old fact has to clear the
 * floor on semantics alone while this morning's barely has to try — backwards,
 * which is what the second route in {@link isAbout} is for. And against the
 * remote embedder it hardly bites at all: `store.ts` measured that model putting
 * every pair of short sentences above 0.69 cosine, so most things clear 0.34 and
 * what carries the honesty there is the ranking, plus telling her plainly that
 * what came back may not be an answer.
 */
const RECALL_TOOL_FLOOR = 0.34;

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
  /** Guards the once-a-conversation credit for her having heard them. */
  #heardToday = false;
  /** In flight while a session is opening, so two callers share one. */
  #waking: Promise<void> | null = null;
  /** True between a `⟦director⟧` cue and the turn it produces. */
  #openerInFlight = false;
  #speaking = false;
  /**
   * When the gap between their turn ending and her first sound began.
   *
   * Zero when she is not in it. Kept as a timestamp rather than a flag because
   * a tool call re-enters the same state and the reason a person is waiting is
   * worth being able to tell apart later.
   */
  #thinkingSince = 0;
  #userTalking = false;
  #lastNotifiedMood: MoodReadout | null = null;
  #memories: string[] = [];
  #closed = false;
  readonly #hands: Hands;
  readonly #place: PlaceSense;
  readonly #watcher: CameraWatcher;
  /** The last weather line she was told, so an unchanged forecast says nothing. */
  #toldPlace = '';
  #weatherTimer: ReturnType<typeof setInterval> | null = null;
  readonly #foreground: ForegroundSense;
  /**
   * Senses the caller asked for explicitly, which survive a wake.
   *
   * Telegram has no camera and the audits deliberately run her blind, and both
   * would otherwise be overridden by the wake defaults a moment later.
   */
  readonly #pinnedSenses: Partial<Record<SenseName, boolean>>;
  #foregroundTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CompanionOptions) {
    this.#brain = options.brain;
    this.#sink = options.sink;
    this.#channel = options.channel;
    this.#now = options.now ?? (() => Date.now());
    this.#connect = options.connect;
    this.situation = new Situation(this.#now);
    this.#hands = options.hands ?? new Hands({ dir: this.#brain.config.dataDir });
    this.#place =
      options.place ??
      new PlaceSense(
        // An offline brain means an offline everything. `PlaceSense` builds a
        // real `fetch` by default, and honouring the flag here is what keeps
        // the suite and the doctor from going outside for the weather.
        this.#brain.offline
          ? { fetcher: () => Promise.reject(new Error('offline')) }
          : {},
      );
    this.#foreground =
      options.foreground ??
      new ForegroundSense(
        // The same rule as the weather: an offline brain reaches nothing, and
        // spawning `osascript` in a test suite is a side effect nobody asked for.
        this.#brain.offline ? { ask: () => Promise.resolve(null) } : {},
      );
    this.#watcher = new CameraWatcher({
      caption:
        options.caption ??
        ((frame) =>
          captionFrame(this.#brain.config.geminiApiKey, frame)),
      isBusy: () => this.#speaking || this.#userTalking || !this.#live?.isLive,
      onChange: (note) => this.#live?.prompt(note),
      now: this.#now,
    });

    this.#pinnedSenses = options.senses ?? {};
    for (const [sense, on] of Object.entries(this.#pinnedSenses)) {
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

    /*
     * The senses come up with her, every time, whatever the last session left.
     *
     * The field default in `Situation` covers construction; this covers a
     * `Companion` reused across a sleep. Waking is the moment the product
     * promises she can hear, so it is the moment to say so rather than to hope.
     *
     * The caller's own `senses` are applied afterwards and win. Without that
     * order this loop silently overrode them, which made the option a lie and
     * broke the one audit check that asks her whether she can see with the
     * camera deliberately off — she could, because this had just turned it back
     * on underneath the test.
     */
    this.situation.setSense('hearing', true);
    this.situation.setSense('sight', true);
    for (const [sense, on] of Object.entries(this.#pinnedSenses)) {
      this.situation.setSense(sense as SenseName, Boolean(on));
    }

    this.#memories = await this.#recall();

    /*
     * Being woken inside her own night.
     *
     * v1 asked `isLateNight()` — 1am to 5am, the same for everybody. This asks
     * her own hours, which is the difference the pivot is about: a person who
     * goes to bed at three is not being woken at two, and telling them she was
     * asleep would be a lie that a companion who lives on their machine has no
     * excuse for.
     *
     * She is woken rather than refusing to wake. Somebody alone at 4am is the
     * user this product is for, and a companion who is unavailable to them is
     * not a companion with boundaries; it is a missing feature.
     */
    const woken = isAsleep(brain.rhythm, this.situation.snapshot().hour);
    if (woken) brain.mood.feel('late-night');

    /*
     * Fetched rather than awaited, and then told to her when it lands.
     *
     * Awaiting it would put a geocode and a forecast in front of hello, which
     * is not a trade worth making. But not awaiting it meant the weather
     * essentially never reached her: the instruction is fixed at connect and
     * only rebuilt on a reconnect, so the first wake of every run shipped with
     * the city and no forecast and stayed that way. The injection is the half
     * that was missing.
     */
    void this.#place.refresh().then((place) => {
      if (place.weather) this.#tellPlace(place);
    });

    const live = new LiveConversation({
      apiKey: brain.config.geminiApiKey,
      model: brain.config.model,
      voice: brain.profile.voice.voice,
      languageCode: brain.profile.voice.languageCode,
      tools: hersTools(),
      // Rebuilt rather than captured, so a reconnect picks up her current mood
      // and the senses that are on now rather than the ones that were on when
      // the conversation started.
      systemInstruction: () => this.#systemInstruction(),
      handlers: {
        onAudio: (pcm) => {
          // The first byte of her voice is the only signal that she has begun.
          // The Live API defines no field for it — `generationComplete` and
          // `turnComplete` both mark the end — so the audio itself is it.
          this.#beginSpeaking();
          this.#sink.audio(pcm);
        },
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
    this.#watchWeather();
    this.#watchForeground();
    // After `start()`, not before: the session has to exist for the note to
    // reach it, and it is a note about the turn that is about to happen.
    if (woken) live.prompt(wokenLine(brain.rhythm, this.situation.snapshot().hour));
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
    this.#watcher.reset();
    if (this.#weatherTimer) clearInterval(this.#weatherTimer);
    this.#weatherTimer = null;
    this.#toldPlace = '';
    if (this.#foregroundTimer) clearInterval(this.#foregroundTimer);
    this.#foregroundTimer = null;
    this.#foreground.reset();
    // Asleep is nothing at all rather than a quieter mode. A sense left on
    // while she is asleep is the camera-light problem in another form: the
    // hardware would say she is watching and the product would say she is not.
    for (const sense of SENSE_NAMES) this.situation.setSense(sense, false);
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
    /*
     * A screen frame arriving is the screen share being on.
     *
     * Nothing else can tell her. Hearing and sight come up with her because the
     * browser opens them on the wake gesture, but a screen share is granted per
     * surface — the desktop application has a remembered source and a browser
     * tab has none — so the only honest signal the server has is that frames
     * are turning up. Treating the frame as the evidence means there is no
     * switch to leave in the wrong position.
     *
     * It stays true until it goes stale rather than being switched off: the
     * question "is she watching the screen right now" is answered by
     * `seeing.screen`, which needs a frame inside fifteen seconds, and that is
     * what the prompt and the openers both read.
     */
    if (kind === 'screen' && !this.situation.senses.screen) {
      this.situation.setSense('screen', true);
    }
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
    // Only the camera. The screen already has a change detector that costs
    // nothing — `shared/screen-change.ts`, in the browser — and captioning it
    // as well would be paying a model to answer a question already answered.
    if (kind === 'camera') void this.#watcher.see(jpeg);
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
    /*
     * They have stopped; she has not started. This is the gap.
     *
     * Nothing in the Live API says "the model is thinking" — there is no field
     * that marks the start of generation, only `generationComplete` and
     * `turnComplete` at the end — so the state is inferred from the boundary
     * that *is* observable: their turn closed and no audio has arrived yet.
     * Measured at 1211ms on the doctor's own round trip, which is past every
     * threshold that matters. Vapi puts the sluggish line at 800ms; Nielsen
     * puts the one where a person stops feeling the system is responding at a
     * second. In that window the sphere used to sit at rest, which is the
     * shape of a companion who has not heard you.
     */
    this.#thinkingSince = this.#now();
    if (!this.#closed) this.#sink.state('thinking');
    this.situation.noteUserSpoke();
    this.#brain.memory.record('user', text);
    this.#brain.intimacy.noteTurn();
    this.#emitMood(false, () => this.#brain.mood.feel('exchange'));
    this.#initiative.poke();
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

  /** Her first sound of this turn: thinking is over, whatever it was doing. */
  #beginSpeaking(): void {
    if (this.#speaking || this.#closed) return;
    this.#speaking = true;
    this.#thinkingSince = 0;
    this.#sink.state('speaking');
  }

  #onTurnComplete(): void {
    this.#speaking = false;
    this.#thinkingSince = 0;
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
    this.#thinkingSince = 0;
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
   * finds out a tool did not work, and adapts instead of repeating herself.
   */
  async #onToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    /*
     * A tool call is the longest kind of thinking she does, and the only kind
     * with a cause worth showing.
     *
     * Function calling on 3.1 is sequential — the model will not start
     * answering until the tool response is back — so a `recall` sits an
     * embedding round trip inside the turn, and `run` sits a shell command with
     * a thirty-second deadline inside it. Those are seconds of silence with a
     * reason, and the reason is exactly what the person waiting cannot see.
     *
     * Re-entered rather than guarded: she can call a tool part way through
     * speaking, and going back to thinking is the truthful thing to show when
     * she does.
     */
    if (!this.#closed) {
      this.#speaking = false;
      this.#thinkingSince = this.#thinkingSince || this.#now();
      this.#sink.state('thinking');
    }
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

      /*
       * The one tool whose answer is content rather than a receipt.
       *
       * Everything above returns `{ok: true}` precisely because prose in a tool
       * response can end up being read out — that happened, and the note above
       * this switch is what came of it. This one has to break that rule: a
       * lookup whose answer is not in the answer is not a lookup. So the payload
       * is kept to what it has to be — a few sentences she wrote herself, no
       * ids, no scores, no embeddings — and the prompt carries the instruction
       * that they are hers to use rather than to recite.
       */
      case RECALL: {
        const about = String(args.about ?? '').trim();
        if (!about) return { ok: false, reason: 'nothing to look up' };

        let hits: RecalledFact[];
        try {
          hits = await this.#brain.memory.recallDetailed(about, RECALL_TOOL_CANDIDATES);
        } catch {
          // Told, not swallowed. An empty answer would read to her as "you were
          // never told this", which is a different and much worse claim than
          // "the lookup did not work".
          return { ok: false, reason: 'your memory could not be searched just now' };
        }

        const facts = hits
          .filter((hit) => isAbout(about, hit))
          .slice(0, RECALL_TOOL_FACTS)
          .map((hit) => hit.text);

        if (facts.length === 0) {
          return {
            ok: true,
            facts: [],
            note:
              'nothing you have kept came back for that. Say you do not have it, ' +
              'plainly; do not guess at it and do not say you were never told.',
          };
        }
        return { ok: true, facts };
      }

      /*
       * The three that touch the machine.
       *
       * They break the receipt rule above for the same reason `recall` does —
       * a command whose output is not in the answer has not been run as far as
       * she is concerned — and they break it more dangerously, because the
       * output is text somebody else wrote. It arrives wrapped by `untrusted()`
       * before it gets here, and the prompt says once what the wrapper means.
       */
      case RUN:
        return await this.#hands.run(String(args.command ?? ''), args.confirmed === true);

      case OPEN:
        return await this.#hands.open(String(args.target ?? ''));

      case WRITE:
        return await this.#hands.write(
          String(args.path ?? ''),
          String(args.text ?? ''),
          args.append === true,
        );

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

  /**
   * Re-asks Open-Meteo once an hour, and only speaks when the answer moved.
   *
   * The hour is `WEATHER_TTL_MS`, which `PlaceSense` already enforces — this
   * timer is what makes anything ask. Rendering the line and comparing it,
   * rather than comparing the numbers, means a degree of drift that does not
   * change what she would say costs nothing, which is the same discipline
   * `MOOD_NOTIFY_DELTA` applies to her mood.
   */
  #watchWeather(): void {
    if (this.#weatherTimer) return;
    this.#weatherTimer = setInterval(() => {
      void this.#place.refresh().then((place) => {
        if (place.weather) this.#tellPlace(place);
      });
    }, WEATHER_TTL_MS);
    this.#weatherTimer.unref?.();
  }

  /**
   * Asks what is in front of them, and speaks only when it changed.
   *
   * Fifteen seconds is slow enough that a person flicking between two windows
   * does not produce a running commentary, and fast enough that "you have been
   * in that document a while" is true when she says it. Nothing is injected
   * while she is talking or being talked to: the point is that she noticed, not
   * that she interrupted.
   */
  #watchForeground(): void {
    if (this.#foregroundTimer) return;
    this.#foregroundTimer = setInterval(() => {
      if (this.#speaking || this.#userTalking || !this.#live?.isLive) return;
      void this.#foreground.poll().then((moved) => {
        if (moved) this.#live?.prompt(foregroundUpdate(moved));
      });
    }, FOREGROUND_INTERVAL_MS);
    this.#foregroundTimer.unref?.();
  }

  #tellPlace(place: Place): void {
    const line = placeLine(place);
    if (line === this.#toldPlace) return;
    this.#toldPlace = line;
    this.#live?.prompt(placeUpdate(place));
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
      seeing: snapshot.seeing,
      localTime: snapshot.localTime,
      channel: this.#channel,
      returning: this.#brain.hasHistory,
      intimacy: this.#brain.intimacy.read(),
      place: this.#place.snapshot(),
      rhythm: this.#brain.rhythm,
      ...(this.#foreground.current ? { foreground: this.#foreground.current } : {}),
      ...(this.#watcher.caption ? { caption: this.#watcher.caption } : {}),
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

/**
 * Whether a recalled fact is about what she asked for.
 *
 * Two ways through, and whichever says yes is enough, because neither signal
 * alone is right about a short sentence. The score is the ranked, semantic answer and
 * carries the cases a keyword cannot: "how did the demo go" finding a fact
 * written down as a presentation on Thursday. A word in common is the second
 * opinion, and it is here because the score is contaminated by age — see
 * {@link RECALL_TOOL_FLOOR} — so a fact from months ago that plainly names the
 * thing being asked about ("interview" against "he is interviewing on Thursday")
 * would otherwise be refused for being old.
 *
 * Tokens come from the embedder rather than from `split(' ')` so that the words
 * being compared are the same words the vectors were built from; it stems and
 * drops stop words, which is what keeps "his sister" from matching every fact
 * with "his" in it.
 *
 * It lets some things through it should not. A query about what someone is
 * working on will match a fact about their morning run for the word "work". That
 * is a real cost and it is the right way round: a spare fact she can ignore is
 * cheaper than a fact she owns and cannot find, which is the failure this whole
 * path exists to fix.
 */
function isAbout(query: string, fact: RecalledFact): boolean {
  if (fact.score >= RECALL_TOOL_FLOOR) return true;
  const wanted = new Set(lexicalTokens(query));
  if (wanted.size === 0) return false;
  return lexicalTokens(fact.text).some((token) => wanted.has(token));
}

function num(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp01(value: number | undefined): number {
  if (value === undefined) return 0.7;
  return Math.min(1, Math.max(0, value));
}
