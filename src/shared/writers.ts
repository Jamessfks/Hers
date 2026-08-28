/**
 * Every module that puts something on your disk, and what it puts there.
 *
 * The companion piece to {@link DESTINATIONS}. That list answers "where can this
 * program reach"; this one answers "what appears on my disk because I ran it",
 * and it is held to the code the same three ways: `npm run doctor` renders its
 * file section from here, `writers.test.ts` scans `src/` for write calls and
 * fails on any module that is not listed, and a second test fails if
 * `docs/PRIVACY.md` does not name every path.
 *
 * This list exists because the prose version had already drifted. The doctor
 * used to print a hand-written file tree, and it had quietly stopped mentioning
 * `README.md` and `gallery/README.md` — two files `profile.ts` demonstrably
 * writes on first run. A list of filenames in a string literal has nothing
 * holding it to the code that writes them, which is exactly the failure this
 * module is here to make impossible.
 *
 * ## What the scan can and cannot see
 *
 * It matches call-shaped occurrences of `writeFile`, `appendFile`,
 * `createWriteStream`, `rename`, `renameSync` and `mkdir`, plus any import of
 * `node:sqlite`. Matching the call shape rather than the bare word is
 * deliberate: three modules mention "rename" in a comment or a log line and
 * touch nothing, and a scan that flagged those would train everyone to ignore
 * it.
 *
 * What it would miss is a write performed through an alias, a dynamic import,
 * or a dependency acting on its own. That is the same class of gap the host
 * list has, and it is named here for the same reason.
 */

/** Which directory a path is relative to. */
export type Root = 'profile' | 'data' | 'cwd' | 'app';

export interface Writer {
  /** The module, relative to `src/`, exactly as the scan reports it. */
  module: string;
  root: Root;
  /** Every path it writes, relative to {@link root}. */
  writes: string[];
  /** What those files are for. */
  what: string;
  /** What has to happen before they exist. */
  when: string;
}

/**
 * The exact pattern the test scans with, and the one `docs/PRIVACY.md` quotes.
 *
 * Exported so the document, the test and this list cannot each carry their own
 * slightly different idea of what counts as a write.
 */
export const WRITE_CALL_PATTERN =
  '(writeFile|appendFile|createWriteStream|renameSync|rename|mkdir)[[:space:]]*\\(|node:sqlite';

export const WRITERS: readonly Writer[] = [
  {
    module: 'core/profile/profile.ts',
    root: 'profile',
    writes: [
      'personality.md',
      'identity.md',
      'voice.md',
      'mood.md',
      'relationship.md',
      'boundaries.md',
      'README.md',
      'gallery/README.md',
    ],
    what: 'Who she is. Plain markdown with a small frontmatter block, and the only description of her character there is.',
    when: 'The six character files and both READMEs are written on first run, and rewritten when you save from Profile on the website.',
  },
  {
    module: 'core/mood/mood.ts',
    root: 'profile',
    writes: ['mood.state.json'],
    what: 'Eight numbers and a timestamp: her mood on four axes, and the baseline it drifts back to.',
    when: 'Written the first time something moves her, so it does not exist on a fresh install.',
  },
  {
    module: 'core/intimacy/intimacy.ts',
    root: 'profile',
    writes: ['intimacy.state.json'],
    what: 'How close she is, and the days behind it.',
    when: 'Written on first run and updated as days pass.',
  },
  {
    module: 'core/avatar/studio.ts',
    root: 'profile',
    writes: [
      'avatar/source.jpg',
      'avatar/face-<expression>-<id>.jpg',
      'avatar/manifest.json',
    ],
    what: 'The photograph you chose as her face, the expressions generated from it, and a manifest recording their sizes, hashes and when they arrived.',
    when: 'When you give her a face, and once per expression generated from it. The manifest is written to a `.incoming` file and renamed into place, so a failed write cannot leave a manifest that describes an image which is not there.',
  },
  {
    module: 'core/gallery/gallery.ts',
    root: 'profile',
    writes: ['gallery/<her description>.jpg'],
    what: 'Pictures of her, including any she generates. Never of you — every one starts from her photograph as the reference.',
    when: 'When she decides to send you a picture that does not exist yet.',
  },
  {
    module: 'core/knowledge/scan.ts',
    root: 'profile',
    writes: ['knowledge.json'],
    what: 'The record of what you approved: absolute folder paths, when you said yes, and when the last scan finished.',
    when: 'Written before the scan starts, so an interrupted scan still leaves a record of what was agreed to. Only exists if you use Setup → Let her read your files.',
  },
  {
    module: 'core/memory/store.ts',
    root: 'data',
    writes: ['memory.db', 'memory.db-wal', 'memory.db-shm'],
    what: 'Every turn of conversation, the facts distilled from them, the rolling summary, and one embedding per fact. Written through `node:sqlite` rather than through `fs`, which is why it is the one entry the write scan finds by its import instead of its call.',
    when: 'Continuously, as the two of you talk. The `-wal` and `-shm` are SQLite running in WAL mode, not extra copies.',
  },
  {
    module: 'core/session/brain.ts',
    root: 'data',
    writes: [],
    what: 'Creates the data directory if it is missing, and is the only thing in this program that deletes either directory — that is Setup → Start over.',
    when: 'On every start, and on a reset you asked for and confirmed.',
  },
  {
    module: 'server/env-file.ts',
    root: 'cwd',
    writes: ['.env'],
    what: 'Your keys. Written with owner-only permissions, one line at a time, leaving every other line exactly as it was.',
    when: 'When you submit a key or a bot token in Setup. Nothing else ever writes here, and Start over does not touch it.',
  },
  {
    module: 'electron/main.js',
    root: 'app',
    writes: ['hers.log'],
    what: 'Everything the last run printed to its console, so that a window which never appeared can still say why. It carries the absolute paths in use — which include your account name — the pinned Telegram chat id if you use the bridge, and every configuration warning. It carries no key: the Gemini key is only ever printed masked to its last four characters, and the bot token is never printed at all.',
    when: 'Rewritten from empty every time the application launches. Only the application writes it; running her from a clone does not.',
  },
  {
    module: 'server/config.ts',
    root: 'cwd',
    writes: [],
    what: 'Renames a pre-v1.0 `anna-profile/` folder to `hers-profile/`. It moves a folder and writes no content, and it is on this list because a scan that only looked for content writes would not have found it.',
    when: 'Once, on the first start after upgrading, and only when the new name does not already exist.',
  },
];

/** Every path this program can write, grouped under the root it hangs from. */
export function writesUnder(root: Root): string[] {
  return [...new Set(WRITERS.filter((w) => w.root === root).flatMap((w) => w.writes))];
}
