/**
 * Her, on Telegram.
 *
 * Long polling, so nothing listens for inbound connections and no webhook URL
 * has to exist. The bot dials out, holds the request open for fifty seconds,
 * and that is the entire transport.
 *
 * ## What happens to each kind of message
 *
 *   text          Straight into the live session.
 *   photo         Straight into the live session as an image. The Live API takes
 *                 JPEG and PNG natively, so nothing is transcoded.
 *   voice, video  Transcribed first — see `transcribeMedia`. A voice note is
 *                 Opus in Ogg and the Live API takes raw PCM only, and no
 *                 amount of wanting changes that.
 *
 * Her replies are voice notes. Every one of them, since v2.0 — in her own
 * recorded voice where the turn produced audio, and synthesised in the same
 * voice where it did not. See `#say`.
 *
 * ## Who is allowed to talk to her
 *
 * A bot token is a bearer credential on a public endpoint — anyone who finds
 * the bot can message it, and Her memory is one person's private life. So
 * every update is checked against an allowlist. When none is configured she
 * pins herself to the first chat that speaks to her and ignores everyone after,
 * which is a sane default rather than an open door.
 */

import { encodeOggOpus, pcmSeconds } from '../../core/speech/ogg-opus.ts';
import { synthesise } from '../../core/speech/synthesise.ts';
import { transcribeMedia } from '../../core/gemini/text.ts';
import type { Conversation, Origin } from '../../core/session/conversation.ts';
import type { Brain } from '../../core/session/brain.ts';
import { TelegramApi, largestPhoto } from './api.ts';
import type { BotCommand, TelegramClient, TelegramMessage, TelegramUpdate } from './api.ts';

/**
 * The command menu, published to Telegram on startup.
 *
 * This is most of what "straightforward setup" means here: nobody has to be
 * told the commands exist, because they are behind the `/` button with
 * descriptions attached.
 */
const COMMANDS: BotCommand[] = [
  { command: 'mood', description: 'How she is' },
  { command: 'bye', description: 'End the conversation' },
  { command: 'whoami', description: 'Your chat id' },
  { command: 'help', description: 'What she can do' },
];

/** Sessions end after this much user silence, which also stops her opening. */
const IDLE_SLEEP_MS = 10 * 60 * 1000;
/** Backoff when Telegram is unreachable, so an outage is not a hot loop. */
const POLL_ERROR_BACKOFF_MS = 5000;
/**
 * Below this, a long poll did not long-poll.
 *
 * `getUpdates` is asked to hold the connection open for fifty seconds, so an
 * empty result that comes back instantly did not come from Telegram — it came
 * from the client swallowing its own error and returning nothing. Without this
 * check the loop spins as fast as the CPU allows on any outage, and because it
 * only ever awaits resolved promises it starves the event loop while doing it:
 * every timer in the process stops, which means the three-minute rule stops too.
 */
const REAL_POLL_MS = 1000;
/** A floor between polls even when updates are genuinely waiting. */
const POLL_GAP_MS = 200;

export interface TelegramBridgeOptions {
  brain: Brain;
  /** The one conversation, shared with the website. */
  conversation: Conversation;
  token: string;
  allowedChatIds: number[];
  /** Injected by tests so the allowlist can be exercised without a network. */
  api?: TelegramClient;
  /**
   * Called once, with the first chat to speak, when there was no allowlist.
   *
   * The bridge reports rather than persists, because it is the wrong place to
   * write a file — and because it is the *only* place that can know: nothing in
   * the Bot API reveals a chat id except an update arriving from it, and the
   * bridge holds the single `getUpdates` loop. A second poller looking for the
   * same thing would be handed the updates and this one would be terminated.
   */
  onChatPinned?: (chatId: number) => void;
}

export class TelegramBridge {
  readonly #brain: Brain;
  readonly #api: TelegramClient;
  readonly #allowed: Set<number>;
  readonly #onChatPinned: ((chatId: number) => void) | undefined;
  #pinnedChatId: number | null = null;
  #offset = 0;
  #running = false;
  #loop: Promise<void> | null = null;
  readonly #conversation: Conversation;
  #attached = false;
  #chatId: number | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Her voice for the turn in progress, kept only until the turn lands. */
  #speech: Buffer[] = [];
  /** True when the last thing they sent was spoken rather than typed. */

  constructor(options: TelegramBridgeOptions) {
    this.#brain = options.brain;
    this.#conversation = options.conversation;
    this.#api = options.api ?? new TelegramApi(options.token);
    this.#allowed = new Set(options.allowedChatIds);
    this.#onChatPinned = options.onChatPinned;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    // Best effort: a failure here costs the menu, not the bot.
    void this.#api.setMyCommands(COMMANDS).catch(() => undefined);
    this.#loop = this.#poll();
  }

  stop(): void {
    this.#running = false;
    this.#clearIdle();
    void this.#sleep();
    void this.#loop;
  }

