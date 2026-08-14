/**
 * The turn loop. Everything else in `core` is a component; this is the thing
 * that makes Anna behave like a person.
 *
 * ## The latency budget
 *
 * The number that decides whether this feels alive is the gap between the user
 * finishing a sentence and Anna making her first sound. Past roughly a second
 * it reads as a machine thinking. The budget is 800ms, and it is spent:
 *
 *     ~120ms   model time-to-first-token
 *     ~180ms   enough tokens to make a first clause worth speaking
 *     ~90ms    Cartesia time-to-first-audio
 *     ------
 *     ~390ms   typical, leaving headroom for a bad network
 *
 * That budget only works because three things overlap: the parser emits a
 * clause before the model has finished the sentence, synthesis of clause N+1
 * starts while clause N is still playing, and the body starts moving on the
 * first directive rather than waiting for audio. Serialise any one of them and
 * the budget is gone.
 *
 * ## Barge-in
 *
 * Interrupting is not an edge case, it is most of how people talk. When the
 * user speaks while Anna is talking, everything in flight — model stream,
 * synthesis, playback — is abandoned immediately. A companion who finishes her
 * sentence over you is worse than one who says nothing.
 */

import type { AudioChunk, TtsProvider } from '../speech/types.ts';
import type { BrainState, PerformanceEvent } from '../../shared/protocol.ts';
import type { ChatMessage, LlmProvider } from '../llm/types.ts';
import { Attention, SituationTracker } from '../senses/attention.ts';
import { Memory } from '../memory/memory.ts';
import { PerformanceParser, spokenText } from '../persona/performance.ts';
import { STYLE_EXAMPLES, buildSystemPrompt } from '../persona/anna.ts';

/** How many clauses may be synthesised ahead of the one playing. */
const SYNTHESIS_LOOKAHEAD = 2;

export interface CompanionSinks {
  /** A beat of performance for the body. */
  perform(event: PerformanceEvent): void;
  /** Audio for a clause, in order. `end` marks the clause complete. */
  audio(clauseId: number, chunk: AudioChunk | null): void;
  state(state: BrainState): void;
  /** Non-fatal problems worth showing the user, phrased for a human. */
  trouble(message: string): void;
}

export interface CompanionOptions {
  llm: LlmProvider;
  tts: TtsProvider;
  memory: Memory;
  attention: Attention;
  situation: SituationTracker;
  sinks: CompanionSinks;
  model: string;
  voiceId: string;
  userName?: string;
  now?: () => number;
}

export class Companion {
  readonly #options: CompanionOptions;
  readonly #now: () => number;
  #turn: AbortController | null = null;
  #turnId = 0;
  /** Set while Anna is mid-turn; drives the "do not interrupt her" rule. */
  #speaking = false;
  #lastActivityAt = 0;

