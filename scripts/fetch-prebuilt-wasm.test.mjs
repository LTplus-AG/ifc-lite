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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
function makeCheckout({ installedJs, published }) {
  const root = mkdtempSync(join(tmpdir(), 'fetch-wasm-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(join(here, 'fetch-prebuilt-wasm.mjs'), join(root, 'scripts/fetch-prebuilt-wasm.mjs'));
  cpSync(join(here, 'lib'), join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, 'packages/wasm/pkg'), { recursive: true });
  writeFileSync(join(root, 'packages/wasm/package.json'), JSON.stringify({ name: '@ifc-lite/wasm', version: '1.2.3' }));
  writeFileSync(join(root, 'packages/wasm/pkg/ifc-lite.d.ts'), DTS);
  if (installedJs !== undefined) {
    writeFileSync(join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm'), 'INSTALLED-WASM');
    if (installedJs !== null) writeFileSync(join(root, 'packages/wasm/pkg/ifc-lite.js'), installedJs);
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  if (published !== null) {
    const src = join(root, 'published/package/pkg');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'ifc-lite.js'), published);
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
