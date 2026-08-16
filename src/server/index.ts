/**
 * Anna's server.
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Brain } from '../core/session/brain.ts';
import { loadConfig, loadDotEnv } from './config.ts';
import { createRequestHandler, missingBuildPage } from './http.ts';
import { WebBridge } from './ws.ts';
import { TelegramBridge } from '../bridges/telegram/bridge.ts';
import { CallBridge } from '../bridges/livekit/bridge.ts';

export const VERSION = '2.0.0';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const brain = await Brain.open(config);

  for (const warning of config.warnings) console.warn(`! ${warning}`);

  // Declared before the handler so the upload route can announce a change to
  // whoever is connected. The closure only runs once a request arrives, long
  // after this is assigned.
  let web: WebBridge;

  const server = createServer(
    createRequestHandler({
      webRoot: path.join(repoRoot, 'dist', 'web'),
      gallery: brain.gallery,
      avatar: brain.avatar,
      onAvatarChanged: () => web.announceAvatar(),
      onMissingBuild: missingBuildPage,
      status: () => ({
        version: VERSION,
        model: config.model,
        configured: Boolean(config.geminiApiKey),
        telegram: Boolean(config.telegram),
        livekit: Boolean(config.livekit),
        hedra: Boolean(config.hedra),
        profileDir: config.profileDir,
        warnings: config.warnings,
      }),
    }),
  );

  web = new WebBridge({
    brain,
    server,
    version: VERSION,
    allowedOrigins: allowedOrigins(config.host, config.port),
  });

  const calls = config.livekit ? new CallBridge({ brain, livekit: config.livekit }) : null;
  const telegram = config.telegram
    ? new TelegramBridge({
        brain,
        token: config.telegram.token,
        allowedChatIds: config.telegram.allowedChatIds,
        calls,
      })
    : null;

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      // The common one, and the one whose default message tells you nothing
      // about what to do: another Anna is usually already running.
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Something is already using port ${config.port}. Another Anna, probably — stop it, or set ANNA_PORT to something else.`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(config.port, config.host, resolve);
  });

  console.log(`\n  Anna is at http://${displayHost(config.host)}:${config.port}\n`);
  console.log(`  profile   ${config.profileDir}`);
  console.log(`  memory    ${path.join(config.dataDir, 'memory.db')}`);
  console.log(`  model     ${config.model}`);
  console.log(`  avatar    ${config.hedra ? `on, budget $${config.hedra.budgetUsd.toFixed(2)}` : 'still only (no HEDRA_API_KEY)'}`);
  console.log(`  telegram  ${telegram ? 'on' : 'off'}`);
  console.log(`  calls     ${calls ? 'on' : 'off'}\n`);

  telegram?.start();

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
    console.error('Anna could not start:', error);
    process.exit(1);
  });
}
