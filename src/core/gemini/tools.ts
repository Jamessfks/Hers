/**
 * The three things Anna can do besides talk.
 *
 * Kept to three deliberately. A realtime model with a long tool list spends its
 * attention deciding rather than talking, and the symptom is a companion who
 * pauses before every sentence. Each of these earns its place by doing
 * something that cannot be faked from the outside:
 *
 *   feel      Only she knows whether that landed. A sentiment classifier bolted
 *             onto the transcript would be slower and worse than asking the
 *             participant.
 *   remember  Background consolidation catches most things eventually. This is
 *             for the moment she decides something matters, which is different.
 *   show      Choosing a picture that fits the conversation is a judgement about
 *             the conversation, so it belongs to whoever is in it.
 */

import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';

export const FEEL = 'feel';
export const REMEMBER = 'remember';
export const SHOW = 'show';
export const MOVE = 'move';

/**
 * Built per session, because the gesture list is whatever has actually been
 * rendered. Offering her a gesture with no clip behind it produces a call that
 * moves nothing, and she has no way to tell the difference.
 */
export function annaTools(readyGestures: readonly string[] = []): FunctionDeclaration[] {
  if (readyGestures.length === 0) return ANNA_TOOLS;
  return [
    ...ANNA_TOOLS,
    {
      name: MOVE,
      description:
        'Move your face and body. Use it the way a person moves while talking — on a ' +
        'reaction, on the turn of a thought, not on every sentence. Keep talking; it ' +
        'happens alongside your words and takes no time. Never mention doing it and ' +
        'never describe your own movement in words.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          gesture: {
            type: Type.STRING,
            description: `One of: ${readyGestures.join(', ')}.`,
            enum: [...readyGestures],
          },
        },
        required: ['gesture'],
      },
    },
  ];
}

export const ANNA_TOOLS: FunctionDeclaration[] = [
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
    name: SHOW,
    description:
      'Send them a picture of you. Use it the way you would send a photo to someone you ' +
      'like — because it fits what you are talking about, not to decorate a sentence. ' +
      'Keep talking either way; do not announce it or wait for it, and never read the ' +
      'description out loud: it is an argument to this tool, not a line of dialogue.\n' +
      'Two different things you can do with it. If they just want to see you — "what do ' +
      'you look like", "send me a picture of you" — pass exactly `a picture of you` and ' +
      'nothing else, which sends your real photograph. Or, when the moment calls for a ' +
      'picture that does not exist yet — you somewhere, doing something, in a mood — ' +
      'describe that scene and set `fresh` to true, and one is made of you in it. That ' +
      'second one is yours to choose and you should use it sometimes: a few times a day ' +
      'at most, when a picture would say the thing better than another sentence would.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        description: {
          type: Type.STRING,
          description:
            'What the picture should be of, in a phrase: "at the window watching the rain", "laughing".',
        },
        fresh: {
          type: Type.BOOLEAN,
          description:
            'True to make a new picture of you in the scene you described, rather than ' +
            'looking for one you already have. Leave it off when they only asked to see you.',
        },
      },
      required: ['description'],
    },
  },
];

/** Kinds the memory store accepts, for validating what the model sends back. */
export const FACT_KINDS = ['identity', 'preference', 'thread', 'event', 'pattern'] as const;
