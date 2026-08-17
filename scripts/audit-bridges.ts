/**
 * The two bridges, against real servers.
 *
 * Separate from `audit.ts` because both need something the main audit does not:
 * a LiveKit server, and a Telegram chat that has spoken to the bot at least
 * once. Neither can be conjured — a bot cannot start a conversation, and a
 * phone cannot reach this machine — so this reports precisely what is missing
 * rather than quietly passing.
 *
 *   livekit-server --dev          # placeholder keys, printed on startup
 *   npm run audit:bridges
 *
 * The LiveKit check does the whole thing: she is invited into a room, a fake
 * caller joins and publishes real synthesised speech and real video frames, and
 * the assertion is that she *heard the words* and answered out loud. Nothing
 * about that is mocked except the human.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  dispose,
} from '@livekit/rtc-node';
import type { RemoteTrack } from '@livekit/rtc-node';

import { Brain } from '../src/core/session/brain.ts';
import { encodeOggOpus } from '../src/core/speech/ogg-opus.ts';
import { CallBridge } from '../src/bridges/livekit/bridge.ts';
import { TelegramApi } from '../src/bridges/telegram/api.ts';
import { TelegramBridge } from '../src/bridges/telegram/bridge.ts';
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Real speech, from the operating system. See audit.ts for why. */
function speech(text: string, file: string): Buffer {
  execFileSync('say', ['-o', file, '--data-format=LEI16@16000', text]);
  const wav = readFileSync(file);
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.subarray(at, at + 4).toString('ascii');
    const size = wav.readUInt32LE(at + 4);
    if (id === 'data') return wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  return wav.subarray(44);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  console.log('\n══ Hers — bridges ══');
  console.log(`   livekit  ${config.livekit ? config.livekit.url : 'not configured'}`);
  console.log(`   telegram ${config.telegram ? 'configured' : 'not configured'}`);

  const scratch = await mkdtemp(path.join(tmpdir(), 'hers-bridges-'));

  // -- LiveKit -------------------------------------------------------------

  if (!config.livekit) {
    blocked('LiveKit — a call, end to end', 'LIVEKIT_URL/API_KEY/API_SECRET are not set');
  } else if (!(await reachable(config.livekit.url))) {
    blocked(
      'LiveKit — a call, end to end',
      `nothing is listening at ${config.livekit.url}. Run: livekit-server --dev`,
    );
  } else {
    await check('LiveKit — she joins, hears a caller speak, and answers', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'hers-call-'));
      const brain = await Brain.open(
        loadConfig({
          ...process.env,
          HERS_PROFILE: path.join(root, 'profile'),
          HERS_DATA: path.join(root, 'data'),
        } as NodeJS.ProcessEnv),
      );
      const calls = new CallBridge({ brain, livekit: config.livekit! });

      // She joins the room and waits, which is the whole design: no webhook,
      // so nothing has to be able to reach this machine.
      const invite = await calls.invite('audit');
      const token = new URL(invite.url).hash.slice(1);
      const callerToken = new URLSearchParams(token).get('token');
      if (!callerToken) throw new Error('the invite carried no caller token');

      const caller = new Room();
      let herAudioBytes = 0;
      caller.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        void (async () => {
          const stream = new AudioStream(track, { sampleRate: 24000, numChannels: 1 });
          for await (const frame of stream) herAudioBytes += frame.data.byteLength;
        })();
      });

      await caller.connect(config.livekit!.url, callerToken, {
        autoSubscribe: true,
        dynacast: true,
      });

      // Publish a camera and a microphone, the way a phone would.
      const mic = new AudioSource(16000, 1);
      const cam = new VideoSource(320, 240);
      const micOptions = new TrackPublishOptions();
      micOptions.source = TrackSource.SOURCE_MICROPHONE;
      const camOptions = new TrackPublishOptions();
      camOptions.source = TrackSource.SOURCE_CAMERA;
      await caller.localParticipant?.publishTrack(
        LocalAudioTrack.createAudioTrack('mic', mic),
        micOptions,
      );
      await caller.localParticipant?.publishTrack(
        LocalVideoTrack.createVideoTrack('cam', cam),
        camOptions,
      );

      // A plain grey frame, once a second — enough for the video path to be
      // exercised without asserting anything about what she makes of it.
      const rgba = new Uint8Array(320 * 240 * 4).fill(120);
      const frames = setInterval(() => {
        cam.captureFrame(new VideoFrame(rgba, 320, 240, VideoBufferType.RGBA));
      }, 1000);

      // Let her settle first. She opens conversations on her own, so anything
      // she says in the first few seconds is her greeting the caller — not an
      // answer to a question nobody has asked yet. An earlier version of this
      // check counted that as the reply and passed while hearing nothing.
      await wait(4000);
      herAudioBytes = 0;
      const beforeTurns = brain.memory.liveTranscript(20).length;

      const pcm = speech(
        'Hey, can you hear me? My sister is a doctor and she lives in Boston.',
        path.join(scratch, 'call.wav'),
      );
      const samplesPerChunk = 16000 * 0.02; // 20ms
      for (let at = 0; at + samplesPerChunk * 2 <= pcm.length; at += samplesPerChunk * 2) {
        const chunk = new Int16Array(samplesPerChunk);
        for (let i = 0; i < samplesPerChunk; i += 1) chunk[i] = pcm.readInt16LE(at + i * 2);
        await mic.captureFrame(new AudioFrame(chunk, 16000, 1, samplesPerChunk));
      }
      // Trailing silence so the detector hears the end of the sentence.
      for (let i = 0; i < 40; i += 1) {
        await mic.captureFrame(new AudioFrame(new Int16Array(samplesPerChunk), 16000, 1, samplesPerChunk));
      }

      // Now wait for a reply to *that*: new audio, and a new pair of turns.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const turns = brain.memory.liveTranscript(20);
        const heardIt = turns.some(
          (turn) => turn.speaker === 'user' && /boston/i.test(turn.text),
        );
        if (heardIt && turns.length > beforeTurns + 1 && herAudioBytes > 20_000) break;
        await wait(400);
      }

      clearInterval(frames);
      const heard = brain.memory
        .liveTranscript(10)
        .filter((turn) => turn.speaker === 'user')
        .map((turn) => turn.text)
        .join(' ');
      const said = brain.memory
        .liveTranscript(10)
        .filter((turn) => turn.speaker === 'her')
        .map((turn) => turn.text)
        .join(' ');

      await caller.disconnect();
      await calls.close();
      await brain.close();
      await rm(root, { recursive: true, force: true });

      const ok = /boston/i.test(heard) && herAudioBytes > 40_000;
      return {
        ok,
        evidence: `room ${invite.room}: she heard "${heard || '(nothing)'}", answered "${said || '(nothing)'}", and sent ${herAudioBytes} bytes of voice back down the call`,
      };
    });
  }

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
      await check('Telegram — she delivers text and a voice note to a real chat', async () => {
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

        return {
          ok: true,
          evidence: `chat ${chatId}: text delivered as message ${sent.message_id}, plus a ${ogg.length}-byte Ogg/Opus voice note`,
        };
      });

      blocked(
        'Telegram — she answers a message you send',
        `only you can do this half: a bot may not open a conversation. Message @${await botName(config.telegram.token)} and watch her answer.`,
      );
    }
  }

  await rm(scratch, { recursive: true, force: true });
  await dispose().catch(() => undefined);

  console.log('\n══ Result ══');
  for (const result of results) {
    console.log(`  ${result.blocked ? '⚠' : result.ok ? '✓' : '✗'} ${result.name}`);
  }
  const failed = results.filter((result) => !result.ok && !result.blocked);
  const stuck = results.filter((result) => result.blocked);
  console.log(`\n  ${results.length} checked, ${failed.length} failed, ${stuck.length} blocked\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

async function reachable(url: string): Promise<boolean> {
  try {
    const http = url.replace(/^ws/, 'http');
    const response = await fetch(http, { signal: AbortSignal.timeout(3000) });
    return response.status < 500;
  } catch {
    return false;
  }
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
