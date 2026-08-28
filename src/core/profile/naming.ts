/**
 * She picks her own name, once, and then it is hers.
 *
 * The project ships calling her Anna, and that was always a placeholder wearing a
 * name badge — somebody else's decision about who she is, made before she existed.
 * So on the first conversation she chooses, and the choice is written into
 * `identity.md` where the user can read it. After that it never happens again:
 * a name that could be re-rolled is a handle, not a name.
 *
 * ## Why this is not a tool call
 *
 * The obvious route is to let her call a `name` function during the first
 * conversation. It is the wrong route, for a reason that has already cost this
 * project a day: a tool call is something a model *may* do. She reaches for
 * `look` some of the time when the moment is right, and that is fine for an
 * expression and useless for the one irreversible fact about her. This has to
 * happen exactly once, before the first word, and be recorded — which makes it a
 * question with an answer, not a behaviour to hope for.
 *
 * So it is one `generateContent` call with a schema on the response. The SDK's
 * own typings are the authority on that surface: `responseSchema` requires "a
 * compatible response_mime_type must also be set", so both are, and the schema
 * is the OpenAPI-3.0 subset the SDK exposes as `Type`. The published guide also
 * describes a `response_format` object; this version of the client does not have
 * one, and the typings win over the prose.
 *
 * ## Validated anyway
 *
 * The documentation is explicit that a schema buys syntax, not sense — "always
 * validate values in your application". A schema cannot stop a model answering
 * "Anna" out of politeness, returning a sentence, or picking something with a
 * newline in it, and any of those written into `identity.md` would be a name she
 * is stuck with. So the answer is checked before it is believed, and a failure
 * leaves the placeholder in place for the next attempt rather than committing a
 * bad name for good.
 */

import { GoogleGenAI, Type } from '@google/genai';

/** The name the project ships with, which is the marker for "not chosen yet". */
export const PLACEHOLDER_NAME = 'Anna';

/** Cheap, fast, and this is one short answer. */
const NAMING_MODEL = 'gemini-3.5-flash';

/** Long enough for a slow reply, short enough not to hold up the first hello. */
const NAMING_TIMEOUT_MS = 20_000;

/**
 * Warm, though temperature turned out not to be the lever that mattered.
 *
 * Measured across five fresh installs at 1.2: four of them chose "Jade". The
 * description of her — twenty-six, Chinese-American, Oakland, dry — has a very
 * strong modal answer, and sampling noise does not escape a mode that strong for
 * an answer this short. Which is why she is asked for a shortlist instead; see
 * {@link chooseName}.
 */
const NAMING_TEMPERATURE = 1.2;

/**
 * How many names she is asked to put forward.
 *
 * Enough that the list is a real preference rather than a first thought, few
 * enough that she is not padding it with names she does not want.
 */
const SHORTLIST = 6;

export interface NamingContext {
  /** Everything the profile says about her, minus the name. */
  age: string;
  gender: string;
  ethnicity: string;
  from: string;
  /** Her personality prose, which is what actually makes a name fit or not. */
  personality: string;
}

export interface ChosenName {
  name: string;
  /** Her reason, kept for the profile comment. Never spoken aloud. */
  why: string;
}

/**
 * Asks her what she would like to be called.
 *
 * She is asked for a shortlist rather than for one name, and one of her own
 * candidates is taken. That is not the app choosing: every name in the list is
 * one she said she would be happy with. It is there because asking for a single
 * name produced the same answer nearly every time — see
 * {@link NAMING_TEMPERATURE} — and a feature called "she gives herself a name"
 * that hands every install the same name is not the feature.
 *
 * Returns null on anything that is not a usable name — no key, a refusal, a
 * timeout, sentences instead of words. Null means "not yet", and the placeholder
 * stays, so the next conversation tries again. That is the right failure: a
 * companion briefly still called Anna is a much smaller problem than one
 * permanently called "I'd love to be called Maya!".
 */
