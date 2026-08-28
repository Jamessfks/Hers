/**
 * The voices she can be given, as Google publishes them.
 *
 * This lives in `shared/` for the same reason the list of profile files does:
 * the browser draws a menu of these and cannot import from `core/`, which is
 * compiled against Node's types. One copy, read by both halves.
 *
 * The character words are Google's own, from the voice-options table in
 * https://ai.google.dev/gemini-api/docs/speech-generation — kept because "Kore"
 * tells nobody anything and "Kore — Firm" tells them enough to choose. They are
 * one word each on purpose: a sentence of description would be a promise about
 * how a voice sounds that only listening can keep.
 *
 * All thirty work with the Live models. The order is Google's, not alphabetical
 * and not sorted by character, because it is the order the API documents and a
 * reordering here would be a silent disagreement with the source.
 */

export interface Voice {
  /** The `voiceName` the Live API expects, exactly as it is spelled. */
  readonly name: string;
  /** Google's one-word description of how it sounds. */
  readonly character: string;
}

export const VOICES: readonly Voice[] = [
  { name: 'Zephyr', character: 'Bright' },
  { name: 'Puck', character: 'Upbeat' },
  { name: 'Charon', character: 'Informative' },
  { name: 'Kore', character: 'Firm' },
  { name: 'Fenrir', character: 'Excitable' },
  { name: 'Leda', character: 'Youthful' },
  { name: 'Orus', character: 'Firm' },
  { name: 'Aoede', character: 'Breezy' },
  { name: 'Callirrhoe', character: 'Easy-going' },
  { name: 'Autonoe', character: 'Bright' },
  { name: 'Enceladus', character: 'Breathy' },
  { name: 'Iapetus', character: 'Clear' },
  { name: 'Umbriel', character: 'Easy-going' },
  { name: 'Algieba', character: 'Smooth' },
  { name: 'Despina', character: 'Smooth' },
  { name: 'Erinome', character: 'Clear' },
  { name: 'Algenib', character: 'Gravelly' },
  { name: 'Rasalgethi', character: 'Informative' },
  { name: 'Laomedeia', character: 'Upbeat' },
  { name: 'Achernar', character: 'Soft' },
  { name: 'Alnilam', character: 'Firm' },
  { name: 'Schedar', character: 'Even' },
  { name: 'Gacrux', character: 'Mature' },
  { name: 'Pulcherrima', character: 'Forward' },
  { name: 'Achird', character: 'Friendly' },
  { name: 'Zubenelgenubi', character: 'Casual' },
  { name: 'Vindemiatrix', character: 'Gentle' },
  { name: 'Sadachbia', character: 'Lively' },
  { name: 'Sadaltager', character: 'Knowledgeable' },
  { name: 'Sulafat', character: 'Warm' },
];

export const PREBUILT_VOICES: readonly string[] = VOICES.map((voice) => voice.name);

/**
 * Breezy, and the one she ships with.
 *
 * Chosen rather than defaulted to the first in the list: `Zephyr` is Google's
 * first and "Bright" is not who this character is.
 */
export const DEFAULT_VOICE = 'Aoede';
