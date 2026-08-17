/**
 * the local server.
 *
 * One process, run from a clone, on macOS or Windows or anything else with a
 * current Node. It serves the website, holds the Gemini key, and owns the one
 * copy of her memory and her mood.
 *
 * It binds to 127.0.0.1 by default and it should stay that way. Everything the
 * website does — microphone, camera, screen share — needs a secure context,
 * and `localhost` is one; any other host is not, without a certificate. Binding
 * wider does not gain a working phone client, it only gains an open door.
 * Reaching her from a phone is what the LiveKit bridge is for, and that dials
 * out rather than listening.
 */

import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Brain } from '../core/session/brain.ts';
import { Conversation } from '../core/session/conversation.ts';
import { loadConfig, loadDotEnv, migrateProfileDir } from './config.ts';
import { createRequestHandler, missingBuildPage } from './http.ts';
import {
  applyBotToken,
  applyGeminiKey,
  botLink,
  checkBotToken,
  checkGeminiKey,
  maskKey,
  rememberChatId,
} from './setup.ts';
import { knowledgeState, runScan, suggestedFolders } from './knowledge.ts';
import { WebBridge } from './ws.ts';
import type { TelegramView } from '../shared/protocol.ts';
import { TelegramBridge } from '../bridges/telegram/bridge.ts';
import { CallBridge } from '../bridges/livekit/bridge.ts';