  // -------------------------------------------------------------------------

  async #poll(): Promise<void> {
    while (this.#running) {
      const startedAt = Date.now();
      let updates: TelegramUpdate[] = [];

      try {
        updates = await this.#api.getUpdates(this.#offset);
        for (const update of updates) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          if (!this.#running) break;
          await this.#onUpdate(update);
        }
      } catch (error) {
        console.warn(`telegram: ${String(error)}`);
        await delay(POLL_ERROR_BACKOFF_MS);
        continue;
      }

      if (!this.#running) break;
      const elapsed = Date.now() - startedAt;
      if (updates.length > 0) await delay(POLL_GAP_MS);
      else if (elapsed < REAL_POLL_MS) await delay(POLL_ERROR_BACKOFF_MS);
    }
  }

  async #onUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message ?? update.edited_message;
    if (!message || message.from?.is_bot) return;

    const chatId = message.chat.id;
    if (!this.#permitted(chatId)) return;

    const text = (message.text ?? '').trim();
    const command = text.startsWith('/') ? text : '';

    if (command && !message.photo && !message.document) {
      await this.#command(chatId, command);
      return;
    }

    await this.#ensureAwake(chatId);
    await this.#api.sendChatAction(chatId, 'typing');
    await this.#deliver(chatId, message, text);
    this.#armIdle();
  }

  /**
   * The allowlist.
   *
   * Pinning to the first chat is the unconfigured default rather than trusting
   * everyone, because "she talks to whoever messages her" and "she reads one
   * person's private life out to whoever messages her" are the same sentence.
   */
  #permitted(chatId: number): boolean {
    if (this.#allowed.size > 0) return this.#allowed.has(chatId);
    if (this.#pinnedChatId === null) {
      this.#pinnedChatId = chatId;
      console.log(`  telegram  linked to chat ${chatId}`);
      this.#onChatPinned?.(chatId);
      return true;
    }
    return this.#pinnedChatId === chatId;
  }

  async #deliver(chatId: number, message: TelegramMessage, text: string): Promise<void> {
    const companion = this.#conversation;

    // A photo goes in as a picture, because she can actually see it.
    const photo = message.photo ? largestPhoto(message.photo) : null;
    if (photo) {
      const bytes = await this.#api.download(photo.file_id);
      if (bytes) {
        companion.look(bytes, 'image/jpeg', 'telegram');
        companion.say(message.caption?.trim() || 'Sent you a photo.', 'telegram');
        return;
      }
    }

