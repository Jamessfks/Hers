import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AvatarStudio, AvatarError, GESTURE_NAMES, IMAGE_LIMITS, isGesture, promptFor } from './studio.ts';
import { HedraClient, silentWav } from './hedra.ts';

/**
 * A stand-in for Hedra.
 *
 * Everything expensive about this feature is on the other side of the network,
 * which is exactly why it is faked here: the behaviour worth pinning down is
 * what happens when a render fails, when the photograph changes underneath one,
 * and when the budget is gone — and none of those are things to discover by
 * spending money.
 */
function fakeHedra(
  behaviour: {
    spent?: number | (() => number);
    onSubmit?: () => void;
    status?: 'COMPLETED' | 'FAILED';
    cost?: number;
    failUsage?: boolean;
  } = {},
) {
  const submitted: string[] = [];
  let spent = typeof behaviour.spent === 'function' ? behaviour.spent() : (behaviour.spent ?? 0);

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/usage')) {
      if (behaviour.failUsage) return new Response('nope', { status: 503 });
      return json({ total_spent: spent });
    }
    if (url.endsWith('/files')) return json({ url: `https://files.test/${submitted.length}` });
    if (url.includes('/models/')) {
      behaviour.onSubmit?.();
      const body = JSON.parse(String(init?.body ?? '{}')) as { input: { prompt: string } };
      submitted.push(body.input.prompt);
      spent += behaviour.cost ?? 0.05;
      return json({ job_id: `job-${submitted.length}`, status: 'IN_QUEUE' });
    }
    if (url.includes('/jobs/')) {
      const status = behaviour.status ?? 'COMPLETED';
      return json({
        status,
        cost: behaviour.cost ?? 0.05,
        ...(status === 'FAILED'
          ? { error: { message: 'the model refused that image' } }
          : { outputs: [{ url: 'https://cdn.test/clip.mp4' }] }),
      });
    }
    if (url.includes('cdn.test')) return new Response(Buffer.from('FAKEMP4'));
    return new Response('not found', { status: 404 });
  };

  return {
    submitted,
    get spent() {
      return spent;
    },
    client: new HedraClient({ apiKey: 'k_live_x:sk_y', fetch: fetchImpl }),
  };
}

