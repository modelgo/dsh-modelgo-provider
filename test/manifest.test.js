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
  // The card must store under the same reference, and ask for the same route, the Host resolves.
  assert.match(client, /KEY_REF = 'MODELGO_API_KEY'/);
  assert.match(client, /ROUTE = 'modelgo'/);
});

test('the in-app page has a title, a description and a short note in both languages', () => {
  for (const lang of ['zh', 'en']) {
    const { meta } = JSON.parse(read(`locale/${lang}.json`));
    assert.ok(meta.title && meta.description, lang);
    // Kept short on purpose: the page shows this above the key field.
    assert.ok(read(meta.detail).length < 400, `${lang}: the in-app note must stay short`);
  }
  assert.ok(pkg.files.includes('locale/*.json') && pkg.files.includes('docs/quickstart.*.md'));
});

test('the plugin ships an icon', () => {
  assert.equal(pkg.icon, './icon.png');
  assert.equal(pkg.exports['./icon'], './icon.png');
  assert.ok(pkg.files.includes('icon.png'));
  assert.ok(readFileSync(new URL('../icon.png', import.meta.url)).length > 1000);
});

test('nothing shipped still points at the retired modelgo.com site', () => {
  for (const name of ['README.md', 'README.zh.md', 'client.js', 'index.js', 'lib/sites.js', 'cordis.patch.yml', 'docs/quickstart.zh.md', 'docs/quickstart.en.md', 'locale/zh.json', 'locale/en.json']) {
    assert.doesNotMatch(read(name), /modelgo\.com/, name);
  }
});
