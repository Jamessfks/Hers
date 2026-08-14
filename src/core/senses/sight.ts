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

/**
 * Phrases that mean "use your eyes, now".
 *
 * The first version of this list caught five of thirty-six realistic ways
 * people ask someone to look — it missed "check this out", "watch this", "what
 * do you think of this", "I got a haircut", "what am I holding" and "tell me
 * what you see". Those are not exotic phrasings; they are the common ones.
 *
 * It stays a list of patterns rather than becoming a classifier because a wrong
 * answer is cheap in one direction and not the other: a false positive costs
 * one vision call, and a false negative only costs the freshness of something
 * she was going to notice anyway.
 */
const SIGHT_INTENT = [
  // Asking directly whether she can see.
  /\b(can|could|do|are) you (see|watch|look)/i,
  /\bare you (watching|looking)\b/i,
  /\btell me what you see\b/i,
  /\bwhat (can|do) you see\b/i,

  // Asking about themselves.
  /\bhow do i look\b/i,
  /\bdo i look\b/i,
  /\bwhat (do i|am i) (look|wear|doing|holding)/i,
  /\bnotice anything\b/i,
  /\bwhat('?s| is) different\b/i,
  /\bmy (new )?(hair|haircut|shirt|face|outfit|glasses|room|desk)\b/i,
  /\bi got a (haircut|new)\b/i,
  /\bcheck me out\b/i,

  // Directing her attention at something.
  /\blook at (me|this|that|my|it)\b/i,
  /\b(check|watch) (this|that|it) out\b/i,
  /\b(check|watch) this\b/i,
  /\bsee this\b/i,
  /\bshow(ing)? you\b/i,
  /\bwhat do you think of (this|it|my)\b/i,
  /\bwhat colou?r\b/i,

  // Someone else in the room.
  /\bsomeone (just )?(walked|came) in\b/i,
  /\bwho('?s| is) (this|that|here)\b/i,
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
