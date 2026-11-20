import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, pickApi, resolveModel, shippedProfiles } from '../lib/profiles.js';
import { SITES, resolveSites } from '../lib/sites.js';
import { baseUrlFor, redact, siteRoot } from '../lib/util.js';

const [com, ai] = resolveSites({});

test('the two sites are fixed routes with separate key references', () => {
  assert.deepEqual(SITES.map((s) => [s.id, s.baseURL, s.apiKeyEnv]), [
    ['modelgo', 'https://api.modelgo.com', 'MODELGO_API_KEY'],
    ['modelgo-ai', 'https://api.modelgo.ai', 'MODELGO_AI_API_KEY'],
  ]);
  assert.equal(com.enabled && ai.enabled, true);
});

test('resolveSites applies stored configuration per site', () => {
  const [a, b] = resolveSites({ sites: { modelgo: { baseURL: 'https://api.modelgo.com/v1/', models: [{ id: 'gpt-5' }, { name: 'no id' }] }, 'modelgo-ai': { enabled: false, displayName: 'Intl' } } });
  assert.equal(a.baseURL, 'https://api.modelgo.com');
  assert.deepEqual(a.models, [{ id: 'gpt-5' }]);
  assert.deepEqual([b.enabled, b.displayName, b.apiKeyEnv], [false, 'Intl', 'MODELGO_AI_API_KEY']);
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
  const { model } = resolveModel(com, { id: 'deepseek-v4-pro', contextWindow: 500000, input: ['text'] });
  assert.equal(model.api, 'openai-completions');
  assert.equal(model.baseUrl, 'https://api.modelgo.com/v1');
  assert.equal(model.provider, 'modelgo');
  assert.equal(model.contextWindow, 500000, 'the live site wins over the snapshot');
  assert.equal(model.reasoning, true);
  assert.equal(model.compat.thinkingFormat, 'deepseek');
  assert.equal(model.thinkingLevelMap.high, 'high');
});

test('Claude models go to the Anthropic surface at the site root, per site', () => {
  const { model } = resolveModel(ai, { id: 'claude-sonnet-5' });
  assert.equal(model.api, 'anthropic-messages');
  assert.equal(model.baseUrl, 'https://api.modelgo.ai');
  assert.equal(model.provider, 'modelgo-ai');
});

test('an unknown model is offered plain: text only, no reasoning', () => {
  const { model, pinnedMaxTokens } = resolveModel(com, { id: 'brand-new-model' });
  assert.deepEqual(model.input, ['text']);
  assert.equal(model.reasoning, false);
  assert.equal('thinkingLevelMap' in model, false);
  assert.equal(model.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(model.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(pinnedMaxTokens, undefined);
});

test('the user entry wins over both the site and the snapshot', () => {
  const { model, pinnedMaxTokens } = resolveModel(com, { id: 'brand-new-model', contextWindow: 1000, input: ['text'] }, {
    override: { id: 'brand-new-model', name: 'Mine', contextWindow: 64000, maxTokens: 4096, input: ['text', 'image'], reasoningLevels: ['off', 'high'], api: 'openai-responses' },
  });
  assert.deepEqual([model.name, model.contextWindow, model.maxTokens, model.api], ['Mine', 64000, 4096, 'openai-responses']);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, { off: 'off', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null });
  assert.equal(pinnedMaxTokens, 4096);
});

test('a model the site offers on no chat protocol is dropped', () => {
  assert.equal(resolveModel(com, { id: 'gpt-5' }, { protocols: ['openai_embeddings'] }), undefined);
});

test('every shipped profile names a supported wire API', () => {
  const profiles = shippedProfiles();
  assert.ok(Object.keys(profiles).length >= 70);
  for (const [id, p] of Object.entries(profiles)) assert.match(p.api, /^(openai-completions|anthropic-messages|openai-responses)$/, id);
});

// Observed live: api.modelgo.ai refuses max_tokens=128000 for this model, api.modelgo.com accepts it.
test('a per-site correction applies to that site only', () => {
  assert.equal(resolveModel(ai, { id: 'claude-sonnet-4.6' }).model.maxTokens, 64000);
  assert.equal(resolveModel(com, { id: 'claude-sonnet-4.6' }).model.maxTokens, 128000);
});

test('an unsized model on a small context gets an output cap that fits it', () => {
  assert.equal(resolveModel(com, { id: 'tiny-model', contextWindow: 8192 }).model.maxTokens, 4096);
});

// Observed live on both sites: glm-5.3-flash is listed with image input and refuses image requests.
test('a shipped input correction wins over what the site lists, and the user still wins over both', () => {
  const listed = { id: 'glm-5.3-flash', input: ['text', 'image'] };
  assert.deepEqual(resolveModel(com, listed).model.input, ['text']);
  assert.deepEqual(resolveModel(com, listed, { override: { id: 'glm-5.3-flash', input: ['text', 'image'] } }).model.input, ['text', 'image']);
});
