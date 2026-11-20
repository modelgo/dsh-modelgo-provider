#!/usr/bin/env node
/**
 * End-to-end smoke test on the real engine, against a local mock of the
 * ModelGo gateway.
 *
 * Packs this repo, installs it into an isolated headless profile, points both
 * sites at the mock, and runs one real `dsh` task per site:
 *
 *   modelgo     → gpt-5            → POST /v1/chat/completions, com-site key
 *   modelgo-ai  → claude-sonnet-5  → POST /v1/messages,         ai-site key
 *
 * This proves what unit tests cannot: the plugin loads inside the host, both
 * routes register, each request leaves on the protocol the site advertises,
 * and each site is called with its own key and never the other's.
 * No real key is used and nothing reaches the network.
 *
 *   node scripts/smoke-e2e.mjs
 *   DSH_BIN="npx -y @deepseek-ai/dsh@0.2.2-rc.1" node scripts/smoke-e2e.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [dshBin, ...dshArgs] = (process.env.DSH_BIN ?? 'dsh').split(' ');
const KEYS = { com: 'mgk_smoke_com_site_key_0001', ai: 'mgk_smoke_ai_site_key_0002' };

// ---------------------------------------------------------------- mock gateway
const seen = [];
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) res.write(event);
  res.end();
};
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const item = (id) => ({ id, object: 'model', created: 1735689600, context_length: 200000, max_request_bytes: 33554432, input_modalities: ['text', 'image'], output_modalities: ['text'] });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const [, siteKey, ...rest] = url.pathname.split('/');
  const route = `/${rest.join('/')}`;
  const key = (req.headers.authorization ?? '').replace(/^Bearer /, '') || req.headers['x-api-key'];
  let body = '';
  for await (const chunk of req) body += chunk;
  seen.push({ site: siteKey, method: req.method, route, key, model: body ? JSON.parse(body).model : undefined });
  if (key !== KEYS[siteKey]) return json(res, 401, { error: { code: 401, message: 'unauthorized' } });

  if (req.method === 'GET' && route === '/v1/models') {
    return json(res, 200, { object: 'list', data: [item('gpt-5'), item('claude-sonnet-5'), { ...item('text-embedding-3-large'), output_modalities: ['embedding'] }] });
  }
  const endpoints = route.match(/^\/v1\/models\/([^/]+)\/endpoints$/);
  if (req.method === 'GET' && endpoints) {
    const code = endpoints[1].startsWith('claude') ? 'anthropic_messages' : 'openai_chat_completions';
    return json(res, 200, { object: 'list', model: endpoints[1], data: [{ code }] });
  }
  if (req.method === 'POST' && route === '/v1/chat/completions') {
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model: 'gpt-5', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return sse(res, [
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: `pong-chat-${siteKey}` }),
      chunk({}, 'stop'),
      `data: ${JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model: 'gpt-5', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }
  if (req.method === 'POST' && route === '/v1/messages') {
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    return sse(res, [
      event('message_start', { message: { id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `pong-messages-${siteKey}` } }),
      event('content_block_stop', { index: 0 }),
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }),
      event('message_stop', {}),
    ]);
  }
  return json(res, 404, { error: { code: 404, message: `no mock for ${req.method} ${route}` } });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- real engine
const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-modelgo-e2e-'));
const work = path.join(root, 'work');
await mkdir(work);
const env = { ...process.env, DSH_HOME: path.join(root, 'dsh-home'), NO_COLOR: '1', MODELGO_API_KEY: KEYS.com, MODELGO_AI_API_KEY: KEYS.ai };
const dsh = (args) => exec(dshBin, [...dshArgs, ...args], { env, cwd: work, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
const patchFile = path.join(env.DSH_HOME, 'profiles', 'headless', 'cordis.patch.yml');
const selectModel = (provider, model) => writeFile(patchFile, [
  '- id: modelgo',
  '  config:',
  '    sites:',
  `      modelgo: { baseURL: '${origin}/com' }`,
  `      modelgo-ai: { baseURL: '${origin}/ai' }`,
  '- id: agent-default-model',
  `  config: { provider: ${provider}, model: ${model} }`,
  '',
].join('\n'));

try {
  const pack = await exec('npm', ['pack', '--json', '--pack-destination', root], { cwd: repo });
  const [{ filename }] = JSON.parse(pack.stdout.slice(pack.stdout.indexOf('[')));
  await dsh(['plugin', '--profile', 'headless', 'add', '--workspace-root', path.join(root, filename)]);

  const cases = [
    { provider: 'modelgo', model: 'gpt-5', site: 'com', route: '/v1/chat/completions', reply: 'pong-chat-com' },
    { provider: 'modelgo-ai', model: 'claude-sonnet-5', site: 'ai', route: '/v1/messages', reply: 'pong-messages-ai' },
  ];
  for (const c of cases) {
    seen.length = 0;
    await selectModel(c.provider, c.model);
    const run = await dsh(['--profile', 'headless', 'Reply with the single word ping.']).catch((error) => error);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    assert.match(run.stdout ?? '', new RegExp(c.reply), `${c.provider}: expected the mock reply.\n${output.slice(-2000)}`);
    const calls = seen.filter((s) => s.method === 'POST');
    assert.ok(calls.length > 0 && calls.every((s) => s.site === c.site && s.route === c.route && s.model === c.model),
      `${c.provider}: unexpected model requests ${JSON.stringify(calls)}`);
    assert.ok(seen.every((s) => s.site === c.site && s.key === KEYS[c.site]), `${c.provider}: a request carried the wrong site or key`);
    assert.doesNotMatch(output, /mgk_smoke/, `${c.provider}: a key value leaked into the output`);
    console.log(`ok: ${c.provider}/${c.model} → ${c.route} with its own key (${seen.length} requests)`);
  }
} finally {
  server.close();
  if (!process.env.KEEP_SMOKE_DIR) await rm(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}
