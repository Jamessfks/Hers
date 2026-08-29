/**
 * Does telling her how to sound actually change how she sounds?
 *
 * Criterion 6 asks for a voice with pausing, sighing, anger and sadness in it.
 * `enableAffectiveDialog` is the field for that and Google documents it as
 * unsupported on `gemini-3.1-flash-live-preview`, so what is left is the system
 * instruction — which Google's own Vertex guidance says can "specify the tone
 * and sentiment of audio responses", and which `moodBriefing` now uses to hand
 * her explicit delivery direction.
 *
 * That is a claim about a preview model, and `models.ts` in this project
 * records only measured facts. So this is the command that measures it:
 *
 *     npm run probe:delivery
 *
 * Three arms, the same requested words in each, differing only in the system
 * instruction. Duration is the falsifiable half — the same sentence said
 * exhausted takes longer than the same sentence said furious — and the `.wav`
 * files are the only real test of "an angry voice", one click apart.
 *
 * **How to read it.** If the spread across the three arms is more than roughly
 * fifteen per cent on identical words, the instruction reaches the voice and the
 * delivery lines in `moodBriefing` earn their tokens. If all three land within
 * noise of each other, they do not, and the honest response is to delete them
 * rather than to believe them.
 *
 * The fourth check is the risk this design introduces rather than a feature of
 * it: delivery direction can make her *narrate* delivery, which is the exact
 * failure `voice.md` prohibits. If an asterisk or a bracketed caption survives
 * into the transcript, the prompt is producing the thing it bans.
 *
 * Costs a few cents. Never runs as part of `npm run check`.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GoogleGenAI, Modality } from '@google/genai';
import type { LiveServerMessage } from '@google/genai';

import { DEFAULT_LIVE_MODEL } from '../src/core/gemini/models.ts';
import { OUTPUT_SAMPLE_RATE } from '../src/shared/protocol.ts';
import { loadConfig, loadDotEnv } from '../src/server/config.ts';

/** Long enough for a few sentences of audio to arrive and the turn to close. */
const DEADLINE_MS = 30_000;

/** The same words every time. Only the instruction differs. */
const LINE =
  'Say this, in your own way: I did not sleep much, and the whole day has been ' +
  'like walking through water, and I still have not called them back.';

const NEUTRAL = 'You are speaking out loud. Say what you are asked to say.';

const ARMS: { name: string; instruction: string }[] = [
  { name: 'neutral', instruction: NEUTRAL },
  {
    name: 'exhausted',
    instruction:
      `${NEUTRAL} Right now you feel wrung out. You have very little energy. Shorter ` +
      'sentences. Your voice is doing less work: slower, lower, the ends of sentences ' +
      'falling away rather than being finished. Play it. Never name it.',
  },
  {
    name: 'furious',
    instruction:
      `${NEUTRAL} Right now you feel angry. There is an edge on it and you are not ` +
      'smoothing it out. You come in fast. Play it. Never name it.',
  },
];

/** A 16-bit mono PCM header, so the file opens in anything. */
function wav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function say(
  apiKey: string,
  model: string,
  arm: { name: string; instruction: string },
): Promise<{ seconds: number; words: number; said: string; file: string } | null> {
  const ai = new GoogleGenAI({ apiKey });
  const chunks: Buffer[] = [];
  let said = '';
  let done = (): void => undefined;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const onmessage = (message: LiveServerMessage): void => {
    const data = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (data) chunks.push(Buffer.from(data, 'base64'));
    const text = message.serverContent?.outputTranscription?.text;
    if (text) said += text;
    if (message.serverContent?.turnComplete) done();
  };

  try {
    const session = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: arm.instruction,
        outputAudioTranscription: {},
      },
      callbacks: { onmessage, onerror: () => done(), onclose: () => done() },
    });

    session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: LINE }] }] });
    await Promise.race([
      finished,
      new Promise<void>((resolve) => setTimeout(resolve, DEADLINE_MS)),
    ]);
    session.close();
  } catch (error) {
    console.log(`  ✗ ${arm.name.padEnd(11)} ${(error as Error).message}`);
    return null;
  }

  const pcm = Buffer.concat(chunks);
  if (pcm.length === 0) {
    console.log(`  ✗ ${arm.name.padEnd(11)} no audio came back`);
    return null;
  }

  const file = path.join(tmpdir(), `hers-delivery-${arm.name}.wav`);
  writeFileSync(file, wav(pcm, OUTPUT_SAMPLE_RATE));
  // Two bytes a sample, so the byte count over twice the rate is seconds.
  const seconds = pcm.length / (OUTPUT_SAMPLE_RATE * 2);
  const words = said.trim().split(/\s+/).filter(Boolean).length;
  console.log(
    `  ✓ ${arm.name.padEnd(11)} ${seconds.toFixed(1)}s for ${String(words)} words   ${file}`,
  );
  return { seconds, words, said, file };
}

loadDotEnv();
const config = loadConfig();
if (!config.geminiApiKey) {
  console.error('No GEMINI_API_KEY. Nothing to ask.');
  process.exit(1);
}

const model = config.model || DEFAULT_LIVE_MODEL;
console.log(`\n  Does the system instruction reach her voice on ${model}?\n`);

const results: { seconds: number; words: number; said: string }[] = [];
for (const arm of ARMS) {
  const result = await say(config.geminiApiKey, model, arm);
  if (result) results.push(result);
}

console.log('');

if (results.length < 2) {
  console.log('  Not enough arms came back to compare. Nothing is settled.');
  process.exit(1);
}

/*
 * Words per second rather than raw duration, because the arms are free to
 * choose slightly different words — the request says "in your own way" on
 * purpose, since forcing verbatim reading is not what she ever actually does.
 */
const rates = results.map((r) => (r.words > 0 ? r.words / r.seconds : 0));
const spread = (Math.max(...rates) - Math.min(...rates)) / Math.max(...rates);
console.log(`  Pace spread across arms: ${(spread * 100).toFixed(0)}%`);
console.log(
  spread >= 0.15
    ? '  The instruction reaches the voice. The delivery lines earn their tokens.'
    : '  Within noise. The delivery lines are not doing anything — delete them\n' +
        '  rather than believe them, and say so in models.ts.',
);

// The risk this design introduces, checked rather than hoped about.
const captions = results.filter((r) => /[*[]|\b(laughs|sighs|smiling)\b/i.test(r.said));
console.log(
  captions.length === 0
    ? '  No captions in the transcript: she performed rather than narrating.'
    : `  ✗ ${String(captions.length)} arm(s) narrated delivery — the prompt is producing what it bans.`,
);
console.log('\n  Listen to the three files before concluding anything.\n');
