import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readSse } from './sse.ts';

/** Streams `text` in fixed-size slices to simulate arbitrary chunk boundaries. */
function streamOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

const WIRE = [
  'event: message_start',
  'data: {"a":1}',
  '',
  'data: {"b":2}',
  '',
  ': this is a comment',
  'event: done',
  'data: [DONE]',
  '',
  '',
].join('\n');

test('parses events regardless of where chunk boundaries land', async () => {
  for (const chunkSize of [1, 3, 7, 64, 4096]) {
    const events = [];
    for await (const event of readSse(streamOf(WIRE, chunkSize))) events.push(event);
    assert.deepEqual(
      events,
      [
        { event: 'message_start', data: '{"a":1}' },
        { data: '{"b":2}' },
        { event: 'done', data: '[DONE]' },
      ],
      `chunk size ${chunkSize}`,
    );
  }
});

test('handles CRLF framing', async () => {
  const events = [];
  for await (const event of readSse(streamOf('data: one\r\n\r\ndata: two\r\n\r\n', 5))) {
    events.push(event);
  }
  assert.deepEqual(events, [{ data: 'one' }, { data: 'two' }]);
});

test('joins multi-line data fields with a newline', async () => {
  const events = [];
  for await (const event of readSse(streamOf('data: a\ndata: b\n\n', 2))) events.push(event);
  assert.deepEqual(events, [{ data: 'a\nb' }]);
});

test('does not split a multi-byte character across chunks', async () => {
  const events = [];
  // "café 😀" is 4 bytes for the emoji; a 1-byte chunker will split it.
  for await (const event of readSse(streamOf('data: café 😀\n\n', 1))) events.push(event);
  assert.deepEqual(events, [{ data: 'café 😀' }]);
});
