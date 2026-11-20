#!/usr/bin/env node
/**
 * Real conversations through the real engine, against the real sites.
 *
 *   node scripts/live-chat.mjs modelgo/deepseek-v4-flash modelgo-ai/claude-sonnet-4.6
 *
 * Packs this repo, installs it into an isolated headless profile, and runs one
 * short `dsh` task per `<route>/<model>` argument. Keys come from the
 * environment (MODELGO_API_KEY, MODELGO_AI_API_KEY). Each task is a real,
 * billed model request — keep the list short. Prints pass/fail per model and
 * the tail of the engine's diagnostics on failure; never a key.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { redact } from '../lib/util.js';
import { pack } from './pack.mjs';

const exec = promisify(execFile);
const [dshBin, ...dshArgs] = (process.env.DSH_BIN ?? 'dsh').split(' ');
const targets = process.argv.slice(2).map((arg) => { const i = arg.indexOf('/'); return { provider: arg.slice(0, i), model: arg.slice(i + 1) }; });
if (!targets.length || targets.some((t) => !t.provider || !t.model)) { console.error('usage: node scripts/live-chat.mjs <route>/<model> ...'); process.exit(2); }

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-modelgo-live-'));
const work = path.join(root, 'work');
await mkdir(work);
const env = { ...process.env, DSH_HOME: path.join(root, 'dsh-home'), NO_COLOR: '1' };
const dsh = (args) => exec(dshBin, [...dshArgs, ...args], { env, cwd: work, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
const clean = (text) => redact(redact(text, process.env.MODELGO_API_KEY), process.env.MODELGO_AI_API_KEY);
let failed = 0;

try {
  const { tarball } = await pack(root);
  await dsh(['plugin', '--profile', 'headless', 'add', '--workspace-root', tarball]);
  const patchFile = path.join(env.DSH_HOME, 'profiles', 'headless', 'cordis.patch.yml');

  for (const { provider, model } of targets) {
    await writeFile(patchFile, `- id: agent-default-model\n  config: { provider: ${provider}, model: '${model}' }\n`);
    const started = Date.now();
    const run = await dsh(['--profile', 'headless', 'Reply with exactly one word: pong']).catch((error) => error);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const answer = (run.stdout ?? '').trim();
    if (/pong/i.test(answer)) {
      console.log(`ok    ${provider}/${model}  ${seconds}s`);
    } else {
      failed += 1;
      const detail = clean(`${answer}\n${run.stderr ?? run.message ?? ''}`).trim().split('\n').filter(Boolean).slice(-6).join('\n        ');
      console.log(`FAIL  ${provider}/${model}  ${seconds}s\n        ${detail}`);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
