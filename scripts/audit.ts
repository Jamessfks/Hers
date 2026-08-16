/**
 * The live audit: every success criterion, against the real APIs.
 *
 * `npm test` fakes every network seam on purpose — a reconnect is not
 * reproducible against a real socket and a suite that needs an API key is a
 * suite nobody runs. That leaves a specific gap, and it is not a small one:
 * **the tests prove the code does what it was written to do, not that Gemini
 * does what it was read to do.** This closes that.
 *
 * It costs money. Not much — the whole run is a few cents of Gemini, plus one
 * optional Hedra render — but it is real, so nothing here runs by accident.
 *
 *   npm run audit                everything except the paid image generation
 *   npm run audit -- --paid      including it
 *   npm run audit -- --quick     skips the two multi-minute endurance checks
 *   npm run audit -- --only=mood runs only checks whose name matches
 *
 * Each check prints what it actually observed rather than only a verdict,
 * because "PASS" with no evidence is worth about as much as no test at all.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { encode as encodeJpeg } from 'jpeg-js';

import { Brain } from '../src/core/session/brain.ts';
import { Companion } from '../src/core/session/companion.ts';
import type { CompanionSink } from '../src/core/session/companion.ts';
import { loadConfig, loadDotEnv } from '../src/server/config.ts';
import type { GalleryItem } from '../src/core/gallery/gallery.ts';

loadDotEnv();

const PAID = process.argv.includes('--paid');
const QUICK = process.argv.includes('--quick');
/** Substring filter, so one check can be re-run without paying for the rest. */
const ONLY = (process.argv.find((arg) => arg.startsWith('--only='))?.slice(7) ?? '').toLowerCase();

function wanted(name: string): boolean {
  return !ONLY || name.toLowerCase().includes(ONLY);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface Result {
  name: string;
  criterion: string;
  ok: boolean;
  evidence: string;
  skipped?: string;
}

const results: Result[] = [];

async function check(
  name: string,
  criterion: string,
  run: () => Promise<{ ok: boolean; evidence: string }>,
): Promise<void> {
  if (!wanted(name)) return;
  process.stdout.write(`\n▸ ${name}\n`);
  const started = Date.now();
  try {
    const { ok, evidence } = await run();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  (${seconds}s)  ${evidence}`);
    results.push({ name, criterion, ok, evidence });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ✗ FAIL  threw: ${message}`);
    results.push({ name, criterion, ok: false, evidence: `threw: ${message}` });
  }
}

function skip(name: string, criterion: string, why: string): void {
  if (!wanted(name)) return;
  console.log(`\n▸ ${name}\n  – SKIP  ${why}`);
  results.push({ name, criterion, ok: true, evidence: why, skipped: why });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Real speech, from the operating system.
 *
 * `say` rather than a TTS API: it is free, local, deterministic enough, and —
 * the point — it is *actual speech*, so the Live API's voice detection and
 * transcription are being exercised rather than bypassed.
 */
function speak(text: string, file: string): Buffer {
  execFileSync('say', ['-o', file, '--data-format=LEI16@16000', text]);
  return pcmFromWav(readFileSync(file));
}

/**
 * Finds the `data` chunk rather than assuming it starts at byte 44.
 *
 * macOS writes extra chunks before it, so the textbook offset reads the middle
 * of a header as audio — which is silence to a listener and noise to a model.
 */
function pcmFromWav(wav: Buffer): Buffer {
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.subarray(at, at + 4).toString('ascii');
    const size = wav.readUInt32LE(at + 4);
    if (id === 'data') return wav.subarray(at + 8, Math.min(at + 8 + size, wav.length));
    at += 8 + size + (size % 2);
  }
  return wav.subarray(44);
}

/**
 * An image whose correct description is not a matter of opinion.
 *
 * Three colour bands, top to bottom. "Did she say red, then green, then blue"
 * is checkable; "did she describe this photograph well" is not.
 */
