import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toConversation, validateConversation, type TranscriptTurn } from './conversation.ts';

const t = (speaker: 'user' | 'anna', text: string): TranscriptTurn => ({ speaker, text });

/** A normal alternating conversation of `n` exchanges. */
function exchanges(n: number): TranscriptTurn[] {
  return Array.from({ length: n }, (_, i) => [t('user', `u${i}`), t('anna', `a${i}`)]).flat();
}

test('the first message is always from the user', () => {
  // The session-killer: the window is sliced by row count, so every other
  // exchange it lands on one of Anna's turns and Anthropic 400s the request.
  for (let n = 1; n <= 40; n += 1) {
    const messages = toConversation(exchanges(n), { maxMessages: 24 });
    if (messages.length === 0) continue;
    assert.equal(messages[0]?.role, 'user', `${n} exchanges produced an assistant-first window`);
  }
});

test('every window of a long conversation is valid', () => {
  for (let n = 1; n <= 60; n += 1) {
    const problem = validateConversation(toConversation(exchanges(n), { maxMessages: 24 }));
    assert.equal(problem, null, `${n} exchanges: ${problem}`);
  }
});

test('an interrupted reply does not leave two user turns adjacent', () => {
  // The user's turn is stored immediately; Anna's only after her audio ends.
  // Barge in, and the store legitimately holds user -> user.
  const messages = toConversation([
    t('user', 'first'),
    t('anna', 'reply'),
    t('user', 'interrupted her'),
    t('user', 'and said this too'),
  ]);
  assert.equal(validateConversation(messages), null);
  assert.equal(messages.at(-1)?.content, 'interrupted her\nand said this too', 'joined, not dropped');
});

test('consecutive assistant turns are joined too', () => {
  const messages = toConversation([t('user', 'hi'), t('anna', 'one'), t('anna', 'two')]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'one\ntwo' },
  ]);
});

test('empty turns are dropped rather than sent', () => {
  // A reply with no speakable text records as empty; Anthropic rejects it.
  const messages = toConversation([t('user', 'hi'), t('anna', '   '), t('user', 'still there?')]);
  assert.equal(validateConversation(messages), null);
  assert.deepEqual(messages.map((m) => m.content), ['hi\nstill there?']);
});

test('trimming keeps the newest turns', () => {
  const messages = toConversation(exchanges(20), { maxMessages: 6 });
  assert.ok(messages.length <= 6);
  assert.equal(messages.at(-1)?.content, 'a19', 'the most recent turn must survive');
});

test('a transcript that is only assistant turns yields nothing sendable', () => {
  // She spoke first and they have not answered: there is no user message, so
  // the caller must add a cue rather than send an invalid list.
  assert.deepEqual(toConversation([t('anna', 'you ok?')]), []);
});

test('validate catches every shape the providers reject', () => {
  assert.match(validateConversation([]) ?? '', /no messages/);
  assert.match(
    validateConversation([{ role: 'assistant', content: 'hi' }]) ?? '',
    /first message is assistant/,
  );
  assert.match(
    validateConversation([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]) ?? '',
    /both user/,
  );
  assert.match(
    validateConversation([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '  ' },
    ]) ?? '',
    /message 1 is empty/,
  );
});
