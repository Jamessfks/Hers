/**
 * macOS sensors: what the user is doing, and what is coming up.
 *
 * These are deliberately the cheapest possible readings. Anna does not need a
 * keylogger or an accessibility tree walk to know someone has been stuck; she
 * needs the frontmost app, how long since the last keypress, and the next thing
 * on the calendar. Everything richer costs privacy we have no use for.
 *
 * Permissions, and what happens without them:
 *
 *   HID idle time      no permission needed, always works
 *   frontmost app      needs Accessibility; without it we report nothing
 *   window title       needs Accessibility; often withheld by the app anyway
 *   calendar           needs Calendars access; without it we report nothing
 *
 * Every reader here fails soft. A denied permission makes Anna less observant,
 * never broken, and never nagging.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Sensors are polled, so a hung `osascript` must not wedge the poll loop. */
const TIMEOUT_MS = 4000;

export interface ActivityReading {
  app: string;
  windowTitle: string;
  idleSeconds: number;
}

/**
 * Seconds since the last keyboard or mouse event, from the HID system.
 *
 * This is the one reading that is always available and always accurate, which
 * makes it the backbone of presence detection: no camera required to know
 * somebody walked away.
 */
export async function readIdleSeconds(): Promise<number> {
  try {
    // `-r` roots the search at the matched class. Without it, `-d 1` limits
    // depth from the registry root and the properties we want are never
    // printed — a silent zero rather than an error.
    const { stdout } = await run('/usr/sbin/ioreg', ['-r', '-c', 'IOHIDSystem', '-d', '1'], {
      timeout: TIMEOUT_MS,
    });
    const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
    if (!match?.[1]) return 0;
    return Number(match[1]) / 1e9; // nanoseconds
  } catch {
    return 0;
  }
}

const FRONTMOST_SCRIPT = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  try
    set winName to name of front window of frontApp
  on error
    set winName to ""
  end try
end tell
return appName & "\\n" & winName
`;

/** Frontmost app and window title. Returns null when Accessibility is denied. */
export async function readFrontmost(): Promise<{ app: string; windowTitle: string } | null> {
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-e', FRONTMOST_SCRIPT], {
      timeout: TIMEOUT_MS,
    });
    const [app = '', windowTitle = ''] = stdout.trim().split('\n');
    if (!app) return null;
    return { app, windowTitle: windowTitle.trim() };
  } catch {
    return null;
  }
}

export async function readActivity(): Promise<ActivityReading | null> {
  const [idleSeconds, frontmost] = await Promise.all([readIdleSeconds(), readFrontmost()]);
  if (!frontmost) return null;
  return { ...frontmost, idleSeconds };
}

const CALENDAR_SCRIPT = `
set output to ""
set nowDate to current date
set horizon to nowDate + (4 * hours)
tell application "Calendar"
  repeat with cal in calendars
    tell cal
      set upcoming to (every event whose start date > nowDate and start date < horizon)
      repeat with ev in upcoming
        set output to output & (summary of ev) & "\\t" & ((start date of ev) - nowDate) & "\\n"
      end repeat
    end tell
  end repeat
end tell
return output
`;

export interface CalendarReading {
  summary: string;
  startsInMinutes: number;
}

/**
 * The next event in the following four hours.
 *
 * Polled rarely — this drives an AppleScript round-trip into Calendar.app,
 * which is slow and, on a large calendar, not free. Once every ten minutes is
 * plenty: the trigger that uses it fires at twelve minutes out.
 */
export async function readNextEvent(): Promise<CalendarReading | null> {
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-e', CALENDAR_SCRIPT], {
      timeout: TIMEOUT_MS * 3,
    });
    const events = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [summary = '', seconds = '0'] = line.split('\t');
        return { summary: summary.trim(), startsInMinutes: Math.round(Number(seconds) / 60) };
      })
      .filter((event) => event.summary && Number.isFinite(event.startsInMinutes))
      .sort((a, b) => a.startsInMinutes - b.startsInMinutes);
    return events[0] ?? null;
  } catch {
    return null;
  }
}
