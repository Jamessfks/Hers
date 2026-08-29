import { existsSync } from 'node:fs';
import path from 'node:path';
import { RHYTHM_FILE } from '../sleep/rhythm.ts';
import { isPlaceholderName } from './naming.ts';
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
  return !isPlaceholderName(identity.name);
}

/**
 * Whether the setup interview still has to happen.
 *
 * `rhythm.md` is the marker, and it is the marker because of what it is: the
 * last thing `setup/compose.ts` writes, and the only profile file the user
 * cannot create by hand or by editing. Everything else in the folder is written
 * by `ensureProfile` on the first start, so its presence proves nothing.
 *
 * The consequence, and it is the intended one: an interview that was abandoned
 * halfway — the browser closed while she was asking about the device scan —
 * resumes rather than leaving a half-composed companion nobody chose.
 */
export function isFirstRun(profileDir: string): boolean {
  return !existsSync(path.join(profileDir, RHYTHM_FILE));
}