/** A real 300x300 PNG header — big enough to pass, small enough to inline. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  header.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  return header;
}

async function studio(hedra: ReturnType<typeof fakeHedra> | null = null, budgetUsd = 1) {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), 'anna-avatar-')), 'avatar');
  const instance = new AvatarStudio({ dir, client: hedra?.client ?? null, budgetUsd });
  await instance.load();
  return { dir, studio: instance };
}

// -- the photograph ---------------------------------------------------------

test('a fresh studio has no face and says so', async () => {
  const { studio: s } = await studio();
  const state = s.state();
  assert.equal(state.hasSource, false);
  assert.equal(state.sourceUrl, null);
  assert.deepEqual(state.ready, []);
  assert.deepEqual(state.all, GESTURE_NAMES);
});

test('a real image is accepted and becomes the source', async () => {
  const { studio: s } = await studio();
  const state = await s.setSource(png(512, 640), 'image/png');
  assert.equal(state.hasSource, true);
  assert.equal(state.width, 512);
  assert.equal(state.height, 640);
  assert.match(state.sourceUrl ?? '', /^\/avatar\/source\?v=/);
  assert.ok(existsSync(s.sourcePath() ?? ''));
});

test('the same picture twice is the same url, a different one is not', async () => {
  const { studio: s } = await studio();
  const first = (await s.setSource(png(512, 640), 'image/png')).sourceUrl;
  const same = (await s.setSource(png(512, 640), 'image/png')).sourceUrl;
  const other = (await s.setSource(png(640, 512), 'image/png')).sourceUrl;

  assert.equal(first, same, 'the same bytes must not bust the cache');
  assert.notEqual(first, other, 'a new picture must, or the old one stays on screen');
});

test('what is refused, and why, in words a person can act on', async () => {
  const { studio: s } = await studio();

  await assert.rejects(() => s.setSource(Buffer.alloc(0), 'image/png'), /empty/);
  await assert.rejects(
    () => s.setSource(Buffer.from('this is just text'), 'image/jpeg'),
    /JPEG, PNG or WebP/,
  );
  await assert.rejects(() => s.setSource(png(64, 64), 'image/png'), /at least 256 pixels/);
  await assert.rejects(() => s.setSource(png(9000, 9000), 'image/png'), /cannot be over/);
  await assert.rejects(
    () => s.setSource(Buffer.alloc(IMAGE_LIMITS.maxBytes + 1, 1), 'image/png'),
    /The limit is/,
  );
});

test('the bytes decide the format, not the content-type header', async () => {
  const { studio: s } = await studio();
  // Claimed as JPEG, actually PNG. The magic number is the evidence.
  const state = await s.setSource(png(400, 400), 'image/jpeg');
  assert.equal(state.hasSource, true);
  assert.equal(s.sourceMimeType(), 'image/png');
});

test('the photograph is offered as a file, so she can send it as well as render from it', async () => {
  const { studio: s, dir } = await studio();
  assert.equal(s.face(), null, 'nothing to send before anything is uploaded');

  await s.setSource(png(512, 640), 'image/png');
  const face = s.face();
  assert.equal(face?.name, 'source.png');
  assert.equal(face?.mimeType, 'image/png');
  assert.equal(face?.absolutePath, path.join(dir, 'source.png'));
  assert.equal(face?.absolutePath, s.sourcePath(), 'one photograph, not two ideas of where it is');

  // Replacing it replaces what gets sent, rather than leaving the old one.
  await s.setSource(png(400, 400), 'image/jpeg');
  assert.equal(s.face()?.absolutePath, s.sourcePath());
});

// -- rendering --------------------------------------------------------------

test('a render produces a playable clip and marks the gesture ready', async () => {
  const hedra = fakeHedra();
  const { studio: s } = await studio(hedra);
  await s.setSource(png(512, 512), 'image/png');

  const clip = await s.render('idle', { seconds: 2 });
  assert.equal(clip.costUsd, 0.05);
  assert.ok(s.has('idle'));
  assert.deepEqual(s.readyGestures(), ['idle']);
  assert.equal(await readFile(s.clipPath('idle') ?? '', 'utf8'), 'FAKEMP4');
});

test('the prompt always asks the clip to return to the photograph', () => {
  for (const gesture of GESTURE_NAMES) {
    const prompt = promptFor(gesture);
    assert.match(prompt, /begins and ends in the same pose/);
    assert.match(prompt, /unchanged background/);
  }
});

test('a render cannot start without a photograph', async () => {
  const hedra = fakeHedra();
  const { studio: s } = await studio(hedra);
  await assert.rejects(() => s.render('idle'), /photograph first/);
  assert.equal(hedra.submitted.length, 0, 'it must not have paid for anything');
});

test('with no key nothing is submitted and the message says why', async () => {
  const { studio: s } = await studio(null);
  await s.setSource(png(300, 300), 'image/png');
  await assert.rejects(() => s.render('idle'), /HEDRA_API_KEY/);
});

test('a failed render leaves the gesture unrendered rather than half-there', async () => {
  const hedra = fakeHedra({ status: 'FAILED' });
  const { studio: s } = await studio(hedra);
  await s.setSource(png(300, 300), 'image/png');

  await assert.rejects(() => s.render('idle'), /refused that image/);
  assert.equal(s.has('idle'), false);
  assert.equal(s.state().rendering.length, 0, 'it must not still look like it is going');
});

// -- money ------------------------------------------------------------------

test('the budget is checked before submitting, not after', async () => {
  const hedra = fakeHedra({ spent: 10 });
  const { studio: s } = await studio(hedra, 1);
  await s.setSource(png(300, 300), 'image/png');
  await s.render('idle');

  // The first render set the baseline at 10 and pushed spend to 10.05. A
  // budget of 1 is not exhausted yet, so this one is allowed...
  await s.render('nod');
  assert.equal(hedra.submitted.length, 2);
});

test('once the budget is gone nothing is submitted', async () => {
  const hedra = fakeHedra({ spent: 0, cost: 0.6 });
  const { studio: s } = await studio(hedra, 1);
  await s.setSource(png(300, 300), 'image/png');

  await s.render('idle');
  await s.render('nod');
  const submittedBefore = hedra.submitted.length;

  await assert.rejects(() => s.render('tilt'), /budget is spent/);
  assert.equal(hedra.submitted.length, submittedBefore, 'it submitted past the ceiling');
});

test('a budget that cannot be established refuses rather than assumes zero', async () => {
  const hedra = fakeHedra({ failUsage: true });
  const { studio: s } = await studio(hedra, 1);
  await s.setSource(png(300, 300), 'image/png');

  await assert.rejects(() => s.render('idle'), /Could not check how much/);
  assert.equal(hedra.submitted.length, 0);
});

// -- the ways this used to lose money ---------------------------------------

test('the job id is written down before the wait, so a crash can resume', async () => {
  let manifestDuringSubmit = '';
  const dirHolder: { dir?: string } = {};
  const hedra = fakeHedra();
  const { dir, studio: s } = await studio(hedra);
  dirHolder.dir = dir;
  await s.setSource(png(300, 300), 'image/png');

  // Read the manifest at the moment the job exists but has not finished.
  const original = hedra.client.wait.bind(hedra.client);
  hedra.client.wait = async (id, options) => {
    manifestDuringSubmit = await readFile(path.join(dir, 'manifest.json'), 'utf8');
    return original(id, options);
  };

  await s.render('idle');
  const pending = JSON.parse(manifestDuringSubmit) as { pending: Array<{ jobId: string }> };
  assert.equal(pending.pending.length, 1, 'the handle was not persisted before waiting');
  assert.ok(pending.pending[0]?.jobId);
});

test('an interrupted render is recovered rather than paid for twice', async () => {
  const hedra = fakeHedra();
  const { dir, studio: s } = await studio(hedra);
  await s.setSource(png(300, 300), 'image/png');

  // Simulate a process that died between submit and completion.
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
    source: { id: string };
    pending: unknown[];
  };
  manifest.pending = [
    { gesture: 'idle', jobId: 'job-orphan', sourceId: manifest.source.id, startedAt: Date.now() },
  ];
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

  const revived = new AvatarStudio({ dir, client: hedra.client, budgetUsd: 1 });
  await revived.load();
  const recovered = await revived.resume();

  assert.deepEqual(recovered, ['idle']);
  assert.equal(hedra.submitted.length, 0, 'resuming must not submit a new job');
  assert.ok(revived.has('idle'));
});

test('a clip from a job that predates the current photograph is not adopted', async () => {
  // The reachable version of "the photograph changed mid-render": submit,
  // crash, upload a different picture, restart. `resume` then finds a finished
  // job belonging to a face that is no longer hers, and a clip of the wrong
  // person cutting over the still is worse than no clip at all.
  const hedra = fakeHedra();
  const { dir, studio: s } = await studio(hedra);
  await s.setSource(png(300, 300), 'image/png');

  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
    pending: unknown[];
  };
  manifest.pending = [
    {
      gesture: 'idle',
      jobId: 'job-from-the-old-face',
      sourceId: 'a-photograph-that-has-since-been-replaced',
      startedAt: Date.now(),
    },
  ];
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

  const revived = new AvatarStudio({ dir, client: hedra.client, budgetUsd: 1 });
  await revived.load();
  assert.deepEqual(await revived.resume(), [], 'it adopted a clip of the wrong face');
  assert.equal(revived.has('idle'), false);

  const after = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
    pending: unknown[];
  };
  assert.deepEqual(after.pending, [], 'and it should stop asking about it');
});

test('the photograph cannot be swapped while something is rendering', async () => {
  const hedra = fakeHedra();
  const { studio: s } = await studio(hedra);
  await s.setSource(png(300, 300), 'image/png');

  const original = hedra.client.wait.bind(hedra.client);
  let refusal: unknown = null;
  hedra.client.wait = async (id, options) => {
    refusal = await s.setSource(png(400, 400), 'image/png').catch((error: unknown) => error);
    return original(id, options);
  };

  await s.render('idle');
  assert.ok(refusal instanceof AvatarError, 'the swap should have been refused');
  assert.match((refusal as AvatarError).message, /middle of a render/);
});

test('replacing the photograph invalidates every clip rendered from the old one', async () => {
  const hedra = fakeHedra();
  const { studio: s } = await studio(hedra);
  await s.setSource(png(300, 300), 'image/png');
  await s.render('idle');
  assert.ok(s.has('idle'));

  await s.setSource(png(400, 400), 'image/png');
  assert.equal(s.has('idle'), false, 'a clip of the old face must not play over the new one');
  assert.deepEqual(s.state().ready, []);
});

// -- the driving audio ------------------------------------------------------

test('the silent track is a real WAV, long enough, and not digital silence', () => {
  const wav = silentWav(2);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString(), 'WAVE');

  const samples = (wav.length - 44) / 2;
  assert.equal(samples, 32_000, '2 seconds at 16kHz');

  // Digital zero makes the model hallucinate mouth movement; the floor exists
  // to stop that, and a test that only checked the header would not notice it
  // disappearing.
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let peak = 0;
  for (let i = 0; i < samples; i += 1) peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 2, true)));
  assert.ok(peak > 0, 'the track is digitally silent, which is the bug this guards');
  assert.ok(peak <= 16, `the noise floor is audible at ${peak}`);
});

test('a clip shorter than Hedra will accept is padded to the floor', () => {
  assert.equal((silentWav(0.1).length - 44) / 2, 8000, 'below 500ms is a 422, not a short clip');
});

test('gesture names are validated before they reach the filesystem', () => {
  assert.equal(isGesture('idle'), true);
  for (const bad of ['../../.env', 'idle/../x', '', 'IDLE', 42, null]) {
    assert.equal(isGesture(bad), false, `${String(bad)} was accepted`);
  }
});
