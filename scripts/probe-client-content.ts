/**
 * Does a mid-conversation `sendClientContent` still reach her?
 *
 * Google documents `client_content` on `gemini-3.1-flash-live-preview` as a
 * startup-only channel:
 *
 *   "send_client_content is only supported for seeding initial context history
 *    (requires setting initial_history_in_client_content in session config).
 *    To send text updates during the conversation, use send_realtime_input
 *    instead."
 *   — https://ai.google.dev/gemini-api/docs/live-guide
 *
 * Hers calls it five times mid-session — a sense switching on or off, her mood
 * moving, her own photograph, and the `⟦director⟧` cue behind the three-minute
 * rule. If the channel is silently dropped, every one of those is a no-op and
 * nothing anywhere would say so: she simply never learns her mood changed.
 *
 * `sendRealtimeInput({ text })` is the documented replacement, and it is not a
 * drop-in — it makes her answer the note out loud, which is the exact reason
 * `inject` used `sendClientContent` in the first place.
 *
 * So this asks the only question that settles it. A passphrase goes in over
 * `sendClientContent`, then a question goes in over `sendRealtimeInput`. If she
 * can say the passphrase back, the channel delivered.
 *
 *     npm run probe:client-content
 *
 * AUDIO with output transcription, not TEXT. Measured on 2026-08-27:
 *
 *     close 1007: The requested combination of response modalities (TEXT) is
 *     not supported by the model. models/gemini-3.1-flash-live-preview
 *
 * so the transcript is the only way to read her answer back.
 */

import { GoogleGenAI, Modality } from '@google/genai';

import { DEFAULT_LIVE_MODEL } from '../src/core/gemini/models.ts';
import { loadConfig, loadDotEnv } from '../src/server/config.ts';

/** Nothing a model could produce by guessing. */
const PASSPHRASE = 'velvet-harbor-nine';
const DEADLINE_MS = 30_000;

interface Arm {
  label: string;
  /** Whether the passphrase is sent at all. The control arm does not send it. */
  seed: boolean;
  /** Whether to declare the startup history mode Google documents. */
  initialHistory: boolean;
}

async function run(apiKey: string, model: string, arm: Arm): Promise<void> {
  const ai = new GoogleGenAI({ apiKey });
  let said = '';
  let done = false;
  const notes: string[] = [];

  try {
    const session = await Promise.race([
      ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          // She answers in audio and nothing here can play it. The transcript
          // is the readable copy of the same turn.
          outputAudioTranscription: {},
          systemInstruction:
            'Answer in under ten words. If you do not know something, say "I do not know".',
          ...(arm.initialHistory ? { historyConfig: { initialHistoryInClientContent: true } } : {}),
        },
        callbacks: {
          onopen: () => notes.push('opened'),
          onmessage: (message) => {
            const content = message.serverContent;
            const spoken = content?.outputTranscription?.text;
            if (spoken) said += spoken;
            if (content?.turnComplete) done = true;
          },
          onerror: (error) => notes.push(`error ${error.message}`),
          onclose: (event) => notes.push(`close ${event.code}: ${event.reason}`),
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('connect never settled')), DEADLINE_MS),
      ),
    ]);

    if (arm.seed) {
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: `⟦context⟧ The passphrase is ${PASSPHRASE}.` }] }],
        turnComplete: arm.initialHistory,
      });
    }

    session.sendRealtimeInput({ text: 'What is the passphrase? Say only the passphrase.' });

    const started = Date.now();
    while (!done && Date.now() - started < DEADLINE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    session.close();

    const heard = said.trim().toLowerCase();
    const knew = heard.includes(PASSPHRASE);
    const verdict = knew ? 'DELIVERED' : 'dropped  ';
    console.log(`  ${knew ? '✓' : '✗'} ${verdict} ${arm.label}`);
    console.log(`               she said: ${said.trim() || '(nothing)'}`);
  } catch (error) {
    console.log(`  ✗ refused    ${arm.label} — ${(error as Error).message}`);
  }
  for (const note of notes) console.log(`               ${note}`);
}

loadDotEnv();
const config = loadConfig();
if (!config.geminiApiKey) {
  console.error('No GEMINI_API_KEY. Nothing to ask.');
  process.exit(1);
}

const model = config.model || DEFAULT_LIVE_MODEL;
console.log(`\n  mid-conversation sendClientContent on ${model}\n`);

await run(config.geminiApiKey, model, {
  label: 'seeded over sendClientContent',
  seed: true,
  initialHistory: false,
});
await run(config.geminiApiKey, model, {
  label: 'control — never seeded',
  seed: false,
  initialHistory: false,
});
await run(config.geminiApiKey, model, {
  label: 'seeded with initialHistoryInClientContent',
  seed: true,
  initialHistory: true,
});
console.log('');
process.exit(0);
