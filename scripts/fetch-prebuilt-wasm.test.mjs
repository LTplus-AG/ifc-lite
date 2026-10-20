/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end behaviour of scripts/fetch-prebuilt-wasm.mjs in a throwaway
 * checkout (a copy of the script plus the libs it imports, so it resolves its
 * own root there). `npm` is replaced by a stub that "publishes" a prepared
 * package directory, so nothing touches the network or the real
 * packages/wasm/pkg. Review of #6945: the script's "already present" early
 * exit used to skip the parity check entirely.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const DTS = 'export class A {}\nexport function f(): void;\nexport function g(): void;\nexport default function init(): void;\n';
const JS_OK = 'export class A {}\nexport function f() {}\nexport function g() {}\nasync function init() {}\nexport { init as default };\n';
const JS_STALE = 'export class A {}\nexport function f() {}\nasync function init() {}\nexport { init as default };\n';
const JS_AHEAD = JS_OK + 'export function brandNew() {}\n';

/** Build a fake checkout; `published` is the js the stub npm will serve (or null for no stub). */
function makeCheckout({ installedJs, published, installedAssets = {}, publishedAssets = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'fetch-wasm-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(dirname(dirname(fileURLToPath(import.meta.resolve('typescript')))),
    join(root, 'node_modules/typescript'), 'dir');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(join(here, 'fetch-prebuilt-wasm.mjs'), join(root, 'scripts/fetch-prebuilt-wasm.mjs'));
  cpSync(join(here, 'lib'), join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, 'packages/wasm/pkg'), { recursive: true });
  writeFileSync(join(root, 'packages/wasm/package.json'), JSON.stringify({ name: '@ifc-lite/wasm', version: '1.2.3',
    files: JSON.parse(readFileSync(join(here, '../packages/wasm/package.json'), 'utf8')).files }));
  writeFileSync(join(root, 'packages/wasm/pkg/ifc-lite.d.ts'), DTS);
  writeFileSync(join(root, 'packages/wasm/pkg/.gitignore'), '*\n');
  if (installedJs !== undefined) {
    writeFileSync(join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm'), 'INSTALLED-WASM');
    if (installedJs !== null) writeFileSync(join(root, 'packages/wasm/pkg/ifc-lite.js'), installedJs);
  }
  function assets(directory, entries) {
    for (const [name, text] of Object.entries(entries)) {
      mkdirSync(dirname(join(directory, name)), { recursive: true });
      writeFileSync(join(directory, name), text);
    }
  }
  assets(join(root, 'packages/wasm/pkg'), installedAssets);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  if (published !== null) {
    const src = join(root, 'published/package/pkg');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'ifc-lite.js'), published);
    assets(src, publishedAssets);
    writeFileSync(join(src, 'ifc-lite_bg.wasm'), 'PUBLISHED-WASM');
    writeFileSync(join(src, 'ifc-lite.d.ts'), 'export function publishedDtsMustNotBeInstalled(): void;\n');
  }
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
execFileSync('tar', ['-czf', 'stub.tgz', '-C', ${JSON.stringify(join(root, 'published'))}, 'package']);
console.log(JSON.stringify([{ filename: 'stub.tgz' }]));
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  return root;
}

function run(root, args = []) {
  return spawnSync(process.execPath, [join(root, 'scripts/fetch-prebuilt-wasm.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
  });
}
const read = (root, name) => readFileSync(join(root, 'packages/wasm/pkg', name), 'utf8');

test('#6945 an already-installed runtime that lacks a declared export fails and is left untouched', () => {
  const root = makeCheckout({ installedJs: JS_STALE, published: JS_OK });
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /\bg\b/);
  assert.match(r.stderr, /--force/);
  assert.equal(read(root, 'ifc-lite.js'), JS_STALE);
  assert.equal(read(root, 'ifc-lite_bg.wasm'), 'INSTALLED-WASM');
});

test('an already-installed runtime that matches the committed d.ts exits 0 without fetching', () => {
  const root = makeCheckout({ installedJs: JS_OK, published: null });
  const r = run(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /already present/);
});

