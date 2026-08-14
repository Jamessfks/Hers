/**
 * When Anna should actually look, rather than rely on what she last saw.
 *
 * The camera samples on a slow timer — deliberately, because a companion who
 * streams your face to a vision model continuously is surveillance with a
 * personality. But that leaves a hole: ask "how do I look?" and she answers
 * from an image up to forty-five seconds old, or from nothing at all. Being
 * confidently wrong about what you are wearing is worse than admitting she was
 * not looking.
 *
 * So a look is *requested* when the conversation needs eyes, and only then.
 * The cost is one extra capture and one vision call on the turns where it
 * matters, and nothing at all on the turns where it does not.
 */

/** Phrases that mean "use your eyes, now". */
const SIGHT_INTENT = [
  /\b(can|do) you see\b/i,
  /\bwhat (do i|am i) (look|wear|doing)/i,
  /\bhow do i look\b/i,
  /\blook at (me|this|my)\b/i,
  /\bare you (watching|looking)\b/i,
  /\bwhat colou?r\b/i,
  /\bnotice anything\b/i,
  /\bdo i look\b/i,
  /\bmy (hair|shirt|face|outfit|room|desk)\b/i,
  /\bcheck me out\b/i,
  /\bsee this\b/i,
  /\bshow(ing)? you\b/i,
];

/**
 * Does answering this need a current look at the user?
 *
 * Deliberately narrow. A false positive costs a vision call and ~600ms on a
 * turn that did not need it; a false negative costs only the freshness of an
 * observation she was going to make anyway. Erring toward not-looking is also
 * the right default for something pointed at someone's face.
 */
export function needsFreshLook(message: string): boolean {
  return SIGHT_INTENT.some((pattern) => pattern.test(message));
}

/** How long a visual read stays worth acting on. */
export const READ_STALE_MS = 3 * 60 * 1000;

/**
 * Is this read different enough from the last one to be worth mentioning?
 *
 * Without this she reports the same posture every time the timer fires, and a
 * companion who says "you look tired" four times in five minutes is a companion
 * you switch off. Compared on content words so that "slumped forward, rubbing
 * their eyes" and "slumped, rubbing eyes" count as the same observation.
 */
export function readChanged(previous: string | undefined, next: string): boolean {
  if (!previous) return true;
  const words = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 3),
    );

  const before = words(previous);
  const after = words(next);
  if (after.size === 0) return false;

  let shared = 0;
  for (const word of after) if (before.has(word)) shared += 1;
  // More than half the content words in common means she is describing the
  // same thing again in slightly different words.
  return shared / after.size < 0.5;
}
