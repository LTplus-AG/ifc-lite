/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gate's own tests. Its whole value is in not reporting "clean" over a
 * target it never actually compared, so the diffing primitive (`diffDirs`)
 * is exercised against synthetic, corrupted, missing, and extra files
 * BEFORE trusting it against the real repo — the same shape as
 * `check-test-wiring.test.mjs`'s "reconstruct the pre-fix state" fixtures.
 *
 * Determinism is checked separately, against the REAL `packages/codegen`
 * generator (built once here): running it twice on the same schema must
 * produce byte-identical output, so a nondeterministic generator (map
 * iteration order, a timestamp, a random id) cannot pass this gate on one
 * run and fail it on the next for no source change.
 *
 * Run: `node --test scripts/check-codegen-sync.test.mjs`
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gate from './check-codegen-sync.mjs';

const { diffDirs, listFilesRecursive, buildCodegen, runCodegenCli, runDataGenerator } = gate;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function mktemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

describe('diffDirs — the primitive that decides pass/fail', () => {
  // A FRESH pair of directories per test (not a shared before/after): a
  // shared pair let an earlier test's files leak into a later test's
  // comparison (`entities.ts` from test 2 was still on disk during test 6,
  // silently widening its expected file set) and the assertion had to name
  // the leaked entries to pass, which would have masked a real regression.
  let genDir;
  let committedDir;
  const dirs = [];

  function freshDirs() {
    genDir = mktemp('ifclite-codegen-sync-test-gen-');
    committedDir = mktemp('ifclite-codegen-sync-test-committed-');
    dirs.push(genDir, committedDir);
  }

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('reports ok on identical trees (positive control — proves the comparison is not vacuously red)', () => {
    freshDirs();
    writeTree(genDir, { 'a.ts': 'export const a = 1;\n', 'nested/b.ts': 'export const b = 2;\n' });
    writeTree(committedDir, { 'a.ts': 'export const a = 1;\n', 'nested/b.ts': 'export const b = 2;\n' });
    const r = diffDirs(genDir, committedDir);
    assert.deepEqual(r, { ok: true, missing: [], extra: [], differing: [] });
  });

  test('fires on a content mismatch (the #3565 shape — a hand-patched committed file)', () => {
    freshDirs();
    writeTree(genDir, { 'entities.ts': 'export interface X { y: UNIQUE Z[]; }\n' });
    writeTree(committedDir, { 'entities.ts': 'export interface X { y: Z[]; }\n' });
    const r = diffDirs(genDir, committedDir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.differing, ['entities.ts']);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.extra, []);
  });

  test('fires when the committed file is not regenerated at all (missing)', () => {
    freshDirs();
    writeTree(genDir, {});
    writeTree(committedDir, { 'only-committed.ts': 'x\n' });
    const r = diffDirs(genDir, committedDir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['only-committed.ts']);
  });

  test('fires when the generator produces a file nothing committed has (extra)', () => {
    freshDirs();
    writeTree(genDir, { 'only-generated.ts': 'x\n' });
    writeTree(committedDir, {});
    const r = diffDirs(genDir, committedDir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.extra, ['only-generated.ts']);
  });

  test('fails closed when the committed directory does not exist at all', () => {
    freshDirs();
    writeTree(genDir, { 'a.ts': 'x\n' });
    const r = diffDirs(genDir, join(committedDir, 'does-not-exist'));
    assert.equal(r.ok, false);
    assert.ok(r.error, 'must name the reason rather than reporting a silent pass');
  });

  test('walks subdirectories at any depth (not a flat readdirSync)', () => {
    freshDirs();
    writeTree(genDir, { 'a/b/c/deep.ts': 'x\n' });
    writeTree(committedDir, { 'a/b/c/deep.ts': 'y\n' });
    const r = diffDirs(genDir, committedDir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.differing, ['a/b/c/deep.ts']);
  });
});

describe('listFilesRecursive', () => {
  test('returns POSIX-separated relative paths, sorted', () => {
    const dir = mktemp('ifclite-codegen-sync-test-list-');
    try {
      writeTree(dir, { 'z.ts': '', 'a/nested.ts': '' });
      assert.deepEqual(listFilesRecursive(dir), ['a/nested.ts', 'z.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('real codegen generator — determinism', { skip: !existsSync(join(ROOT, 'packages/codegen/schemas/IFC4_ADD2_TC1.exp')) ? 'no schema on disk' : false }, () => {
  before(() => {
    buildCodegen(ROOT);
  });

  test('the same schema run twice produces byte-identical output', () => {
    const out1 = mktemp('ifclite-codegen-sync-test-det1-');
    const out2 = mktemp('ifclite-codegen-sync-test-det2-');
    try {
      runCodegenCli(ROOT, join(ROOT, 'packages/codegen/schemas/IFC4_ADD2_TC1.exp'), out1);
      runCodegenCli(ROOT, join(ROOT, 'packages/codegen/schemas/IFC4_ADD2_TC1.exp'), out2);
      const r = diffDirs(out1, out2);
      assert.deepEqual(r, { ok: true, missing: [], extra: [], differing: [] }, 'generator is not deterministic run-to-run');
      assert.ok(listFilesRecursive(out1).length > 0, 'positive control: the run actually produced files');
    } finally {
      rmSync(out1, { recursive: true, force: true });
      rmSync(out2, { recursive: true, force: true });
    }
  });
});

describe('real data generator — determinism', () => {
  test('the same upstream input run twice produces byte-identical output', () => {
    const w1 = mktemp('ifclite-codegen-sync-test-data1-');
    const w2 = mktemp('ifclite-codegen-sync-test-data2-');
    try {
      const out1 = runDataGenerator(ROOT, w1);
      const out2 = runDataGenerator(ROOT, w2);
      const r = diffDirs(out1, out2);
      assert.deepEqual(r, { ok: true, missing: [], extra: [], differing: [] }, 'data generator is not deterministic run-to-run');
      assert.ok(listFilesRecursive(out1).length > 0, 'positive control: the run actually produced files');
    } finally {
      rmSync(w1, { recursive: true, force: true });
      rmSync(w2, { recursive: true, force: true });
    }
  });
});
