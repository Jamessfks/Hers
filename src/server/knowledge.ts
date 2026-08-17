/**
 * Turning a consented scan of the machine into things she remembers.
 *
 * The scan itself is in `core/knowledge/scan.ts` and knows nothing about models
 * or memory; this is the part that asks Gemini what any of it means and writes
 * the answers down. Split that way because the scan is the part with the
 * privacy consequences and it should be readable on its own.
 *
 * Two properties worth stating, because both are load-bearing:
 *
 *   **The raw text does not survive.** Excerpts go into one model call and the
 *   *facts* come out. Nothing keeps sixty pages of somebody's dissertation in a
 *   system instruction forever, and nothing writes it to disk.
 *
 *   **This cannot make her feel closer.** It writes memories, and memories are
 *   not intimacy — see `core/intimacy`. She can finish this knowing where
 *   somebody studies, what they are applying for and who their sister is, and
 *   she is still a stranger at 1% who has not earned the right to tease them.
 */

import type { Brain } from '../core/session/brain.ts';
import { createGeminiDistiller } from '../core/gemini/text.ts';
import { parseExtraction } from '../core/memory/memory.ts';
import { describeScan, readConsent, scanFolders, writeConsent } from '../core/knowledge/scan.ts';
import type { ScanReport } from '../core/knowledge/scan.ts';

/**
 * What she is asked to take from somebody's files.
 *
 * Written to produce the kind of fact a person would actually retain about a
 * friend, and to refuse the kind that is merely present in a document. A scan of
 * a home directory contains a great deal that is true and nothing to do with
 * who the person is, and a memory full of that is worse than no memory: it
 * crowds out the eight facts that matter with four hundred that do not.
 */
const SCAN_PROMPT = `You are reading a list of files from someone's computer, and short excerpts
from some of them. They gave permission for this. Your job is to work out who this person is.

Write only durable facts about the *person* — what they do, where they study or work, what
they are working towards, who matters to them, what they care about, what they are worried
about. A fact is worth keeping only if it would still be true and still be worth knowing in
six months.

Ignore anything that is merely present in a file rather than true of the person: software,
file formats, boilerplate, other people's documents, anything you are guessing at. If a file
name is the only evidence, you may use it, but do not invent detail around it.

Never record credentials, account numbers, addresses, or medical details.

At most 12 facts. Reply in exactly this shape and nothing else:

FACTS
identity | 0.8 | they are a computer science student at Northeastern
thread | 0.7 | they are applying for a 2027 co-op

SUMMARY
Two or three sentences on who this person appears to be.

The kind comes first, then the confidence, then the sentence. Valid kinds are exactly:
identity, preference, thread, event, pattern. Confidence is 0 to 1 — use 0.6 or below for
anything inferred from a file name alone.`;

/**
 * Room for twelve facts and a summary, on a model that thinks first.
 *
 * The distiller's default budget is sized for a consolidation pass, and Gemini 3
 * spends part of any output budget on thinking before it writes anything. At the
 * default this reply came back cut off mid-line — two facts, the second one
 * ending at its separator — which parsed to one nonsense memory.
 */
const SCAN_OUTPUT_TOKENS = 3000;

export interface KnowledgeState {
  /** Folders she has been allowed to read. Empty means she has never asked. */
  folders: string[];
  /** When permission was given. 0 when it never was. */
  at: number;
  /** When the last scan finished. 0 when none has. */
  scannedAt: number;
}

export async function knowledgeState(brain: Brain): Promise<KnowledgeState> {
  return readConsent(brain.config.profileDir);
}

export interface ScanOutcome {
  ok: boolean;
  error?: string;
  /** Facts written. */
  learned: number;
  seen: number;
  read: number;
  refused: number;
  denied: { folder: string; reason: string }[];
}

/**
 * Records the permission, walks the folders, and remembers what it finds.
 *
 * The permission is written *before* the scan runs, so a scan interrupted
 * halfway leaves a record of what was agreed to rather than a folder list that
 * exists only in a request that is now gone.
 */
export async function runScan(brain: Brain, folders: readonly string[]): Promise<ScanOutcome> {
  const chosen = folders.map((folder) => folder.trim()).filter(Boolean);
  if (chosen.length === 0) {
    return { ok: false, error: 'No folders were chosen.', learned: 0, seen: 0, read: 0, refused: 0, denied: [] };
  }

  const now = Date.now();
  await writeConsent(brain.config.profileDir, { folders: chosen, at: now, scannedAt: 0 });

  let report: ScanReport;
  try {
    report = await scanFolders(chosen);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      learned: 0,
      seen: 0,
      read: 0,
      refused: 0,
      denied: [],
    };
  }

  const outcome: ScanOutcome = {
    ok: true,
    learned: 0,
    seen: report.seen,
    read: report.read,
    refused: report.refused,
    denied: report.denied,
  };

  if (report.findings.length === 0 || !brain.config.geminiApiKey) {
    await writeConsent(brain.config.profileDir, { folders: chosen, at: now, scannedAt: Date.now() });
    if (!brain.config.geminiApiKey) outcome.error = 'No Gemini key, so nothing could be read for meaning.';
    return outcome;
  }

  try {
    const distiller = createGeminiDistiller(
      brain.config.geminiApiKey,
      undefined,
      SCAN_OUTPUT_TOKENS,
    );
    const parsed = parseExtraction(await distiller.distil(SCAN_PROMPT, describeScan(report)));
    for (const fact of parsed.facts) {
      // Capped below certainty whatever the model says. These were inferred from
      // documents rather than heard from the person, and a fact she was told
      // should always outrank one she deduced.
      await brain.memory.remember(fact.kind, fact.text, {
        confidence: Math.min(0.8, fact.confidence),
      });
      outcome.learned += 1;
    }
  } catch (error) {
    outcome.error = `The files were read but could not be made sense of: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  await writeConsent(brain.config.profileDir, { folders: chosen, at: now, scannedAt: Date.now() });
  return outcome;
}

/** Somewhere sensible to offer, in the order a person would expect. */
export function suggestedFolders(home: string): string[] {
  return ['Documents', 'Desktop', 'Downloads'].map((name) => `${home}/${name}`);
}