  constructor(options: CompanionOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  get isSpeaking(): boolean {
    return this.#speaking;
  }

  /**
   * The user said something. Anna answers.
   *
   * Any turn already in flight is cancelled first — see barge-in above.
   */
  async respondTo(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    this.bargeIn();
    this.#options.memory.record('user', clean);
    this.#options.situation.observe({ kind: 'user-typed', text: clean, at: this.#now() });
    await this.#speak({ userText: clean });
  }

  /**
   * Periodic check: has anything happened that Anna would speak up about?
   * Called on a timer by the host. Returns true if she opened.
   */
  async tick(): Promise<boolean> {
    if (this.#speaking) return false;
    const now = this.#now();
    const snapshot = this.#options.situation.snapshot(now, this.#inConversation(now));
    const opener = this.#options.attention.decide(snapshot, now);
    if (!opener) return false;
    await this.#speak({ openerReason: opener.reason });
    return true;
  }

  /** Stop everything immediately. Safe to call when nothing is running. */
  bargeIn(): void {
    if (!this.#turn) return;
    this.#turn.abort();
    this.#turn = null;
    this.#speaking = false;
    this.#options.perform_bargeIn?.();
    this.#options.sinks.perform({ kind: 'barge-in' });
    this.#options.sinks.state('listening');
  }

  #inConversation(now: number): boolean {
    return this.#speaking || (now - this.#lastActivityAt) / 60000 < 3;
  }

  async #speak(input: { userText?: string; openerReason?: string }): Promise<void> {
    const { sinks, memory, situation, llm, tts } = this.#options;
    const controller = new AbortController();
    this.#turn = controller;
    this.#speaking = true;
    this.#lastActivityAt = this.#now();
    const turnId = `t${(this.#turnId += 1)}`;

    sinks.state('thinking');

    try {
      const memories = await memory.recall(input.userText ?? input.openerReason ?? '', 8);
      const system = buildSystemPrompt({
        ...(this.#options.userName && { userName: this.#options.userName }),
        localTime: formatLocalTime(this.#now()),
        memories,
        ...(memory.runningSummary() && { runningSummary: memory.runningSummary() }),
        situation: situation.describe(this.#now()),
        ...(input.openerReason && { openerReason: input.openerReason }),
      });

      const messages: ChatMessage[] = [
        ...STYLE_EXAMPLES,
        ...memory.liveTranscript().map(
          (turn): ChatMessage => ({
            role: turn.speaker === 'user' ? 'user' : 'assistant',
            content: turn.text,
          }),
        ),
      ];
      if (input.openerReason && messages.at(-1)?.role === 'assistant') {
        // Providers reject two assistant turns in a row; give her a cue to
        // answer instead. The cue is never spoken and never stored.
        messages.push({ role: 'user', content: '(they have not said anything)' });
      }

      const parser = new PerformanceParser();
      const pipeline = new VoicePipeline(tts, this.#options.voiceId, sinks, controller.signal);
      const collected: PerformanceEvent[] = [];
      let emotion: string | undefined;
      let started = false;

      for await (const delta of llm.stream({
        system,
        messages,
        model: this.#options.model,
        maxTokens: 400,
        signal: controller.signal,
      })) {
        for (const event of parser.push(delta)) {
          if (!started) {
            started = true;
            sinks.state('speaking');
          }
          if (event.kind === 'expression') emotion = event.name;
          collected.push(event);
          sinks.perform(event);
          if (event.kind === 'say') pipeline.enqueue(event.clauseId, event.text, emotion);
        }
      }

      for (const event of parser.end()) {
        collected.push(event);
        sinks.perform(event);
        if (event.kind === 'say') pipeline.enqueue(event.clauseId, event.text, emotion);
      }

      await pipeline.drain();
      if (controller.signal.aborted) return;

      const said = spokenText(collected);
      if (said) {
        memory.record('anna', said);
        situation.noteAnnaSpoke(this.#now());
      }

      sinks.perform({ kind: 'turn-end', turnId });
      sinks.state('idle');

      if (memory.needsConsolidation) void memory.consolidate();
    } catch (error) {
      if (controller.signal.aborted) return;
      sinks.trouble(describe(error));
      sinks.perform({ kind: 'turn-end', turnId });
      sinks.state('idle');
    } finally {
      if (this.#turn === controller) {
        this.#turn = null;
        this.#speaking = false;
        this.#lastActivityAt = this.#now();
      }
    }
  }
}

/**
 * Synthesises clauses in order, a couple ahead of playback.
 *
 * Order matters more than throughput here: clause 3 arriving before clause 2 is
 * not a performance win, it is Anna talking backwards. Each clause therefore
 * gets its own sequential slot, while the *requests* overlap.
 */
class VoicePipeline {
  readonly #tts: TtsProvider;
  readonly #voiceId: string;
  readonly #sinks: CompanionSinks;
  readonly #signal: AbortSignal;
  #chain: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(tts: TtsProvider, voiceId: string, sinks: CompanionSinks, signal: AbortSignal) {
    this.#tts = tts;
    this.#voiceId = voiceId;
    this.#sinks = sinks;
    this.#signal = signal;
  }

  enqueue(clauseId: number, text: string, emotion: string | undefined): void {
    if (this.#signal.aborted) return;
    this.#pending += 1;
    const previous = this.#chain;
    this.#chain = (async () => {
      await previous;
      if (this.#signal.aborted) return;
      try {
        for await (const chunk of this.#tts.synthesize({
          text,
          voiceId: this.#voiceId,
          ...(emotion && { emotion }),
          signal: this.#signal,
        })) {
          if (this.#signal.aborted) return;
          this.#sinks.audio(clauseId, chunk);
        }
        this.#sinks.audio(clauseId, null);
      } catch (error) {
        if (!this.#signal.aborted) this.#sinks.trouble(describe(error));
        this.#sinks.audio(clauseId, null);
      } finally {
        this.#pending -= 1;
      }
    })();
  }

  get backlog(): number {
    return this.#pending;
  }

  /** Waits for every enqueued clause to finish synthesising. */
  async drain(): Promise<void> {
    await this.#chain;
  }
}

export { SYNTHESIS_LOOKAHEAD };

function formatLocalTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
