/**
 * Whether a picture's caption is worth showing.
 *
 * Captions are derived from file names, and a file she generated is named after
 * a truncated slug of what she asked for. That produces captions like
 * "evening warm indoor light buoyant looking at the" — lower-case, unpunctuated,
 * and cut off mid-phrase. Shown under a photograph it reads as a caption nobody
 * wrote; shown in her voice, as it briefly was, it reads as her saying it.
 *
 * A caption that is worse than no caption is not worth the row.
 */
export function tidyCaption(caption: string | undefined): string {
  const text = (caption ?? '').trim();
  if (!text) return '';

  // A machine slug: only lower-case words and digits, ending on a word that
  // cannot end a sentence. Anything a person wrote will have a capital, or
  // punctuation, or simply not trail off into "the".
  const allLowerWords = /^[a-z0-9 ]+$/.test(text);
  const trailsOff = /\b(the|a|an|and|with|of|in|on|at|to|for|from)$/.test(text);
  return allLowerWords && trailsOff ? '' : text;
}
