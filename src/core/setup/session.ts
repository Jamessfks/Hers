/**
 * The first conversation, from socket to written profile.
 *
 * Separate from {@link Companion} rather than a mode inside it, and the reason
 * is not tidiness. `Companion` is built out of the profile folder — the prompt,
 * the mood engine, the memory recall at wake, the intimacy clock — and during
 * setup none of those have anything in them yet. Running the interview through
 * it would mean threading "except during setup" through nine call sites of a
 * seven-hundred-line class, and the branch would be the only thing anybody ever
 * read.
 *
 * So this is its own short thing: one Live session, one system instruction, two
 * tools, and a text call at the end. When it finishes it writes the profile
 * folder and hands back; `Conversation` then wakes her the ordinary way, in the
 * voice she has just chosen.
 */

import { LiveConversation } from '../gemini/live.ts';
import type { LiveConnector } from '../gemini/live.ts';
import { chooseName } from '../profile/naming.ts';
import { writeChosenName } from '../profile/profile.ts';
import type { ChosenName } from '../profile/naming.ts';
import { DEFAULT_VOICE } from '../../shared/voices.ts';
import { applyComposed, compose } from './compose.ts';
import type { Composed } from './compose.ts';
import { Interview, setupInstruction, setupTools } from './interview.ts';
import type { Brain } from '../session/brain.ts';

export interface SetupSink {
  audio(pcm: Buffer): void;
  state(state: 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'): void;
  trouble(message: string): void;
  /** She has said what she will be called. */
  named(name: string): void;
  /** Setup is over and she is about to come back as herself. */
  done(): void;
}

export interface SetupOptions {
  brain: Brain;
  sink: SetupSink;
  home: string;
  timeZone?: string;
  /** Injected by tests so nothing opens a socket. */
  connect?: LiveConnector;
  /** Injected by tests so no name is asked for. */
  name?: (personality: string) => Promise<ChosenName | null>;
  /** Injected by tests so nothing is composed over the network. */
  composer?: (transcript: string, digest: string, herName: string) => Promise<Composed>;
}

export class SetupSession {
  #options: SetupOptions;
  #interview: Interview;
  #live: LiveConversation | null = null;
  #transcript: string[] = [];
  #finishing = false;

  constructor(options: SetupOptions) {
    this.#options = options;
    this.#interview = new Interview({
      home: options.home,
      profileDir: options.brain.config.profileDir,
    });
  }

  /**
   * The voice she is interviewed in.
   *
   * The shipped default, and it is worth being clear that this is a compromise
   * rather than a choice: voice is a connect-time parameter on the Live API, so
   * she cannot be interviewed in a voice she has not picked yet. The
   * alternative — a silent interview, or one over text — would make the first
   * three minutes the one part of this product that is not spoken.
   */
  async start(): Promise<void> {
    const brain = this.#options.brain;
    if (!brain.config.geminiApiKey) {
      this.#options.sink.trouble('No Gemini API key yet.');
      return;
    }

    const live = new LiveConversation({
      apiKey: brain.config.geminiApiKey,
      model: brain.config.model,
      voice: DEFAULT_VOICE,
      tools: setupTools(),
      systemInstruction: () => setupInstruction(),
      handlers: {
        onAudio: (pcm) => this.#options.sink.audio(pcm),
        onUserText: (text, final) => this.#note('them', text, final),
        onHerText: (text, final) => this.#note('her', text, final),
        onTurnComplete: () => void this.#checkComplete(),
        onInterrupted: () => undefined,
        onToolCall: (name, args) => this.#interview.onToolCall(name, args),
        onState: (state) => {
          if (state === 'live') this.#options.sink.state('listening');
          if (state === 'error') this.#options.sink.state('error');
        },
        onTrouble: (message) => this.#options.sink.trouble(message),
      },
      ...(this.#options.connect ? { connect: this.#options.connect } : {}),
    });

    this.#live = live;
    this.#options.sink.state('connecting');
    await live.start();
  }

  /** Microphone audio, straight through. Nothing here is recorded to disk. */
  hear(pcm: Buffer): void {
    this.#live?.sendAudio(pcm);
  }

  async close(): Promise<void> {
    const live = this.#live;
    this.#live = null;
    await live?.close();
  }

  #note(who: 'them' | 'her', text: string, final: boolean): void {
    if (!final || !text.trim()) return;
    this.#transcript.push(`${who === 'her' ? 'You' : 'Them'}: ${text.trim()}`);
  }

  /**
   * Ends the interview when all three beats have happened.
   *
   * Checked on turn completion rather than the moment the last tool returns,
   * so that she gets to finish the sentence she is in the middle of. Cutting
   * the socket mid-word to go and compose a personality is the sort of thing
   * that reads as a crash.
   */
  async #checkComplete(): Promise<void> {
    if (this.#finishing || !this.#interview.complete) return;
    this.#finishing = true;
    await this.finish();
  }

  /**
   * Name her, compose her, write her, and reload.
   *
   * Order matters in one place: the name is chosen before the composition, and
   * passed into it, because six files of prose written about a nameless person
   * read like six files of prose written about a nameless person.
   */
  async finish(): Promise<void> {
    const { brain, sink } = this.#options;
    await this.close();
    sink.state('thinking');

    const chosen = await (this.#options.name ?? ((personality: string) =>
      chooseName(brain.config.geminiApiKey, {
        age: brain.profile.identity.age,
        gender: brain.profile.identity.gender,
        ethnicity: brain.profile.identity.ethnicity,
        from: brain.profile.identity.from,
        personality,
      })))(brain.profile.prose.personality ?? '');

    const herName = chosen?.name ?? brain.profile.identity.name;
    const transcript = this.#transcript.join('\n');
    const digest = this.#interview.digest();

    const composed = await (this.#options.composer ??
      ((t: string, d: string, name: string) =>
        compose({
          apiKey: brain.config.geminiApiKey,
          userName: this.#interview.name,
          herName: name,
          digest: d,
          transcript: t,
          timeZone:
            this.#options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
        })))(transcript, digest, herName);

    await applyComposed(brain.config.profileDir, composed);
    if (chosen) await writeChosenName(brain.config.profileDir, chosen.name, chosen.why);

    await brain.reload();
    sink.named(herName);
    sink.done();
  }
}
