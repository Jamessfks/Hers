import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MediaKind,
  SENSE_NAMES,
  decodeMediaFrame,
  encodeMediaFrame,
  parseClientMessage,
} from './protocol.ts';

test('a media frame round-trips with its payload intact', () => {
  const payload = new Uint8Array([0, 255, 1, 128, 64]);
  const { kind, decoded } = (() => {
    const frame = encodeMediaFrame(MediaKind.MIC_PCM16, payload);
    const result = decodeMediaFrame(frame);
    return { kind: result.kind, decoded: result.payload };
  })();

  assert.equal(kind, MediaKind.MIC_PCM16);
  assert.deepEqual([...decoded], [...payload]);
});

test('every media kind survives the byte it is stored in', () => {
  for (const kind of Object.values(MediaKind)) {
    const frame = encodeMediaFrame(kind, new Uint8Array([7]));
    assert.equal(decodeMediaFrame(frame).kind, kind, `kind ${kind} did not round-trip`);
  }
});

test('an empty payload is a valid frame, not a crash', () => {
  const frame = encodeMediaFrame(MediaKind.CAMERA_JPEG, new Uint8Array(0));
  const { kind, payload } = decodeMediaFrame(frame);
  assert.equal(kind, MediaKind.CAMERA_JPEG);
  assert.equal(payload.length, 0);
});

test('an empty frame decodes to nothing rather than throwing', () => {
  const { kind, payload } = decodeMediaFrame(new Uint8Array(0));
  assert.equal(kind, 0);
  assert.equal(payload.length, 0);
});

test('the outbound kind is distinct from every inbound one', () => {
  const inbound = [MediaKind.MIC_PCM16, MediaKind.CAMERA_JPEG, MediaKind.SCREEN_JPEG];
  assert.ok(
    !inbound.includes(MediaKind.HERS_PCM24 as never),
    'a collision here would route her own voice back into her ears',
  );
});

test('a control message is parsed, and rubbish is refused rather than thrown', () => {
  assert.deepEqual(parseClientMessage('{"t":"wake"}'), { t: 'wake' });
  assert.equal(parseClientMessage('not json'), null);
  assert.equal(parseClientMessage('[]'), null, 'an array has no discriminant');
  assert.equal(parseClientMessage('null'), null);
  assert.equal(parseClientMessage('"a string"'), null);
  assert.equal(parseClientMessage('{"no":"discriminant"}'), null);
  assert.equal(parseClientMessage('{"t":42}'), null);
});

test('the sense names are the three the product promises', () => {
  assert.deepEqual([...SENSE_NAMES].sort(), ['hearing', 'screen', 'sight']);
});
