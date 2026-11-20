/**
 * A local stand-in for the ModelGo gateway, for tests that must not touch the
 * real sites. It serves two "sites" under the path prefixes /com and /ai, each
 * accepting only its own key, with the gateway's real response shapes:
 *
 *   GET  /<site>/v1/models                    model list
 *   GET  /<site>/v1/models/{id}/endpoints     advertised protocols
 *   POST /<site>/v1/chat/completions          OpenAI SSE stream
 *   POST /<site>/v1/messages                  Anthropic SSE stream
 *
 * Run it directly to try the plugin by hand:
 *
 *   node scripts/mock-gateway.mjs        # prints the two base URLs and keys
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const MOCK_KEYS = Object.freeze({ com: 'mgk_smoke_com_site_key_0001', ai: 'mgk_smoke_ai_site_key_0002' });

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) res.write(event);
  res.end();
};
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const item = (id) => ({ id, object: 'model', created: 1735689600, context_length: 200000, max_request_bytes: 33554432, input_modalities: ['text', 'image'], output_modalities: ['text'] });

/**
 * Start the mock on a free loopback port.
 * @returns the origin, every request seen so far, and a close function.
 */
export async function startMockGateway({ port = 0 } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const [, siteKey, ...rest] = url.pathname.split('/');
    const route = `/${rest.join('/')}`;
    const key = (req.headers.authorization ?? '').replace(/^Bearer /, '') || req.headers['x-api-key'];
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ site: siteKey, method: req.method, route, key, model: body ? JSON.parse(body).model : undefined });
    if (key !== MOCK_KEYS[siteKey]) return json(res, 401, { error: { code: 401, message: 'unauthorized' } });

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
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await startMockGateway({ port: Number(process.env.PORT ?? 0) });
  console.log(`mock ModelGo gateway on ${mock.origin}`);
  console.log(`  modelgo     baseURL ${mock.origin}/com   key ${MOCK_KEYS.com}`);
  console.log(`  modelgo-ai  baseURL ${mock.origin}/ai    key ${MOCK_KEYS.ai}`);
}
