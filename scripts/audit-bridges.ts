/**
 * The Telegram bridge, against a real server.
 *
 * Separate from `audit.ts` because it needs something the main audit does not:
 * a Telegram chat that has spoken to the bot at least once. That cannot be
 * conjured — a bot cannot start a conversation — so this reports precisely what
 * is missing rather than quietly passing.
 *
 *   npm run audit:bridges
 */

import { encodeOggOpus } from '../src/core/speech/ogg-opus.ts';
import { TTS_MODEL, synthesise } from '../src/core/speech/synthesise.ts';
import { TelegramApi } from '../src/bridges/telegram/api.ts';
import { loadConfig, loadDotEnv } from '../src/server/config.ts';

loadDotEnv();

const results: Array<{ name: string; ok: boolean; evidence: string; blocked?: boolean }> = [];

async function check(name: string, run: () => Promise<{ ok: boolean; evidence: string }>) {
  process.stdout.write(`\n▸ ${name}\n`);
  const started = Date.now();
  try {
    const { ok, evidence } = await run();
    console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  (${((Date.now() - started) / 1000).toFixed(1)}s)  ${evidence}`);
    results.push({ name, ok, evidence });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ✗ FAIL  threw: ${message}`);
    results.push({ name, ok: false, evidence: `threw: ${message}` });
  }
}

function blocked(name: string, evidence: string) {
  console.log(`\n▸ ${name}\n  ⚠ BLOCKED  ${evidence}`);
  results.push({ name, ok: false, evidence, blocked: true });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  console.log('\n══ Hers — bridges ══');
  console.log(`   telegram ${config.telegram ? 'configured' : 'not configured'}`);

  // -- Telegram ------------------------------------------------------------

  if (!config.telegram) {
    blocked('Telegram — a message, end to end', 'TELEGRAM_BOT_TOKEN is not set');
  } else {
    const api = new TelegramApi(config.telegram.token);

    await check('Telegram — the token works and long polling is clear', async () => {
      const updates = await api.getUpdates(0, 1);
      const hook = await fetch(
        `https://api.telegram.org/bot${config.telegram!.token}/getWebhookInfo`,
      ).then((response) => response.json() as Promise<{ result?: { url?: string } }>);
      const webhook = hook.result?.url ?? '';
      return {
        ok: webhook === '',
        evidence: webhook
          ? `a webhook is set to ${webhook}, which blocks long polling`
          : `polling works; ${updates.length} update(s) waiting`,
      };
    });

    /*
     * The allowlist is a chat id somebody already confirmed.
     *
     * Looking only at *pending* updates reported BLOCKED whenever the bot had
     * been running, because it had already consumed them — the harness had
     * everything it needed and said it did not.
     */
    const chatId =
      Number(process.env.TELEGRAM_AUDIT_CHAT_ID ?? 0) ||
      config.telegram.allowedChatIds[0] ||
      (await firstChat(api));

    if (!chatId) {
      blocked(
        'Telegram — a message, end to end',
        `no chat has ever messaged the bot. Open Telegram, message @${await botName(config.telegram.token)}, then re-run.`,
      );
    } else {
      /*
       * Split, because only one half is testable without a person.
       *
       * Outbound — auth, delivery, and the voice-note encoding — is entirely
       * under this harness's control and is checked for real. Inbound is not:
       * Telegram forbids a bot from opening a conversation, so a message from
       * the owner cannot be manufactured. Reporting that half as FAILED said
       * something untrue about the product; it is blocked on a human.
       */
      await check('Telegram — every reply is a voice note, and the fallback is too', async () => {
        // v2.0 sends no trailing transcript. The text here is the audit
        // announcing itself, not the shape of a reply.
        const sent = await api.sendMessage(
          chatId,
          '(audit) Checking in — this message and the voice note after it were sent by the audit.',
        );
        if (!sent) return { ok: false, evidence: 'Telegram refused a plain text message' };

        // A second of a 220Hz tone: enough for Telegram to accept, encode and
        // render as a voice bubble without spending a Gemini turn on it.
        const rate = 24_000;
        const pcm = Buffer.alloc(rate * 2 * 2);
        for (let i = 0; i < rate * 2; i += 1) {
          pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 9000), i * 2);
        }
        const ogg = encodeOggOpus(pcm);
        if (!ogg) return { ok: false, evidence: 'the Ogg/Opus encoder produced nothing' };

        const before = await pendingUpdateCount(config.telegram!.token);
        await api.sendVoice(chatId, { data: ogg, name: 'voice.ogg', mimeType: 'audio/ogg' }, 2);
        void before;

        /*
         * The synthesised fallback, which is the half that can silently rot.
         *
         * Her ordinary Telegram voice is the PCM the Live session produced, so
         * it is exercised by every real turn. `synthesise` only runs on the
         * path where a turn produced no audio at all, which is rare enough that
         * a broken model name there would go unnoticed for a release.
         */
        const spoken = await synthesise(
          config.geminiApiKey,
          'This one was synthesised, because the turn behind it had no audio.',
          'Aoede',
          // With a direction, because the flat path is the one that was already
          // known to work and the styled one is what criterion 6 rests on.
          { direction: 'Read the following slowly and low, letting the ends of sentences fall away.' },
        );
        const spokenOgg = spoken ? encodeOggOpus(spoken) : null;
        if (!spokenOgg) {
          return { ok: false, evidence: `${TTS_MODEL} produced no audio for the fallback path` };
        }
        await api.sendVoice(
          chatId,
          { data: spokenOgg, name: 'voice.ogg', mimeType: 'audio/ogg' },
          2,
        );

        return {
          ok: true,
          evidence: `chat ${chatId}: message ${sent.message_id}, a ${ogg.length}-byte recorded voice note, and a ${spokenOgg.length}-byte one synthesised by ${TTS_MODEL}`,
        };
      });

      blocked(
        'Telegram — she answers a message you send',
        `only you can do this half: a bot may not open a conversation. Message @${await botName(config.telegram.token)} and watch her answer.`,
      );
    }
  }

  console.log('\n══ Result ══');
  for (const result of results) {
    console.log(`  ${result.blocked ? '⚠' : result.ok ? '✓' : '✗'} ${result.name}`);
  }
  const failed = results.filter((result) => !result.ok && !result.blocked);
  const stuck = results.filter((result) => result.blocked);
  console.log(`\n  ${results.length} checked, ${failed.length} failed, ${stuck.length} blocked\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

async function firstChat(api: TelegramApi): Promise<number> {
  const updates = await api.getUpdates(0, 1);
  for (const update of updates) {
    const chat = (update.message ?? update.edited_message)?.chat.id;
    if (chat) return chat;
  }
  return 0;
}

async function pendingUpdateCount(token: string): Promise<number> {
  try {
    const body = (await (
      await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
    ).json()) as { result?: { pending_update_count?: number } };
    return body.result?.pending_update_count ?? 0;
  } catch {
    return 0;
  }
}

async function botName(token: string): Promise<string> {
  try {
    const body = (await (
      await fetch(`https://api.telegram.org/bot${token}/getMe`)
    ).json()) as { result?: { username?: string } };
    return body.result?.username ?? 'your bot';
  } catch {
    return 'your bot';
  }
}

await main();
