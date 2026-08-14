/**
 * What Anna is actually allowed to do.
 *
 * `Info.plist` says what an app *may* ask for. It says nothing about what the
 * user granted, and macOS gives no notification when a permission is revoked —
 * the call simply starts failing. Anna's sensors all fail soft by design, which
 * is correct behaviour and terrible diagnostics: she quietly stops noticing
 * what app you are in and never mentions it.
 *
 * So the settings screen probes for real. Each check is the cheapest genuine
 * call that the permission gates, which is the only thing that distinguishes
 * "denied" from "nothing to report".
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { systemPreferences } from 'electron';

import type { PermissionReport, PermissionState } from '../../shared/protocol.ts';

const run = promisify(execFile);
const TIMEOUT_MS = 5000;

/**
 * Accessibility, via the API that answers the question directly.
 *
 * `prompt: false` matters — passing true pops the system dialog as a side
 * effect of *reading* the setting, which is a hostile thing for a settings
 * screen to do on load.
 */
function hasAccessibility(): boolean {
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return false;
  }
}

/**
 * Calendar access, by counting calendars.
 *
 * Deliberately not "read the next event": an empty calendar and a denied
 * permission both return nothing, and reporting "denied" to someone whose
 * afternoon is simply free would send them into System Settings for no reason.
 * Counting calendars separates the two — a denied app cannot count them either.
 *
 * **This probe prompts.** There is no non-prompting way to ask macOS whether an
 * app has calendar access; touching Calendar at all is what triggers consent.
 * So it only runs once the user has already switched the calendar sense on,
 * which is the moment they expect to be asked. Running it eagerly means the
 * settings window pops a consent dialog the first time it opens, for a feature
 * that is off by default — precisely the behaviour that teaches people to hit
 * Don't Allow on reflex.
 */
async function hasCalendar(): Promise<boolean> {
  try {
    const { stdout } = await run(
      '/usr/bin/osascript',
      ['-e', 'tell application "Calendar" to return (count of calendars)'],
      { timeout: TIMEOUT_MS },
    );
    return Number.isFinite(Number(stdout.trim()));
  } catch {
    return false;
  }
}

export interface ProbeOptions {
  /** Only true when the calendar sense is already enabled. See hasCalendar. */
  probeCalendar: boolean;
}

export async function readPermissions(options: ProbeOptions): Promise<PermissionReport> {
  return {
    accessibility: hasAccessibility(),
    calendar: options.probeCalendar ? ((await hasCalendar()) ? 'granted' : 'denied') : 'not-determined',
    camera: mediaStatus('camera'),
    microphone: mediaStatus('microphone'),
  };
}

function mediaStatus(kind: 'camera' | 'microphone'): PermissionState {
  try {
    const status = systemPreferences.getMediaAccessStatus(kind);
    if (status === 'granted' || status === 'denied' || status === 'not-determined') return status;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