function bandsJpeg(): Buffer {
  const width = 480;
  const height = 360;
  const data = Buffer.alloc(width * height * 4);
  const bands = [
    [220, 30, 30],
    [30, 190, 60],
    [40, 70, 230],
  ];
  for (let y = 0; y < height; y += 1) {
    const band = bands[Math.min(2, Math.floor((y / height) * 3))]!;
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = band[0]!;
      data[at + 1] = band[1]!;
      data[at + 2] = band[2]!;
      data[at + 3] = 255;
    }
  }
  return Buffer.from(encodeJpeg({ data, width, height }, 90).data);
}

/** A second, differently shaped JPEG, so a replacement is visibly a replacement. */
function portraitJpeg(): Buffer {
  const width = 400;
  const height = 560;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 200;
    data[i * 4 + 1] = 170;
    data[i * 4 + 2] = 150;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(encodeJpeg({ data, width, height }, 90).data);
}

// ---------------------------------------------------------------------------
// A companion wired to collectors
// ---------------------------------------------------------------------------

interface Session {
  companion: Companion;
  brain: Brain;
  heard: string[];
  said: string[];
  tools: Array<{ name: string; args: Record<string, unknown> }>;
  moves: string[];
  shows: GalleryItem[];
  turns: number;
  audioBytes: number;
  troubles: string[];
  dispose: () => Promise<void>;
}

