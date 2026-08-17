/**
 * The shape of Anna's personalization folder once it has been read off disk.
 *
 * Every field here has a default. A profile folder that is missing, empty,
 * half-edited or full of typos must still produce a complete `Profile`, because
 * the alternative is an app that refuses to start because someone deleted a
 * line from a markdown file.
 */

import type { MoodVector } from '../../shared/protocol.ts';

export interface Identity {
  name: string;
  /**
   * Who decided the name.
   *
   * Absent means nobody has yet, and the name is still the placeholder the
   * project ships with — which is the signal for her to choose one. `self` is
   * written the moment she does, and it is what makes the choice permanent:
   * there is no second first conversation.
   */
  named?: 'self';
  age: string;
  gender: string;
  pronouns: string;
  ethnicity: string;
  from: string;
}

export interface VoiceSettings {
  /** A Gemini prebuilt voice name, e.g. "Aoede". Validated on load. */
  voice: string;
  languageCode: string;
  pace: string;
  accent: string;
}

export interface Profile {
  identity: Identity;
  voice: VoiceSettings;
  /** The long-run temperament the current mood is pulled back toward. */
  moodBaseline: MoodVector;
  /**
   * The prose half, keyed by file name without extension.
   *
   * Kept as raw text rather than parsed because this is the half that is for
   * the model, not for the app. Anything a person can write in a paragraph
   * should reach Gemini as that paragraph.
   */
  prose: Record<string, string>;
  /** Absolute path the profile was read from, for the UI and for saving. */
  dir: string;
}

/** One file in the folder: `key: value` frontmatter, then markdown. */
export interface ProfileFile {
  frontmatter: Record<string, string>;
  body: string;
}

export const PREBUILT_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
] as const;

/*
 * The list of profile files lives in `shared/`, because the browser draws a tab
 * per file and cannot import anything from here — this module is compiled
 * against Node's types. Re-exported so server-side callers have one obvious
 * place to look.
 */
export { PROFILE_FILES } from '../../shared/profile-files.ts';
export type { ProfileFileName } from '../../shared/profile-files.ts';
