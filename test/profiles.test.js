import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, pickApi, resolveModel, shippedProfiles } from '../lib/profiles.js';
import { SITES, resolveSites } from '../lib/sites.js';
import { baseUrlFor, redact, siteRoot } from '../lib/util.js';

const [site] = resolveSites({});

test('the site is one fixed route with one key reference', () => {
  assert.deepEqual(SITES.map((s) => [s.id, s.displayName, s.baseURL, s.apiKeyEnv]), [
    ['modelgo', 'ModelGo', 'https://api.modelgo.ai', 'MODELGO_API_KEY'],
  ]);
  assert.equal(site.enabled, true);
});

test('resolveSites applies stored configuration', () => {
  const [a] = resolveSites({ sites: { modelgo: { baseURL: 'https://gateway.example/v1/', displayName: 'Mine', models: [{ id: 'gpt-5' }, { name: 'no id' }] } } });
  assert.equal(a.baseURL, 'https://gateway.example');
  assert.deepEqual(a.models, [{ id: 'gpt-5' }]);
  assert.deepEqual([a.enabled, a.displayName, a.apiKeyEnv], [true, 'Mine', 'MODELGO_API_KEY']);
  assert.equal(resolveSites({ sites: { modelgo: { enabled: false } } })[0].enabled, false);
});

test('url helpers and redaction', () => {
  assert.equal(siteRoot('https://api.modelgo.ai/v1//'), 'https://api.modelgo.ai');
  assert.equal(baseUrlFor('https://api.modelgo.ai', 'openai-completions'), 'https://api.modelgo.ai/v1');
  assert.equal(baseUrlFor('https://api.modelgo.ai/v1', 'anthropic-messages'), 'https://api.modelgo.ai');
  assert.equal(redact('key mgk_abcdefgh1234 and custom-secret', 'custom-secret'), 'key mgk_<redacted> and <redacted>');
});

test('pickApi honours what the site advertises', () => {
  assert.equal(pickApi('claude-sonnet-5'), 'anthropic-messages');
  assert.equal(pickApi('gpt-5'), 'openai-completions');
  assert.equal(pickApi('claude-sonnet-5', ['openai_chat_completions', 'anthropic_messages']), 'anthropic-messages');
  assert.equal(pickApi('claude-sonnet-5', ['openai_chat_completions']), 'openai-completions');
  assert.equal(pickApi('gpt-5.4-pro', ['openai_responses']), 'openai-responses');
  assert.equal(pickApi('some-image-model', ['openai_images']), undefined);
});

test('a shipped model gets its wire quirks from the snapshot and its sizes from the site', () => {
  const { model } = resolveModel(site, { id: 'deepseek-v4-pro', contextWindow: 500000, input: ['text'] });
  assert.equal(model.api, 'openai-completions');
  assert.equal(model.baseUrl, 'https://api.modelgo.ai/v1');
  assert.equal(model.provider, 'modelgo');
  assert.equal(model.contextWindow, 500000, 'the live site wins over the snapshot');
  assert.equal(model.reasoning, true);
  assert.equal(model.compat.thinkingFormat, 'deepseek');
  assert.equal(model.thinkingLevelMap.high, 'high');
});

test('Claude models go to the Anthropic surface at the site root', () => {
  const { model } = resolveModel(site, { id: 'claude-sonnet-5' });
  assert.equal(model.api, 'anthropic-messages');
  assert.equal(model.baseUrl, 'https://api.modelgo.ai');
  assert.equal(model.provider, 'modelgo');
});

test('an unknown model is offered plain: text only, no reasoning', () => {
  const { model, pinnedMaxTokens } = resolveModel(site, { id: 'brand-new-model' });
  assert.deepEqual(model.input, ['text']);
  assert.equal(model.reasoning, false);
  assert.equal('thinkingLevelMap' in model, false);
  assert.equal(model.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(model.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(pinnedMaxTokens, undefined);
});

test('the user entry wins over both the site and the snapshot', () => {
  const { model, pinnedMaxTokens } = resolveModel(site, { id: 'brand-new-model', contextWindow: 1000, input: ['text'] }, {
    override: { id: 'brand-new-model', name: 'Mine', contextWindow: 64000, maxTokens: 4096, input: ['text', 'image'], reasoningLevels: ['off', 'high'], api: 'openai-responses' },
  });
  assert.deepEqual([model.name, model.contextWindow, model.maxTokens, model.api], ['Mine', 64000, 4096, 'openai-responses']);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, { off: 'off', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null });
  assert.equal(pinnedMaxTokens, 4096);
});

test('a model the site offers on no chat protocol is dropped', () => {
  assert.equal(resolveModel(site, { id: 'gpt-5' }, { protocols: ['openai_embeddings'] }), undefined);
});

test('every shipped profile names a supported wire API', () => {
  const profiles = shippedProfiles();
  assert.ok(Object.keys(profiles).length >= 70);
  for (const [id, p] of Object.entries(profiles)) assert.match(p.api, /^(openai-completions|anthropic-messages|openai-responses)$/, id);
});

// Observed live: the site refuses max_tokens=128000 for this model and accepts 64000.
test('a limit the site sets lower than the vendor is applied', () => {
  assert.equal(resolveModel(site, { id: 'claude-sonnet-4.6' }).model.maxTokens, 64000);
  assert.equal(resolveModel(site, { id: 'claude-sonnet-5' }).model.maxTokens, 128000);
});

test('an unsized model on a small context gets an output cap that fits it', () => {
  assert.equal(resolveModel(site, { id: 'tiny-model', contextWindow: 8192 }).model.maxTokens, 4096);
});

// What a model can read is the site's statement about that model; the plugin does not second-guess it.
test('input types the site lists are passed through as listed', () => {
  assert.deepEqual(resolveModel(site, { id: 'glm-5.3-flash', input: ['text', 'image'] }).model.input, ['text', 'image']);
});

// Observed live: qwen3.6-flash refuses reasoning_effort=medium and accepts high.
test('a level the model does not have is not offered', () => {
  const { model } = resolveModel(site, { id: 'qwen3.6-flash' });
  assert.equal(model.thinkingLevelMap.medium, null);
  assert.notEqual(model.thinkingLevelMap.high, null);
});
