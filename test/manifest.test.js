import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

// What awesome-dsh-plugin's submission gate checks before a human reads the repo.
test('package.json declares an installable bundle', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  assert.equal(pkg.repository.url, 'git+https://github.com/modelgo/dsh-modelgo-provider.git');
});

test('the patch row names this package and no key value', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, new RegExp(`name: '${pkg.name}'`));
  assert.match(patch, /^\s+- id: modelgo$/m);
  assert.doesNotMatch(patch, /mgk_[A-Za-z0-9]/);
});

test('host packages are peers, never bundled dependencies', () => {
  assert.equal(pkg.dependencies, undefined);
  for (const name of Object.keys(pkg.peerDependencies)) assert.match(name, /^@(deepseek-ai|earendil-works)\//);
});

test('the version in README install commands matches package.json', () => {
  for (const name of ['README.md', 'README.zh.md']) {
    for (const [, version] of read(name).matchAll(/dsh-modelgo-provider@(\d+\.\d+\.\d+[\w.-]*)/g)) assert.equal(version, pkg.version, name);
  }
});

test('the browser half is shipped and declared', () => {
  assert.equal(pkg.exports['./client'], './client.js');
  assert.ok(pkg.files.includes('client.js'));
  assert.equal(pkg.dsh.client.platform, 'web');
  const client = read('client.js');
  assert.match(client, new RegExp(`id: '${pkg.name}'`), 'the client module id must be the package name');
  // The card must store under the same references the Host resolves.
  for (const ref of ['MODELGO_API_KEY', 'MODELGO_AI_API_KEY']) assert.match(client, new RegExp(`ref: '${ref}'`));
});