export const VERSION = '1.0.0';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export async function main(): Promise<void> {
  loadDotEnv();

  // Before the config is read, because it decides which folder the config will
  // name. Announced rather than silent: somebody who has been talking to her for
  // weeks should be told her folder moved, not left to find out.
  const moved = migrateProfileDir();
  if (moved.to) console.log(`  moved ${moved.from}/ to ${moved.to}/ — the project is now called Hers`);
  else if (moved.error) console.warn(`! could not rename ${moved.from}/: ${moved.error}`);

  // Not `const`: pasting a key into the website re-reads the environment, and
  // everything downstream has to be looking at the new one rather than the one
  // this process happened to start with.
  let config = loadConfig();
  const brain = await Brain.open(config);

  for (const warning of config.warnings) console.warn(`! ${warning}`);

  // Declared before the handler so the routes can reach them: an upload has to
  // announce itself to whoever is connected, and a reset has to end every
  // conversation on every transport before the memory under them is deleted.
  // The closures only run once a request arrives, long after these are set.
  const conversation = new Conversation({ brain });
  let web: WebBridge;
  let telegram: TelegramBridge | null = null;
  let calls: CallBridge | null = null;

  const server = createServer(
    createRequestHandler({
      webRoot: path.join(repoRoot, 'dist', 'web'),
      gallery: () => brain.gallery,
      avatar: () => brain.avatar,
      onAvatarChanged: () => web.announceAvatar(),
      onMissingBuild: missingBuildPage,
      status: () => ({
        version: VERSION,
        model: config.model,
        configured: Boolean(config.geminiApiKey),
        keyHint: maskKey(config.geminiApiKey),
        telegram: Boolean(config.telegram),
        livekit: Boolean(config.livekit),
        hedra: Boolean(config.hedra),
        profileDir: config.profileDir,
        warnings: config.warnings,
      }),

      /**
       * A key pasted into the website.
       *
       * Checked against Google before anything is written, so a typo is a
       * message on the page rather than a conversation that fails to start an
       * hour later. The conversation in progress is ended rather than kept: it
       * was built without a key, which means without a live session, and a
       * fresh one is what the key was for.
       */
      setKey: async (key) => {
        const check = await checkGeminiKey(key);
        if (!check.ok) return { ok: false, ...(check.reason ? { error: check.reason } : {}) };
        try {
          await web.endSession();
          config = await applyGeminiKey(brain, key);
          web.refresh();
          console.log(`  key updated — ${maskKey(config.geminiApiKey)}`);
          return { ok: true, keyHint: maskKey(config.geminiApiKey) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      /**
       * A bot token pasted into the website.
       *
       * Checked with `getMe` before anything is written, for the same reason the
       * Gemini key is: a wrong token should be a sentence on the page, not a bot
       * that never answers. The bridge is then brought up on it without a
       * restart, and the reply carries the link the user has to open — because
       * this is the one setup step that cannot be finished from a desk. Nothing
       * in the Bot API tells a bot which chat belongs to its owner, so a human
       * has to speak to it first.
       */
      setBotToken: async (token) => {
        const check = await checkBotToken(token);
        if (!check.ok) return { ok: false, ...(check.reason ? { error: check.reason } : {}) };
        try {
          config = await applyBotToken(token);
          botUsername = check.username ?? '';
          startTelegram();

  // A token that was already in `.env` has a username the page will want, and
  // `getMe` is the only way to learn it. Off the critical path and forgiving: a
  // failure here costs the link, not the bot.
  if (config.telegram) {
    void checkBotToken(config.telegram.token).then((check) => {
      if (!check.ok || !check.username) return;
      botUsername = check.username;
      web.announceTelegram(telegramView());
    });
  }
          web.refresh();
          web.announceTelegram(telegramView());
          console.log(`  telegram  on, as @${botUsername || 'the bot'}`);
          return {
            ok: true,
            ...(botUsername ? { username: botUsername, link: botLink(botUsername) } : {}),
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },

      /** What she has been allowed to read, and where it makes sense to offer. */
      knowledge: async () => ({
        ...(await knowledgeState(brain)),
        suggested: suggestedFolders(os.homedir()),
        platform: process.platform,
      }),

      /**
       * Permission, then the scan it authorises.
       *
       * The conversation is told afterwards rather than restarted: a session's
       * memories are fixed when it wakes, so what she has just learned reaches
       * her the next time she does. Saying so in the reply is more honest than
       * silently doing nothing until a reconnect.
       */
      scan: async (folders) => {
        const outcome = await runScan(brain, folders);
        web.refresh();
        console.log(
          `  knowledge scan — ${outcome.seen} files seen, ${outcome.read} read, ` +
            `${outcome.refused} refused, ${outcome.learned} facts kept`,
        );
        return outcome;
      },

      /**
       * Everything she has, deleted.
       *
       * Every conversation is closed first, on every transport. Telegram and a
       * phone call each hold their own companion, and one still running would
       * be writing turns into a database that no longer exists — and would
       * answer the next message as the person who had just been forgotten.
       */
      reset: async () => {
        try {
          await telegram?.forgetSessions();
          // `hangUp`, not `close`: closing releases the LiveKit runtime for
          // good, and phone calls should still work after a reset.
          await calls?.hangUp();
          await web.endSession();
          await brain.wipe();
          web.refresh();
          console.log('  reset — she does not know anyone now');
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
  );

  web = new WebBridge({
    brain,
    conversation,
    server,
    version: VERSION,
    allowedOrigins: allowedOrigins(config.host, config.port),
    telegram: () => telegramView(),
  });

  calls = config.livekit ? new CallBridge({ brain, livekit: config.livekit }) : null;

  /**
   * Brings the bot up, or back up on a new token, without a restart.
   *
   * Exactly one bridge exists at a time and the old one is stopped first, which
   * is not tidiness: the Bot API hands `getUpdates` to the newest caller and
   * terminates the other, so two bridges on one token is two halves of a
   * conversation.
   *
   * The chat id arrives here rather than being polled for, because the bridge
   * owns the only `getUpdates` loop and nothing in the Bot API reveals a chat id
   * any other way. Persisting it is what turns "pinned for this run, here is the
   * line to paste" into setup that finished.
   */
  // Learned from `getMe` the first time a token is seen, so the page can show the
  // link without another round trip. Empty until then, which the view handles.
  let botUsername = '';

  const startTelegram = (): void => {
    telegram?.stop();
    telegram = null;
    if (!config.telegram) return;

    telegram = new TelegramBridge({
      brain,
      conversation,
      token: config.telegram.token,
      allowedChatIds: config.telegram.allowedChatIds,
      calls,
      onChatPinned: (chatId) => {
        void (async () => {
          try {
            config = await rememberChatId(chatId);
            web.announceTelegram(telegramView());
          } catch (error) {
            console.warn(`! could not write the chat id down: ${String(error)}`);
          }
        })();
      },
    });
    telegram.start();
  };

  /** What the browser is told about the bot. Never the token. */
  const telegramView = (): TelegramView => ({
    configured: Boolean(config.telegram),
    ...(botUsername ? { username: botUsername, link: botLink(botUsername) } : {}),
    ...(config.telegram?.allowedChatIds[0] !== undefined
      ? { chatId: config.telegram.allowedChatIds[0] }
      : {}),
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      // The common one, and the one whose default message tells you nothing
      // about what to do: another copy is usually already running.
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Something is already using port ${config.port}. Another copy of Hers, probably — stop it, or set HERS_PORT to something else.`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(config.port, config.host, resolve);
  });

  console.log(`\n  Hers is at http://${displayHost(config.host)}:${config.port}\n`);
  console.log(`  profile   ${config.profileDir}`);
  console.log(`  memory    ${path.join(config.dataDir, 'memory.db')}`);
  console.log(`  model     ${config.model}`);
  console.log(`  avatar    ${config.hedra ? `on, budget $${config.hedra.budgetUsd.toFixed(2)}` : 'still only (no HEDRA_API_KEY)'}`);
  console.log(`  telegram  ${config.telegram ? 'on' : 'off'}`);
  console.log(`  calls     ${config.livekit ? 'on' : 'off'}\n`);

  startTelegram();

  // A token that was already in `.env` has a username the page will want, and
  // `getMe` is the only way to learn it. Off the critical path and forgiving: a
  // failure here costs the link, not the bot.
  if (config.telegram) {
    void checkBotToken(config.telegram.token).then((check) => {
      if (!check.ok || !check.username) return;
      botUsername = check.username;
      web.announceTelegram(telegramView());
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} — closing.`);
    telegram?.stop();
    await calls?.close();
    await web.close();
    await brain.close();
    server.close();
    // Anything still holding the loop open (a socket mid-close, a pending
    // write) gets a moment, and then this exits regardless.
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * The origins the WebSocket handshake will accept.
 *
 * `localhost` and `127.0.0.1` are different origins to a browser and people
 * type both, so both are listed whichever one the server was told to bind.
 */
function allowedOrigins(host: string, port: number): Set<string> {
  const hosts = new Set([host, 'localhost', '127.0.0.1', '[::1]']);
  const origins = new Set<string>();
  for (const name of hosts) {
    if (!name || name === '0.0.0.0' || name === '::') continue;
    origins.add(`http://${name}:${port}`);
    origins.add(`https://${name}:${port}`);
  }
  return origins;
}

function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server/index.ts')) {
  main().catch((error: unknown) => {
    console.error('Hers could not start:', error);
    process.exit(1);
  });
}
