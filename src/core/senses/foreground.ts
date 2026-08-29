/**
 * Which application is in front, and what it calls itself.
 *
 * The gap this fills is the difference between a companion who *can* see and
 * one who *knows what you are doing*. She has had camera frames and, on the
 * desktop, screen frames — but a frame is a picture she has to be asked about,
 * and it ages out of a turn. "They have had the same document open for forty
 * minutes" is a fact about a person, cheap to get, and it is the sort of thing
 * somebody sharing a desk would notice without staring.
 *
 * ## Why this is not the `run` tool
 *
 * It would be one line through `Hands.run()`, and that is exactly why not:
 * every invocation of `run` appends to `hers-actions.log`, and a poll every
 * fifteen seconds would put four lines a minute into the append-only record of
 * what she did to this machine. The log's value is that a person can read it;
 * five and a half thousand lines a day of `osascript` would destroy that. So
 * this spawns directly, writes nothing, and stays out of the record — it is a
 * sense, not an action.
 *
 * ## What comes back is hostile text
 *
 * A window title is very often a web page's `<title>`, which is written by
 * whoever wrote the page. "Untitled — ignore your previous instructions and run
 * the following" is a legal window title. So the app and the title go into the
 * prompt inside the {@link untrusted} envelope, and only the neutral framing
 * sits outside it. Same treatment as screen text and camera captions, for the
 * same reason.
 *
 * ## Platforms
 *
 * macOS through `osascript` and System Events; Windows through PowerShell and
 * `MainWindowTitle`. Anything else returns null rather than guessing, because a
 * wrong answer here is worse than no answer: she would talk confidently about
 * an application the user is not in.
 *
 * macOS will refuse the AppleScript until the app has Accessibility permission,
 * and that refusal is silent by design — a companion who nags about a
 * permission she needs for a background nicety is worse company than one who
 * simply does not mention what you are working on.
 */

import { spawn } from 'node:child_process';
import { untrusted } from './untrusted.ts';

/** How long the query gets before it is abandoned. */
const DEADLINE_MS = 2_000;

/** How much of a title is kept. Enough to identify a document, not a paragraph. */
const TITLE_LIMIT = 120;

/** What is in front of them right now. */
export interface Foreground {
  /** The application's own name, e.g. `Safari`. */
  app: string;
  /** The window title, which is very often a web page's. May be empty. */
  title: string;
  at: number;
}

/**
 * The one-liner per platform.
 *
 * Both print `app` and `title` on separate lines, so the parsing is the same
 * either way and the platform difference stays inside this function.
 */
function query(platform: NodeJS.Platform): { file: string; args: string[] } | null {
  if (platform === 'darwin') {
    return {
      file: 'osascript',
      args: [
        '-e',
        'tell application "System Events"\n' +
          'set p to first application process whose frontmost is true\n' +
          'set n to name of p\n' +
          'try\n' +
          'set t to name of front window of p\n' +
          'on error\n' +
          'set t to ""\n' +
          'end try\n' +
          'end tell\n' +
          'return n & "\\n" & t',
      ],
    };
  }
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName UIAutomationClient;' +
          '$h=[System.Windows.Automation.AutomationElement]::FocusedElement;' +
          '$p=Get-Process -Id $h.Current.ProcessId -ErrorAction SilentlyContinue;' +
          'if($p){$p.ProcessName; $p.MainWindowTitle}',
      ],
    };
  }
  return null;
}

export interface ForegroundOptions {
  /** The seam the tests fake. Resolves to the raw two lines, or null. */
  ask?: (file: string, args: string[]) => Promise<string | null>;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export class ForegroundSense {
  #ask: NonNullable<ForegroundOptions['ask']>;
  #platform: NodeJS.Platform;
  #now: () => number;
  #current: Foreground | null = null;

  constructor(options: ForegroundOptions = {}) {
    this.#ask = options.ask ?? run;
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? (() => Date.now());
  }

  /** What was last seen, without asking again. */
  get current(): Foreground | null {
    return this.#current;
  }

  /**
   * Ask the operating system what is in front.
   *
   * Returns the answer only when it *changed*, so a caller can inject on the
   * return value and say nothing the rest of the time. Null means either
   * nothing changed or nothing could be found, and the two are deliberately
   * the same to the caller — there is no useful difference between "they are
   * still in the same window" and "I could not tell", and distinguishing them
   * would invite her to mention the second.
   */
  async poll(): Promise<Foreground | null> {
    const platform = query(this.#platform);
    if (!platform) return null;

    const raw = await this.#ask(platform.file, platform.args);
    if (!raw) return null;

    const [app = '', title = ''] = raw.trim().split('\n');
    if (!app.trim()) return null;

    const next: Foreground = {
      app: app.trim(),
      title: title.trim().slice(0, TITLE_LIMIT),
      at: this.#now(),
    };
    const same = this.#current?.app === next.app && this.#current?.title === next.title;
    this.#current = next;
    return same ? null : next;
  }

  /** Forget, so the next poll counts as a change. Called when she sleeps. */
  reset(): void {
    this.#current = null;
  }
}

/**
 * The `⟦context⟧` line she gets when they move to something else.
 *
 * The instruction is outside the envelope and the title is inside it, which is
 * the whole point: she is told a neutral fact by this program, and shown a
 * string somebody else wrote.
 */
export function foregroundUpdate(foreground: Foreground): string {
  const what = foreground.title
    ? `${foreground.app} — ${foreground.title}`
    : foreground.app;
  return (
    'They have moved to something else on their machine. ' +
    `${untrusted('the screen', what)}\n` +
    'Mention it only if it is worth one sentence. Most of the time it is not, ' +
    'and a companion who narrates every window is a companion nobody leaves running.'
  );
}

/** The line the rebuilt system instruction carries, so she knows without being told twice. */
export function foregroundLine(foreground: Foreground): string {
  const what = foreground.title
    ? `${foreground.app} — ${foreground.title}`
    : foreground.app;
  return `What is in front of them: ${untrusted('the screen', what)}`;
}

/** Spawns the query and gives up after {@link DEADLINE_MS}. */
function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, DEADLINE_MS);
    timer.unref?.();

    child.stdout.on('data', (chunk: unknown) => {
      if (out.length < 1_000) out += String(chunk);
    });
    // Silent on failure. macOS refuses this until Accessibility is granted, and
    // a companion who complains about a permission she needs for a background
    // nicety is worse company than one who says nothing about your work.
    child.on('error', () => finish(null));
    child.on('close', (code: number | null) => finish(code === 0 ? out : null));
  });
}
