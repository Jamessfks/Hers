import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MODEL_CATALOG,
  defaultModelFor,
  isConversational,
  isForeignModel,
  modelBelongsTo,
  rankModels,
  resolveModel,
} from './models.ts';

// -- ownership --------------------------------------------------------------

test('model names are attributed to the right vendor', () => {
  assert.equal(modelBelongsTo('claude-sonnet-5'), 'anthropic');
  assert.equal(modelBelongsTo('claude-haiku-4-5-20251001'), 'anthropic');
  assert.equal(modelBelongsTo('gpt-4.1-mini'), 'openai');
  assert.equal(modelBelongsTo('o3-mini'), 'openai');
  assert.equal(modelBelongsTo('chatgpt-4o-latest'), 'openai');
  assert.equal(modelBelongsTo('gemini-2.5-flash'), 'google');
  assert.equal(modelBelongsTo('models/gemini-2.5-pro'), 'google');
});

test('an unrecognised name belongs to nobody, so it is left alone', () => {
  // Fine-tunes and self-hosted names must survive a provider round trip rather
  // than being helpfully replaced.
  assert.equal(modelBelongsTo('my-finetune-v3'), null);
  assert.equal(modelBelongsTo(''), null);
  assert.equal(isForeignModel('openai', 'my-finetune-v3'), false);
});

test('a model from another vendor is detected as foreign', () => {
  assert.equal(isForeignModel('openai', 'claude-sonnet-5'), true);
  assert.equal(isForeignModel('anthropic', 'claude-sonnet-5'), false);
  assert.equal(isForeignModel('google', 'gpt-4.1'), true);
});

// -- the bug this file exists for -------------------------------------------

test('switching provider never carries the old vendor model across', () => {
  // The original bug: settings kept config.llm.model on a provider change, so
  // Anthropic -> OpenAI left `claude-sonnet-5` configured and every request
  // 404'd with a vendor error nobody would trace back to the dropdown.
  for (const provider of ['anthropic', 'openai', 'google'] as const) {
    for (const stale of ['claude-sonnet-5', 'gpt-4.1', 'gemini-2.5-flash']) {
      const chosen = resolveModel({ provider, current: stale });
      assert.equal(
        isForeignModel(provider, chosen),
        false,
        `${provider} resolved to ${chosen} from stale ${stale}`,
      );
    }
  }
});

test('falls back to the provider default when nothing is known', () => {
  assert.equal(resolveModel({ provider: 'openai' }), defaultModelFor('openai'));
  assert.equal(resolveModel({ provider: 'google' }), 'gemini-2.5-flash');
});

test('remembers what you last chose for that provider', () => {
  const remembered = { anthropic: 'claude-opus-5', openai: 'gpt-4o' } as const;
  assert.equal(resolveModel({ provider: 'openai', remembered }), 'gpt-4o');
  assert.equal(resolveModel({ provider: 'anthropic', remembered }), 'claude-opus-5');
  // Nothing remembered for google, so the default.
  assert.equal(resolveModel({ provider: 'google', remembered }), 'gemini-2.5-flash');
});

test('a remembered model that no longer exists is dropped', () => {
  const chosen = resolveModel({
    provider: 'openai',
    remembered: { openai: 'gpt-4-retired' },
    available: ['gpt-4.1', 'gpt-4o'],
  });
  assert.equal(chosen, 'gpt-4.1');
});

test('a remembered model from the wrong vendor is ignored', () => {
  // Guards against a corrupted or hand-edited config file.
  const chosen = resolveModel({ provider: 'openai', remembered: { openai: 'claude-opus-5' } });
  assert.equal(chosen, defaultModelFor('openai'));
});

test('the result is always in the live list when there is one', () => {
  const available = ['gpt-4o-mini', 'gpt-4o'];
  for (const current of ['claude-sonnet-5', 'gpt-4.1', 'anything', '']) {
    const chosen = resolveModel({ provider: 'openai', current, available });
    assert.ok(available.includes(chosen), `${chosen} is not offered by the provider`);
  }
});

test('a custom model the provider does offer is preserved', () => {
  const chosen = resolveModel({
    provider: 'openai',
    current: 'ft:gpt-4.1:anna:custom',
    available: ['gpt-4.1', 'ft:gpt-4.1:anna:custom'],
  });
  assert.equal(chosen, 'ft:gpt-4.1:anna:custom');
});

test('prefers the catalogue order among what is offered', () => {
  // gpt-4o is offered and gpt-4.1 is not, so it should not fall to the
  // alphabetically-first thing in the list.
  const chosen = resolveModel({
    provider: 'openai',
    available: ['aardvark-1', 'gpt-4o', 'zebra-9'],
  });
  assert.equal(chosen, 'gpt-4o');
});

test('an empty live list is treated as "could not fetch", not "none exist"', () => {
  assert.equal(resolveModel({ provider: 'anthropic', available: [] }), 'claude-sonnet-5');
});

// -- ranking ----------------------------------------------------------------

test('ranking floats the catalogue to the top and sinks the junk', () => {
  const ranked = rankModels('openai', [
    { id: 'babbage-002', label: 'babbage-002' },
    { id: 'text-embedding-3-small', label: 'emb' },
    { id: 'gpt-4.1', label: 'gpt-4.1' },
    { id: 'gpt-5-preview', label: 'gpt-5-preview' },
    { id: 'dall-e-3', label: 'dall-e-3' },
  ]);
  assert.equal(ranked[0]?.id, 'gpt-4.1', 'catalogue model should lead');
  assert.equal(ranked[1]?.id, 'gpt-5-preview', 'unknown chat model should come next');
  assert.deepEqual(
    ranked.slice(-2).map((m) => m.id).sort(),
    ['dall-e-3', 'text-embedding-3-small'],
    'non-conversational models sink',
  );
});

test('ranking is stable and loses nothing', () => {
  const input = MODEL_CATALOG.google.map((id) => ({ id, label: id }));
  assert.deepEqual(rankModels('google', input), input);
  assert.equal(rankModels('google', input).length, input.length);
});

test('non-conversational endpoints are recognised for each vendor', () => {
  assert.equal(isConversational('openai', 'text-embedding-3-small'), false);
  assert.equal(isConversational('openai', 'whisper-1'), false);
  assert.equal(isConversational('openai', 'gpt-4.1'), true);
  assert.equal(isConversational('google', 'text-embedding-004'), false);
  assert.equal(isConversational('google', 'gemini-2.5-flash'), true);
  assert.equal(isConversational('anthropic', 'claude-opus-5'), true);
});
