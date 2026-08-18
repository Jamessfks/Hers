/**
 * One conversation, several places to have it from.
 *
 * Until this existed, each transport built its own {@link Companion}: the
 * website had one, Telegram had another, and each owned a separate Gemini socket
 * and a separate initiative timer. Everything downstream of that was wrong in
 * ways that are obvious once stated —
 *
 *   - Two initiative timers meant two openers. She would decide to speak first
 *     on the phone and, independently, decide to speak first at the desk, at two
 *     different moments, about two different things. Two billed calls for one
 *     thought.
 *   - Two sockets meant two contexts. They shared a memory, so the *facts*
 *     agreed, but the live thread of what had just been said did not.
 *   - A turn on Telegram did not appear in an open browser tab until it was
 *     reloaded, because the tab was told the transcript once, on connect.
 *
 * ## What OpenClaw does, which is the model here
 *
 * Its Gateway is "the single source of truth for sessions, routing, and channel
 * connections", direct messages collapse into one `main` session by default
 * rather than one per channel, and replies go "back to the channel where a
 * message came from". Its web dashboard is then the exception that makes the
 * whole thing legible: WebChat attaches to the agent's main session, so it
 * "lets you see cross-channel context for that agent in one place".
 *
 * So: one session, replies to whoever asked, and the web is the view onto all of
 * it. That is exactly this class.
 *
 * ## Where this goes further, and why
 *
 * OpenClaw's documentation says nothing about an agent that speaks first, so
 * there is no precedent to copy for the case that matters most here. Her rule
 * is that an opener belongs to no channel, so it goes to *all* of them — one
 * decision, one API call, delivered everywhere she is reachable. A companion who
 * says "still up?" to your phone and something else entirely to your desk is two
 * companions.
 *
 * ## Why replies are not broadcast
 *
 * Only openers fan out. Answer a message typed at the desk and Telegram stays
 * quiet, because the alternative is a phone that buzzes for a conversation you
 * are already having in front of you. The record still agrees — the browser sees
 * every turn from every surface, and memory holds all of it — which is the same
 * division OpenClaw draws between where a reply is *delivered* and where the
 * conversation can be *seen*.
 */

import type { ConnectionState, MoodReadout, SenseName } from '../../shared/protocol.ts';
import type { GalleryItem } from '../gallery/gallery.ts';
import { Companion } from './companion.ts';
import type { Brain } from './brain.ts';
import type { LiveConnector } from '../gemini/live.ts';

/** Somewhere she can be reached. Calls are deliberately not one of these. */
export type SurfaceName = 'web' | 'telegram';

/**
 * Which surface an event is *for*.
 *
 * `null` means she started it herself, and that is the case worth naming: an
 * opener has no origin, so every surface takes it.
 */
export type Origin = SurfaceName | null;

/**
 * One place she can be reached from.
 *
 * Every method takes the origin, so a surface decides for itself whether an
 * event is something to deliver to the user or merely something to display.
 * That decision cannot be made centrally: it is the difference between a
 * transcript line in a browser and a notification on somebody's phone.
 */
export interface Surface {
  readonly name: SurfaceName;
  transcript(who: 'user' | 'her', text: string, final: boolean, origin: Origin): void;
  audio?(pcm: Buffer, origin: Origin): void;
  show?(item: GalleryItem, origin: Origin): void;
  state?(state: ConnectionState): void;
  mood?(mood: MoodReadout): void;
  /** She named herself. No origin: it is true everywhere at once. */
  named?(name: string): void;
  interrupted?(): void;
  trouble?(message: string): void;
}

export interface ConversationOptions {
  brain: Brain;
  /** Injected by tests so nothing opens a socket. */
  connect?: LiveConnector;
}

export class Conversation {
  readonly #options: ConversationOptions;
  readonly #surfaces = new Map<SurfaceName, Surface>();
  #companion: Companion | null = null;
  /**
   * Whoever is being answered.
   *
   * Set by every piece of input and cleared when the turn closes, so an opener
   * that fires afterwards has no origin and reaches everybody. A field rather
   * than a parameter threaded through the model, because what comes back from
   * Gemini carries no memory of what prompted it.
   */
  #origin: Origin = null;

  constructor(options: ConversationOptions) {
    this.#options = options;
  }

  attach(surface: Surface): void {
    this.#surfaces.set(surface.name, surface);
  }

  detach(name: SurfaceName): void {
    this.#surfaces.delete(name);
  }