    const media = message.voice ?? message.video_note ?? message.video ?? message.audio;
    if (media) {
      const bytes = await this.#api.download(media.file_id);
      if (!bytes) {
        await this.#api.sendMessage(chatId, "That file was too big for me to fetch.");
        return;
      }
      const heard = await transcribeMedia(this.#brain.config.geminiApiKey, {
        data: bytes,
        mimeType: mimeTypeOf(message),
      });
      if (!heard) {
        await this.#api.sendMessage(chatId, "I couldn't make that out.");
        return;
      }
      companion.say(heard, 'telegram');
      return;
    }

    if (text) {
      companion.say(text, 'telegram');
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async #command(chatId: number, raw: string): Promise<void> {
    const [head] = raw.split(/\s+/);
    const command = (head ?? '').split('@')[0]?.toLowerCase() ?? '';

    switch (command) {
      case '/start':
      case '/help':
        await this.#api.sendMessage(
          chatId,
          [
            `I'm ${this.#brain.profile.identity.name}.`,
            '',
            'Just talk to me — text, photos, voice notes, video notes. All of it reaches me.',
            '',
            '/mood     how I am',
            '/bye      end the conversation',
            '/whoami   your chat id',
          ].join('\n'),
        );
        return;

      case '/whoami':
        await this.#api.sendMessage(chatId, `This chat is ${chatId}.`);
        return;

      case '/mood': {
        const mood = this.#brain.mood.read();
        await this.#api.sendMessage(chatId, `${mood.label}.`);
        return;
      }

      case '/bye':
        await this.#sleep();
        await this.#api.sendMessage(chatId, 'Alright. Talk later.');
        return;

      default:
        await this.#api.sendMessage(chatId, `I don't know ${command}. /help lists what I do.`);
    }
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  async #ensureAwake(chatId: number): Promise<void> {
    if (this.#attached && this.#chatId === chatId) return;
    await this.#sleep();
    this.#chatId = chatId;

    /*
     * Telegram becomes a surface on the one conversation rather than opening its
     * own. Two sessions meant two initiative timers and two openers for one
     * thought; one session means the browser and the phone are the same
     * conversation, seen from two places.
     */
    this.#chatId = chatId;
    if (!this.#attached) {
      this.#attached = true;
      this.#conversation.attach({
        name: 'telegram',
        /*
         * Delivered only when this is her answer to Telegram, or when she
         * started it herself.
         *
         * `origin === null` is an opener: she decided to speak, so it reaches
         * every surface she is reachable from — which is the whole point of the
         * shared session. `origin === 'web'` is somebody typing at their desk,
         * and a phone that buzzes for that conversation is a phone nobody wants.
         * OpenClaw draws the same line: replies go "back to the channel where a
         * message came from".
         */
        transcript: (who, text, final, origin) => {
          if (who !== 'her' || !final || !this.#mine(origin)) return;
          void this.#say(chatId, text);
        },
        audio: (pcm, origin) => {
          if (!this.#mine(origin)) return;
          // Kept for the length of a turn so it can be sent as a voice note.
          if (this.#speech.length < 400) this.#speech.push(pcm);
        },
        trouble: (message) => console.warn(`telegram: ${message}`),
      });
    }
    await this.#conversation.wake();
    this.#armIdle();
  }

  /**
   * Sends a finished line, as a voice note. Always.
   *
   * v1 gated this: a voice note only if the answer was under 320 characters
   * *and* either they had spoken first or a coin came up one in four. Every
   * other reply was text, and the transcript was appended to the voice notes
   * as well. That produced a companion who was mostly a chat bot with an
   * occasional audio novelty, which is the exact product v2.0 exists to stop
   * being.
   *
   * So the gate is gone and so is the trailing transcript. Three ways a turn
   * can end, in order of preference:
   *
   *   **Her own voice**, re-encoded from the PCM the Live session produced.
   *   Better than any re-render, because it *is* the take — the pauses and the
   *   breath are the ones she actually made.
   *
   *   **Synthesised**, when a turn produced no audio at all, which happens when
   *   she answers a Telegram message while nothing is playing at the desk.
   *   `gemini-3.1-flash-tts-preview` in her own `voiceName`, so it is at least
   *   the same voice.
   *
   *   **Text**, only when both of those failed. Not a fallback anybody chose —
   *   a message that never arrives is worse than one in the wrong medium — and
   *   it is the one path here that breaks the promise the rest of this file
   *   makes.
   */
  async #say(chatId: number, text: string): Promise<void> {
    const pcm = Buffer.concat(this.#speech);
    this.#speech = [];

    const ogg = pcm.length > 0 ? encodeOggOpus(pcm) : null;
    if (ogg) {
      await this.#api.sendVoice(
        chatId,
        { data: ogg, name: 'voice.ogg', mimeType: 'audio/ogg' },
        pcmSeconds(pcm),
      );
      return;
    }

    const spoken = await this.#speak(text);
    if (spoken) {
      await this.#api.sendVoice(
        chatId,
        { data: spoken.ogg, name: 'voice.ogg', mimeType: 'audio/ogg' },
        spoken.seconds,
      );
      return;
    }

    await this.#api.sendMessage(chatId, text);
  }

  /** The synthesised fallback. Null on anything that did not work. */
  async #speak(text: string): Promise<{ ogg: Buffer; seconds: number } | null> {
    const key = this.#brain.config.geminiApiKey;
    if (!key || !text.trim()) return null;
    const pcm = await synthesise(key, text, this.#brain.profile.voice.voice);
    if (!pcm) return null;
    const ogg = encodeOggOpus(pcm);
    return ogg ? { ogg, seconds: pcmSeconds(pcm) } : null;
  }

  /**
   * Ends the conversation without stopping the bot.
   *
   * Called when everything she remembers is deleted from the website. A
   * companion left running would hold the old memory open, write into a
   * database that no longer exists, and answer the next message as somebody who
   * has just been forgotten.
   */
  async forgetSessions(): Promise<void> {
    await this.#sleep();
  }

  /** True when what she just said belongs on this phone. */
  #mine(origin: Origin): boolean {
    return origin === 'telegram' || origin === null;
  }

  async #sleep(): Promise<void> {
    this.#clearIdle();
    this.#chatId = null;
    this.#conversation.detach('telegram');
    this.#attached = false;
    // Only ends the conversation if nothing else is holding it. A browser tab
    // open at the desk is still a place she is reachable from.
    if (this.#conversation.attached.length === 0) await this.#conversation.sleep();
  }

  #armIdle(): void {
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => void this.#sleep(), IDLE_SLEEP_MS);
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
}

// ---------------------------------------------------------------------------

/**
 * Telegram's own `mime_type` when it gives one, and a correct guess when it
 * does not — video notes never carry one and are always MP4.
 */
function mimeTypeOf(message: TelegramMessage): string {
  if (message.voice) return message.voice.mime_type ?? 'audio/ogg';
  if (message.video_note) return 'video/mp4';
  if (message.video) return message.video.mime_type ?? 'video/mp4';
  if (message.audio) return message.audio.mime_type ?? 'audio/mpeg';
  return 'application/octet-stream';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
