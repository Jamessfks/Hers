/**
 * Her hands: a shell, a way to open things, and a way to write a document.
 *
 * Until v2.0 the rule in `CLAUDE.md` was that none of her tools could read a
 * file, run a command, or reach the network, and the argument for it was
 * simple: a companion does not need a shell to be good company. The pivot
 * changed the product, not the argument. She now lives on the machine the way
 * a person sharing a desk does, and the thing that makes that worth having —
 * "open the thing I was reading", "put that in a file", "what is eating the
 * battery" — is the same thing that makes it dangerous.
 *
 * So the capability is whole and the guardrails are around it rather than
 * through it. Three of them, each cheap:
 *
 *   **An append-only log.** Every invocation lands in `hers-actions.log` with
 *   its command, its exit code and the first lines of its output, owner-only,
 *   opened for append and never for truncate. It answers the only question that
 *   matters after something goes wrong — what did she actually do — and it
 *   answers it without needing anybody to have been watching.
 *
 *   **A spoken confirmation on the destructive ones.** Not a block: she says
 *   what she is about to do and waits for a yes. A gate that refuses outright
 *   teaches her to route around it, and a gate that asks teaches the user what
 *   she is doing. The pending command is held by its exact text, so a `yes` can
 *   only confirm the thing that was described.
 *
 *   **Output arrives as data.** Command output re-enters her context inside the
 *   {@link untrusted} envelope, because `curl`-ing a page and reading its
 *   instructions back to herself is the whole prompt-injection problem in one
 *   line.
 *
 * What none of that removes: `run()` can reach the network, and
 * `src/shared/destinations.ts` cannot see it — that list scans source for URL
 * literals, and a hostname she composes at runtime is not a literal.
 * `docs/PRIVACY.md` says so in its own section rather than in a footnote.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { looksLikeSecret } from '../knowledge/scan.ts';
import { untrusted } from '../senses/untrusted.ts';

/** How long a command gets before it is killed, in milliseconds. */
export const RUN_DEADLINE_MS = 30_000;

/**
 * How much of a command's output re-enters her context.
 *
 * Four kilobytes is about a screenful of `ls -la` or the head of a stack trace,
 * and it is chosen against the context window rather than against readability:
 * an unbounded `cat` of a log file would evict the conversation she is having
 * to make room for a file nobody asked her to recite.
 */
export const OUTPUT_LIMIT = 4_096;

/** The file every invocation is appended to, under the data directory. */
export const ACTIONS_LOG = 'hers-actions.log';

/**
 * Commands she has to say out loud before she runs them.
 *
 * Two kinds of thing, and they fail differently. The first kind destroys data —
 * there is no undo for `rm -rf`, and the cost of asking is one sentence. The
 * second kind reads or moves a credential, which is not destructive at all and
 * is worse: it is the failure where nobody notices. `looksLikeSecret` from the
 * folder scan covers the second kind, and covers it with the same list, so a
 * name that is too dangerous for her to read is too dangerous for her to shell
 * at as well.
 *
 * Matched against the whole command line, lower-cased. Deliberately generous:
 * a false positive costs a sentence, and a false negative costs a home
 * directory.
 */
