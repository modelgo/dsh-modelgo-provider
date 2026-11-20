#!/usr/bin/env node
/**
 * Clean-install smoke test: pack this repo, install the tarball into an
 * isolated DSH home with the real `dsh`, and check the composed profile.
 *
 * Unit tests cannot see a broken manifest, a file missing from `files`, or an
 * import the host does not provide; this does. No key and no network call to
 * ModelGo are needed.
 *
 *   node scripts/smoke-install.mjs            # uses `dsh` on PATH
 *   DSH_BIN="npx -y @deepseek-ai/dsh@0.2.2-rc.1" node scripts/smoke-install.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pack } from './pack.mjs';

const exec = promisify(execFile);
const [dshBin, ...dshArgs] = (process.env.DSH_BIN ?? 'dsh').split(' ');
const profile = process.env.DSH_PROFILE ?? 'web';
const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-modelgo-smoke-'));
const env = { ...process.env, DSH_HOME: path.join(root, 'dsh-home'), NO_COLOR: '1' };
const dsh = (args) => exec(dshBin, [...dshArgs, ...args], { env, cwd: root, maxBuffer: 64 * 1024 * 1024 });

try {
  const { tarball, filename, files: packed } = await pack(root);
  for (const needed of ['index.js', 'cordis.patch.yml', 'lib/adapter.js', 'data/model-profiles.json']) {
    assert.ok(packed.includes(needed), `tarball is missing ${needed}`);
  }
  const install = await dsh(['plugin', '--profile', profile, 'add', '--workspace-root', tarball]);
  assert.doesNotMatch(`${install.stdout}\n${install.stderr}`, /unmet peer/i);

  const dump = await dsh(['--profile', profile, '--dump-config']);
  assert.match(dump.stdout, /@model-go\/dsh-modelgo-provider/, 'the plugin row is not in the composed profile');

  const pkg = JSON.parse(await readFile(path.join(env.DSH_HOME, 'profiles', profile, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies?.['@model-go/dsh-modelgo-provider'], 'the profile does not depend on the plugin');

  console.log(`ok: ${filename} installs into a clean "${profile}" profile (${packed.length} files)`);
} finally {
  if (!process.env.KEEP_SMOKE_DIR) await rm(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}
