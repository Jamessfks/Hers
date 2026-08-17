/**
 * Reading and writing the personalization folder.
 *
 * The contract this module keeps, and the reason it is more defensive than it
 * looks: **loading a profile can fail in a hundred small ways and none of them
 * may stop Anna from waking up.** The folder is meant to be edited by hand, in
 * a text editor, by someone who is not thinking about parsers. A stray tab in
 * the frontmatter, a deleted file, a number written as "0,5" — every one of
 * those falls back to a default and gets on with it.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MoodVector } from '../../shared/protocol.ts';
import { DEFAULT_PROFILE_FILES, GALLERY_README } from './defaults.ts';
import { PREBUILT_VOICES, PROFILE_FILES } from './types.ts';
import { PLACEHOLDER_NAME } from './naming.ts';
import type { Profile, ProfileFile } from './types.ts';

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Parses `---` delimited `key: value` frontmatter.
 *
 * Not YAML. A real YAML parser is a dependency and a class of surprises (`no`
 * becoming `false`, `5:6` becoming a sexagesimal number) in exchange for
 * nesting nobody writing a character sheet needs. Keys are lowercased and
 * underscores are collapsed so `eye_color`, `eye color` and `Eye_Color` are the
 * same key — because all three will be typed.
 */
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

function normaliseKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function serialiseProfileFile(file: ProfileFile): string {
  const keys = Object.keys(file.frontmatter);
  if (keys.length === 0) return `${file.body.trim()}\n`;
  const header = keys.map((key) => `${key}: ${file.frontmatter[key]}`).join('\n');
  return `---\n${header}\n---\n\n${file.body.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Creates the folder and fills in anything missing, then reads it back.
 *
 * Missing files are written rather than merely defaulted in memory: the whole
 * point of a personalization *folder* is that you can open it and see what she
 * is made of, and a file that only exists inside the process is not that.
 */
export async function ensureProfile(dir: string): Promise<Profile> {
  await mkdir(path.join(dir, 'gallery'), { recursive: true });

  for (const [name, contents] of Object.entries(DEFAULT_PROFILE_FILES)) {
    const target = path.join(dir, name);
    if (!existsSync(target)) await writeFile(target, contents, 'utf8');
  }
  const galleryReadme = path.join(dir, 'gallery', 'README.md');
  if (!existsSync(galleryReadme)) await writeFile(galleryReadme, GALLERY_README, 'utf8');

  return loadProfile(dir);
}

export async function loadProfile(dir: string): Promise<Profile> {
  const files = new Map<string, ProfileFile>();

  for (const name of PROFILE_FILES) {
    const raw = await readOrDefault(dir, `${name}.md`);
    files.set(name, parseProfileFile(raw));
  }

  const identity = files.get('identity')?.frontmatter ?? {};
  const voice = files.get('voice')?.frontmatter ?? {};
  const mood = files.get('mood')?.frontmatter ?? {};

  const prose: Record<string, string> = {};
  for (const [name, file] of files) if (file.body) prose[name] = file.body;

  return {
    dir,
    identity: {
      name: text(identity.name, PLACEHOLDER_NAME),
      ...(identity.named === 'self' ? { named: 'self' as const } : {}),
      age: text(identity.age, '26'),
      gender: text(identity.gender, 'female'),
      pronouns: text(identity.pronouns, 'she/her'),
      ethnicity: text(identity.ethnicity, 'Chinese-American'),
      from: text(identity.from, 'Oakland, California'),
    },
    voice: {
      voice: pickVoice(voice.voice),
      languageCode: text(voice.language_code, 'en-US'),
      pace: text(voice.pace, 'unhurried'),
      accent: text(voice.accent, 'General American'),
    },
    moodBaseline: {
      valence: number(mood.baseline_valence, 0.25),
      energy: number(mood.baseline_energy, 0.1),
      warmth: number(mood.baseline_warmth, 0.55),
      interest: number(mood.baseline_interest, 0.4),
    },
    prose,
  };
}

/** How hard events move her, from `mood.md`. Read separately: the mood engine owns it. */
export async function loadVolatility(dir: string): Promise<number> {
  const { frontmatter } = parseProfileFile(await readOrDefault(dir, 'mood.md'));
  return clamp(number(frontmatter.volatility, 0.5), 0, 1);
}

/**
 * Writes edited files back.
 *
 * Only names the loader already knows are accepted, and only as flat files in
 * the profile directory. The UI is served over HTTP on localhost and a message
 * saying `{"../../.ssh/authorized_keys": "..."}` must not become a file write.
 */
export async function saveProfileFiles(
  dir: string,
  files: Record<string, string>,
): Promise<string[]> {
  const written: string[] = [];
  for (const [rawName, contents] of Object.entries(files)) {
    const name = path.basename(rawName);
    const stem = name.replace(/\.md$/i, '');
    if (!(PROFILE_FILES as readonly string[]).includes(stem)) continue;
    if (typeof contents !== 'string' || contents.length > 200_000) continue;
    await writeFile(path.join(dir, `${stem}.md`), contents.replace(/\r\n/g, '\n'), 'utf8');
    written.push(stem);
  }
  return written;
}

/** The profile folder as raw text, for the editor in the UI. */
export async function readProfileFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of PROFILE_FILES) out[name] = await readOrDefault(dir, `${name}.md`);
  return out;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

async function readOrDefault(dir: string, file: string): Promise<string> {
  try {
    const raw = await readFile(path.join(dir, file), 'utf8');
    if (raw.trim()) return raw;
  } catch {
    // Falls through to the shipped default.
  }
  return DEFAULT_PROFILE_FILES[file] ?? '';
}

function text(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

/**
 * Accepts a decimal comma, because half the world types one, and refuses
 * anything that is not finite rather than letting NaN reach the mood engine
 * where it would poison every subsequent blend.
 */
function number(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? clamp(parsed, -1, 1) : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Case-insensitive, because "aoede" is what people type. */
function pickVoice(value: string | undefined): string {
  const wanted = value?.trim().toLowerCase();
  if (!wanted) return 'Aoede';
  return PREBUILT_VOICES.find((voice) => voice.toLowerCase() === wanted) ?? 'Aoede';
}

/**
 * Writes the name she chose, and nothing else.
 *
 * Reads `identity.md`, changes two frontmatter keys and puts the rest back
 * exactly as it was — prose, comments, ordering, any key this program has never
 * heard of. A `saveProfileFiles` round trip would have been shorter and would
 * have rewritten a file the user is invited to edit, on a path where they are
 * not the one doing the editing.
 *
 * The reason goes in as a comment rather than as data: it is hers, it explains
 * the file to whoever opens it, and nothing reads it back.
 */
export async function writeChosenName(dir: string, name: string, why: string): Promise<void> {
  const file = path.join(dir, 'identity.md');
  const parsed = parseProfileFile(await readOrDefault(dir, 'identity.md'));

  parsed.frontmatter.name = name;
  parsed.frontmatter.named = 'self';

  const note = why ? `She chose this name herself. ${why}` : 'She chose this name herself.';
  const body = parsed.body.includes('She chose this name herself')
    ? parsed.body
    : `<!-- ${note} -->\n\n${parsed.body}`.trim();

  await writeFile(file, serialiseProfileFile({ ...parsed, body }), 'utf8');
}
