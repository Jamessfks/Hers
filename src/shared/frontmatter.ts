/**
 * Reading and writing the `key: value` block at the top of a profile file.
 *
 * Moved here from `core/profile/` when the voice menu arrived: the browser needs
 * to change one frontmatter key without disturbing the prose under it, and a
 * second implementation in `web/` would be a second set of rules about what a
 * profile file is. `core/profile/profile.ts` re-exports these, so server-side
 * callers still have one obvious place to look.
 *
 * Not YAML, deliberately. A real YAML parser is a dependency and a class of
 * surprises (`no` becoming `false`, `5:6` becoming a sexagesimal number) in
 * exchange for nesting nobody writing a character sheet needs.
 */

/** One file in the folder: `key: value` frontmatter, then markdown. */
export interface ProfileFile {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Keys are lowercased and separators collapsed, so `eye_color`, `eye color` and
 * `Eye_Color` are the same key — because all three will be typed.
 */
function normaliseKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function parseProfileFile(raw: string): ProfileFile {
  const frontmatter: Record<string, string> = {};
  const normalised = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');

  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalised);
  if (!match) return { frontmatter, body: normalised.trim() };

  for (const line of (match[1] ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = normaliseKey(trimmed.slice(0, colon));
    const value = trimmed
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body: normalised.slice(match[0].length).trim() };
}

export function serialiseProfileFile(file: ProfileFile): string {
  const keys = Object.keys(file.frontmatter);
  if (keys.length === 0) return `${file.body.trim()}\n`;
  const header = keys.map((key) => `${key}: ${file.frontmatter[key]}`).join('\n');
  return `---\n${header}\n---\n\n${file.body.trim()}\n`;
}

/**
 * Changes one key and puts everything else back.
 *
 * A round trip through parse and serialise, which is the point: the prose, the
 * comments and every key this program has never heard of survive, and the file
 * stays something a person can keep editing by hand after a menu has touched
 * it. A file with no frontmatter at all gains a block containing just this key
 * rather than being refused — the profile folder is allowed to be half-written.
 */
export function setFrontmatterValue(raw: string, key: string, value: string): string {
  const parsed = parseProfileFile(raw);
  parsed.frontmatter[normaliseKey(key)] = value.trim();
  return serialiseProfileFile(parsed);
}

/** The value of one key, or `undefined`. Case and separators are forgiving. */
export function frontmatterValue(raw: string, key: string): string | undefined {
  return parseProfileFile(raw).frontmatter[normaliseKey(key)];
}
