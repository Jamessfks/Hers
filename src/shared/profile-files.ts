/**
 * The files that make up her profile, in the order the editor shows them.
 *
 * This lives in `shared/` because both halves need it and neither owns it: the
 * server reads these files off disk, and the browser draws a tab per file. It
 * used to be two lists — one in `core/profile/types.ts` and a hand-copied one in
 * `web/` — with a test whose entire job was to notice when they drifted apart.
 * A list of six strings does not need a guard; it needs one copy.
 *
 * The order is the order of the tabs, which is roughly how much each one
 * changes who she is.
 *
 * There is no `appearance` entry, deliberately. What she looks like is the
 * photograph the user uploaded — the same one the interface shows and every
 * generated picture of her starts from — and a written description beside it is
 * a second answer to a question that already has one. When the two disagreed,
 * visibly: generated pictures kept the face from the photograph and the hair
 * from the prose.
 */
export const PROFILE_FILES = [
  'personality',
  'identity',
  'voice',
  'mood',
  'relationship',
  'boundaries',
] as const;

export type ProfileFileName = (typeof PROFILE_FILES)[number];
