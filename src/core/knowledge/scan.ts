/**
 * Reading the machine, once, with permission, so she knows who she is talking to.
 *
 * The brief: *"Anna will scan the local hard drive before the conversation has
 * begun. She will ask the user if it is ok."* That second sentence is the whole
 * design and it is not decoration — this reads somebody's private documents and
 * sends excerpts to Google, so everything here exists to make that a decision
 * the user makes rather than one the software makes for them.
 *
 * Four rules, in order of how badly they matter:
 *
 *  1. **Nothing is read until they say yes**, to specific named folders. There
 *     is no default set, no "just the safe ones", and no implicit consent from
 *     having installed the app. {@link Consent} on disk is the record.
 *  2. **Secrets are never read**, whatever folder they are in. A `.env`, a
 *     private key, a wallet, anything with `password` in the name: skipped
 *     before it is opened, because the failure mode is a credential in a prompt.
 *  3. **Raw text does not become her context.** Excerpts go to the distiller,
 *     the *facts* are kept, and the text is dropped. A document read once
 *     becomes "they are a Northeastern student" rather than sixty pages living
 *     in a system instruction forever.
 *  4. **Knowing is not closeness.** Nothing here touches intimacy. She can come
 *     out of this knowing a great deal and still be a stranger at 1%, which is
 *     the point — see core/intimacy.
 *
 * ## What is actually readable
 *
 * Less than it sounds, and the limits are external rather than choices:
 *
 *   Google Docs   Not possible from disk. A `.gdoc` is a ~175-byte JSON stub
 *                 holding a URL and an id — no content — and Drive's filesystem
 *                 driver refuses programmatic reads of it. Only the *title* is
 *                 available locally; the content needs the Drive API over OAuth.
 *   Apple Mail    `.emlx` files under `~/Library/Mail`, which is behind Full
 *                 Disk Access rather than ordinary folder permission.
 *   Gmail         Cloud only. Same OAuth story as Docs.
 *   macOS         `~/Documents`, `~/Desktop` and `~/Downloads` are gated by TCC,
 *                 granted to whichever process launched Node — and the grant is
 *                 tied to the binary's path, so a Node upgrade silently revokes
 *                 it. Denials are reported with the remedy rather than swallowed.
 *
 * So this reads plain text: `.txt`, `.md`, `.rtf`, `.csv`, `.json` and the like,
 * plus the names of everything else. Names alone are worth more than they look —
 * a folder of files called `neu-transcript.pdf` and `co-op-cover-letter.docx`
 * describes somebody quite well without a single byte being opened.
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** File contents worth reading. Everything else contributes its name only. */
const READABLE = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rtf',
  '.csv',
  '.tsv',
  '.json',
  '.yml',
  '.yaml',
  '.org',
  '.tex',
  '.eml',
  '.emlx',
]);

/**
 * Never opened, whatever folder they are in and whatever was consented to.
 *
 * Checked against the lower-cased file name, so `.env.local` and
 * `Copy of id_rsa` are both caught. This list is the difference between a
 * feature and an incident.
 */
const SECRETS = [
  '.env',
  '.pem',
  '.key',
  '.keystore',
  '.p12',
  '.pfx',
  '.ppk',
  '.kdbx',
  '.jks',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'credential',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'wallet',
  'seed-phrase',
  'seedphrase',
  'mnemonic',
  'recovery-code',
  '.ssh',
  '.gnupg',
  '.aws',
  'keychain',
];

/** Directories that are never worth walking into. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.cache',
  'caches',
  '.npm',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
  '.gradle',
  'library',
  'applications',
  'system',
  '.trash',
  '.ssh',
  '.gnupg',
  '.aws',
  '.config',
  '.local',
]);

export const SCAN_LIMITS = {
  /** Directory depth below each approved folder. */
  depth: 4,
  /** Files whose names are collected. */
  maxFiles: 4000,
  /** Files whose contents are opened. */
  maxRead: 300,
  /** Bytes taken from any one file. The opening of a document says what it is. */
  excerptBytes: 4000,
  /** Total characters handed to the distiller across the whole scan. */
  totalChars: 120_000,
} as const;

export interface ScanFinding {
  /** Relative to the folder it was found in, so no home path is in a prompt. */
  name: string;
  /** Empty when only the name was taken. */
  excerpt: string;
}

export interface ScanReport {
  findings: ScanFinding[];
  /** Files seen, whether or not they were opened. */
  seen: number;
  /** Files whose contents were read. */
  read: number;
  /** Files skipped for looking like a credential. */
  refused: number;
  /**
   * Folders that could not be listed, with the reason.
   *
   * Reported rather than swallowed: on macOS this is the ordinary case until
   * the user grants access, and "she knows nothing about you" with no
   * explanation is indistinguishable from the feature being broken.
   */
  denied: { folder: string; reason: string }[];
}

/** What the user agreed to, written next to her profile so it is auditable. */
export interface Consent {
  /** Absolute folders, exactly as approved. */
  folders: string[];
  /** When they said yes. 0 when they never have. */
  at: number;
  /** When the last scan finished. 0 when it has not run. */
  scannedAt: number;
}

