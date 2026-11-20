import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, endpointsUrl, isChatModel, parseEndpoints, parseModelList } from '../lib/catalog.js';

const site = { id: 'modelgo', baseURL: 'https://api.modelgo.com', headers: {} };

// Shape taken from the gateway's own /v1/models item (pkg/gateway/models.go).
const listing = (ids) => ({
  object: 'list',
  data: ids.map((id) => ({
    id, object: 'model', created: 1735689600, context_length: 200000,
    max_request_bytes: 33554432, input_modalities: ['text', 'image'], output_modalities: ['text'],
  })),
});

// A gateway stand-in: the model list at /v1/models, chat protocols for every endpoints read.
const gateway = (list) => async (url) => (String(url).endsWith('/v1/models') ? list() : jsonResponse({ object: 'list', data: [{ code: 'openai_chat_completions' }] }));
const listCalls = (calls) => calls.filter((c) => c.url.endsWith('/v1/models'));

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('parseModelList keeps what the gateway publishes and drops duplicates', () => {
  const entries = parseModelList({ data: [...listing(['gpt-5', 'gpt-5']).data, { id: '' }, { id: 'bare' }] });
  assert.deepEqual(entries.map((e) => e.id), ['gpt-5', 'bare']);
  assert.deepEqual(entries[0], {
    id: 'gpt-5', contextWindow: 200000, maxTokens: undefined, protocols: undefined,
    input: ['text', 'image'], output: ['text'], maxRequestBytes: 33554432,
  });
  assert.equal(entries[1].contextWindow, undefined);
});

test('parseModelList reads protocol and output-cap fields once the gateway sends them', () => {
  const [entry] = parseModelList({ data: [{ id: 'claude-sonnet-5', public_protocols: ['anthropic_messages'], max_output_tokens: 64000 }] });
  assert.deepEqual(entry.protocols, ['anthropic_messages']);
  assert.equal(entry.maxTokens, 64000);
});

// Cases observed on the live sites: image models that also emit text, a model
// served only on a non-chat surface, and a realtime-only model.
test('isChatModel needs text-only output and, when known, a chat protocol', () => {
  assert.equal(isChatModel({ id: 'x', output: ['text'] }), true);
  assert.equal(isChatModel({ id: 'x', output: ['image'] }), false);
  assert.equal(isChatModel({ id: 'gemini-3-pro-image', output: ['text', 'image'] }), false);
  assert.equal(isChatModel({ id: 'qwen3.8-omni-flash-realtime', output: ['text', 'audio'] }), false);
  assert.equal(isChatModel({ id: 'jev-1.14.0', output: ['text'], protocols: ['typesafe_systemone'] }), false);
  assert.equal(isChatModel({ id: 'x', output: ['text'], protocols: [] }), false);
  assert.equal(isChatModel({ id: 'x', output: ['text'], protocols: ['openai_responses', 'anthropic_messages'] }), true);
  assert.equal(isChatModel({ id: 'text-embedding-3-large' }), false);
  assert.equal(isChatModel({ id: 'qwen3-max' }), true);
});

test('protocols are read once per chat candidate and attached to the list', async () => {
  const calls = [];
  const catalog = new Catalog({
    ttlMs: 1000, now: () => 0,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/v1/models')) return jsonResponse({ data: [...listing(['gpt-5', 'jev-1']).data, { id: 'seedream', output_modalities: ['image'] }] });
      return jsonResponse({ data: [{ code: String(url).includes('jev-1') ? 'typesafe_systemone' : 'openai_chat_completions' }] });
    },
  });
  const { entries } = await catalog.get(site, 'k');
  assert.deepEqual(entries.filter(isChatModel).map((e) => e.id), ['gpt-5']);
  assert.equal(calls.filter((u) => u.includes('/endpoints')).length, 2, 'the image model is never asked about');
  await catalog.get(site, 'k', { force: true });
  assert.equal(calls.filter((u) => u.includes('/endpoints')).length, 2, 'protocol answers outlive a list refresh');
});

test('endpoints helpers', () => {
  assert.equal(endpointsUrl('https://api.modelgo.com/v1/', 'gpt-5'), 'https://api.modelgo.com/v1/models/gpt-5/endpoints');
  assert.equal(endpointsUrl('https://api.modelgo.ai', 'anthropic/claude-haiku-4.5'), 'https://api.modelgo.ai/v1/models/endpoints?model=anthropic%2Fclaude-haiku-4.5');
  assert.deepEqual(parseEndpoints({ object: 'list', data: [{ code: 'openai_chat_completions' }, { code: 'anthropic_messages' }, {}] }), ['openai_chat_completions', 'anthropic_messages']);
});

test('the list is cached per key, refreshed after the TTL, and sent with the bearer key', async () => {
  let clock = 0;
  const calls = [];
  const catalog = new Catalog({
    ttlMs: 1000, now: () => clock,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), auth: init.headers.authorization }); return gateway(() => jsonResponse(listing(['gpt-5'])))(url); },
  });
  await catalog.get(site, 'mgk_key_one_aaaa');
  await catalog.get(site, 'mgk_key_one_aaaa');
  assert.equal(listCalls(calls).length, 1);
  assert.ok(calls.every((c) => c.auth === 'Bearer mgk_key_one_aaaa'));
  await catalog.get(site, 'mgk_key_two_bbbb');
  assert.equal(listCalls(calls).length, 2, 'a different key is a different list');
  clock = 1001;
  await catalog.get(site, 'mgk_key_one_aaaa');
  assert.equal(listCalls(calls).length, 3);
});

test('a failed refresh serves the previous list and reports a change only when ids change', async () => {
  let clock = 0;
  let next = () => jsonResponse(listing(['gpt-5']));
  const changed = [];
  const catalog = new Catalog({ ttlMs: 1000, now: () => clock, fetchImpl: gateway(() => next()), onChange: (id) => changed.push(id) });
  await catalog.get(site, 'k');
  clock = 2000;
  next = () => jsonResponse({ error: { message: 'upstream down' } }, 502);
  assert.deepEqual((await catalog.get(site, 'k')).entries.map((e) => e.id), ['gpt-5']);
  clock = 40_000;
  next = () => jsonResponse(listing(['gpt-5', 'gpt-5-mini']));
  assert.deepEqual((await catalog.get(site, 'k')).entries.map((e) => e.id), ['gpt-5', 'gpt-5-mini']);
  assert.deepEqual(changed, ['modelgo']);
});

test('a first fetch that fails throws, with the key redacted', async () => {
  const catalog = new Catalog({ fetchImpl: async () => jsonResponse({ error: { message: 'bad key mgk_secret_value_1234' } }, 401) });
  await assert.rejects(catalog.get(site, 'mgk_secret_value_1234'), (error) => {
    assert.equal(error.code, 'AUTH');
    assert.doesNotMatch(error.message, /secret_value/);
    return true;
  });
});

test('protocolsFor returns undefined when the site cannot be asked', async () => {
  const ok = new Catalog({ fetchImpl: async () => jsonResponse({ data: [{ code: 'anthropic_messages' }] }) });
  assert.deepEqual(await ok.protocolsFor(site, 'k', 'claude-sonnet-5'), ['anthropic_messages']);
  const down = new Catalog({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await down.protocolsFor(site, 'k', 'claude-sonnet-5'), undefined);
});