test('an installed runtime that is ahead of the checkout warns and exits 0', () => {
  const root = makeCheckout({ installedJs: JS_AHEAD, published: null });
  const r = run(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /brandNew/);
});

test('a .wasm with no ifc-lite.js beside it is reported as incomplete, not accepted', () => {
  const root = makeCheckout({ installedJs: null, published: null });
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /incomplete/);
});

test('--force replaces a stale installed runtime with a matching published one and keeps the committed d.ts', () => {
  const root = makeCheckout({ installedJs: JS_STALE, published: JS_OK });
  const r = run(root, ['--force']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(read(root, 'ifc-lite.js'), JS_OK);
  assert.equal(read(root, 'ifc-lite_bg.wasm'), 'PUBLISHED-WASM');
  assert.equal(read(root, 'ifc-lite.d.ts'), DTS);
});

test('--force with a stale published package fails and keeps the previously installed runtime', () => {
  const root = makeCheckout({ installedJs: JS_OK, published: JS_STALE });
  const r = run(root, ['--force']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(read(root, 'ifc-lite.js'), JS_OK);
  assert.equal(read(root, 'ifc-lite_bg.wasm'), 'INSTALLED-WASM');
});

test('a fresh fetch of a stale published package installs nothing and exits 1', () => {
  const root = makeCheckout({ published: JS_STALE });
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(existsSync(join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm')), false);
  assert.equal(existsSync(join(root, 'packages/wasm/pkg/ifc-lite.js')), false);
  assert.equal(existsSync(join(root, '.wasm-fetch-tmp')), false);
  assert.equal(existsSync(join(root, 'stub.tgz')), false);
});

test('a fresh fetch of a matching package installs the runtime only, never the published d.ts', () => {
  const root = makeCheckout({ published: JS_OK });
  const r = run(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(read(root, 'ifc-lite.js'), JS_OK);
  assert.equal(read(root, 'ifc-lite.d.ts'), DTS);
});


const JS_HELPER = "import { helper } from './snippets/private/driver.mjs';\n" + JS_OK;
const HELPERS = {
  'snippets/private/driver.mjs': "export const driver = 1; export { helper } from './nested/helper.js';\n",
  // Top-level throw proves validation never evaluates even a copied helper.
  'snippets/private/nested/helper.js': "throw new Error('must not execute'); export const helper = 1;\n" +
    "export { driver } from '../driver.mjs';\n" +
    "export async function lazy() { return import('/optional-sdk/worker.mjs'); }\n",
};
test('fetch copies the complete nested static helper closure without evaluating it', () => {
  const root = makeCheckout({ published: JS_HELPER, publishedAssets: HELPERS });
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(read(root, 'ifc-lite.js'), JS_HELPER);
  for (const [name, content] of Object.entries(HELPERS)) assert.equal(read(root, name), content);
  assert.equal(read(root, 'ifc-lite.d.ts'), DTS);
  // Exercise real local npm file selection with wasm-pack's broad .gitignore,
  // not the fetch fixture's npm stub. No registry access or package build.
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: join(root, 'packages/wasm'), encoding: 'utf8', env: process.env,
  });
  assert.equal(pack.status, 0, pack.stdout + pack.stderr);
  const packaged = JSON.parse(pack.stdout)[0].files.map(file => file.path);
  for (const name of Object.keys(HELPERS)) assert(packaged.includes(`pkg/${name}`), name);
  assert.equal(packaged.includes('pkg/.npmignore'), false);
  // The installed-runtime path validates that same closure without fetching.
  const installed = run(root);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.doesNotMatch(installed.stdout, /Fetching/);
});

test('missing nested published helper rejects before replacing any installed runtime asset', () => {
  const root = makeCheckout({ installedJs: JS_OK, published: JS_HELPER,
    installedAssets: { 'snippets/previous.js': 'previous helper' },
    publishedAssets: { 'snippets/private/driver.mjs': HELPERS['snippets/private/driver.mjs'] } });
  const result = run(root, ['--force']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /missing runtime asset.*nested/);
  assert.equal(read(root, 'ifc-lite.js'), JS_OK);
  assert.equal(read(root, 'ifc-lite_bg.wasm'), 'INSTALLED-WASM');
  assert.equal(read(root, 'snippets/previous.js'), 'previous helper');
  assert.equal(read(root, 'ifc-lite.d.ts'), DTS);
  assert.equal(existsSync(join(root, 'packages/wasm/pkg/snippets/private/driver.mjs')), false);
  assert.equal(existsSync(join(root, '.wasm-fetch-tmp')), false);
  assert.equal(existsSync(join(root, 'stub.tgz')), false);
});

test('installed glue with matching exports but missing private helper is rejected untouched', () => {
  const root = makeCheckout({ installedJs: JS_HELPER, published: null });
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /incomplete.*missing runtime asset/);
  assert.equal(read(root, 'ifc-lite.js'), JS_HELPER);
  assert.equal(read(root, 'ifc-lite_bg.wasm'), 'INSTALLED-WASM');
  assert.equal(read(root, 'ifc-lite.d.ts'), DTS);
  assert.doesNotMatch(result.stdout, /Fetching/);
});

for (const specifier of ['elsewhere', 'https://example.invalid/driver.js', '/private/driver.js',
  '../outside.js', './snippets/%2e%2e/driver.js']) {
  test(`foreign/outside static import is refused before install: ${specifier}`, () => {
    const published = `import '${specifier}';\n${JS_OK}`;
    const root = makeCheckout({ installedJs: JS_OK, published });
    const result = run(root, ['--force']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /foreign static runtime import|dependency escapes pkg/);
    assert.equal(read(root, 'ifc-lite.js'), JS_OK);
    assert.equal(read(root, 'ifc-lite_bg.wasm'), 'INSTALLED-WASM');
    assert.equal(read(root, 'ifc-lite.d.ts'), DTS);
  });
}


test('a symlinked published helper cannot import a foreign runtime asset', () => {
  const root = makeCheckout({ installedJs: JS_OK, published: JS_HELPER,
    publishedAssets: { 'snippets/private/padding.js': 'export const padding = 1;' } });
  const foreign = join(root, 'foreign-helper.mjs');
  writeFileSync(foreign, 'throw new Error("foreign code must never execute");');
  symlinkSync(foreign, join(root, 'published/package/pkg/snippets/private/driver.mjs'));
  const result = run(root, ['--force']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /foreign runtime asset/);
  assert.equal(read(root, 'ifc-lite.js'), JS_OK);
  assert.equal(read(root, 'ifc-lite_bg.wasm'), 'INSTALLED-WASM');
  assert.equal(read(root, 'ifc-lite.d.ts'), DTS);
});


// PR #7940, review r4310646739: installed runtimes also need npm metadata.
test('already-installed complete helper runtime is publishable without fetching or changing runtime bytes', () => {
  const root = makeCheckout({ installedJs: JS_HELPER, installedAssets: HELPERS, published: null });
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Fetching/);
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: join(root, 'packages/wasm'), encoding: 'utf8', env: process.env,
  });
  assert.equal(pack.status, 0, pack.stdout + pack.stderr);
  const packaged = JSON.parse(pack.stdout)[0].files.map(file => file.path);
  for (const name of Object.keys(HELPERS)) assert(packaged.includes(`pkg/${name}`), name);
  assert.equal(read(root, '.npmignore'), '\n');
  assert.equal(read(root, 'ifc-lite.js'), JS_HELPER);
  assert.equal(read(root, 'ifc-lite_bg.wasm'), 'INSTALLED-WASM');
  assert.equal(read(root, 'ifc-lite.d.ts'), DTS);
  for (const [name, content] of Object.entries(HELPERS)) assert.equal(read(root, name), content);
});