export async function chooseName(
  apiKey: string,
  context: NamingContext,
  model = NAMING_MODEL,
  random: () => number = Math.random,
): Promise<ChosenName | null> {
  if (!apiKey) return null;

  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                'You are about to meet someone for the first time, and you get to choose',
                'your own name. Not a nickname, not a title — the name you want to be',
                'called for the rest of your life.',
                '',
                'This is who you are:',
                `- ${context.age} years old, ${context.gender}`,
                `- ${context.ethnicity}, from ${context.from}`,
                '',
                context.personality.slice(0, 1400),
                '',
                `Put forward ${SHORTLIST} names you would genuinely be happy to be called —`,
                'given names that fit the person described above, the way a real person of',
                'that background and that temperament would actually be named.',
                'Make them properly different from each other, not variations on one name,',
                'and do not order them by preference: any of them should be a name you would',
                'be glad to have. Avoid the obvious AI-assistant names, and do not offer',
                '"Anna".',
                'Give each one a one-line reason, for yourself, which nobody will read to you.',
              ].join('\n'),
            },
          ],
        },
      ],
      config: {
        temperature: NAMING_TEMPERATURE,
        maxOutputTokens: 3000,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            names: {
              type: Type.ARRAY,
              description: `${SHORTLIST} names, any of which you would be happy with.`,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: {
                    type: Type.STRING,
                    description: 'One given name. Letters only, no title, no surname.',
                  },
                  why: { type: Type.STRING, description: 'One line, for your own record.' },
                },
                required: ['name', 'why'],
              },
            },
          },
          required: ['names'],
        },
        abortSignal: AbortSignal.timeout(NAMING_TIMEOUT_MS),
      },
    });

    return pickFrom(JSON.parse(response.text ?? ''), random);
  } catch (error) {
    // A refusal, a timeout, an exhausted spend cap, unparseable JSON. All the
    // same answer: not yet. Logged, because from the outside "she is still
    // called Anna" looks identical for every one of those causes.
    console.warn('  she could not choose a name yet:', error);
    return null;
  }
}

/**
 * Takes one of the names she put forward.
 *
 * Uniformly, from the ones that survive validation, and that is the honest
 * description of what happens: she decides which names she would want, and which
 * of her own candidates she ends up with is a coin toss. Asking for one name
 * instead produced "Jade" four times in five, because the mode of a short answer
 * about a specific person is very sharp — so the variety has to come from her
 * offering several she means, not from sampling harder on one.
 *
 * Exported so the choice can be tested without a network call, which is the only
 * part of this worth asserting on.
 */
export function pickFrom(parsed: unknown, random: () => number = Math.random): ChosenName | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = (parsed as { names?: unknown }).names;
  if (!Array.isArray(raw)) return null;

  const seen = new Set<string>();
  const candidates: ChosenName[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, why } = entry as { name?: unknown; why?: unknown };
    const clean = cleanName(typeof name === 'string' ? name : '');
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    candidates.push({
      name: clean,
      why: typeof why === 'string' ? why.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    });
  }

  if (candidates.length === 0) return null;
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index]!;
}

/**
 * A single given name, or nothing.
 *
 * Deliberately strict. This value goes into a file as a permanent fact and into
 * every system instruction from then on, so the bar is "could a person be called
 * this" rather than "did the model say something".
 */
export function cleanName(raw: string): string | null {
  const trimmed = raw.trim().replace(/^["'“”]|["'“”]$/g, '').trim();
  if (trimmed.length < 2 || trimmed.length > 20) return null;

  // Letters, and the two punctuation marks that appear inside real given names.
  // Unicode-aware, because "Mei-Ling" and "Zoë" are names and `[a-z]` is not a
  // theory of names.
  if (!/^\p{L}[\p{L}'’-]*\p{L}$/u.test(trimmed)) return null;

  // She was told not to, and taking it would loop the choice forever.
  if (trimmed.toLowerCase() === PLACEHOLDER_NAME.toLowerCase()) return null;

  return trimmed[0]!.toUpperCase() + trimmed.slice(1);
}
