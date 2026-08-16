import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from './config.ts';
import { DEFAULT_LIVE_MODEL } from '../core/gemini/models.ts';

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

test('an empty environment still produces a working configuration', () => {
  const config = loadConfig(env({}));
  assert.equal(config.geminiApiKey, '');
  assert.equal(config.model, DEFAULT_LIVE_MODEL);
  assert.equal(config.host, '127.0.0.1', 'binding wider by default would be a mistake');
  assert.equal(config.port, 5175);
  assert.equal(config.maxSilenceMs, 180_000, 'the three-minute promise is the default');
  assert.equal(config.telegram, null);
  assert.equal(config.livekit, null);
  assert.deepEqual(config.warnings, []);
});

test('GOOGLE_API_KEY is accepted, because half the docs use it', () => {
  assert.equal(loadConfig(env({ GOOGLE_API_KEY: 'abc' })).geminiApiKey, 'abc');
  assert.equal(
    loadConfig(env({ GEMINI_API_KEY: 'first', GOOGLE_API_KEY: 'second' })).geminiApiKey,
    'first',
  );
});

test('paths are resolved so nothing depends on the working directory', () => {
  const config = loadConfig(env({ ANNA_PROFILE: 'somewhere', ANNA_DATA: 'else' }));
  assert.ok(path.isAbsolute(config.profileDir));
  assert.ok(path.isAbsolute(config.dataDir));
});

test('a bad number warns and falls back rather than failing to start', () => {
  const config = loadConfig(env({ ANNA_PORT: 'banana' }));
  assert.equal(config.port, 5175);
  assert.match(config.warnings.join(' '), /ANNA_PORT/);
});

test('an out-of-range number is clamped and said out loud', () => {
  const config = loadConfig(env({ ANNA_PORT: '99999' }));
  assert.equal(config.port, 65535);
  assert.match(config.warnings.join(' '), /out of range/);
});

test('a silence floor above the ceiling cannot silently break the promise', () => {
  const config = loadConfig(env({ ANNA_MAX_SILENCE_MS: '60000', ANNA_MIN_SILENCE_MS: '120000' }));
  assert.equal(config.maxSilenceMs, 60_000);
  assert.equal(config.minSilenceMs, 60_000);
  assert.match(config.warnings.join(' '), /above ANNA_MAX_SILENCE_MS/);
});

test('frame rates cannot exceed what the Live API accepts', () => {
  const config = loadConfig(env({ ANNA_CAMERA_FPS: '30', ANNA_SCREEN_FPS: '0,25' }));
  assert.equal(config.cameraFps, 1, 'the API takes at most one frame per second');
  assert.equal(config.screenFps, 0.25, 'and a decimal comma is what half the world types');
  assert.match(config.warnings.join(' '), /1 frame per second/);
});

test('half-configured LiveKit is off, and says why', () => {
  const config = loadConfig(env({ LIVEKIT_URL: 'wss://x.livekit.cloud' }));
  assert.equal(config.livekit, null);
  assert.match(config.warnings.join(' '), /half configured/);
});

test('fully configured LiveKit is on', () => {
  const config = loadConfig(
    env({
      LIVEKIT_URL: 'wss://x.livekit.cloud',
      LIVEKIT_API_KEY: 'key',
      LIVEKIT_API_SECRET: 'secret',
      ANNA_CALL_PAGE_URL: 'https://example.github.io/anna/',
    }),
  );
  assert.equal(config.livekit?.url, 'wss://x.livekit.cloud');
  assert.deepEqual(config.warnings, []);
});

test('LiveKit without a call page warns, because /call would have nowhere to point', () => {
  const config = loadConfig(
    env({ LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' }),
  );
  assert.ok(config.livekit);
  assert.match(config.warnings.join(' '), /ANNA_CALL_PAGE_URL/);
});

test('a Telegram bot with no allowlist is flagged, loudly', () => {
  const config = loadConfig(env({ TELEGRAM_BOT_TOKEN: '123:abc' }));
  assert.deepEqual(config.telegram?.allowedChatIds, []);
  assert.match(config.warnings.join(' '), /first chat/);
});

test('chat ids are parsed from anything a person would type', () => {
  const config = loadConfig(
    env({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_ALLOWED_CHAT_IDS: '111, -222  333' }),
  );
  assert.deepEqual(config.telegram?.allowedChatIds, [111, -222, 333]);
  assert.deepEqual(config.warnings, [], 'a valid list should not warn');
});

test('a chat id that is not a number is called out rather than dropped in silence', () => {
  const config = loadConfig(
    env({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_ALLOWED_CHAT_IDS: '111,@zicheng' }),
  );
  assert.deepEqual(config.telegram?.allowedChatIds, [111]);
  assert.match(config.warnings.join(' '), /@zicheng/);
});