  get attached(): SurfaceName[] {
    return [...this.#surfaces.keys()];
  }

  /** The live session, or null when she is asleep. */
  get live(): Companion['live'] {
    return this.#companion?.live ?? null;
  }

  get awake(): boolean {
    return this.#companion?.live !== null && this.#companion !== null;
  }

  /**
   * What is true about the room, for whoever needs to read it.
   *
   * One situation for one conversation: the senses the website switched on are
   * the senses she has, including while she is answering Telegram. That is the
   * point of there being one of her.
   */
  get situation(): Companion['situation'] | null {
    return this.#companion?.situation ?? null;
  }

  /**
   * Opens the session if it is not already open.
   *
   * Idempotent and the only way in, so two surfaces arriving at once cannot
   * produce two sessions. `Companion.wake` is itself guarded, but relying on
   * that would mean this class had two owners.
   */
  async wake(): Promise<void> {
    this.#ensure();
    await this.#companion?.wake();
  }

  async sleep(): Promise<void> {
    const companion = this.#companion;
    this.#companion = null;
    this.#origin = null;
    await companion?.sleep();
  }

  /** Something they typed or said, from one particular place. */
  say(text: string, from: SurfaceName): void {
    this.#origin = from;
    this.#ensure().say(text);
  }

  /** Microphone audio. Only the website has one. */
  hear(pcm: Buffer, from: SurfaceName): void {
    this.#origin = from;
    this.#companion?.hear(pcm);
  }

  see(jpeg: Buffer, kind: 'camera' | 'screen', from: SurfaceName): void {
    // Deliberately does not set the origin. A frame is not a question, and a
    // camera left running should not decide where her next sentence is sent.
    void from;
    this.#companion?.see(jpeg, kind);
  }

  /** A picture they deliberately sent. That is a question, so it sets origin. */
  look(bytes: Buffer, mimeType: string, from: SurfaceName): void {
    this.#origin = from;
    this.#companion?.look(bytes, mimeType);
  }

  setSense(sense: SenseName, on: boolean): void {
    this.#companion?.setSense(sense, on);
  }

  notePresence(idleSeconds: number, tabVisible: boolean): void {
    this.#companion?.notePresence(idleSeconds, tabVisible);
  }

  noteScreen(...args: Parameters<Companion['noteScreen']>): void {
    this.#companion?.noteScreen(...args);
  }

  interrupt(): void {
    this.#companion?.interrupt();
  }

  // -------------------------------------------------------------------------

  #ensure(): Companion {
    if (this.#companion) return this.#companion;

    this.#companion = new Companion({
      brain: this.#options.brain,
      // The desk, because that is where the senses are. A conversation that
      // moved between channel identities would have to rebuild its system
      // instruction to do it, and there is one conversation.
      channel: 'desktop',
      ...(this.#options.connect ? { connect: this.#options.connect } : {}),
      sink: {
        audio: (pcm) => this.#each((surface, origin) => surface.audio?.(pcm, origin)),
        transcript: (who, text, final) => {
          this.#each((surface, origin) => surface.transcript(who, text, final, origin));
        },
        show: (item) => this.#each((surface, origin) => surface.show?.(item, origin)),
        state: (state) => {
          this.#each((surface) => surface.state?.(state));
          /*
           * The turn is over, so the next thing she says is her own idea.
           *
           * Cleared on the turn boundary rather than on her last sentence,
           * because a turn can contain several. Clearing per sentence sent the
           * second half of a reply to everybody — which on a phone is a buzz for
           * a conversation you are already having at your desk.
           */
          if (state === 'listening') this.#origin = null;
        },
        mood: (mood) => this.#each((surface) => surface.mood?.(mood)),
        named: (name) => this.#each((surface) => surface.named?.(name)),
        interrupted: () => this.#each((surface) => surface.interrupted?.()),
        trouble: (message) => this.#each((surface) => surface.trouble?.(message)),
      },
    });
    return this.#companion;
  }

  /**
   * Hands an event to every attached surface, with the origin of the turn.
   *
   * The origin is read once, here, rather than per surface — so a turn that
   * completes while it is being delivered cannot have its first half addressed
   * to Telegram and its second half to nobody.
   */
  #each(deliver: (surface: Surface, origin: Origin) => void): void {
    const origin = this.#origin;
    for (const surface of this.#surfaces.values()) {
      try {
        deliver(surface, origin);
      } catch {
        // One broken surface must not silence the others. A closed socket
        // throwing here would otherwise cost Telegram its message.
      }
    }
  }

}
