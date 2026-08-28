/**
 * Whether anything has ever happened here.
 *
 * One question, asked once per connection, and the answer decides whether the
 * browser opens the first-run wizard. Getting it wrong in either direction is a
 * real cost: a wizard that reappears is an app that has forgotten you, and a
 * wizard that never appears leaves somebody looking at an empty chat box and
 * six markdown files they have never heard of.
 *
 * ## What "fresh" means, and why it is three things
 *
 * It is deliberately not one signal, for the same reason `Brain.ensureNamed`
 * refuses to be one: any single marker is either forgeable by a hand edit or
 * absent in a case that obviously is not fresh.
 *
 *  1. **She has not named herself.** The same pair of conditions `ensureNamed`
 *     uses, and read the same way round — no `named: self` marker *and* the name
 *     still being the placeholder the project ships with. Once she has chosen,
 *     a first conversation has happened by definition, and there is no second
 *     first conversation.
 *
 *  2. **Memory is empty.** No turn, no fact, no rolling summary — `hasHistory`,
 *     which asks the whole store rather than the session about to start. A
 *     profile folder that was deleted and rebuilt beside a database full of
 *     somebody's life in it is not a fresh install, and offering that person a
 *     wizard would be the same failure as telling a returning user "this is the
 *     beginning".
 *
 *  3. **The wizard has not run.** Which is the case neither of the others
 *     catches: somebody who opens the page, skips every step, and never speaks
 *     to her. Nothing about the profile changed and nothing reached memory, so
 *     without a mark of its own the wizard would be waiting again on the next
 *     reload, forever.
 *
 * ## Where the mark lives
 *
 * In `relationship.md`, as `met`. It ships as the sentence "the day they
 * installed you" and the wizard replaces it with the date that day turned out
 * to be — which is true regardless of what was answered, is a better value than
 * the one it replaces, and is legible to somebody reading the file rather than
 * being app bookkeeping parked in her character sheet.
 *
 * The default it is compared against is read out of `DEFAULT_PROFILE_FILES`
 * rather than written down here, so the two cannot drift the day somebody
 * reword that line.
 */

import { frontmatterValue } from '../../shared/frontmatter.ts';
import { DEFAULT_PROFILE_FILES } from './defaults.ts';
import { PLACEHOLDER_NAME } from './naming.ts';
import type { Identity } from './types.ts';

/**
 * Whether her name is one somebody actually chose.
 *
 * The same pair of conditions `Brain.ensureNamed` refuses to reduce to one, read
 * off a loaded profile rather than off the files: `named: self` means she chose
 * it, and any name that is not the shipped placeholder means a person typed it
 * in. Either counts. Neither means she is still unnamed, and the interface says
 * so by drawing no name.
 */
export function hasChosenName(identity: Identity): boolean {
  if (identity.named === 'self') return true;
  return identity.name.trim().toLowerCase() !== PLACEHOLDER_NAME.toLowerCase();
}

export interface FirstRunSignals {
  /**
   * The six profile files as raw markdown, keyed without the extension —
   * exactly what `readProfileFiles` returns.
   */
  files: Readonly<Record<string, string>>;
  /** True when the store holds a turn, a fact or a summary. `Brain.hasHistory`. */
  hasHistory: boolean;
}

/** The `met:` value that means nobody has been through the wizard. */
export function unmetValue(): string {
  return frontmatterValue(DEFAULT_PROFILE_FILES['relationship.md'] ?? '', 'met') ?? '';
}

export function isFirstRun({ files, hasHistory }: FirstRunSignals): boolean {
  if (hasHistory) return false;

  const identity = files.identity ?? '';
  if (frontmatterValue(identity, 'named') === 'self') return false;

  // Absent counts as the placeholder: that is what `loadProfile` falls back to,
  // and a half-written file is a case this folder is explicitly allowed to be in.
  const name = frontmatterValue(identity, 'name')?.trim();
  if (name && name.toLowerCase() !== PLACEHOLDER_NAME.toLowerCase()) return false;

  const met = frontmatterValue(files.relationship ?? '', 'met')?.trim();
  if (met && met !== unmetValue()) return false;

  return true;
}
