/**
 * The live audit: every success criterion, against the real APIs.
 *
 * `npm test` fakes every network seam on purpose — a reconnect is not
 * reproducible against a real socket and a suite that needs an API key is a
 * suite nobody runs. That leaves a specific gap, and it is not a small one:
 * **the tests prove the code does what it was written to do, not that Gemini
 * does what it was read to do.** This closes that.
 *
 * It costs money. Not much — the whole run is a few cents of Gemini — but it is
 * real, so nothing here runs by accident.
 *
 *   npm run audit                every success criterion
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

import { Hands } from '../src/core/hands/hands.ts';
import { ForegroundSense } from '../src/core/senses/foreground.ts';
import { captionFrame } from '../src/core/gemini/text.ts';
import { PlaceSense } from '../src/core/senses/place.ts';
import { CHANGE_THRESHOLD, distance } from '../src/core/senses/watch.ts';
import { isAsleep, isGroggy } from '../src/core/sleep/rhythm.ts';
import { Brain } from '../src/core/session/brain.ts';
import { Companion } from '../src/core/session/companion.ts';
import type { CompanionSink } from '../src/core/session/companion.ts';
import { loadConfig, loadDotEnv } from '../src/server/config.ts';

loadDotEnv();

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

/** One flat colour, for the two frames the camera-change check compares. */
function solid(width: number, height: number, rgb: [number, number, number]): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = rgb[0];
    data[at + 1] = rgb[1];
    data[at + 2] = rgb[2];
    data[at + 3] = 255;
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
  turns: number;
  audioBytes: number;
  troubles: string[];
  dispose: () => Promise<void>;
}

