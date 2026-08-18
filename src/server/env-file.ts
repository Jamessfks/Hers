/**
 * Writing one value into `.env` without disturbing the rest of it.
 *
 * The website can be given an API key, and the key has to survive a restart, so
 * something has to write it down. `.env` is where every other secret in this
 * project already lives and where Google's own guidance points — *"read keys
 * from environment variables rather than configuration files"* — so this
 * rewrites that one file rather than inventing a second place to look.
 *
 * Two rules, both about not being clever:
 *
 *   **Only the matching line is touched.** Comments, blank lines, ordering and
 *   every other variable come back exactly as they were. Parsing the whole file
 *   and re-emitting it would mean owning the quoting rules for values this code
 *   has no business understanding.
 *
 *   **Values that would need quoting are refused rather than escaped.** An API
 *   key is alphanumeric with dashes; a value with a space, a quote or a `#` in
 *   it is a mistake, and guessing at the escaping is how a file that reads back
 *   subtly wrong gets written.
 */

import { chmod, readFile, writeFile } from 'node:fs/promises';

/**
 * What may appear in a value written from here.
 *
 * Gemini keys are `AIza…`, Telegram tokens are `1234:AA…`, LiveKit URLs have
 * slashes and dots. Everything this program stores fits.
 */
const SAFE_VALUE = /^[A-Za-z0-9_\-.:/@+]+$/;

export class EnvFileError extends Error {}

/**
 * Sets `name=value`, creating the file if it is not there.
 *
 * The file is written with owner-only permissions. That is close to meaningless
 * on a single-user laptop and exactly right on anything else, and it costs one
 * syscall.
 */
export async function setEnvValue(file: string, name: string, value: string): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new EnvFileError(`${name} is not a variable name.`);
  if (!SAFE_VALUE.test(value)) {
    throw new EnvFileError(
      'That value has characters in it that do not belong in a key — a space, a quote or a #. Check for something that came along with a copy and paste.',
    );
  }

  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    // No file yet. The normal case on a first run.
  }

  await writeFile(file, replaceOrAppend(existing, name, value), 'utf8');
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows, or a filesystem with no permission bits. Not worth failing over.
  }
}

// ---------------------------------------------------------------------------

function replaceOrAppend(contents: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const lines = contents.split(/\r?\n/);

  let replaced = false;
  for (const [index, each] of lines.entries()) {
    if (!lineSets(each, name)) continue;
    lines[index] = line;
    replaced = true;
    // Keep going: a file with the variable set twice would otherwise still have
    // the stale one, and the last assignment is the one that wins when read.
  }

  if (!replaced) {
    // Land on its own line whatever the file ended with.
    if (lines.at(-1)?.trim() !== '') lines.push('');
    lines[lines.length - 1] = line;
    lines.push('');
  }

  return lines.join('\n');
}

/** True for `NAME=…`, `export NAME=…` and leading whitespace; false for comments. */
function lineSets(line: string, name: string): boolean {
  return new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line);
}
