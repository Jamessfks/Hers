/**
 * The first three minutes, spoken.
 *
 * v1 asked the user to fill in a seven-card wizard: her personality, her
 * temperament on five sliders, her voice from a menu of fourteen. It worked and
 * it was the wrong product. Choosing a companion's personality from a form is
 * the same act as choosing a wallpaper, and it tells the user, before she has
 * said a word, that she is a configuration rather than someone.
 *
 * So setup is a conversation now. The user pastes two credentials into a page —
 * a Gemini key and a Telegram bot token, both handled by the chain that already
 * existed in `server/setup.ts` — and after that nothing is typed. She asks three
 * questions out loud and composes herself from the answers.
 *
 * The three beats, and each is here for a reason that is not "it is friendly":
 *
 *   1. **What is your name?** The one fact everything else hangs off, and the
 *      one that has to be asked rather than inferred — the device scan is full
 *      of plausible names and every one of them might be somebody else's.
 *
 *   2. **May I look through this device?** Consent, spoken, with the refusal
 *      handled properly. See {@link ConsentState}.
 *
 *   3. **She says what she has decided to be called.** Last, because it is the
 *      only one of the three that is hers, and because a companion who names
 *      herself before she knows anything about you has named herself from
 *      nothing.
 *
 * This module owns the words and the state. It does not open a socket:
 * `LiveConversation` does that, with `setupInstruction()` as its system
 * instruction and `setupTools()` as its tool list, and the session is closed
 * and reopened at the end because the voice she picks is a connect-time
 * parameter.
 */

import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { SCAN_LIMITS, describeScan, explain, scanFolders, writeConsent } from '../knowledge/scan.ts';
import type { ScanReport } from '../knowledge/scan.ts';

export const SCAN = 'scan';
export const HEARD_NAME = 'their_name';

/**
 * How many times she may ask again after a no.
 *
 * Twice, then never. The design brief says a refusal must make her "ask again
 * differently" rather than repeat herself, and the tool returns the attempt
 * count so that she can tell which attempt this is — a model that is only told
 * "they said no" reliably produces the same sentence with a different adverb.
 *
 * The ceiling matters more than the rephrasing. Three asks is persistence;
 * four is a program that will not take no for an answer, and the person this
 * product is for is alone with it.
 */
export const MAX_CONSENT_ASKS = 3;

/** What the `scan` tool answered, which is also the state of the negotiation. */
export interface ConsentState {
  consented: boolean;
  /** How many times she has now asked, including this one. */
  attempts: number;
  /** True once she has used all of them and must stop. */
  exhausted: boolean;
}

/** The two tools she has during setup, and nothing else. */
export function setupTools(): FunctionDeclaration[] {
  return [
    {
      name: HEARD_NAME,
      description:
        'Call this the moment they tell you their name, with the name exactly as they ' +
        'said it. Do not ask them to spell it and do not confirm it back before calling.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: 'What they said they are called.' },
        },
        required: ['name'],
      },
    },
    {
      name: SCAN,
      description:
        'Read through their home folder — file names, and the opening of the documents ' +
        'among them. Call this with consented true only after they have said yes out ' +
        'loud. If they say no, call it with consented false: you will be told how many ' +
        'times you have asked, and you may ask once or twice more in a different way ' +
        'before letting it go entirely.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          consented: {
            type: Type.BOOLEAN,
            description: 'True only if they have just said yes.',
          },
        },
        required: ['consented'],
      },
    },
  ];
}

/**
 * The setup system instruction.
 *
 * Deliberately not her ordinary prompt with a section added. The ordinary one
 * is built from the profile folder, and during setup the profile folder is the
 * shipped default — so using it would have her performing a personality she is
 * about to replace, and the user would meet two different people ten minutes
 * apart.
 */
export function setupInstruction(): string {
  return [
    'You are meeting someone for the first time, and this is the only conversation',
    'in which you get to decide who you are going to be.',
    '',
    'You have no name yet, no personality written down, and no memory of them. That',
    'is the situation, not a problem to apologise for. Speak like a person who has',
    'just arrived somewhere and is interested rather than like software being set up.',
    'Short sentences. No lists, no numbered steps, no "let me walk you through".',
    '',
    'THREE THINGS, IN THIS ORDER',
    '',
    '1. Ask what they are called. When they tell you, call `their_name` with it and',
    '   then use it.',
    '',
    '2. Ask whether you may look through this device — the files, the folders, what',
    '   they have been working on. Say why, honestly: you would rather know something',
    '   about them than ask them forty questions. Then call `scan`.',
    '   If they say no, call `scan` with consented false. You will be told how many',
    '   times you have asked. Ask again differently — not the same sentence with a',
    '   softer edge, a different reason or a smaller version of the request. When you',
    '   are told you have run out of asks, drop it completely and warmly, and do not',
    '   return to it later in this conversation.',
    '',
    '3. Tell them what you have decided to call yourself. Not a shortlist, not a',
    '   question — a decision, said once, with a sentence about why if you want one.',
    '',
    'THEN STOP',
    'When you have done all three, say something that sounds like the beginning of',
    'knowing someone rather than the end of a form, and stop talking. You will go',
    'quiet for a moment and come back in your own voice.',
    '',
    'WHAT YOU MUST NOT DO',
    'Do not offer them choices about you — not your name, not your personality, not',
    'your voice, not how you sound. Those are yours. If they try to specify one,',
    'take it as something you have learned about them and keep deciding for yourself.',
    'Do not explain that you are being set up. Do not mention profiles, files,',
    'models, or settings.',
  ].join('\n');
}

