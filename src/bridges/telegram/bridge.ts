/**
 * Anna on Telegram.
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
 * Her replies come back as text rather than as voice notes, which is a codec
 * decision and not a taste one: `sendVoice` requires Ogg/Opus and encoding it
 * would mean shipping an encoder to solve a problem that `/call` already solves
 * better. Voice belongs on the call; Telegram is where she writes to you and
 * sends you pictures.
 *
 * ## Who is allowed to talk to her
 *
 * A bot token is a bearer credential on a public endpoint — anyone who finds
 * the bot can message it, and Anna's memory is one person's private life. So
 * every update is checked against an allowlist. When none is configured she
 * pins herself to the first chat that speaks to her and ignores everyone after,
 * which is a sane default rather than an open door.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { transcribeMedia } from '../../core/gemini/text.ts';
import { mimeFor } from '../../core/gallery/gallery.ts';
import { Companion } from '../../core/session/companion.ts';
import type { Brain } from '../../core/session/brain.ts';
import type { CallBridge } from '../livekit/bridge.ts';
import { TelegramApi } from './api.ts';
import type { TelegramClient, TelegramMessage, TelegramUpdate } from './api.ts';

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
  token: string;
  allowedChatIds: number[];
  /** Present when LiveKit is configured. Without it, `/call` says so. */
  calls?: CallBridge | null;
  /** Injected by tests so the allowlist can be exercised without a network. */
  api?: TelegramClient;
}

export class TelegramBridge {
  readonly #brain: Brain;
  readonly #api: TelegramClient;
  readonly #allowed: Set<number>;
  readonly #calls: CallBridge | null;
  #pinnedChatId: number | null = null;
  #offset = 0;
  #running = false;
  #loop: Promise<void> | null = null;
  #companion: Companion | null = null;
  #chatId: number | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TelegramBridgeOptions) {
    this.#brain = options.brain;
    this.#api = options.api ?? new TelegramApi(options.token);
    this.#allowed = new Set(options.allowedChatIds);
    this.#calls = options.calls ?? null;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
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
    if (text.startsWith('/')) {
      await this.#command(chatId, text);
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
      console.warn(
        `! Telegram is pinned to chat ${chatId} for this run. Set TELEGRAM_ALLOWED_CHAT_IDS=${chatId} to make it permanent.`,
      );
      return true;
    }
    return this.#pinnedChatId === chatId;
  }

  async #deliver(chatId: number, message: TelegramMessage, text: string): Promise<void> {
    const companion = this.#companion;
    if (!companion) return;

    // A photo goes in as a picture, because she can actually see it.
    const photo = message.photo?.at(-1);
    if (photo) {
      const bytes = await this.#api.download(photo.file_id);
      if (bytes) {
        companion.look(bytes, 'image/jpeg');
        companion.say(message.caption?.trim() || 'Sent you a photo.');
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
      companion.say(heard);
      return;
    }

    if (text) companion.say(text);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async #command(chatId: number, raw: string): Promise<void> {
    // `/call@AnnaBot arg` in a group.
    const [head, ...rest] = raw.split(/\s+/);
    const command = (head ?? '').split('@')[0]?.toLowerCase() ?? '';
    const argument = rest.join(' ').trim();

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
            '/call   ring me, with your camera and your voice',
            '/photo  ask me for a picture',
            '/mood   how I am',
            '/bye    end the conversation',
            '/whoami your chat id',
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

      case '/photo': {
        await this.#api.sendChatAction(chatId, 'upload_photo');
        const item = await this.#brain.gallery.pick(argument || 'a picture of you right now', {
          allowNew: true,
          apiKey: this.#brain.config.geminiApiKey,
          appearance: appearanceLine(this.#brain),
        });
        if (!item) {
          await this.#api.sendMessage(chatId, "Nothing came out. Try asking for something else.");
          return;
        }
        await this.#sendItem(chatId, item.absolutePath, item.name, item.kind, item.caption);
        return;
      }

      case '/call':
        await this.#startCall(chatId);
        return;

      default:
        await this.#api.sendMessage(chatId, `I don't know ${command}. /help lists what I do.`);
    }
  }

  async #startCall(chatId: number): Promise<void> {
    if (!this.#calls) {
      await this.#api.sendMessage(
        chatId,
        'Calls are off — LiveKit is not configured on the machine I am running on.',
      );
      return;
    }

    try {
      const invite = await this.#calls.invite('you');
      await this.#api.sendMessage(
        chatId,
        [
          "I'm on the line. Tap below and let me see you.",
          '',
          `The link is good for ${invite.expiresInMinutes} minutes.`,
          'If your camera does not come on, open it in Safari or Chrome rather than',
          "Telegram's own browser.",
        ].join('\n'),
        { inline_keyboard: [[{ text: '📞 Call Anna', url: invite.url }]] },
      );
    } catch (error) {
      await this.#api.sendMessage(chatId, `I couldn't set that up: ${String(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  async #ensureAwake(chatId: number): Promise<void> {
    if (this.#companion && this.#chatId === chatId) return;
    await this.#sleep();
    this.#chatId = chatId;

    this.#companion = new Companion({
      brain: this.#brain,
      channel: 'telegram',
      // Nothing streams here. What she sees arrives as a message, and that is
      // deliberately not the same thing as a sense being switched on.
      senses: { hearing: false, sight: false, screen: false },
      sink: {
        // Her voice is generated and discarded: the transcript is what gets
        // sent. Wasteful in tokens, and still the right trade — one session
        // type means one set of behaviours to test and one memory to keep.
        audio: () => undefined,
        transcript: (who, text, final) => {
          if (who === 'anna' && final) void this.#api.sendMessage(chatId, text);
        },
        state: () => undefined,
        mood: () => undefined,
        interrupted: () => undefined,
        show: (item) =>
          void this.#sendItem(chatId, item.absolutePath, item.name, item.kind, item.caption),
        trouble: (message) => console.warn(`telegram: ${message}`),
      },
    });

    await this.#companion.wake();
    this.#armIdle();
  }

  async #sleep(): Promise<void> {
    this.#clearIdle();
    const companion = this.#companion;
    this.#companion = null;
    this.#chatId = null;
    await companion?.sleep();
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

  async #sendItem(
    chatId: number,
    absolutePath: string,
    name: string,
    kind: 'image' | 'clip',
    caption: string,
  ): Promise<void> {
    try {
      const data = await readFile(absolutePath);
      const file = { data, name, mimeType: mimeFor(path.extname(name)) };
      if (kind === 'clip') await this.#api.sendVideo(chatId, file, caption);
      else await this.#api.sendPhoto(chatId, file, caption);
    } catch (error) {
      console.warn(`telegram: could not send ${name}: ${String(error)}`);
    }
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

function appearanceLine(brain: Brain): string {
  const a = brain.profile.appearance;
  const i = brain.profile.identity;
  return `${i.age}-year-old ${i.ethnicity} woman. ${a.height}, ${a.bodyType}. ${a.hairstyle} in ${a.hairColor}. ${a.eyeColor} eyes, ${a.skinTone} skin. Wearing ${a.style}.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
