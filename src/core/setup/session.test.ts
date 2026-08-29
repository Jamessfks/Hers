import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { LiveServerMessage } from '@google/genai';

import { Brain } from '../session/brain.ts';
import { Conversation } from '../session/conversation.ts';
import { loadConfig } from '../../server/config.ts';
import { isFirstRun } from '../profile/first-run.ts';
import type { LiveConnector, LiveSocket } from '../gemini/live.ts';
import { SetupSession } from './session.ts';
import { DEFAULT_RHYTHM } from '../sleep/rhythm.ts';

class FakeSocket implements LiveSocket {
  emit: (message: LiveServerMessage) => void = () => undefined;
  closed = false;
  sendRealtimeInput(): void {}
  sendClientContent(): void {}
  sendToolResponse(): void {}
  close(): void {
    this.closed = true;
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hers-setup-'));
  const profileDir = path.join(root, 'profile');
  const brain = await Brain.open(
    loadConfig({
      GEMINI_API_KEY: 'test-key',
      HERS_PROFILE: profileDir,
      HERS_DATA: path.join(root, 'data'),
    } as NodeJS.ProcessEnv),
    { offline: true },
  );

  const sockets: FakeSocket[] = [];
  const connect: LiveConnector = async ({ callbacks }) => {
    const socket = new FakeSocket();
    socket.emit = (message) => callbacks.onmessage(message);
    sockets.push(socket);
    return socket;
  };
  return { brain, profileDir, connect, sockets };
}

function sink() {
  const events: string[] = [];
  return {
    events,
    sink: {
      audio: () => undefined,
      state: (state: string) => events.push(`state:${state}`),
      trouble: (message: string) => events.push(`trouble:${message}`),
      named: (name: string) => events.push(`named:${name}`),
      done: () => events.push('done'),
    },
  };
}

const COMPOSED = [
  '=== personality',
  'You do not soothe.',
  '=== voice',
  'chosen: Kore',
  'Flat and quick.',
  '=== rhythm',
  'sleep: 1',
  'wake: 9',
  'They stop around one.',
].join('\n');

test('a fresh profile folder is a first run, and a written rhythm is not', async () => {
  const f = await fixture();
  assert.equal(isFirstRun(f.profileDir), true, 'ensureProfile alone is not setup');

  const s = sink();
  const setup = new SetupSession({
    brain: f.brain,
    sink: s.sink,
    home: f.profileDir,
    connect: f.connect,
    name: async () => ({ name: 'Mei', why: 'it is short' }),
    composer: async () => ({ files: {}, voice: '', rhythm: DEFAULT_RHYTHM }),
  });
  await setup.finish();
  assert.equal(isFirstRun(f.profileDir), false);
});

test('what she composed lands in the profile folder, name and voice included', async () => {
  const f = await fixture();
  const s = sink();
  const { parseComposed } = await import('./compose.ts');

  const setup = new SetupSession({
    brain: f.brain,
    sink: s.sink,
    home: f.profileDir,
    connect: f.connect,
    name: async () => ({ name: 'Mei', why: 'it is short' }),
    composer: async () => parseComposed(COMPOSED),
  });
  await setup.finish();

  assert.match(readFileSync(path.join(f.profileDir, 'personality.md'), 'utf8'), /do not soothe/);
  assert.match(readFileSync(path.join(f.profileDir, 'voice.md'), 'utf8'), /voice: Kore/);
  assert.match(readFileSync(path.join(f.profileDir, 'identity.md'), 'utf8'), /name: Mei/);
  assert.match(readFileSync(path.join(f.profileDir, 'rhythm.md'), 'utf8'), /sleep: 1/);
  assert.deepEqual(s.events.slice(-2), ['named:Mei', 'done']);
});

test('the brain comes back holding what was just written', async () => {
  const f = await fixture();
  const s = sink();
  const { parseComposed } = await import('./compose.ts');
  const setup = new SetupSession({
    brain: f.brain,
    sink: s.sink,
    home: f.profileDir,
    connect: f.connect,
    name: async () => ({ name: 'Mei', why: '' }),
    composer: async () => parseComposed(COMPOSED),
  });
  await setup.finish();

  assert.equal(f.brain.profile.identity.name, 'Mei');
  assert.equal(f.brain.profile.voice.voice, 'Kore');
  assert.equal(f.brain.rhythm.sleepHour, 1);
});

test('a naming call that came back with nothing still ends setup', async () => {
  const f = await fixture();
  const s = sink();
  const setup = new SetupSession({
    brain: f.brain,
    sink: s.sink,
    home: f.profileDir,
    connect: f.connect,
    name: async () => null,
    composer: async () => ({ files: {}, voice: '', rhythm: DEFAULT_RHYTHM }),
  });
  await setup.finish();

  assert.equal(isFirstRun(f.profileDir), false, 'the interview must not repeat forever');
  assert.ok(existsSync(path.join(f.profileDir, 'rhythm.md')));
});

test('the first wake on a fresh profile is the interview, not a conversation', async () => {
  const f = await fixture();
  const conversation = new Conversation({ brain: f.brain, connect: f.connect });
  await conversation.wake();

  // One socket, and it is the setup one — `Conversation.live` is the ordinary
  // session, which has not been built.
  assert.equal(f.sockets.length, 1);
  assert.equal(conversation.live, null);
  await conversation.sleep();
  assert.equal(f.sockets[0]?.closed, true);
});

test('a companion who has already been composed wakes straight into a conversation', async () => {
  const f = await fixture();
  const { writeRhythm } = await import('../profile/profile.ts');
  await writeRhythm(f.profileDir, DEFAULT_RHYTHM);

  const conversation = new Conversation({ brain: f.brain, connect: f.connect });
  await conversation.wake();
  assert.ok(conversation.live, 'no interview for somebody she has already met');
});