const CONSENT_FILE = 'knowledge.json';

export async function readConsent(dir: string): Promise<Consent> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dir, CONSENT_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return noConsent();
    const raw = parsed as Partial<Consent>;
    return {
      folders: Array.isArray(raw.folders) ? raw.folders.filter((f) => typeof f === 'string') : [],
      at: typeof raw.at === 'number' ? raw.at : 0,
      scannedAt: typeof raw.scannedAt === 'number' ? raw.scannedAt : 0,
    };
  } catch {
    return noConsent();
  }
}

export async function writeConsent(dir: string, consent: Consent): Promise<void> {
  await writeFile(path.join(dir, CONSENT_FILE), JSON.stringify(consent, null, 2), 'utf8');
}

function noConsent(): Consent {
  return { folders: [], at: 0, scannedAt: 0 };
}

/**
 * True for a name that must never be opened.
 *
 * Substring rather than extension matching, because the dangerous cases are not
 * tidy: `.env.production`, `aws-credentials-old.txt`, `Copy of id_rsa`.
 */
export function looksLikeSecret(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRETS.some((marker) => lower.includes(marker));
}

/**
 * Walks the approved folders and comes back with names and excerpts.
 *
 * Bounded on every axis — depth, file count, bytes per file, total characters —
 * because the input is somebody's whole home directory and the output has to fit
 * in a model call. It reads the beginning of each file rather than sampling
 * through it: the first paragraph of a document is what tells you what it is.
 */
export async function scanFolders(folders: readonly string[]): Promise<ScanReport> {
  const report: ScanReport = { findings: [], seen: 0, read: 0, refused: 0, denied: [] };
  let characters = 0;

  for (const folder of folders) {
    const root = path.resolve(folder);
    try {
      await stat(root);
    } catch (error) {
      report.denied.push({ folder: root, reason: explain(error) });
      continue;
    }

    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
      const { dir, depth } = queue.shift()!;
      if (report.seen >= SCAN_LIMITS.maxFiles) break;

      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        // Only worth reporting for the folder they actually chose; a single
        // unreadable subdirectory inside it is noise.
        if (dir === root) report.denied.push({ folder: dir, reason: explain(error) });
        continue;
      }

      for (const entry of entries) {
        if (report.seen >= SCAN_LIMITS.maxFiles) break;
        const name = entry.name;
        if (name.startsWith('.') && entry.isDirectory()) continue;

        if (entry.isDirectory()) {
          if (depth + 1 > SCAN_LIMITS.depth) continue;
          if (SKIP_DIRS.has(name.toLowerCase())) continue;
          queue.push({ dir: path.join(dir, name), depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;

        report.seen += 1;
        if (looksLikeSecret(name)) {
          report.refused += 1;
          continue;
        }

        const relative = path.relative(root, path.join(dir, name));
        const extension = path.extname(name).toLowerCase();
        const readable =
          READABLE.has(extension) &&
          report.read < SCAN_LIMITS.maxRead &&
          characters < SCAN_LIMITS.totalChars;

        if (!readable) {
          report.findings.push({ name: relative, excerpt: '' });
          continue;
        }

        try {
          const handle = await readFile(path.join(dir, name), 'utf8');
          const excerpt = tidy(handle.slice(0, SCAN_LIMITS.excerptBytes));
          report.read += 1;
          characters += excerpt.length;
          report.findings.push({ name: relative, excerpt });
        } catch {
          // Unreadable for any reason is the same as name-only. A `.gdoc` lands
          // here: Drive's driver refuses the read outright.
          report.findings.push({ name: relative, excerpt: '' });
        }
      }
    }
  }

  return report;
}

/**
 * The scan, as one block of text for the distiller.
 *
 * Names first and then excerpts, because the names alone are a surprisingly good
 * summary of a person and they survive the truncation if the excerpts do not.
 */
export function describeScan(report: ScanReport): string {
  const lines = ['FILES ON THIS MACHINE', ''];
  for (const finding of report.findings) lines.push(`- ${finding.name}`);

  const withText = report.findings.filter((finding) => finding.excerpt);
  if (withText.length > 0) {
    lines.push('', 'EXCERPTS', '');
    for (const finding of withText) {
      lines.push(`--- ${finding.name} ---`, finding.excerpt, '');
    }
  }
  return lines.join('\n');
}

/** Turns a denial into the thing that fixes it. */
export function explain(error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? '';
  if (code === 'EPERM' || code === 'EACCES') {
    return process.platform === 'darwin'
      ? 'macOS refused it. System Settings -> Privacy & Security -> Full Disk Access, ' +
          'and add the app you start Anna from (Terminal, iTerm, or your editor). The ' +
          'grant follows the Node binary, so a Node upgrade silently revokes it.'
      : 'The operating system refused it. Check the folder permissions.';
  }
  if (code === 'ENOENT') return 'There is nothing at that path.';
  return error instanceof Error ? error.message : String(error);
}

function tidy(text: string): string {
  // Collapse the whitespace an exported document is full of, so the character
  // budget buys words rather than indentation.
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
