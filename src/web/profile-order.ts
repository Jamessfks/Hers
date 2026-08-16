/**
 * The order the profile tabs appear in.
 *
 * There is no `appearance` entry: what she looks like is the photograph, which
 * lives behind the Face panel rather than in a text file.
 *
 * A copy rather than an import of `core/profile/types.ts`, because that module
 * is server-side and importing it here would drag Node types into the browser
 * bundle. It is a list of seven strings that changes when a profile file is
 * added, and `profile-order.test.ts` fails if the two ever disagree.
 */
export const PROFILE_ORDER = [
  'personality',
  'identity',
  'voice',
  'mood',
  'relationship',
  'boundaries',
] as const;
