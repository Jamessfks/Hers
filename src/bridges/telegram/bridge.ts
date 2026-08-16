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

import { encodeOggOpus, pcmSeconds } from '../../core/speech/ogg-opus.ts';
import { transcribeMedia } from '../../core/gemini/text.ts';
import { mimeFor } from '../../core/gallery/gallery.ts';
import { Companion } from '../../core/session/companion.ts';
import type { Brain } from '../../core/session/brain.ts';
import type { CallBridge } from '../livekit/bridge.ts';
import { AvatarError, GESTURE_NAMES, isGesture } from '../../core/avatar/studio.ts';
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
  { command: 'me', description: 'Her actual photo — the one you gave her' },
  { command: 'face', description: 'Send a photo to become her face' },
  { command: 'gestures', description: 'Which movements she has, and what they cost' },
  { command: 'render', description: 'Render a movement — /render nod' },
  { command: 'call', description: 'Ring her, with your camera and voice' },
  { command: 'photo', description: 'Ask her for a picture' },
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
  /**
   * Chats that asked for `/face` and owe us a photo.
   *
   * Without this the bot has to guess what a bare photo means, and the two
   * meanings are far apart: "look at this" and "this is now your face". A
   * photo is only taken as a face when it was asked for, or when its caption
   * says so.
   */
  readonly #awaitingFace = new Set<number>();
  /** Her voice for the turn in progress, kept only until the turn lands. */
  #speech: Buffer[] = [];
  /** True when the last thing they sent was spoken rather than typed. */
  #theySpoke = false;

  constructor(options: TelegramBridgeOptions) {
    this.#brain = options.brain;
    this.#api = options.api ?? new TelegramApi(options.token);
    this.#allowed = new Set(options.allowedChatIds);
    this.#calls = options.calls ?? null;
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

    /*
     * A command can arrive as a photo's caption, and that is the natural way to
     * send `/face` with the picture attached. The Bot API delivers it in
     * `caption_entities` as a `bot_command`; most bot frameworks only look at
     * `text` and miss it entirely, which is why this reads both.
     */
    const text = (message.text ?? '').trim();
    const caption = (message.caption ?? '').trim();
    const command = text.startsWith('/') ? text : caption.startsWith('/') ? caption : '';

    if (command && !message.photo && !message.document) {
      await this.#command(chatId, command);
      return;
    }

    // A photo is her face when it was asked for, or when it says so.
    const wantsFace =
      command.split(/\s+/)[0]?.split('@')[0]?.toLowerCase() === '/face' ||
      this.#awaitingFace.has(chatId);
    if (wantsFace && (message.photo || isImageDocument(message))) {
      await this.#setFace(chatId, message);
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

  /**
   * Adopts a photo as her face.
   *
   * Everything after the download is the studio's job — it validates the bytes
   * rather than the claim, and it is the same path the web upload takes, so
   * there is one set of rules about what a face may be rather than two.
   */
  async #setFace(chatId: number, message: TelegramMessage): Promise<void> {
    this.#awaitingFace.delete(chatId);
    await this.#api.sendChatAction(chatId, 'typing');

    const document = isImageDocument(message) ? message.document : null;
    const photo = message.photo ? largestPhoto(message.photo) : null;
    const fileId = document?.file_id ?? photo?.file_id;
    if (!fileId) {
      await this.#api.sendMessage(chatId, "I couldn't find a picture in that.");
      return;
    }

    const bytes = await this.#api.download(fileId);
    if (!bytes) {
      await this.#api.sendMessage(chatId, 'That file was too big for me to fetch.');
      return;
    }

    const had = this.#brain.avatar.readyGestures();
    try {
      await this.#brain.avatar.setSource(bytes, document?.mime_type ?? 'image/jpeg');
    } catch (error) {
      await this.#api.sendMessage(
        chatId,
        error instanceof AvatarError ? error.message : 'That picture could not be used.',
      );
      return;
    }

    const lines = ["That's me now."];
    if (had.length > 0) {
      // Every clip started from the old photograph, so none of them are of this
      // person any more. Saying so beats them noticing a stranger nodding.
      lines.push(
        `The ${had.length} movement${had.length === 1 ? '' : 's'} I had were of the old picture, so they're gone.`,
      );
    }
    lines.push('', 'Use /render idle to bring this one to life. /gestures lists the rest.');
    await this.#api.sendMessage(chatId, lines.join('\n'));
  }

  async #deliver(chatId: number, message: TelegramMessage, text: string): Promise<void> {
    const companion = this.#companion;
    if (!companion) return;

    // A photo goes in as a picture, because she can actually see it.
    const photo = message.photo ? largestPhoto(message.photo) : null;
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
      // They spoke, so she answers in kind.
      this.#theySpoke = Boolean(message.voice ?? message.video_note);
      companion.say(heard);
      return;
    }

    if (text) {
      this.#theySpoke = false;
      companion.say(text);
    }
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
            '/me       my actual photo, the one you gave me',
            '/face     send a photo to become my face',
            '/gestures which movements I have',
            '/render   render one — /render nod',
            '/call     ring me, with your camera and your voice',
            '/photo    ask me for a picture',
            '/mood     how I am',
            '/bye      end the conversation',
            '/whoami   your chat id',
          ].join('\n'),
        );
        return;

      case '/whoami':
        await this.#api.sendMessage(chatId, `This chat is ${chatId}.`);
        return;

      case '/face': {
        this.#awaitingFace.add(chatId);
        const current = this.#brain.avatar.state();
        await this.#api.sendMessage(
          chatId,
          [
            current.hasSource
              ? 'Send me a photo and it replaces my face.'
              : 'Send me a photo and it becomes my face.',
            '',
            'JPEG, PNG or WebP. At least 256 pixels on the short side, at most 12 MB.',
            'Send it as a file rather than a photo if you want the full resolution.',
            current.ready.length > 0
              ? `Heads up: my ${current.ready.length} rendered movement(s) start from the current picture, so a new one clears them.`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return;
      }

      case '/gestures': {
        const state = this.#brain.avatar.state();
        if (!state.hasSource) {
          await this.#api.sendMessage(chatId, 'Give me a face first — /face.');
          return;
        }
        const lines = state.all.map((gesture) => {
          const mark = state.ready.includes(gesture)
            ? '●'
            : state.rendering.includes(gesture)
              ? '…'
              : '○';
          return `${mark} ${gesture.replace('_', ' ')}`;
        });
        await this.#api.sendMessage(
          chatId,
          [
            '● rendered   ○ not yet   … rendering',
            '',
            ...lines,
            '',
            state.configured
              ? `$${state.spentUsd.toFixed(2)} of $${state.budgetUsd.toFixed(2)} spent. /render idle`
              : 'No Hedra key on the machine I run on, so nothing can be rendered.',
          ].join('\n'),
        );
        return;
      }

      case '/render': {
        const wanted = argument.toLowerCase().replace(/[\s-]+/g, '_');
        if (!isGesture(wanted)) {
          await this.#api.sendMessage(
            chatId,
            `Which one? ${GESTURE_NAMES.join(', ')}. For example: /render idle`,
          );
          return;
        }
        if (this.#brain.avatar.has(wanted)) {
          await this.#api.sendMessage(chatId, `I already have ${wanted.replace('_', ' ')}.`);
          return;
        }
        await this.#api.sendMessage(
          chatId,
          `Rendering ${wanted.replace('_', ' ')}. Takes a few minutes — I'll say when it lands.`,
        );
        // Not awaited: a render is minutes long and the bot has to stay
        // responsive, including for the message that says it failed.
        void this.#brain.avatar
          .render(wanted)
          .then(() =>
            this.#api.sendMessage(chatId, `Done — I can ${wanted.replace('_', ' ')} now.`),
          )
          .catch((error: unknown) =>
            this.#api.sendMessage(
              chatId,
              error instanceof AvatarError ? error.message : `That render failed: ${String(error)}`,
            ),
          );
        return;
      }

      case '/mood': {
        const mood = this.#brain.mood.read();
        await this.#api.sendMessage(chatId, `${mood.label}.`);
        return;
      }

      case '/bye':
        await this.#sleep();
        await this.#api.sendMessage(chatId, 'Alright. Talk later.');
        return;

      /*
       * The photograph itself, never a generation.
       *
       * `/photo` may generate — that is what it is for. This one is the
       * opposite promise: it is exactly the picture you uploaded, every time,
       * with nothing in between. Asking "can I see you?" and getting a redraw
       * of someone similar is the complaint this command exists to answer.
       */
      case '/me':
      case '/selfie': {
        const face = this.#brain.gallery.face();
        if (!face) {
          await this.#api.sendMessage(chatId, "You haven't given me a face yet — /face.");
          return;
        }
        await this.#api.sendChatAction(chatId, 'upload_photo');
        await this.#sendItem(chatId, face.absolutePath, face.name, face.kind, '');
        return;
      }

      case '/photo': {
        await this.#api.sendChatAction(chatId, 'upload_photo');
        const item = await this.#brain.gallery.pick(argument || 'a picture of you right now', {
          allowNew: true,
          apiKey: this.#brain.config.geminiApiKey,
        });
        if (!item) {
          await this.#api.sendMessage(chatId, "Nothing came out. Try asking for something else.");
          return;
        }
        await this.#sendItem(chatId, item.absolutePath, item.name, item.kind, item.label);
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
        // Kept for the length of a turn so it can be sent as a voice note.
        audio: (pcm) => {
          if (this.#speech.length < 400) this.#speech.push(pcm);
        },
        transcript: (who, text, final) => {
          if (who === 'anna' && final) void this.#say(chatId, text);
        },
        state: () => undefined,
        mood: () => undefined,
        interrupted: () => undefined,
        show: (item) =>
          void this.#sendItem(chatId, item.absolutePath, item.name, item.kind, item.label),
        // Gesture clips are for the web interface. Sending a two-second silent
        // video after every other message would be noise, not presence.
        move: () => undefined,
        trouble: (message) => console.warn(`telegram: ${message}`),
      },
    });

    await this.#companion.wake();
    this.#armIdle();
  }

  /**
   * Sends a finished line, in her voice or in text.
   *
   * She answers in kind: a voice note back to a voice note is what a person
   * does, and it is the rule that needs no threshold. Beyond that she speaks
   * occasionally rather than always — a companion who only ever sends audio is
   * one you cannot read on a train.
   *
   * The text goes either way. A voice note nobody can play is a dead end, and
   * the transcript costs nothing.
   */
  async #say(chatId: number, text: string): Promise<void> {
    const pcm = Buffer.concat(this.#speech);
    this.#speech = [];

    const worthSpeaking =
      pcm.length > 0 &&
      // Long answers are tedious to listen to and easy to read.
      text.length <= 320 &&
      (this.#theySpoke || Math.random() < 0.25);

    if (!worthSpeaking) {
      await this.#api.sendMessage(chatId, text);
      return;
    }

    const ogg = encodeOggOpus(pcm);
    if (!ogg) {
      await this.#api.sendMessage(chatId, text);
      return;
    }

    await this.#api.sendVoice(
      chatId,
      { data: ogg, name: 'anna.ogg', mimeType: 'audio/ogg' },
      pcmSeconds(pcm),
    );
    await this.#api.sendMessage(chatId, text);
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
      // An empty caption is no caption: a picture she generated has nothing a
      // person wrote to put under it, and the file name is not a substitute.
      const label = caption.trim() || undefined;
      if (kind === 'clip') await this.#api.sendVideo(chatId, file, label);
      else await this.#api.sendPhoto(chatId, file, label);
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

/** True for a picture sent as a file rather than compressed into a photo. */
function isImageDocument(message: TelegramMessage): boolean {
  return Boolean(message.document?.mime_type?.startsWith('image/'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
