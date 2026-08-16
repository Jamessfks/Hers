/**
 * The thin slice of the Telegram Bot API that Anna uses.
 *
 * Written against `fetch` rather than a client library, because the surface
 * needed here is eight methods and a long-poll loop, and every Telegram client
 * on npm is a framework with a plugin system attached.
 *
 * The only subtle part is uploading. Telegram takes multipart for files, which
 * modern Node gives for free: a `FormData` containing a `Blob` is sent as
 * multipart by `fetch` with the boundary handled for you. No dependency, no
 * hand-rolled boundary, no chance of getting the CRLFs wrong.
 */

const API = 'https://api.telegram.org';

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}

export interface TelegramPhotoSize extends TelegramFile {
  width: number;
  height: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; username?: string; first_name?: string };
  from?: { id: number; is_bot: boolean; username?: string; first_name?: string };
  text?: string;
  caption?: string;
  voice?: TelegramFile & { duration: number; mime_type?: string };
  audio?: TelegramFile & { duration: number; mime_type?: string };
  video_note?: TelegramFile & { duration: number; length: number };
  video?: TelegramFile & { duration: number; mime_type?: string };
  photo?: TelegramPhotoSize[];
  document?: TelegramFile & { mime_type?: string; file_name?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
}

/** Telegram will not serve a file larger than this through `getFile`. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class TelegramApi {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  /**
   * Long-polls for updates.
   *
   * `timeout` is Telegram's, in seconds, and the request genuinely hangs for
   * that long — so the local `AbortSignal` is set comfortably above it. An
   * abort budget below Telegram's own would cancel every single poll just
   * before it was going to answer.
   */
  async getUpdates(offset: number, timeoutSeconds = 50): Promise<TelegramUpdate[]> {
    const result = await this.#call<TelegramUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message'],
      },
      (timeoutSeconds + 15) * 1000,
    );
    return result ?? [];
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: InlineKeyboard,
  ): Promise<TelegramMessage | null> {
    return this.#call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      // Telegram rejects anything longer, and truncating beats a silent failure.
      text: text.slice(0, 4096),
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async sendChatAction(chatId: number, action: 'typing' | 'upload_photo'): Promise<void> {
    await this.#call('sendChatAction', { chat_id: chatId, action });
  }

  async sendPhoto(chatId: number, file: UploadFile, caption?: string): Promise<void> {
    await this.#upload('sendPhoto', 'photo', chatId, file, caption);
  }

  async sendVideo(chatId: number, file: UploadFile, caption?: string): Promise<void> {
    await this.#upload('sendVideo', 'video', chatId, file, caption);
  }

  /** Resolves a `file_id` and downloads the bytes. Null if it is too big or gone. */
  async download(fileId: string): Promise<Buffer | null> {
    const file = await this.#call<{ file_path?: string; file_size?: number }>('getFile', {
      file_id: fileId,
    });
    if (!file?.file_path) return null;
    if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) return null;

    try {
      const response = await fetch(`${API}/file/bot${this.#token}/${file.file_path}`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------

  async #call<T>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<T | null> {
    try {
      const response = await fetch(`${API}/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = (await response.json()) as { ok: boolean; result?: T; description?: string };
      if (!payload.ok) {
        // Telegram's own errors are descriptive and worth seeing once, but they
        // are not worth taking a bot down for.
        console.warn(`telegram ${method}: ${payload.description ?? response.status}`);
        return null;
      }
      return payload.result ?? null;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TimeoutError') {
        console.warn(`telegram ${method}: ${String(error)}`);
      }
      return null;
    }
  }

  async #upload(
    method: string,
    field: string,
    chatId: number,
    file: UploadFile,
    caption?: string,
  ): Promise<void> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption.slice(0, 1024));
    form.set(field, new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.name);

    try {
      const response = await fetch(`${API}/bot${this.#token}/${method}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const payload = (await response.json()) as { ok: boolean; description?: string };
      if (!payload.ok) console.warn(`telegram ${method}: ${payload.description ?? response.status}`);
    } catch (error) {
      console.warn(`telegram ${method}: ${String(error)}`);
    }
  }
}

export interface UploadFile {
  data: Buffer;
  name: string;
  mimeType: string;
}
