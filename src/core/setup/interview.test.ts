import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEARD_NAME, Interview, MAX_CONSENT_ASKS, SCAN, setupInstruction, setupTools } from './interview.ts';
import type { ScanReport } from '../knowledge/scan.ts';

const REPORT: ScanReport = {
  findings: [{ name: 'thesis/chapter-3.md', excerpt: 'The argument so far' }],
  seen: 812,
  read: 40,
  refused: 3,
  denied: [],
};

function interview(report: ScanReport | Error = REPORT): {
  interview: Interview;
  folders: string[][];
} {
  const folders: string[][] = [];
  return {
    folders,
    interview: new Interview({
      home: '/Users/sam',
      profileDir: '/Users/sam/profile',
      consent: async () => undefined,
      scan: async (list) => {
        folders.push([...list]);
        if (report instanceof Error) throw report;
        return report;
      },
    }),
  };
}

test('she has two tools during setup and neither can run anything', () => {
  const names = setupTools().map((tool) => tool.name);
  assert.deepEqual(names.sort(), [HEARD_NAME, SCAN].sort());
});

test('the name they said is the name that is kept', async () => {
  const { interview: i } = interview();
  await i.onToolCall(HEARD_NAME, { name: '  Sam  ' });
  assert.equal(i.name, 'Sam');
});

test('a refusal tells her how many times she has asked and how to ask again', async () => {
  const { interview: i, folders } = interview();
  const first = (await i.onToolCall(SCAN, { consented: false })) as Record<string, unknown>;
  assert.equal(first.consented, false);
  assert.equal(first.attempts, 1);
  assert.equal(first.exhausted, false);
  assert.match(String(first.note), /differently/);
  assert.equal(folders.length, 0, 'nothing is read on a no');
});

test('she runs out of asks rather than asking forever', async () => {
  const { interview: i } = interview();
  let last: Record<string, unknown> = {};
  for (let ask = 0; ask < MAX_CONSENT_ASKS; ask += 1) {
    last = (await i.onToolCall(SCAN, { consented: false })) as Record<string, unknown>;
  }
  assert.equal(last.exhausted, true);
  assert.match(String(last.note), /last time|let it go/i);
});

test('a yes reads the whole home folder, once', async () => {
  const { interview: i, folders } = interview();
  const answer = (await i.onToolCall(SCAN, { consented: true })) as Record<string, unknown>;
  assert.deepEqual(folders, [['/Users/sam']]);
  assert.equal(answer.consented, true);
  assert.equal(answer.files, 812);
  assert.equal(answer.opened, 40);
});

test('the findings themselves do not come back into the live session', async () => {
  const { interview: i } = interview();
  const answer = (await i.onToolCall(SCAN, { consented: true })) as Record<string, unknown>;
  // A hundred thousand characters injected into an audio session would evict
  // the conversation she is having. She gets a shape, and the composer gets
  // the text.
  assert.doesNotMatch(JSON.stringify(answer), /chapter-3|argument so far/);
  assert.match(i.digest(), /chapter-3/);
});

test('a refusal she never got past is still a finished interview', async () => {
  const { interview: i } = interview();
  await i.onToolCall(HEARD_NAME, { name: 'Sam' });
  assert.equal(i.complete, false);
  for (let ask = 0; ask < MAX_CONSENT_ASKS; ask += 1) {
    await i.onToolCall(SCAN, { consented: false });
  }
  assert.equal(i.complete, true);
  assert.match(i.digest(), /did not want/);
});

test('a folder that cannot be read comes back as the thing that fixes it', async () => {
  const denied = Object.assign(new Error('nope'), { code: 'EPERM' });
  const { interview: i } = interview(denied);
  const answer = (await i.onToolCall(SCAN, { consented: true })) as Record<string, unknown>;
  assert.equal(answer.ok, false);
  assert.match(String(answer.reason), /Full Disk Access|permission/i);
});

test('a tool she was not given does nothing', async () => {
  const { interview: i } = interview();
  const answer = (await i.onToolCall('run', { command: 'rm -rf /' })) as Record<string, unknown>;
  assert.equal(answer.ok, false);
});

test('the instruction refuses to let the user configure her', () => {
  const instruction = setupInstruction();
  assert.match(instruction, /Do not offer them choices about you/);
  assert.match(instruction, /Ask again differently/i);
  // She must not narrate the machinery she is part of.
  assert.match(instruction, /Do not mention profiles, files/);
});
