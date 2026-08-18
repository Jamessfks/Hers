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
 * If this ever prints CONNECTED, flip `affectiveDialog` to true for 3.1 in
 * `src/core/gemini/models.ts` and delete nothing else — the session already sends
 * the field whenever the capability says it may.
 */

import { GoogleGenAI, Modality } from '@google/genai';

import { DEFAULT_LIVE_MODEL } from '../src/core/gemini/models.ts';
import { HERS_TOOLS } from '../src/core/gemini/tools.ts';
import { loadConfig, loadDotEnv } from '../src/server/config.ts';

/** The SDK's connect promise does not settle when setup is rejected. */
const DEADLINE_MS = 25_000;

async function attempt(
  apiKey: string,
  model: string,
  label: string,
  withTools: boolean,
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
          enableAffectiveDialog: true,
          ...(withTools ? { tools: [{ functionDeclarations: HERS_TOOLS }] } : {}),
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
    session.close();
    console.log(`  ✓ CONNECTED  ${label}`);
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

console.log(`\n  enableAffectiveDialog on ${config.model || DEFAULT_LIVE_MODEL}\n`);
await attempt(config.geminiApiKey, config.model || DEFAULT_LIVE_MODEL, 'with her tools', true);
await attempt(config.geminiApiKey, config.model || DEFAULT_LIVE_MODEL, 'without tools', false);
console.log('');
process.exit(0);
