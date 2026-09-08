#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for check-tla-chunk-await.mjs, the gate behind issue #2246.
 *
 * Two things are under test, and they pull in opposite directions:
 *
 *   1. The gate must still catch every shape it was written for -- the
 *      minified single-line importer that reproduced the real white screen,
 *      the pretty-printed multi-line one, and the bare side-effect import of
 *      a deferred chunk.
 *   2. The gate must not report success having inspected nothing. An assets
 *      directory that is missing, empty, or full of chunks among which not
 *      one is `__tla`-wrapped are all states in which every scan iterates
 *      over an empty set, so `violations` is empty because nothing was
 *      examined. Each must exit non-zero.
 *
 * The healthy-bundle cases exist to hold (2) honest: a guard that reds a
 * correct build gets switched off, which is worse than the vacuity it closes.
 *
 * Each case is a synthetic `apps/viewer/dist/assets` under a temp root, fed
 * to the gate via `--root`.
 *
 * Run: node --test scripts/check-tla-chunk-await.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'check-tla-chunk-await.mjs');
const ASSETS_REL = join('apps', 'viewer', 'dist', 'assets');

/**
 * Runs the gate over a synthetic assets dir.
 *
 * `chunks` is filename -> file text. `null` for the whole map means "do not
 * create the assets directory at all"; an empty map creates it with no .js
 * files in it.
 */
function runOn(chunks) {
  const dir = mkdtempSync(join(tmpdir(), 'tla-chunk-await-'));
  try {
    if (chunks !== null) {
      const assets = join(dir, ASSETS_REL);
      mkdirSync(assets, { recursive: true });
      for (const [name, text] of Object.entries(chunks)) {
        writeFileSync(join(assets, name), text);
      }
    }
    const r = spawnSync(process.execPath, [GATE, '--root', dir], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A `__tla`-wrapped chunk, in the plugin's real emitted shape: the deferred
 * binding is exported literally, unmangled, alongside the mangled real
 * exports.
 */
const TLA_CHUNK = `let __tla = Promise.resolve().then(async () => { z = () => 1; });
let z;
export { z, __tla };
`;

/** The correctly-propagated importer: imports `__tla` aliased and folds it in. */
const GOOD_IMPORTER = `import { z as C, __tla as __tla_0 } from "./store-abc.js";
let __tla = Promise.all([
  (() => { try { return __tla_0; } catch {} })(),
]).then(async () => { C(); });
export { __tla };
`;

test('a healthy bundle -- a __tla chunk and an importer that awaits it -- passes', () => {
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'pending-def.js': GOOD_IMPORTER });
  assert.equal(status, 0, out);
  assert.match(out, /✅ 0 chunks importing a __tla chunk without awaiting it/);
  // The success line must show it actually looked at the pair, not at nothing.
  assert.match(out, /1 static import\(s\) of a __tla-wrapped chunk checked/);
  // Both chunks count as wrapped: an importer that propagates the wait is
  // itself transformed, so it re-exports its own `__tla` -- the real shape.
  assert.match(out, /\(2 __tla-wrapped chunk\(s\) among 2 emitted chunk\(s\)\)/);
});

test('a healthy bundle whose __tla chunk is only imported dynamically passes', () => {
  // A lazy route is `import()`ed, never statically imported. The plugin makes
  // that shape safe by construction, so zero STATIC imports of a wrapped chunk
  // is a legitimate bundle and must not be treated as vacuity.
  const lazyImporter = `const load = () => import("./store-abc.js");
export { load };
`;
  const { status, out } = runOn({ 'store-abc.js': TLA_CHUNK, 'entry-def.js': lazyImporter });
  assert.equal(status, 0, out);
  assert.match(out, /0 static import\(s\) of a __tla-wrapped chunk checked/);
});

test('RED (#2246): a minified single-line importer with no __tla in its clause is caught', () => {
  // The exact shape the first version of the gate missed: every import
  // concatenated onto one unbroken line ahead of the first statement.
  const { status, out } = runOn({
    'store-abc.js': TLA_CHUNK,
    'pending-def.js': `import{z as C}from"./store-abc.js";C();`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /1 chunk\(s\) statically import a __tla-wrapped chunk without awaiting/);
  assert.match(out, /pending-def\.js {2}imports \{ z \} {2}from {2}store-abc\.js/);
});

test('RED: a pretty-printed multi-line importer with no __tla in its clause is caught', () => {
  const { status, out } = runOn({
    'store-abc.js': TLA_CHUNK,
    'panel-def.js': `import { z as C } from "./store-abc.js";\nC();\n`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /1 chunk\(s\) statically import a __tla-wrapped chunk without awaiting/);
});

test('RED: a bare side-effect import of a __tla-wrapped chunk is caught, under its own heading', () => {
  const { status, out } = runOn({
    'store-abc.js': TLA_CHUNK,
    'entry-def.js': `import"./store-abc.js";\n`,
  });
  assert.equal(status, 1, out);
  assert.match(out, /1 chunk\(s\) import a __tla-wrapped chunk for its side effect only/);
  assert.match(out, /side effect IS the contract/);
});

test('RED: chunks emitted but not one __tla-wrapped chunk must fail, not tick', () => {
  // The vacuity this test file's second half exists for: with no wrapped
  // chunk, every scan below iterates over an empty set. Before the guard this
  // exact tree printed `✅ ... 0 static import(s) ... (0 __tla-wrapped chunk(s)
  // among 2 emitted chunk(s))` and exited 0 -- a green tick whose own numbers
  // said nothing had been checked.
  const { status, out } = runOn({
    'store-abc.js': `const z = () => 1;\nexport { z };\n`,
    'pending-def.js': `import{z as C}from"./store-abc.js";C();`,
  });
  assert.equal(status, 1, out);
  assert.doesNotMatch(out, /✅/);
  assert.match(out, /NOT ONE of\s*\n?them exports a `__tla` binding/);
  assert.match(out, /2 \.js chunk\(s\)/);
});

test('RED: an assets dir with no .js chunks at all must fail', () => {
  const { status, out } = runOn({});
  assert.equal(status, 1, out);
  assert.doesNotMatch(out, /✅/);
  assert.match(out, /contains no \.js chunks/);
});

test('RED: a missing assets dir must fail', () => {
  const { status, out } = runOn(null);
  assert.equal(status, 1, out);
  assert.doesNotMatch(out, /✅/);
  assert.match(out, /does not exist/);
});
