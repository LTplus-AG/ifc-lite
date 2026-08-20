#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-sdk-lazy-import-warmup.mjs.
 *
 * A drift gate that silently matches nothing is worse than no gate -- it is the
 * failure it exists to prevent, wearing the costume of a pass. So every way it
 * could go false-green is an executable case here: a lazy import added without
 * warming it, a package dropped from the warm-up list, a stale entry left
 * behind, and either extractor broken so it returns the empty set.
 *
 * Method matches scripts/check-clash-degenerate-reason-parity.test.mjs: mutate
 * a copy of the REAL sources in a temp tree outside the repo, run the
 * UNMODIFIED checker against it via `--root`, and assert exit code plus
 * message. Every mutation anchor is asserted to exist in the real input first,
 * so a drifted anchor fails the suite instead of quietly testing nothing.
 *
 * Run: node --test scripts/check-sdk-lazy-import-warmup.test.mjs
 * (wired as a step of the CI node-test job in .github/workflows/test.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lazilyImportedPackages, warmedPackages } from './check-sdk-lazy-import-warmup.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const CHECKER = join(SCRIPTS, 'check-sdk-lazy-import-warmup.mjs');

const NAMESPACES_REL = 'packages/sdk/src/namespaces';
const SETUP_REL = 'packages/sdk/vitest.setup.ts';

const realNamespaces = Object.fromEntries(
  readdirSync(join(ROOT, NAMESPACES_REL))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(ROOT, NAMESPACES_REL, f), 'utf8')]),
);
const realSetup = readFileSync(join(ROOT, SETUP_REL), 'utf8');

/** Writes a (possibly mutated) tree to a temp dir and runs the checker on it. */
function runOn({ namespaces = realNamespaces, setup = realSetup }) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-lazy-warmup-'));
  try {
    mkdirSync(join(dir, NAMESPACES_REL), { recursive: true });
    for (const [name, source] of Object.entries(namespaces)) {
      writeFileSync(join(dir, NAMESPACES_REL, name), source);
    }
    writeFileSync(join(dir, SETUP_REL), setup);
    const r = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the real tree is in sync', () => {
  assert.equal(runOn({}).status, 0);
});

test('the extractors actually find something in the real tree', () => {
  // Guards every case below: if these returned empty, each mutation would be
  // compared against nothing and the suite would pass while checking nothing.
  assert.ok(lazilyImportedPackages(realNamespaces).size >= 5);
  assert.ok(warmedPackages(realSetup).size >= 5);
});

test('fires when a namespace gains a lazy import nobody warms', () => {
  assert.ok('bcf.ts' in realNamespaces, 'anchor: bcf.ts exists');
  const anchor = "const name = '@ifc-lite/bcf';";
  assert.ok(realNamespaces['bcf.ts'].includes(anchor), 'anchor: bcf loader binding');
  const { status, stderr } = runOn({
    namespaces: {
      ...realNamespaces,
      'bcf.ts': realNamespaces['bcf.ts'].replace(
        anchor,
        `const otherName = '@ifc-lite/query';\n  ${anchor}`,
      ),
    },
  });
  assert.equal(status, 1);
  assert.match(stderr, /NOT warmed/);
  assert.match(stderr, /@ifc-lite\/query/);
});

test('fires when a package is dropped from the warm-up list', () => {
  const anchor = "  '@ifc-lite/bcf',\n";
  assert.ok(realSetup.includes(anchor), 'anchor: bcf listed in the setup file');
  const { status, stderr } = runOn({ setup: realSetup.replace(anchor, '') });
  assert.equal(status, 1);
  assert.match(stderr, /NOT warmed/);
  assert.match(stderr, /@ifc-lite\/bcf/);
});

test('fires when a stale entry is left in the warm-up list', () => {
  const anchor = "  '@ifc-lite/bcf',\n";
  assert.ok(realSetup.includes(anchor), 'anchor: bcf listed in the setup file');
  const { status, stderr } = runOn({
    setup: realSetup.replace(anchor, `${anchor}  '@ifc-lite/no-longer-used',\n`),
  });
  assert.equal(status, 1);
  assert.match(stderr, /no longer imported lazily/);
  assert.match(stderr, /@ifc-lite\/no-longer-used/);
});

test('fires when the loader idiom disappears, rather than passing vacuously', () => {
  // The vacuity guard. Both sides would otherwise be compared as empty sets and
  // "agree" -- which is exactly how a dead gate looks like a healthy one.
  const gutted = Object.fromEntries(
    Object.entries(realNamespaces).map(([name, source]) => [
      name,
      source.replace(/const\s+(\w*[Nn]ame)\s*=\s*'@ifc-lite\/[^']+'/g, "const $1 = 'renamed'"),
    ]),
  );
  assert.equal(lazilyImportedPackages(gutted).size, 0, 'mutation applied');
  const { status, stderr } = runOn({ namespaces: gutted });
  assert.equal(status, 1);
  assert.match(stderr, /No dynamic @ifc-lite import found/);
});

test('fires when the warm-up array is renamed, rather than scanning the whole file', () => {
  // The setup-side counterpart of the vacuity guard. The extractor anchors on
  // the array literal, so a rename yields the empty set and every package reads
  // as unwarmed -- loud. A bare whole-file scan would instead keep finding all
  // six and report agreement with a list that no longer exists.
  const anchor = 'LAZY_NAMESPACE_PACKAGES';
  assert.ok(realSetup.includes(anchor), 'anchor: the array constant is named that');
  const renamed = realSetup.split(anchor).join('WARMED_PACKAGES');
  assert.equal(warmedPackages(renamed).size, 0, 'mutation applied');
  const { status, stderr } = runOn({ setup: renamed });
  assert.equal(status, 1);
  assert.match(stderr, /NOT warmed/);
});

test('a package named only in a comment does not count as warmed', () => {
  const anchor = "  '@ifc-lite/bcf',\n";
  assert.ok(realSetup.includes(anchor), 'anchor: bcf listed in the setup file');
  // Removed from the array, mentioned in prose. Comments are stripped, so this
  // must still fail -- otherwise a docblock could satisfy the gate.
  const { status, stderr } = runOn({
    setup: realSetup.replace(anchor, '') + "\n// mentions '@ifc-lite/bcf' in prose only\n",
  });
  assert.equal(status, 1);
  assert.match(stderr, /@ifc-lite\/bcf/);
});