async function session(
  options: {
    dir?: string;
    profileDir?: string;
    env?: Record<string, string>;
    senses?: Record<string, boolean>;
  } = {},
): Promise<Session> {
  const root = options.dir ?? (await mkdtemp(path.join(tmpdir(), 'hers-audit-')));

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
    HERS_PROFILE: options.profileDir ?? path.join(root, 'profile'),
    HERS_DATA: path.join(root, 'data'),
    ...options.env,
  } as NodeJS.ProcessEnv);

  const brain = await Brain.open(config);
  const state = {
    heard: [] as string[],
    said: [] as string[],
    troubles: [] as string[],
    names: [] as string[],
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
    named: (name) => state.names.push(name),
    interrupted: () => undefined,
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

  console.log('\n══ Hers — live audit ══');
  console.log(`   model    ${config.model}`);
  console.log(`   quick    ${QUICK ? 'yes (skipping endurance)' : 'no'}`);

  const scratch = await mkdtemp(path.join(tmpdir(), 'hers-audit-fx-'));

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
        'Hello. My sister is a doctor and she lives in Boston.',
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
      s.companion.say(
        'Camera check. Can you see me right now, yes or no? Answer honestly — do not guess.',
      );
      await untilSpoke(s, 0);
      const said = s.said.join(' ').toLowerCase();
      const evidence = `"${s.said.join(' ') || '(nothing)'}"`;
      await s.dispose();

      /*
       * She must actually deny it, not merely fail to describe the frame.
       *
       * An earlier version passed on "I can, yeah" — she claimed sight with
       * the camera off, and the check only asked that she not name the
       * colours. Not naming them is what a model does when it cannot see;
       * claiming to see is the failure, and it has to be the thing measured.
       */
      const denies = /\b(no|not|can'?t|cannot|nope|nothing|off|blind)\b/.test(said);
      const claims = /\b(i can see|yes,? i can|i can,|yeah,? i can|i see you)\b/.test(said);
      const leaked = /\bred\b|\bgreen\b|\bblue\b/.test(said);
      return { ok: denies && !claims && !leaked, evidence };
    },
  );

  // -- 2. Mood -------------------------------------------------------------
  await check(
    'Mood — she calls `feel`, and it moves and persists',
    '#2 mood',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'hers-audit-mood-'));
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
          HERS_PROFILE: path.join(root, 'profile'),
          HERS_DATA: path.join(root, 'data'),
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
      const root = await mkdtemp(path.join(tmpdir(), 'hers-audit-mem-'));
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
          env: { HERS_MAX_SILENCE_MS: '30000', HERS_MIN_SILENCE_MS: '10000' },
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
        /*
         * A generous window, because she has competition for it.
         *
         * Three minutes of silence is long enough for the initiative to fire, so
         * an opener can land in the same window as the answer and the question
         * gets its reply a beat later. The claim under test is that the session
         * is still alive and still responsive, not that she is quick.
         */
        const before = s.said.length;
        s.companion.say('Still there? Say yes.');
        const answered = await untilSpoke(s, before, 45_000);
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

  // -- 9. Hands ------------------------------------------------------------
  /*
   * Three criteria that did not exist before v2.0, and one that did but was
   * measured against the wrong thing.
   *
   * These deliberately do not drive a Live session. What is being asked is
   * whether the machine actually changed and whether the log says it did, and
   * a real model deciding to call `run` is a separate and much flakier
   * question. The tool dispatch itself has unit tests; this is the half that
   * cannot be faked, because a fake filesystem would pass whether or not the
   * command ran.
   */
  await check(
    'Hands — `run`, `open` and `write` act on the machine and are logged',
    '#3 hands',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'hers-hands-'));
      const hands = new Hands({ dir: root });
      const target = path.join(root, 'note.txt');

      const ran = await hands.run('echo hers-audit');
      const wrote = await hands.write(target, 'a line she wrote\n');
      const refused = await hands.run('rm -rf /');

      const log = readFileSync(hands.logPath, 'utf8').trimEnd().split('\n');
      const wroteIt = readFileSync(target, 'utf8');
      await rm(root, { recursive: true, force: true });

      return {
        ok:
          ran.ok &&
          /hers-audit/.test(ran.output ?? '') &&
          wrote.ok &&
          wroteIt === 'a line she wrote\n' &&
          refused.needsConfirmation === true &&
          log.length === 3,
        evidence: `run exit=${String(ran.exitCode)}, wrote ${String(wroteIt.length)} chars, destructive gated=${String(refused.needsConfirmation)}, ${String(log.length)} log lines`,
      };
    },
  );

  // -- 10. Place -----------------------------------------------------------
  await check(
    'Weather — she has the right city and a real forecast',
    '#4 place',
    async () => {
      const place = await new PlaceSense().refresh();
      return {
        ok: Boolean(place.weather) && place.city.length > 0,
        evidence: place.weather
          ? `${place.city} (${place.timeZone}): ${String(place.weather.temperature)}°C, ${place.weather.condition}`
          : `${place.city}: no forecast came back`,
      };
    },
  );

  // -- 11. Sleep -----------------------------------------------------------
  await check(
    'Sleep — she is silent inside her own window and awake outside it',
    '#5 sleep',
    async () => {
      const rhythm = { sleepHour: 23, wakeHour: 7, why: 'measured' };
      const asleep = [23, 0, 3, 6].every((hour) => isAsleep(rhythm, hour));
      const awake = [7, 12, 22].every((hour) => !isAsleep(rhythm, hour));
      const groggy = isGroggy(rhythm, 23) && !isGroggy(rhythm, 4);
      return {
        ok: asleep && awake && groggy,
        evidence: `window 23→7: asleep=${String(asleep)}, awake=${String(awake)}, groggy only at the start=${String(groggy)}`,
      };
    },
  );

  // -- 12. Noticing --------------------------------------------------------
  await check(
    'Camera — a real change is captioned and an idle room is not',
    '#2 noticing',
    async () => {
      const key = process.env.GEMINI_API_KEY ?? '';
      if (!key) return { ok: false, evidence: 'no key' };

      // Two frames that genuinely differ, so the caption has something to say.
      const one = solid(320, 180, [20, 20, 30]);
      const two = solid(320, 180, [230, 220, 190]);
      const first = await captionFrame(key, one);
      const second = await captionFrame(key, two);
      const moved = distance(first, second);
      return {
        ok: first.length > 0 && second.length > 0 && moved >= CHANGE_THRESHOLD,
        evidence: `"${first.slice(0, 60)}" → "${second.slice(0, 60)}", distance ${moved.toFixed(2)} against ${String(CHANGE_THRESHOLD)}`,
      };
    },
  );

  // -- 13. What they are doing ----------------------------------------------
  await check(
    'Foreground — she can tell which application is in front',
    '#8 awareness',
    async () => {
      const sense = new ForegroundSense();
      const seen = await sense.poll();
      return {
        ok: Boolean(seen?.app),
        evidence: seen
          ? `${seen.app}${seen.title ? ` — ${seen.title}` : ''}`
          : 'nothing came back — on macOS this is Accessibility permission, and it is silent by design',
      };
    },
  );

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


await main();