async function session(
  options: {
    dir?: string;
    /** Use an existing profile — the one with rendered avatar clips in it. */
    profileDir?: string;
    env?: Record<string, string>;
    senses?: Record<string, boolean>;
  } = {},
): Promise<Session> {
  const root = options.dir ?? (await mkdtemp(path.join(tmpdir(), 'anna-audit-')));

  /*
   * Nothing this harness creates may land inside the repository.
   *
   * A single wrong root — `path.dirname(profileDir)`, which resolves to the
   * repo itself — silently created a second profile folder beside the real one
   * and a later `git add -A` committed all eleven files of it. Refusing here is
   * cheaper than noticing later.
   */
  const inside = path.resolve(root).startsWith(path.resolve(process.cwd()) + path.sep);
  if (inside && !options.profileDir) {
    throw new Error(`the audit tried to write into the repo at ${root}; use a temp directory`);
  }

  const config = loadConfig({
    ...process.env,
    ANNA_PROFILE: options.profileDir ?? path.join(root, 'profile'),
    ANNA_DATA: path.join(root, 'data'),
    ...options.env,
  } as NodeJS.ProcessEnv);

  const brain = await Brain.open(config);
  const state = {
    heard: [] as string[],
    said: [] as string[],
    moves: [] as string[],
    shows: [] as GalleryItem[],
    troubles: [] as string[],
    turns: 0,
    audioBytes: 0,
  };

  const sink: CompanionSink = {
    audio: (pcm) => {
      state.audioBytes += pcm.length;
    },
    transcript: (who, text, final) => {
      if (!final) return;
      (who === 'user' ? state.heard : state.said).push(text);
    },
    state: () => undefined,
    mood: () => undefined,
    interrupted: () => undefined,
    show: (item) => state.shows.push(item),
    move: (gesture) => state.moves.push(gesture),
    trouble: (message) => state.troubles.push(message),
  };

  const companion = new Companion({
    brain,
    channel: 'desktop',
    senses: { hearing: true, sight: false, screen: false, ...options.senses },
    sink,
  });

  // Count completed turns by watching the transcript grow.
  const tools: Array<{ name: string; args: Record<string, unknown> }> = [];

  return {
    companion,
    brain,
    tools,
    get heard() {
      return state.heard;
    },
    get said() {
      return state.said;
    },
    get moves() {
      return state.moves;
    },
    get shows() {
      return state.shows;
    },
    get troubles() {
      return state.troubles;
    },
    get turns() {
      return state.said.length;
    },
    get audioBytes() {
      return state.audioBytes;
    },
    dispose: async () => {
      await companion.sleep();
      await brain.close();
      if (!options.dir) await rm(root, { recursive: true, force: true });
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Streams PCM at roughly the rate a microphone would, which is what VAD expects. */
async function stream(companion: Companion, pcm: Buffer): Promise<void> {
  const chunk = 16000 * 2 * 0.064; // 64ms
  for (let at = 0; at < pcm.length; at += chunk) {
    companion.hear(pcm.subarray(at, at + chunk));
    await wait(60);
  }
  // A beat of silence so the detector hears the end of the sentence.
  const silence = Buffer.alloc(chunk);
  for (let i = 0; i < 12; i += 1) {
    companion.hear(silence);
    await wait(60);
  }
}

/** Waits until she has finished saying something, or gives up. */
async function untilSpoke(session: Session, before: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.said.length > before) {
      // Let a multi-part turn settle.
      await wait(1500);
      return true;
    }
    await wait(250);
  }
  return false;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.geminiApiKey) {
    console.error('No GEMINI_API_KEY. The audit is entirely about the real APIs.');
    process.exit(1);
  }

  console.log('\n══ Anna — live audit ══');
  console.log(`   model    ${config.model}`);
  console.log(`   paid     ${PAID ? 'yes (image generation and a Hedra render)' : 'no'}`);
  console.log(`   quick    ${QUICK ? 'yes (skipping endurance)' : 'no'}`);

  const scratch = await mkdtemp(path.join(tmpdir(), 'anna-audit-fx-'));

  // -- 6. Hearing ----------------------------------------------------------
  await check(
    'Hearing — real speech reaches her and is transcribed',
    '#6 senses',
    async () => {
      const s = await session();
      await s.companion.wake();
      // Plain English words on purpose. An earlier version of this check used
      // "Mei" and "Chengdu" and failed on a working system: `say` pronounces
      // Mei as "May" and the transcriber spelled Chengdu "Chandu". Asserting on
      // how a synthetic voice and a recogniser happen to agree about a Chinese
      // name tests neither of them and fails the product for it.
      const pcm = speak(
        'Hello Anna. My sister is a doctor and she lives in Boston.',
        path.join(scratch, 'a.wav'),
      );
      await stream(s.companion, pcm);
      const spoke = await untilSpoke(s, 0);
      const heard = s.heard.join(' ').toLowerCase();
      const evidence = `she heard "${s.heard.join(' ') || '(nothing)'}" and replied "${s.said[0] ?? '(nothing)'}"`;
      await s.dispose();
      return {
        ok: spoke && /sister/.test(heard) && /doctor/.test(heard) && /boston/.test(heard),
        evidence,
      };
    },
  );

  // -- 6. Sight ------------------------------------------------------------
  await check(
    'Sight — a camera frame reaches her and she describes it correctly',
    '#6 senses',
    async () => {
      const s = await session({ senses: { hearing: true, sight: true } });
      await s.companion.wake();
      s.companion.see(bandsJpeg(), 'camera');
      await wait(1200);
      s.companion.say('Ignore how odd this is and just tell me the three colours you can see, top to bottom.');
      const spoke = await untilSpoke(s, 0);
      const said = s.said.join(' ').toLowerCase();
      const evidence = `"${s.said.join(' ') || '(nothing)'}"`;
      await s.dispose();
      const order =
        said.indexOf('red') >= 0 &&
        said.indexOf('green') > said.indexOf('red') &&
        said.indexOf('blue') > said.indexOf('green');
      return { ok: spoke && order, evidence };
    },
  );

  // -- 6. Screen -----------------------------------------------------------
  await check(
    'Screen — a screen frame reaches her on its own channel',
    '#6 senses',
    async () => {
      const s = await session({ senses: { hearing: true, screen: true } });
      await s.companion.wake();
      s.companion.see(bandsJpeg(), 'screen');
      await wait(1200);
      s.companion.say('What is on my screen right now? Name the colours.');
      const spoke = await untilSpoke(s, 0);
      const said = s.said.join(' ').toLowerCase();
      const evidence = `"${s.said.join(' ') || '(nothing)'}"`;
      await s.dispose();
      return { ok: spoke && /red/.test(said) && /green/.test(said) && /blue/.test(said), evidence };
    },
  );

  // -- 6. A sense that is off stays off ------------------------------------
  await check(
    'A sense that is off is genuinely off',
    '#6 senses',
    async () => {
      const s = await session({ senses: { hearing: true, sight: false } });
      await s.companion.wake();
      s.companion.see(bandsJpeg(), 'camera'); // dropped: sight is off
      await wait(1000);
      s.companion.say('Can you see anything through my camera right now? One word: yes or no.');
      await untilSpoke(s, 0);
      const said = s.said.join(' ').toLowerCase();
      const evidence = `"${s.said.join(' ') || '(nothing)'}"`;
      await s.dispose();
      return { ok: !/\bred\b|\bgreen\b|\bblue\b/.test(said), evidence };
    },
  );

  // -- 2. Mood -------------------------------------------------------------
  await check(
    'Mood — she calls `feel`, and it moves and persists',
    '#2 mood',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'anna-audit-mood-'));
      const s = await session({ dir: root });
      await s.companion.wake();
      const before = s.brain.mood.read();

      s.companion.say(
        'I wanted to say something. Talking to you is genuinely the best part of my day, and I mean that.',
      );
      await untilSpoke(s, 0);
      await wait(2000);

      const after = s.brain.mood.read();
      const moved =
        Math.abs(after.current.valence - before.current.valence) +
        Math.abs(after.current.warmth - before.current.warmth);
      await s.dispose();

      // Reopened from disk: the state file is the persistence claim.
      const reopened = await Brain.open(
        loadConfig({
          ...process.env,
          ANNA_PROFILE: path.join(root, 'profile'),
          ANNA_DATA: path.join(root, 'data'),
        } as NodeJS.ProcessEnv),
        { offline: true },
      );
      const restored = reopened.mood.read();
      await reopened.close();
      await rm(root, { recursive: true, force: true });

      return {
        ok: moved > 0.05 && Math.abs(restored.current.valence - after.current.valence) < 0.2,
        evidence: `${before.label} → ${after.label} (moved ${moved.toFixed(2)}); reopened as ${restored.label}`,
      };
    },
  );

  // -- 3/4. Memory ---------------------------------------------------------
  await check(
    'Memory — a fact survives into a second, separate conversation',
    '#4 memory',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'anna-audit-mem-'));
      const first = await session({ dir: root });
      await first.companion.wake();
      first.companion.say(
        'Something to keep: my sister is called Mei, she is a doctor in Chengdu, and her birthday is in March.',
      );
      await untilSpoke(first, 0);
      // `dispose` closes the brain, which now waits for consolidation — so by
      // the time this resolves the facts are on disk or they never will be.
      await first.dispose();

      const second = await session({ dir: root });
      await second.companion.wake();
      second.companion.say('What do you remember about my sister?');
      await untilSpoke(second, 0);
      const said = second.said.join(' ').toLowerCase();
      const facts = await second.brain.memory.recall('sister', 8);
      await second.dispose();
      await rm(root, { recursive: true, force: true });

      return {
        ok: /mei/.test(said),
        evidence: `she said "${said.slice(0, 140)}"; stored facts: ${JSON.stringify(facts).slice(0, 160)}`,
      };
    },
  );

  // -- 1. Initiative -------------------------------------------------------
  if (QUICK) {
    skip('Initiative — she speaks first', '#1 three minutes', 'skipped by --quick');
  } else {
    await check(
      'Initiative — she speaks first, unprompted, inside the ceiling',
      '#1 three minutes',
      async () => {
        // The default ceiling is 180s. Running the real default takes over
        // three minutes of wall clock, so the ceiling is lowered and the
        // *default* is asserted separately, from config.
        const declared = loadConfig({ ...process.env } as NodeJS.ProcessEnv).maxSilenceMs;
        const s = await session({
          env: { ANNA_MAX_SILENCE_MS: '30000', ANNA_MIN_SILENCE_MS: '10000' },
        });
        await s.companion.wake();

        const started = Date.now();
        let firstAt = 0;
        for (let i = 0; i < 90; i += 1) {
          if (s.said.length > 0 && firstAt === 0) firstAt = Date.now() - started;
          if (firstAt) break;
          await wait(500);
        }
        const openers = [...s.said];
        await s.dispose();

        return {
          ok: declared === 180_000 && firstAt > 0 && firstAt <= 32_000,
          evidence:
            firstAt > 0
              ? `spoke unprompted after ${(firstAt / 1000).toFixed(1)}s (ceiling 30s) — "${openers[0]?.slice(0, 110)}"; shipped default is ${declared / 1000}s`
              : `stayed silent for 45s with a 30s ceiling; shipped default is ${declared / 1000}s`,
        };
      },
    );
  }

  // -- 7. Endurance --------------------------------------------------------
  if (QUICK) {
    skip('Endurance — past the two-minute audio+video cap', '#7 architecture', 'skipped by --quick');
  } else {
    await check(
      'Endurance — an audio+video session outlives the documented 2-minute cap',
      '#7 architecture',
      async () => {
        const s = await session({ senses: { hearing: true, sight: true } });
        await s.companion.wake();
        const frame = bandsJpeg();
        const silence = Buffer.alloc(16000 * 2 * 0.064);

        // Just over three minutes of continuous audio and video — comfortably
        // past the cap this architecture claims to have removed.
        const until = Date.now() + 190_000;
        let frames = 0;
        while (Date.now() < until) {
          s.companion.hear(silence);
          if (frames * 1000 < Date.now() - (until - 190_000)) {
            s.companion.see(frame, 'camera');
            frames += 1;
          }
          await wait(60);
        }

        // Still alive? Ask it something and see.
        const before = s.said.length;
        s.companion.say('Still there? Say yes.');
        const answered = await untilSpoke(s, before, 25_000);
        const live = s.companion.live?.isLive === true;
        const evidence = `after 190s and ${frames} frames: socket live=${live}, answered=${answered} ("${s.said.at(-1)?.slice(0, 80) ?? ''}"), troubles=${JSON.stringify(s.troubles)}`;
        await s.dispose();
        return { ok: live && answered, evidence };
      },
    );
  }

  // -- 8. Tools ------------------------------------------------------------
  await check(
    'Tools — she reaches for `remember` when it matters',
    '#4 memory',
    async () => {
      const s = await session();
      await s.companion.wake();
      s.companion.say(
        'Write this down properly, I want you to have it: I am terrified of the demo on Thursday.',
      );
      await untilSpoke(s, 0);
      await s.brain.memory.consolidate();
      const facts = await s.brain.memory.recall('demo Thursday', 8);
      await s.dispose();
      return {
        ok: facts.some((fact) => /thursday|demo/i.test(fact)),
        evidence: JSON.stringify(facts).slice(0, 200),
      };
    },
  );

  if (PAID) {
    await check(
      'Gallery — she generates a picture of herself and sends it',
      '#8 media',
      async () => {
        const s = await session();
        await s.companion.wake();
        s.companion.say(
          'Make me a new picture of you right now, wherever you are. Actually make one, do not just describe it.',
        );
        await untilSpoke(s, 0);
        // Generation is slow and runs off the turn.
        for (let i = 0; i < 90 && s.shows.length === 0; i += 1) await wait(1000);
        const shown = s.shows.map((item) => item.name);
        const evidence = shown.length ? `sent ${shown.join(', ')}` : 'no picture arrived';
        await s.dispose();
        return { ok: shown.length > 0, evidence };
      },
    );
  } else {
    skip('Gallery — image generation', '#8 media', 'costs money; run with --paid');
  }

  // -- Avatar --------------------------------------------------------------
  await check(
    'Avatar — an uploaded picture becomes the source that gestures render from',
    'avatar',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'anna-face-'));
      const brain = await Brain.open(
        loadConfig({
          ...process.env,
          ANNA_PROFILE: path.join(root, 'profile'),
          ANNA_DATA: path.join(root, 'data'),
        } as NodeJS.ProcessEnv),
        { offline: true },
      );

      // A real JPEG, through the same validation the web upload and Telegram
      // both go through — there is one set of rules about what a face may be,
      // not one per entry point.
      const first = await brain.avatar.setSource(bandsJpeg(), 'image/jpeg');
      const reference = await brain.avatar.sourceImage();

      // Replace it, the way /face or the Face dialog would.
      const second = await brain.avatar.setSource(portraitJpeg(), 'image/jpeg');

      await brain.close();
      await rm(root, { recursive: true, force: true });

      return {
        ok:
          first.hasSource &&
          second.hasSource &&
          first.sourceUrl !== second.sourceUrl &&
          reference !== null &&
          second.all.length > 0 &&
          second.ready.length === 0,
        evidence: `uploaded ${first.width}x${first.height}, replaced with ${second.width}x${second.height}; ${second.all.length} gestures render from it, ${second.ready.length} stale clips carried over`,
      };
    },
  );
  await check(
    'Avatar — she is offered exactly the movements that exist',
    'avatar',
    async () => {
      const config = loadConfig();
      const brain = await Brain.open(config, { offline: true });
      const ready = brain.avatar.readyGestures();
      const state = brain.avatar.state();
      await brain.close();
      return {
        ok: ready.every((gesture) => state.ready.includes(gesture)),
        evidence: `rendered: ${JSON.stringify(ready)}; spent $${state.spentUsd.toFixed(2)} of $${state.budgetUsd.toFixed(2)}`,
      };
    },
  );

  if (loadConfig().hedra && ready0()) {
    await check(
      'Avatar — she plays a movement while talking',
      'avatar',
      async () => {
        // The real profile, because that is the one with rendered clips — and
        // she is only ever offered gestures that exist.
        const s = await session({ profileDir: loadConfig().profileDir });
        await s.companion.wake();
        const offered = s.brain.avatar.readyGestures();
        s.companion.say('Quick one: do you agree that coffee is better than tea? Just nod if so.');
        await untilSpoke(s, 0);
        await wait(2500);
        const moves = [...s.moves];
        if (moves.length === 0 && offered.length === 0) {
          await s.dispose();
          return { ok: false, evidence: 'no clips were offered to her at all' };
        }
        const said = s.said.join(' ');
        await s.dispose();
        return {
          ok: moves.length > 0,
          evidence: moves.length
            ? `played ${moves.join(', ')} while saying "${said.slice(0, 90)}"`
            : `no movement; she said "${said.slice(0, 110)}"`,
        };
      },
    );
  } else {
    skip('Avatar — playing a movement', 'avatar', 'no rendered clips in the default profile');
  }

  // -- Report --------------------------------------------------------------
  await rm(scratch, { recursive: true, force: true });

  const failed = results.filter((result) => !result.ok);
  const skipped = results.filter((result) => result.skipped);
  console.log('\n══ Result ══');
  for (const result of results) {
    const mark = result.skipped ? '–' : result.ok ? '✓' : '✗';
    console.log(`  ${mark} ${result.criterion.padEnd(18)} ${result.name}`);
  }
  console.log(
    `\n  ${results.length - skipped.length} checked, ${failed.length} failed, ${skipped.length} skipped\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

/** True when the default profile already has at least one rendered clip. */
function ready0(): boolean {
  try {
    const config = loadConfig();
    const manifest = path.join(config.profileDir, 'avatar', 'manifest.json');
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      clips?: Record<string, unknown>;
    };
    return Object.keys(parsed.clips ?? {}).length > 0;
  } catch {
    return false;
  }
}

await main();
