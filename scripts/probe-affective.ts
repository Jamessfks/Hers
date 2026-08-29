/**
 * Can she carry mood in her voice yet?
 *
 * `enableAffectiveDialog` is the one feature this project wants and cannot have.
 * It is documented as unsupported on `gemini-3.1-flash-live-preview`, and
 * "unsupported" here does not mean ignored — the setup is rejected and the socket
 * closes, so `models.ts` has to declare it off and the session strips the field.
 *
 * That is a fact about a preview model, which is to say a fact with a short shelf
 * life. This is the one command that settles it, so nobody has to reason about it
 * from a changelog:
 *
 *     npm run probe:affective
 *
 * Measured on 2026-08-17, with tools attached and without:
 *
 *     opened, then close 1011 "Internal error encountered."
 *
 * If this ever prints SURVIVED for 3.1, flip `affectiveDialog` to true for it in
 * `src/core/gemini/models.ts` and delete nothing else — the session already sends
 * the field whenever the capability says it may.
 *
 * Extended in v2.0.1 to ask the question it was actually for. It only ever
 * opened a session, so it tested whether the setup is accepted rather than the
 * recorded failure, which is "tools plus audio *input* closes the socket". It
 * now speaks a second of real audio and waits for the 1011 to arrive. It also
 * asks 2.5, which is the model that has affective dialogue and is documented as
 * supporting `NON_BLOCKING` function calling — a claim that contradicts this
 * repository's own measurement, and one command settles it.
 */

import { Behavior, GoogleGenAI, Modality } from '@google/genai';

import { DEFAULT_LIVE_MODEL } from '../src/core/gemini/models.ts';
import { hersTools } from '../src/core/gemini/tools.ts';
import { loadConfig, loadDotEnv } from '../src/server/config.ts';

/** The SDK's connect promise does not settle when setup is rejected. */
const DEADLINE_MS = 25_000;

/**
 * A second of near-silence, as 16 kHz signed 16-bit little-endian PCM.
 *
 * The recorded failure is "tools + audio *input*", and the original probe only
 * ever opened a session — so it was testing whether the setup is accepted, not
 * whether speaking to her with tools attached closes the socket. Those are
 * different questions and only the second one is the one that mattered.
 */
function oneSecondOfSpeech(): string {
  const rate = 16_000;
  const pcm = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i += 1) {
    // A quiet 220 Hz tone. Voice activity detection needs something to detect.
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 6000), i * 2);
  }
  return pcm.toString('base64');
}

async function attempt(
  apiKey: string,
  model: string,
  label: string,
  withTools: boolean,
  options: { affective?: boolean; speak?: boolean; nonBlocking?: boolean } = {},
): Promise<void> {
  const ai = new GoogleGenAI({ apiKey });
  const notes: string[] = [];

  try {
    const session = await Promise.race([
      ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: 'Answer in one short sentence.',
          ...(options.affective === false ? {} : { enableAffectiveDialog: true }),
          ...(withTools
            ? {
                tools: [
                  {
                    functionDeclarations: options.nonBlocking
                      ? hersTools().map((tool) => ({ ...tool, behavior: Behavior.NON_BLOCKING }))
                      : hersTools(),
                  },
                ],
              }
            : {}),
        },
        callbacks: {
          onopen: () => notes.push('opened'),
          onmessage: () => undefined,
          onerror: (error) => notes.push(`error ${error.message}`),
          onclose: (event) => notes.push(`close ${event.code}: ${event.reason}`),
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('connect never settled')), DEADLINE_MS),
      ),
    ]);
    if (options.speak) {
      // The half the original probe never reached: speak, then wait long enough
      // for a 1011 to arrive if it is going to.
      session.sendRealtimeInput({
        audio: { data: oneSecondOfSpeech(), mimeType: 'audio/pcm;rate=16000' },
      });
      await new Promise((resolve) => setTimeout(resolve, 6_000));
    }
    session.close();
    const died = notes.some((note) => note.startsWith('close 1011'));
    console.log(`  ${died ? '✗ 1011      ' : '✓ SURVIVED  '} ${label}`);
  } catch (error) {
    console.log(`  ✗ refused    ${label} — ${(error as Error).message}`);
  }
  for (const note of notes) console.log(`               ${note}`);
}

loadDotEnv();
const config = loadConfig();
if (!config.geminiApiKey) {
  console.error('No GEMINI_API_KEY. Nothing to ask.');
  process.exit(1);
}

const live = config.model || DEFAULT_LIVE_MODEL;
const NATIVE_AUDIO_25 = 'gemini-2.5-flash-native-audio-preview-12-2025';

console.log(`\n  enableAffectiveDialog on ${live}\n`);
await attempt(config.geminiApiKey, live, 'with her tools', true);
await attempt(config.geminiApiKey, live, 'without tools', false);

/*
 * The other half of the question, and the reason this probe was extended.
 *
 * `models.ts` records, measured on 2026-08-17, that 2.5 closes with 1011 the
 * moment tools meet audio input — which is why the default is 3.1 and why
 * affective dialogue is unavailable. Google's capabilities guide now documents
 * asynchronous function calling on 2.5 with `behavior: NON_BLOCKING`, which
 * contradicts that measurement. One of the two is out of date and a command is
 * cheaper than an argument.
 *
 * If either 2.5 arm SURVIVES, `toolsWithAudio` flips for that model and the
 * default-model decision reopens with affective dialogue and proactive audio
 * attached to it. If both still 1011, add today's date beside 2026-08-17 in
 * `models.ts` and change nothing else.
 */
console.log(`\n  tools plus real audio input on ${NATIVE_AUDIO_25}\n`);
await attempt(config.geminiApiKey, NATIVE_AUDIO_25, 'blocking tools, then speech', true, {
  speak: true,
});
await attempt(config.geminiApiKey, NATIVE_AUDIO_25, 'NON_BLOCKING tools, then speech', true, {
  speak: true,
  nonBlocking: true,
});

console.log(`\n  and the same on ${live}, for a control\n`);
await attempt(config.geminiApiKey, live, 'her tools, then speech', true, {
  speak: true,
  affective: false,
});
console.log('');
console.log('');
process.exit(0);