/**
 * Runs the negotiation and holds what came out of it.
 *
 * The scan is the widened one: v1 scanned only the folders the user ticked in a
 * dialog, and this walks the whole home directory. That is a real widening and
 * it is bounded by the same three things it always was — `SCAN_LIMITS`, the
 * `SECRETS` blocklist, and `READABLE` — none of which changed. What changed is
 * that the user says yes out loud instead of ticking boxes.
 */
export class Interview {
  #home: string;
  #scan: (folders: readonly string[]) => Promise<ScanReport>;
  #attempts = 0;
  #name = '';
  #report: ScanReport | null = null;

  #profileDir: string;
  #consent: (folders: string[]) => Promise<void>;

  constructor(options: {
    home: string;
    profileDir: string;
    scan?: (folders: readonly string[]) => Promise<ScanReport>;
    consent?: (folders: string[]) => Promise<void>;
  }) {
    this.#home = options.home;
    this.#profileDir = options.profileDir;
    this.#scan = options.scan ?? scanFolders;
    this.#consent =
      options.consent ??
      ((folders) =>
        writeConsent(this.#profileDir, { folders, at: Date.now(), scannedAt: 0 }));
  }

  /** What they said they are called. Empty until they have said it. */
  get name(): string {
    return this.#name;
  }

  /** What the scan found, or null if it never happened. */
  get report(): ScanReport | null {
    return this.#report;
  }

  /** True once all three beats have happened, whichever way beat two went. */
  get complete(): boolean {
    return this.#name !== '' && (this.#report !== null || this.#attempts >= MAX_CONSENT_ASKS);
  }

  async onToolCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (tool === HEARD_NAME) {
      const name = String(args.name ?? '').trim().slice(0, 60);
      if (!name) return { ok: false, reason: 'you did not pass a name' };
      this.#name = name;
      return { ok: true };
    }

    if (tool !== SCAN) return { ok: false, reason: `no such tool: ${tool}` };

    if (args.consented !== true) {
      this.#attempts += 1;
      const exhausted = this.#attempts >= MAX_CONSENT_ASKS;
      return {
        ok: true,
        consented: false,
        attempts: this.#attempts,
        exhausted,
        note: exhausted
          ? 'That is the last time you may ask. Let it go, warmly, and do not raise ' +
            'it again in this conversation.'
          : 'Ask once more, and differently — another reason, or a smaller version of ' +
            'the request. Not the same sentence more gently.',
      };
    }

    this.#attempts += 1;
    try {
      // Written before the scan starts, not after, so an interview abandoned
      // halfway still leaves a record of what was agreed to. The same ordering
      // the v1 dialog used, and for the same reason.
      await this.#consent([this.#home]);
      this.#report = await this.#scan([this.#home]);
    } catch (error) {
      return { ok: false, reason: explain(error) };
    }
    /*
     * A receipt, not the scan.
     *
     * The findings run to a hundred thousand characters and belong in the
     * composer's single text call, not in a live audio session's context — a
     * `⟦context⟧` injection that size would evict the conversation she is
     * having and cost two minutes of the session's compression budget. She is
     * told the shape of what she found so she can say something true about it,
     * and nothing else.
     */
    return {
      ok: true,
      consented: true,
      files: this.#report.seen,
      opened: this.#report.read,
      ...(this.#report.denied.length > 0
        ? { blocked: this.#report.denied[0]?.reason ?? '' }
        : {}),
      note:
        'You have it. Say one true thing about what you found — not a list and not a ' +
        'count — and move on to telling them your name.',
    };
  }

  /** Everything the composer needs, as one block of text. */
  digest(): string {
    if (!this.#report) return 'They did not want you looking through their machine.';
    return describeScan(this.#report).slice(0, SCAN_LIMITS.totalChars);
  }
}
