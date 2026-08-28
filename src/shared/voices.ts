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
 * All thirty work with the Live models; `FEMALE_VOICES` is the subset she is
 * offered. The order is Google's, not alphabetical
 * and not sorted by character, because it is the order the API documents and a
 * reordering here would be a silent disagreement with the source.
 */

export interface Voice {
  /** The `voiceName` the Live API expects, exactly as it is spelled. */
  readonly name: string;
  /** Google's one-word description of how it sounds. */
  readonly character: string;
  /**
   * Which of Google's two labels it carries.
   *
   * Not on the Gemini page, which lists only a name and a character word. It is
   * on Cloud Text-to-Speech's pages for the same thirty names, in a column
   * headed Gender:
   * https://docs.cloud.google.com/text-to-speech/docs/gemini-tts
   * Verified against the raw table, and against the Chirp 3 HD page, which
   * agrees on all thirty. Fourteen female, sixteen male.
   */
  readonly gender: 'female' | 'male';
}

export const VOICES: readonly Voice[] = [
  { name: 'Zephyr', character: 'Bright', gender: 'female' },
  { name: 'Puck', character: 'Upbeat', gender: 'male' },
  { name: 'Charon', character: 'Informative', gender: 'male' },
  { name: 'Kore', character: 'Firm', gender: 'female' },
  { name: 'Fenrir', character: 'Excitable', gender: 'male' },
  { name: 'Leda', character: 'Youthful', gender: 'female' },
  { name: 'Orus', character: 'Firm', gender: 'male' },
  { name: 'Aoede', character: 'Breezy', gender: 'female' },
  { name: 'Callirrhoe', character: 'Easy-going', gender: 'female' },
  { name: 'Autonoe', character: 'Bright', gender: 'female' },
  { name: 'Enceladus', character: 'Breathy', gender: 'male' },
  { name: 'Iapetus', character: 'Clear', gender: 'male' },
  { name: 'Umbriel', character: 'Easy-going', gender: 'male' },
  { name: 'Algieba', character: 'Smooth', gender: 'male' },
  { name: 'Despina', character: 'Smooth', gender: 'female' },
  { name: 'Erinome', character: 'Clear', gender: 'female' },
  { name: 'Algenib', character: 'Gravelly', gender: 'male' },
  { name: 'Rasalgethi', character: 'Informative', gender: 'male' },
  { name: 'Laomedeia', character: 'Upbeat', gender: 'female' },
  { name: 'Achernar', character: 'Soft', gender: 'female' },
  { name: 'Alnilam', character: 'Firm', gender: 'male' },
  { name: 'Schedar', character: 'Even', gender: 'male' },
  { name: 'Gacrux', character: 'Mature', gender: 'female' },
  { name: 'Pulcherrima', character: 'Forward', gender: 'female' },
  { name: 'Achird', character: 'Friendly', gender: 'male' },
  { name: 'Zubenelgenubi', character: 'Casual', gender: 'male' },
  { name: 'Vindemiatrix', character: 'Gentle', gender: 'female' },
  { name: 'Sadachbia', character: 'Lively', gender: 'male' },
  { name: 'Sadaltager', character: 'Knowledgeable', gender: 'male' },
  { name: 'Sulafat', character: 'Warm', gender: 'female' },
];

export const PREBUILT_VOICES: readonly string[] = VOICES.map((voice) => voice.name);

/**
 * The ones she is offered.
 *
 * She is a woman, so the menu is the fourteen and not the thirty. The other
 * sixteen stay in `VOICES` rather than being deleted, and stay valid on load,
 * because `voice.md` is a file somebody is invited to edit: a profile that
 * already says `voice: Puck` should keep its voice rather than be quietly
 * reset to something it never chose. What changed is what is *offered*, not
 * what is *accepted*.
 */
export const FEMALE_VOICES: readonly Voice[] = VOICES.filter((voice) => voice.gender === 'female');

/**
 * Breezy, and the one she ships with.
 *
 * Chosen rather than defaulted to the first in the list: `Zephyr` is Google's
 * first and "Bright" is not who this character is.
 */
export const DEFAULT_VOICE = 'Aoede';
