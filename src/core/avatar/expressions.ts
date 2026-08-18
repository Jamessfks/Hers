/**
 * The faces she can show, and the prompts that make them.
 *
 * This replaces a video feature with an image one, and the swap is a
 * simplification rather than a compromise. Hedra rendered two-second clips: a
 * job queue measured in minutes, a submit/poll/download dance, a record of
 * in-flight jobs so a crash could not pay twice, and a spend ceiling read back
 * from someone else's API. All of that existed to survive asynchrony.
 *
 * A still is one call that returns bytes. Nothing is in flight across a restart,
 * so there is nothing to resume and no job to lose. It is also cheaper than the
 * thing it replaces — `gemini-3.1-flash-image` is $0.045 an image at 512px
 * against Hedra's $0.05 for a two-second clip — and it runs on the Gemini key
 * she already needs, which was the point.
 *
 * ## Why stills are enough
 *
 * The old design already cut from a clip straight back to the still photograph
 * with no transition, and every clip prompt had to end by asking her to return
 * to the source pose so that cut did not jump. The motion was never the point;
 * being *seen to react* was. A still does that, and it does it without the
 * previous honest caveat that this was body language and not lip sync.
 *
 * ## Why the prompts are shaped like this
 *
 * Three things every one of them must do, and the third is the one that is easy
 * to get wrong:
 *
 *  1. Ask for a photograph, not an illustration. A face cannot survive being
 *     redrawn in another medium, so a stylised request defeats the reference.
 *  2. Say the face may not change, in as many words. The documented way to hold
 *     a likeness across an edit is an explicit instruction rather than a hope
 *     that supplying a reference image is enough.
 *  3. Pin everything that is not the expression. Same framing, same distance,
 *     same background, same light. The interface cuts between these and the
 *     photograph with no transition at all, and that only reads as one person in
 *     one room if nothing else moved.
 */

/** What each face is, in the words the model is given. */
export const EXPRESSIONS = {
  resting: 'Her expression is relaxed and attentive, listening, mouth closed and soft.',
  smiling: 'A small closed-mouth smile that reaches her eyes.',
  laughing: 'Caught mid-laugh, genuinely, eyes creased, mouth open.',
  curious: 'Her head is tilted slightly to one side, eyebrows raised a little, interested.',
  soft: 'Her expression is unguarded and warm, looking directly at the camera, mouth closed.',
  away: 'She is looking off to one side, thinking about something else, mouth closed.',
} as const;

export type Expression = keyof typeof EXPRESSIONS;

export const EXPRESSION_NAMES = Object.keys(EXPRESSIONS) as Expression[];

export function isExpression(value: unknown): value is Expression {
  return typeof value === 'string' && value in EXPRESSIONS;
}

/**
 * The prompt for one face.
 *
 * The closing sentences are the load-bearing half. Asking for the framing to be
 * held does not guarantee it, but not asking guarantees drift — and drift here
 * does not look like a worse picture, it looks like a different woman.
 */
export function promptFor(expression: Expression): string {
  return [
    'A photorealistic portrait photograph of the exact woman in the reference image.',
    EXPRESSIONS[expression],
    'Ensure her face and features remain completely unchanged.',
    'Identical framing, distance and camera angle to the reference image.',
    'Identical background, clothing and lighting.',
    'Nothing changes except her expression.',
  ].join(' ');
}