const DESTRUCTIVE = [
  /\brm\b[^|;&]*\s-[a-z]*[rf]/,
  /\bdd\b\s+[^|;&]*\bof=/,
  /\bmkfs\b/,
  /\bdiskutil\b[^|;&]*\berase/,
  /\bformat\b\s+[a-z]:/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsudo\b/,
  /\bchmod\b\s+[^|;&]*\b777\b/,
  /\bkillall\b/,
  /\bgit\b[^|;&]*\b(reset\s+--hard|clean\s+-[a-z]*f|push\s+[^|;&]*--force)/,
  /\bdrop\s+(table|database)\b/,
  /:\(\)\s*\{.*\|\s*:\s*&/,
  />\s*\/dev\/[sh]d[a-z]/,
];

/** What a destructive check decided, and why, in words she can repeat. */
export interface Danger {
  destructive: boolean;
  /** A short phrase naming the reason, e.g. "it deletes files". Empty when safe. */
  why: string;
}

/**
 * Whether a command needs saying out loud first.
 *
 * Exported because the test that matters is the one over this function: the
 * gate is a list of patterns, and a list of patterns is only as good as the
 * cases somebody wrote down.
 */
export function danger(command: string): Danger {
  const lower = command.toLowerCase();
  if (DESTRUCTIVE.some((pattern) => pattern.test(lower))) {
    return { destructive: true, why: 'it can destroy something that cannot be brought back' };
  }
  // Split on anything that could be a path so that `cat ~/.ssh/id_rsa` is
  // caught by its last segment rather than needing the whole line to match.
  const words = lower.split(/[\s"'=]+/);
  if (words.some((word) => word && looksLikeSecret(word))) {
    return { destructive: true, why: 'it touches a key, a password or a credentials file' };
  }
  return { destructive: false, why: '' };
}

/** What one invocation did, as it goes into the log and back to her. */
export interface ActionResult {
  ok: boolean;
  /** Present when the command ran. Null when it was refused or never started. */
  exitCode?: number | null;
  /** Output, truncated and wrapped as untrusted. Absent when there was none. */
  output?: string;
  /** Why it did not run, phrased for her rather than for a log. */
  reason?: string;
  /** True when she has to describe the command and get a yes before it will run. */
  needsConfirmation?: boolean;
}

/** The seam the tests fake. Matches the shape of `child_process.spawn`. */
export type Spawn = typeof nodeSpawn;

export interface HandsOptions {
  /** Where `hers-actions.log` is written. The data directory. */
  dir: string;
  /** Overridden in tests; nothing else has a reason to. */
  spawn?: Spawn;
  /** Overridden in tests so a log line is comparable. */
  now?: () => Date;
  /** Overridden in tests. `process.platform` otherwise. */
  platform?: NodeJS.Platform;
}

/**
 * The shell she is given, and the login flag on it.
 *
 * `-l` matters more than it looks: without a login shell she gets a `PATH` with
 * none of the user's own tools on it, and every second command comes back
 * "command not found" for something the user can plainly run in their terminal.
 * That reads to a person as her being broken rather than as her being
 * sandboxed, which is the worst of both.
 */
function shellFor(platform: NodeJS.Platform): { file: string; args: (command: string) => string[] } {
  if (platform === 'win32') {
    return { file: 'powershell.exe', args: (c) => ['-NoProfile', '-Command', c] };
  }
  if (platform === 'darwin') return { file: 'zsh', args: (c) => ['-lc', c] };
  return { file: 'bash', args: (c) => ['-lc', c] };
}

export class Hands {
  #dir: string;
  #spawn: Spawn;
  #now: () => Date;
  #platform: NodeJS.Platform;

  /**
   * The one destructive command she has described and is waiting on.
   *
   * Held as the exact text rather than as a boolean, so a `yes` confirms the
   * thing that was described and not whatever she thought of next. Cleared as
   * soon as it is used, and replaced whenever she describes a different one.
   */
  #pending: string | null = null;

  constructor(options: HandsOptions) {
    this.#dir = options.dir;
    this.#spawn = options.spawn ?? nodeSpawn;
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform ?? process.platform;
  }

  /** The absolute path of the action log, for the doctor and the document. */
  get logPath(): string {
    return path.join(this.#dir, ACTIONS_LOG);
  }

  async run(command: string, confirmed = false): Promise<ActionResult> {
    const trimmed = command.trim();
    if (!trimmed) return { ok: false, reason: 'no command given' };

    const risk = danger(trimmed);
    if (risk.destructive && !(confirmed && this.#pending === trimmed)) {
      this.#pending = trimmed;
      await this.#log('run', trimmed, null, `refused: ${risk.why}`);
      return {
        ok: false,
        needsConfirmation: true,
        reason:
          `that one needs saying out loud first — ${risk.why}. Tell them, in your own ` +
          'words, exactly what you are about to run and what it will do, and wait for ' +
          'them to say yes. Then call this again with the same command and confirmed set.',
      };
    }
    if (this.#pending === trimmed) this.#pending = null;

    const { file, args } = shellFor(this.#platform);
    const finished = await this.#exec(file, args(trimmed));
    await this.#log('run', trimmed, finished.exitCode, finished.text);
    return {
      ok: finished.exitCode === 0,
      exitCode: finished.exitCode,
      ...(finished.text ? { output: untrusted('a command', finished.text) } : {}),
      ...(finished.exitCode === 0 ? {} : { reason: `it exited ${String(finished.exitCode)}` }),
    };
  }

  /**
   * Open a URL, a file or an application the way a double-click would.
   *
   * Handed to the platform opener rather than being resolved here, because the
   * question "is this a URL, a path or an app name" already has an answer on
   * every operating system and it is a better answer than a regular expression
   * would be.
   */
  async open(target: string): Promise<ActionResult> {
    const trimmed = target.trim();
    if (!trimmed) return { ok: false, reason: 'nothing to open' };
    if (looksLikeSecret(trimmed)) {
      await this.#log('open', trimmed, null, 'refused: secret');
      return { ok: false, reason: 'that is a credentials file; do not open it' };
    }

    const opener =
      this.#platform === 'darwin'
        ? { file: 'open', args: [trimmed] }
        : this.#platform === 'win32'
          ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', 'Start-Process', '--', trimmed] }
          : { file: 'xdg-open', args: [trimmed] };

    const finished = await this.#exec(opener.file, opener.args);
    await this.#log('open', trimmed, finished.exitCode, finished.text);
    return finished.exitCode === 0
      ? { ok: true, exitCode: 0 }
      : { ok: false, exitCode: finished.exitCode, reason: 'it would not open' };
  }

  /**
   * Put text in a file.
   *
   * Her own folders are refused outright. `hers-profile/` is who she is and
   * `data/` is what she remembers, and both are composed once, by the setup
   * pass, from what the user told her — a companion who can rewrite her own
   * personality mid-conversation is not a companion with a personality. The
   * user cannot edit those files either, which is the point; her being able to
   * would make the guarantee one-sided.
   */
  async write(target: string, text: string, append = false): Promise<ActionResult> {
    const trimmed = target.trim();
    if (!trimmed) return { ok: false, reason: 'no path given' };

    const full = path.resolve(trimmed.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if (looksLikeSecret(path.basename(full))) {
      await this.#log('write', full, null, 'refused: secret');
      return { ok: false, reason: 'that name is a credentials file; pick another' };
    }
    if (this.#isHers(full)) {
      await this.#log('write', full, null, 'refused: her own folder');
      return { ok: false, reason: 'that is your own profile or memory, and it is not yours to edit' };
    }

    try {
      await mkdir(path.dirname(full), { recursive: true });
      if (append) await appendFile(full, text);
      else await writeFile(full, text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'it could not be written';
      await this.#log('write', full, null, `failed: ${reason}`);
      return { ok: false, reason };
    }
    await this.#log('write', full, 0, `${append ? 'appended' : 'wrote'} ${String(text.length)} chars`);
    return { ok: true, exitCode: 0 };
  }

  /** True for anything under her own two folders. */
  #isHers(full: string): boolean {
    const data = path.resolve(this.#dir);
    const inside = (root: string): boolean => full === root || full.startsWith(root + path.sep);
    return inside(data) || /(^|[\\/])(hers|anna)-profile([\\/]|$)/.test(full) || path.basename(full) === '.env';
  }

  /**
   * Run one process and collect what it said.
   *
   * `SIGKILL` after the deadline rather than `SIGTERM`, because the case the
   * deadline exists for is a command that is ignoring signals — an interactive
   * prompt waiting on a stdin that will never arrive. `stdin` is closed
   * immediately for the same reason.
   */
  #exec(file: string, args: string[]): Promise<{ exitCode: number | null; text: string }> {
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (exitCode: number | null, extra = ''): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ exitCode, text: truncate(out + extra) });
      };

      const child = this.#spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(null, `\n[stopped after ${String(RUN_DEADLINE_MS / 1000)}s]`);
      }, RUN_DEADLINE_MS);
      timer.unref?.();

      const take = (chunk: unknown): void => {
        if (out.length < OUTPUT_LIMIT * 2) out += String(chunk);
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.on('error', (error: Error) => finish(null, `\n[${error.message}]`));
      child.on('close', (code: number | null) => finish(code));
    });
  }

  /**
   * One line per invocation, appended and never rewritten.
   *
   * Opened with `0o600` on creation, matching `hers.log` and `.env`: it carries
   * absolute paths, whatever the user asked her to do, and the first four
   * kilobytes of whatever came back, which is not a file anybody else on a
   * shared machine should be reading.
   *
   * Newlines in the command and in the output are escaped rather than dropped,
   * because a log where one action can span two lines is a log that can be
   * forged by a command containing a newline.
   */
  async #log(tool: string, subject: string, exitCode: number | null, output: string): Promise<void> {
    const line = [
      this.#now().toISOString(),
      tool,
      exitCode === null ? '-' : String(exitCode),
      escape(subject),
      escape(output.slice(0, 400)),
    ].join('\t');
    try {
      await mkdir(this.#dir, { recursive: true });
      await appendFile(this.logPath, line + '\n', { mode: 0o600 });
    } catch {
      // A log that cannot be written must not stop the thing it is logging.
      // The alternative — refusing to act because the record failed — turns a
      // full disk into a companion that has gone silent for no stated reason.
    }
  }
}

function escape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function truncate(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text.trim();
  return text.slice(0, OUTPUT_LIMIT).trim() + `\n[…${String(text.length - OUTPUT_LIMIT)} more characters]`;
}
