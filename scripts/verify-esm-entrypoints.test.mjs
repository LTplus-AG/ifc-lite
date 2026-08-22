#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for verify-esm-entrypoints.mjs reporting success on an
 * empty discovery.
 *
 * The script smoke-tests every publishable package under `packages/`. If
 * discovery returns nothing at all — the directory moved, or no package.json
 * matches the publishable filter any more — the smoke loop has nothing to
 * fail on, the summary prints "0 passed, 0 failed, 0 skipped", and the run
 * exits 0: success reported for having imported nothing. That is the same
 * absence-as-success shape as the unbuilt-package skip the script already
 * fails closed on, one level further up.
 *
 * The script resolves `packages/` relative to its own file, so each case here
 * runs a copy of it inside a temp root with a synthetic `packages/` tree. The
 * legitimate case is covered too: a run that discovers a real package must
 * still exit 0, or this gate would red CI for everyone.
 *
 * Run: node --test scripts/verify-esm-entrypoints.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'verify-esm-entrypoints.mjs');

/**
 * Build a throwaway root holding a copy of the script and a `packages/`
 * tree described by `packages` — each entry is `{ dir, pkgJson, files }`.
 * Returns the path of the script copy to run.
 */
function makeRoot(packages) {
  const root = mkdtempSync(join(tmpdir(), 'ifclite-verify-esm-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'packages'), { recursive: true });
  const scriptCopy = join(root, 'scripts', 'verify-esm-entrypoints.mjs');
  copyFileSync(SCRIPT, scriptCopy);
  for (const p of packages) {
    const pkgDir = join(root, 'packages', p.dir);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(p.pkgJson, null, 2)
    );
    for (const [rel, body] of Object.entries(p.files ?? {})) {
      const abs = join(pkgDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
  }
  return { root, scriptCopy };
}

function run(scriptCopy) {
  const r = spawnSync(process.execPath, [scriptCopy], { encoding: 'utf8' });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

test('fails when discovery finds no packages at all', () => {
  const { root, scriptCopy } = makeRoot([]);
  try {
    const r = run(scriptCopy);
    assert.equal(
      r.status,
      1,
      `expected exit 1 on an empty discovery, got ${r.status}\n${r.stdout}${r.stderr}`
    );
    assert.match(r.stderr, /No publishable packages were discovered/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when packages/ holds only private and unnamed manifests', () => {
  // Discovery drops these before the skip list, so `skipped` stays empty
  // too — the summary would otherwise read 0/0/0 and exit 0.
  const { root, scriptCopy } = makeRoot([
    { dir: 'app-private', pkgJson: { name: '@ifc-lite/app', private: true } },
    { dir: 'no-version', pkgJson: { name: '@ifc-lite/nover' } },
  ]);
  try {
    const r = run(scriptCopy);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    assert.match(r.stderr, /No publishable packages were discovered/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('passes on a legitimate run that discovers and imports a package', () => {
  const { root, scriptCopy } = makeRoot([
    {
      dir: 'good',
      pkgJson: {
        name: '@ifc-lite/good',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      },
      files: { 'dist/index.js': 'export const ok = true;\n' },
    },
  ]);
  try {
    const r = run(scriptCopy);
    assert.equal(
      r.status,
      0,
      `a real package must still pass, got ${r.status}\n${r.stdout}${r.stderr}`
    );
    assert.match(r.stdout, /ok {4}@ifc-lite\/good/);
    assert.match(r.stdout, /1 passed, 0 failed, 0 skipped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when a package is skipped only because it is unbuilt', () => {
  // The other half of this script's fail-closed rule, and the one the
  // discovery gate above cannot carry: a package that DECLARES a dist entry
  // whose file is absent was never built, so its ESM entry point is
  // unverified, not fine. Discovery finds it (so `skipped` is non-empty and
  // the empty-discovery gate stays quiet) and the run must still exit 1.
  const { root, scriptCopy } = makeRoot([
    {
      dir: 'unbuilt',
      pkgJson: {
        name: '@ifc-lite/unbuilt',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      },
    },
  ]);
  try {
    const r = run(scriptCopy);
    assert.equal(
      r.status,
      1,
      `expected exit 1 on an unbuilt package, got ${r.status}\n${r.stdout}${r.stderr}`
    );
    assert.match(r.stderr, /skipped only because they are unbuilt/);
    assert.doesNotMatch(r.stderr, /No publishable packages were discovered/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a healthy package does not mask an unbuilt sibling', () => {
  // The asymmetric case: `testable.length` is non-zero and the smoke loop
  // reports "1 passed, 0 failed", so every count in the summary line reads
  // green. Only the unbuilt filter sees the second package, and a build
  // that skipped one package is exactly the shape a wholesale-unbuilt check
  // would miss.
  const { root, scriptCopy } = makeRoot([
    {
      dir: 'good',
      pkgJson: {
        name: '@ifc-lite/good',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      },
      files: { 'dist/index.js': 'export const ok = true;\n' },
    },
    {
      dir: 'unbuilt',
      pkgJson: {
        name: '@ifc-lite/unbuilt',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      },
    },
  ]);
  try {
    const r = run(scriptCopy);
    assert.equal(
      r.status,
      1,
      `one unbuilt package must red the run, got ${r.status}\n${r.stdout}${r.stderr}`
    );
    assert.match(r.stdout, /1 passed, 0 failed, 1 skipped/);
    assert.match(r.stderr, /1 package\(s\) were skipped only because they are unbuilt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not fire when everything discovered was legitimately skipped', () => {
  // A skip is a package that WAS discovered, so the empty-discovery gate
  // must stay quiet and leave the existing skip semantics untouched.
  const { root, scriptCopy } = makeRoot([
    {
      dir: 'sourceonly',
      pkgJson: {
        name: '@ifc-lite/sourceonly',
        version: '1.0.0',
        exports: { '.': { import: './src/index.ts' } },
      },
      files: { 'src/index.ts': 'export const ok = true;\n' },
    },
  ]);
  try {
    const r = run(scriptCopy);
    assert.equal(
      r.status,
      0,
      `a skipped-only run must not trip the discovery gate, got ${r.status}\n${r.stdout}${r.stderr}`
    );
    assert.doesNotMatch(r.stderr, /No publishable packages were discovered/);
    assert.match(r.stdout, /0 passed, 0 failed, 1 skipped/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
