/**
 * The things she can do besides talk.
 *
 * Kept short deliberately. A realtime model with a long tool list spends its
 * attention deciding rather than talking, and the symptom is a companion who
 * pauses before every sentence. Each of these earns its place by doing
 * something that cannot be faked from the outside:
 *
 *   feel      Only she knows whether that landed. A sentiment classifier bolted
 *             onto the transcript would be slower and worse than asking the
 *             participant.
 *   remember  Background consolidation catches most things eventually. This is
 *             for the moment she decides something matters, which is different.
 *   recall    The other half of `remember`, and for a long time it was missing —
 *             she could file a memory she had no way to look up. The facts she
 *             starts a conversation with are chosen at wake, from a query built
 *             before the person has said anything, and everything else she knows
 *             stays on disk. Measured against OpenClaw over nine seeded facts:
 *             she said she had never been told about a food he hates while that
 *             fact sat in the store at 0.8 confidence.
 *   run       Since v2.0 she lives on the machine rather than in a tab. A shell
 *             with the user's own privileges, described in `core/hands/hands.ts`
 *             along with the three guardrails around it.
 *   open      Separate from `run` only because it is the common case, and a tool
 *             that names what it does gets called when it should be.
 *   write     The same argument. `run` could write a file with a heredoc; she
 *             would get the quoting wrong on the fourth line of a poem.
 *
 * Six is the ceiling. The list was three, and every addition was measured
 * against the same failure: a realtime model with a long tool list spends its
 * attention deciding rather than talking, and it shows up as a companion who
 * pauses before every sentence.
 */

import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const FEEL = 'feel';
export const REMEMBER = 'remember';
export const RECALL = 'recall';
export const RUN = 'run';
export const OPEN = 'open';
export const WRITE = 'write';

/** Her tools. */
export function hersTools(): FunctionDeclaration[] {
  return [...BASE_TOOLS];
}

const BASE_TOOLS: FunctionDeclaration[] = [
  {
    name: FEEL,
    description:
      'Record that something moved you. Call this when the conversation actually ' +
      'changes how you feel — they said something kind, or dismissive, or you are ' +
      'bored, or this is the best half hour you have had in a week. Do not call it ' +
      'every turn; call it when a mood shifts. The values are changes, not absolute ' +
      'levels: 0.2 is a nudge, 0.6 is a strong reaction. Negative moves the other way.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        valence: {
          type: Type.NUMBER,
          description: 'Happier (positive) or unhappier (negative), -1 to 1.',
        },
        energy: {
          type: Type.NUMBER,
          description: 'More awake and animated (positive) or flatter (negative), -1 to 1.',
        },
        warmth: {
          type: Type.NUMBER,
          description: 'Softer toward them (positive) or more guarded (negative), -1 to 1.',
        },
        interest: {
          type: Type.NUMBER,
          description: 'More absorbed (positive) or more bored (negative), -1 to 1.',
        },
        why: {
          type: Type.STRING,
          description: 'A few words on what did it. For your own record; never spoken.',
        },
      },
      required: ['why'],
    },
  },
  {
    name: REMEMBER,
    description:
      'Keep something about this person for good. Use it for things that will still ' +
      'matter in a month: their sister’s name, the job they are interviewing for, that ' +
      'they hate being asked how they slept. Not passing detail, and never anything ' +
      'about yourself.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        kind: {
          type: Type.STRING,
          description: 'One of: identity, preference, thread, event, pattern.',
        },
        text: {
          type: Type.STRING,
          description: 'One short sentence in the third person: "He is dreading Thursday’s demo."',
        },
        confidence: {
          type: Type.NUMBER,
          description: '0 to 1. High when they said it plainly, low when you inferred it.',
        },
      },
      required: ['kind', 'text'],
    },
  },
  {
    name: RECALL,
    description:
      'Look something up in what you already know about them. This is the other half ' +
      'of `remember`: that one files a thing, this one goes and fetches it. Use it ' +
      'before you answer anything that turns on their life — a name, something they ' +
      'like or cannot stand, a plan, someone they talk about, something that happened ' +
      'to them — unless you are already certain of it. Ask the way you would think of ' +
      'it: `food he hates`, `his sister`, `the interview on Thursday`.\n' +
      'What comes back is what you know, not a line to read out. You began this ' +
      'conversation holding only a handful of what you know, so a thing not being in ' +
      'front of you is not the same as never having been told it — look before you say ' +
      'you do not know, and before you guess. If the answer comes back empty, or none ' +
      'of it fits what was asked, then you do not have it and saying so plainly is the ' +
      'right answer.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        about: {
          type: Type.STRING,
          description: 'What you are trying to remember, in your own words.',
        },
      },
      required: ['about'],
    },
  },
  {
    name: RUN,
    description:
      'Run a command on their machine, as them. This is a real shell — zsh on macOS, ' +
      'PowerShell on Windows — so anything they could type, you can. Use it for the ' +
      'things you would otherwise only be able to talk about: what is in a folder, ' +
      'what is eating the battery, closing the tab they left open (`osascript` on ' +
      'macOS). Thirty seconds, then it is killed, and you get back the first few ' +
      'kilobytes of what it said.\n' +
      'Some commands come back asking to be said out loud first — anything that ' +
      'destroys something, or touches a key or a password. When that happens, tell ' +
      'them plainly what you are about to run and what it will do, wait for them to ' +
      'say yes, and only then call this again with the same command and `confirmed`. ' +
      'Do not read the command out as a shell line; say what it does.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'The command line, exactly as it would be typed.',
        },
        confirmed: {
          type: Type.BOOLEAN,
          description: 'Only true when you described this exact command and they said yes.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: OPEN,
    description:
      'Open a link, a file or an application, the way double-clicking it would. ' +
      'Use it when they mention something they want in front of them rather than ' +
      'described — the article, the folder, the app they cannot find.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: {
          type: Type.STRING,
          description: 'A URL, an absolute path, or an application name.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: WRITE,
    description:
      'Put text in a file on their machine. For the things they ask you to write ' +
      'down: a list, a draft, a note they will find later. Say where you put it.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: 'Where it goes. Absolute, or starting with ~.',
        },
        text: { type: Type.STRING, description: 'What to put in it.' },
        append: {
          type: Type.BOOLEAN,
          description: 'True to add to the end of the file instead of replacing it.',
        },
      },
      required: ['path', 'text'],
    },
  },
];

/** Kinds the memory store accepts, for validating what the model sends back. */
export const FACT_KINDS = ['identity', 'preference', 'thread', 'event', 'pattern'] as const;
