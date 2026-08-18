/**
 * `npm run doctor` — the live check the test suite cannot do.
 *
 * Every test in this repository fakes the network, deliberately: a reconnect is
 * not reproducible against a real socket and a suite that needs an API key is a
 * suite nobody runs. The gap that leaves is exactly one question — *is this
 * key, this model and this account actually working right now* — and this is
 * the answer to it.
 *
 * It opens a real Live session, says one thing, waits for audio to come back,
 * and closes. That single round trip exercises the key, the model name, the
 * quota, the voice, the websocket path and the audio pipeline in one go. If it
 * passes, the only things left between here and her talking are the browser's
 * own permissions.
 */

import { Brain } from '../core/session/brain.ts';
import { KNOWN_LIVE_MODELS } from '../core/gemini/models.ts';
import { LiveConversation } from '../core/gemini/live.ts';
import { loadConfig, loadDotEnv } from './config.ts';

const ok = (message: string) => console.log(`  ✓ ${message}`);
const bad = (message: string) => console.log(`  ✗ ${message}`);
const note = (message: string) => console.log(`    ${message}`);

async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  let failures = 0;

  console.log('\nHers — checking\n');

  // -- configuration --------------------------------------------------------

  if (config.geminiApiKey) {
    ok(`Gemini key present (${config.geminiApiKey.length} characters)`);
  } else {
    bad('No Gemini key.');
    note('Get one at https://aistudio.google.com/apikey, then put this in .env:');
    note('GEMINI_API_KEY=…');
    failures += 1;
  }

  if (KNOWN_LIVE_MODELS.includes(config.model)) {
    ok(`Model ${config.model}`);
  } else {
    ok(`Model ${config.model} (not one I know; affective dialog will be left off)`);
  }

  for (const warning of config.warnings) {
    bad(warning);
  }

  // -- the profile and the memory -------------------------------------------

  try {
    const brain = await Brain.open(config, { offline: true });
    ok(`Profile at ${config.profileDir}`);
    note(
      `${brain.profile.identity.name}, ${brain.profile.identity.age}, ${brain.profile.identity.gender}, ` +
        `voice ${brain.profile.voice.voice}, ` +
        `${brain.avatar.face() ? 'has a photograph' : 'no photograph yet'}`,
    );
    ok(`Memory at ${config.dataDir} — ${brain.memory.turnCount()} turns in this conversation`);
    ok(`Gallery has ${(await brain.gallery.list()).length} things in it`);
    ok(`Mood: ${brain.mood.read().label}`);
    await brain.close();
  } catch (error) {
    bad(`Could not open her profile or memory: ${String(error)}`);
    failures += 1;
  }

  // -- the bridges ----------------------------------------------------------

  console.log(config.telegram ? '  ✓ Telegram configured' : '  · Telegram off');
  console.log(config.livekit ? '  ✓ LiveKit configured' : '  · Phone calls off');

  // -- the one thing only a real key can answer -----------------------------

  if (config.geminiApiKey) {
    console.log('\n  Opening a real session…');
    const result = await liveRoundTrip(config.geminiApiKey, config.model);
    if (result.ok) {
      ok(`Gemini answered — ${result.bytes} bytes of audio, ${result.ms}ms to first sound`);
      if (result.said) note(`She said: “${result.said.trim()}”`);
    } else {
      bad(`Gemini did not answer: ${result.reason}`);
      note('A 400 usually means the model name; a 403 means the key; a 429 means quota.');
      failures += 1;
    }
  }

  console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} thing(s) to fix.\n`);
  return failures === 0 ? 0 : 1;
}

interface RoundTrip {
  ok: boolean;
  reason?: string;
  bytes?: number;
  ms?: number;
  said?: string;
}

function liveRoundTrip(apiKey: string, model: string): Promise<RoundTrip> {
  return new Promise((resolve) => {
    let bytes = 0;
    let said = '';
    let firstAudioAt = 0;
    const startedAt = Date.now();

    const finish = (result: RoundTrip) => {
      clearTimeout(deadline);
      void live.close().then(() => resolve(result));
    };

    const deadline = setTimeout(() => {
      finish(
        bytes > 0
          ? { ok: true, bytes, ms: firstAudioAt - startedAt, said }
          : { ok: false, reason: 'no audio within 25 seconds' },
      );
    }, 25_000);

    const live = new LiveConversation({
      apiKey,
      model,
      voice: 'Aoede',
      systemInstruction: () =>
        'You are being tested by a setup script. Reply with exactly: "I can hear you." Nothing else.',
      handlers: {
        onAudio: (pcm) => {
          if (bytes === 0) firstAudioAt = Date.now();
          bytes += pcm.length;
        },
        onUserText: () => undefined,
        onHerText: (text, final) => {
          if (final) said = text;
        },
        onTurnComplete: () => {
          if (bytes > 0) finish({ ok: true, bytes, ms: firstAudioAt - startedAt, said });
        },
        onInterrupted: () => undefined,
        onToolCall: async () => ({}),
        onState: (state) => {
          // The first reconnect during a check means the setup was rejected;
          // waiting out the backoff would only produce the same rejection.
          if (state === 'reconnecting') finish({ ok: false, reason: 'the session was refused' });
        },
        onTrouble: () => undefined,
      },
    });

    void live
      .start()
      .then(() => live.sendText('Say the test line.'))
      .catch((error: unknown) => finish({ ok: false, reason: String(error) }));
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