// PR #7940, review r4310646754: every destination must pass before the first copy.
for (const obstruction of ['file symlink', 'parent symlink', 'pkg symlink', 'later directory',
  'npmignore symlink', 'npmignore directory', 'types symlink', 'gitignore symlink']) {
  test(`force fetch rejects destination ${obstruction} before changing any existing asset`, () => {
    const root = makeCheckout({ installedJs: JS_OK, published: JS_HELPER, publishedAssets: HELPERS,
      installedAssets: { 'snippets/previous.js': 'previous helper' } });
    const output = join(root, 'packages/wasm/pkg');
    const foreign = join(root, 'foreign');
    mkdirSync(foreign);
    const sentinel = join(foreign, 'sentinel');
    writeFileSync(sentinel, 'outside must stay unchanged');
    if (obstruction === 'file symlink') {
      mkdirSync(join(output, 'snippets/private'));
      symlinkSync(sentinel, join(output, 'snippets/private/driver.mjs'));
    } else if (obstruction === 'parent symlink') {
      mkdirSync(join(foreign, 'private'));
      writeFileSync(join(foreign, 'private/driver.mjs'), 'outside driver');
      symlinkSync(join(foreign, 'private'), join(output, 'snippets/private'), 'dir');
    } else if (obstruction === 'pkg symlink') {
      renameSync(output, join(foreign, 'pkg'));
      symlinkSync(join(foreign, 'pkg'), output, 'dir');
    } else if (obstruction === 'later directory') {
      mkdirSync(join(output, 'snippets/private/nested/helper.js'), { recursive: true });
    } else if (obstruction === 'npmignore directory') {
      mkdirSync(join(output, '.npmignore'));
    } else {
      const name = obstruction === 'types symlink' ? 'ifc-lite.d.ts' :
        obstruction === 'gitignore symlink' ? '.gitignore' : '.npmignore';
      // Preserve the declaration content for parity to pass before destination validation.
      if (name === 'ifc-lite.d.ts') writeFileSync(sentinel, DTS);
      rmSync(join(output, name), { force: true });
      symlinkSync(sentinel, join(output, name));
    }
    const result = run(root, ['--force']);
    assert.equal(readFileSync(sentinel, 'utf8'), obstruction === 'types symlink' ? DTS : 'outside must stay unchanged');
    assert.equal(read(root, 'ifc-lite_bg.wasm'), 'INSTALLED-WASM');
    assert.equal(read(root, 'ifc-lite.js'), JS_OK);
    assert.equal(read(root, 'ifc-lite.d.ts'), DTS);
    assert.equal(read(root, 'snippets/previous.js'), 'previous helper');
    if (obstruction === 'parent symlink') {
      assert.equal(readFileSync(join(foreign, 'private/driver.mjs'), 'utf8'), 'outside driver');
      assert.equal(existsSync(join(foreign, 'private/nested')), false);
    }
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /unsafe runtime destination/);
    assert.equal(existsSync(join(root, '.wasm-fetch-tmp')), false);
    assert.equal(existsSync(join(root, 'stub.tgz')), false);
    assert.equal(readFileSync(join(root, 'published/package/pkg/ifc-lite.js'), 'utf8'), JS_HELPER);
    for (const [name, content] of Object.entries(HELPERS)) {
      assert.equal(readFileSync(join(root, 'published/package/pkg', name), 'utf8'), content);
    }
  });
}


for (const obstruction of ['symlink', 'directory']) {
  test(`installed runtime rejects npmignore ${obstruction} without modifying runtime or outside files`, () => {
    const root = makeCheckout({ installedJs: JS_HELPER, installedAssets: HELPERS, published: null });
    const foreign = join(root, 'outside-ignore');
    writeFileSync(foreign, 'outside must stay unchanged');
    if (obstruction === 'symlink') symlinkSync(foreign, join(root, 'packages/wasm/pkg/.npmignore'));
    else mkdirSync(join(root, 'packages/wasm/pkg/.npmignore'));
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /unsafe runtime destination/);
    assert.doesNotMatch(result.stdout, /Fetching/);
    assert.equal(readFileSync(foreign, 'utf8'), 'outside must stay unchanged');
    assert.equal(read(root, 'ifc-lite.js'), JS_HELPER);
    assert.equal(read(root, 'ifc-lite_bg.wasm'), 'INSTALLED-WASM');
    assert.equal(read(root, 'ifc-lite.d.ts'), DTS);
    for (const [name, content] of Object.entries(HELPERS)) assert.equal(read(root, name), content);
  });
}
