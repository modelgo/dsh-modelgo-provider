#!/usr/bin/env node
/**
 * Conformance sweep: what an agent actually needs from each model, on the real
 * engine against the real sites.
 *
 *   node scripts/live-conformance.mjs modelgo/deepseek-v4-flash modelgo-ai/claude-sonnet-5
 *   CASES=tool,image node scripts/live-conformance.mjs modelgo/gpt-5.4-mini
 *   node scripts/live-conformance.mjs modelgo/claude-opus-5@low,max      # only these levels
 *
 * A plain "say pong" proves little: the failures users report are in tool-call
 * turns, in reasoning replay, and in image input. Each `<route>/<model>` runs:
 *
 *   tool    read a file through the `read` tool and repeat its random token —
 *           a tool call, a tool result, and a second request that carries both
 *   think   the same at every reasoning level, one run per level, for a model
 *           the plugin offers levels on — reasoning must survive the tool turn.
 *           A level DSH refuses before sending is reported as "not offered",
 *           which costs nothing and is not a failure
 *   image   look at a solid-colour PNG through `read_image` and name the colour
 *           (skipped when the site lists the model as text-only)
 *
 * Models are resolved from each site's live list, exactly as the plugin does.
 *
 * Every run is a real, billed request (two per case). Keys come from the
 * environment (MODELGO_API_KEY, MODELGO_AI_API_KEY). Output is one line per
 * case and a JSON summary; a key value is never printed.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { Catalog } from '../lib/catalog.js';
import { LEVELS, resolveModel } from '../lib/profiles.js';
import { resolveSites } from '../lib/sites.js';
import { redact } from '../lib/util.js';
import { pack } from './pack.mjs';

const exec = promisify(execFile);
const [dshBin, ...dshArgs] = (process.env.DSH_BIN ?? 'dsh').split(' ');
const WORKERS = Number(process.env.WORKERS ?? 4);
const wanted = new Set((process.env.CASES ?? 'tool,think,image').split(','));
const sites = new Map(resolveSites({}).map((site) => [site.id, site]));
// `<route>/<model>` or `<route>/<model>@low,max` to try only those reasoning levels (for costly models).
const targets = process.argv.slice(2).map((arg) => {
  const i = arg.indexOf('/');
  const [model, only] = arg.slice(i + 1).split('@');
  return { provider: arg.slice(0, i), model, ...(only ? { only: new Set(only.split(',')) } : {}) };
});
if (!targets.length || targets.some((t) => !sites.has(t.provider) || !t.model)) {
  console.error('usage: node scripts/live-conformance.mjs <modelgo|modelgo-ai>/<model> ...');
  process.exit(2);
}
const clean = (text) => redact(redact(text, process.env.MODELGO_API_KEY), process.env.MODELGO_AI_API_KEY);

/** A 64×64 solid magenta PNG, built by hand so the script needs no image library. */
function solidPng([r, g, b], size = 64) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Each site's live list, read once with that site's key.
const catalog = new Catalog();
const live = new Map();
for (const site of sites.values()) {
  if (!targets.some((t) => t.provider === site.id)) continue;
  const { entries } = await catalog.get(site, process.env[site.apiKeyEnv]);
  live.set(site.id, new Map(entries.map((entry) => [entry.id, entry])));
}

/** The cases that apply to one model, judged by what the plugin itself would offer for it. */
function casesFor({ provider, model, only }) {
  const resolved = resolveModel(sites.get(provider), live.get(provider).get(model) ?? { id: model })?.model;
  const cases = [];
  if (wanted.has('tool')) cases.push({ name: 'tool' });
  if (wanted.has('think') && resolved?.reasoning) {
    // A level the shipped map hides is known not to be offered; every other one is tried.
    for (const level of LEVELS) if (resolved.thinkingLevelMap?.[level] !== null && (!only || only.has(level))) cases.push({ name: 'think', effort: level });
  }
  if (wanted.has('image') && resolved?.input.includes('image')) cases.push({ name: 'image' });
  return cases;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-modelgo-conf-'));
const results = [];

async function worker(index, queue, tarball) {
  const home = path.join(root, `home-${index}`);
  const work = path.join(root, `work-${index}`);
  await mkdir(work, { recursive: true });
  const env = { ...process.env, DSH_HOME: home, NO_COLOR: '1' };
  const dsh = (args) => exec(dshBin, [...dshArgs, ...args], { env, cwd: work, maxBuffer: 64 * 1024 * 1024, timeout: 240_000 });
  await dsh(['plugin', '--profile', 'headless', 'add', '--workspace-root', tarball]);
  const patchFile = path.join(home, 'profiles', 'headless', 'cordis.patch.yml');
  await writeFile(path.join(work, 'color.png'), solidPng([255, 0, 255]));

  for (let job = queue.shift(); job; job = queue.shift()) {
    const { provider, model, name, effort } = job;
    const token = `mgo-${randomBytes(6).toString('hex')}`;
    await writeFile(path.join(work, 'token.txt'), `${token}\n`);
    const effortLine = effort ? `, reasoningEffort: ${effort}` : '';
    await writeFile(patchFile, `- id: agent-default-model\n  config: { provider: ${provider}, model: '${model}'${effortLine} }\n`);
    const prompt = name === 'image'
      ? 'Use the read_image tool on the file color.png in the current directory. Then answer with one word: the main colour of the image.'
      : 'Use the read tool to read the file token.txt in the current directory. Then reply with exactly the text it contains and nothing else.';
    const started = Date.now();
    const run = await dsh(['--profile', 'headless', prompt]).catch((error) => error);
    const answer = (run.stdout ?? '').trim();
    const ok = name === 'image' ? /magenta|purple|pink|fuchsia|violet|紫|品红|粉|洋红/i.test(answer) : answer.includes(token);
    const output = clean(`${answer}\n${run.stderr ?? run.message ?? ''}`);
    // Refused by DSH before anything was sent: the plugin does not offer this level on this model.
    const notOffered = !ok && /UNSUPPORTED_REASONING_EFFORT/.test(output);
    const status = ok ? 'ok' : notOffered ? 'not-offered' : 'fail';
    const detail = status === 'fail' ? output.trim().split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 700) : '';
    const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    results.push({ provider, model, case: name, ...(effort ? { effort } : {}), status, ok: status !== 'fail', seconds, ...(detail ? { detail } : {}) });
    console.log(`${status.padEnd(11)} ${provider}/${model}  ${name}${effort ? `(${effort})` : ''}  ${seconds}s${detail ? `\n        ${detail}` : ''}`);
  }
}

try {
  const { tarball } = await pack(root);
  const queue = targets.flatMap(({ provider, model, only }) => casesFor({ provider, model, only }).map((c) => ({ provider, model, ...c })));
  console.log(`${queue.length} cases over ${targets.length} models, ${Math.min(WORKERS, queue.length)} at a time`);
  await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, (_, index) => worker(index, queue, tarball)));
} finally {
  await rm(root, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.filter((r) => r.status === 'ok').length} ok, ${results.filter((r) => r.status === 'not-offered').length} not offered, ${failed.length} failed`);
if (process.env.RESULTS_FILE) await writeFile(process.env.RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`);
process.exitCode = failed.length ? 1 : 0;
