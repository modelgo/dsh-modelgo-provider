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
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MOCK_KEYS, startMockGateway } from './mock-gateway.mjs';
import { pack } from './pack.mjs';

const exec = promisify(execFile);
const [dshBin, ...dshArgs] = (process.env.DSH_BIN ?? 'dsh').split(' ');

const mock = await startMockGateway();
const { origin, seen } = mock;
const KEYS = MOCK_KEYS;

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
  const { tarball } = await pack(root);
  await dsh(['plugin', '--profile', 'headless', 'add', '--workspace-root', tarball]);

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
  mock.close();
  if (!process.env.KEEP_SMOKE_DIR) await rm(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}
