#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for `fetch-fixtures.mjs --check`, the step every fixture-consuming CI
 * job runs unconditionally after its cache-gated fetch.
 *
 * Why this file exists. The fetch is gated on a cache MISS, so on a cache HIT
 * nothing confirmed the restored `tests/models/` still matched the manifest.
 * A partial or corrupted cache then turned every `fixture_or_skip!` test into
 * a no-op that printed a skip line and reported ok. `--check` closes that —
 * which makes it a gate about a gate, and a gate that can itself pass over
 * nothing is worth less than no gate at all, because it also buys silence.
 *
 * So two directions are under test:
 *
 *   1. It must go RED for each way a cache hit can be wrong, and NAME the
 *      offender: absent from disk, right size but wrong bytes, wrong size.
 *      "3 of 164" sends the reader back to the manifest to work out which
 *      three; the path plus the reason does not.
 *   2. It must not report success having verified nothing. A manifest that is
 *      absent, unparseable, or lists zero files makes the per-entry loop
 *      iterate over an empty set, so `needed` is 0 because nothing was
 *      examined. Each must exit non-zero. So must a scoped invocation
 *      (`--check a.ifc b.ifc`, as benchmark.yml uses) naming a path the
 *      manifest does not list: filtering it away silently reported "all 1
 *      fixtures present and verified" over a corpus one file short.
 *
 * The passing cases exist to hold (2) honest: a check that reds a healthy tree
 * gets switched off, which is worse than the vacuity it closes.
 *
 * Each case builds a synthetic repo root under a temp dir — a copy of the real
 * script (it resolves `tests/models/` relative to its own location, so a copy
 * is how you point it at a synthetic corpus) plus a hand-written manifest and
 * a few small files. `--check` never fetches, so nothing here touches the
 * network.
 *
 * Run: node --test scripts/fixtures/fetch-fixtures.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'fetch-fixtures.mjs');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Build a synthetic repo root: a copy of the real fetcher at
 * `<root>/scripts/fixtures/`, a manifest at `<root>/tests/models/`, and
 * whatever files `onDisk` names. Returns the root; the caller removes it.
 *
 * @param {object} opts
 * @param {string[]} opts.fixtures      manifest-relative paths to manifest
 * @param {Record<string,string>} [opts.onDisk]  path -> exact bytes to write
 * @param {unknown} [opts.manifest]     raw manifest override (object)
 * @param {string} [opts.manifestText]  raw manifest bytes (wins over both)
 * @param {boolean} [opts.noManifest]   write no manifest at all
 */
function makeRoot(opts) {
  const root = mkdtempSync(join(tmpdir(), 'fixcheck-'));
  const scriptDir = join(root, 'scripts', 'fixtures');
  const modelsDir = join(root, 'tests', 'models');
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  copyFileSync(SCRIPT, join(scriptDir, 'fetch-fixtures.mjs'));

  // Canonical contents for every manifested fixture. The manifest records the
  // hash and size of THESE, so a test that writes something else on disk is
  // writing a corrupted cache entry.
  const canonical = new Map(
    (opts.fixtures ?? []).map((p) => [p, Buffer.from(`ISO-10303-21;\n/* ${p} */\nEND-ISO-10303-21;\n`)]),
  );

  const files = [...canonical].map(([path, buf]) => ({
    path,
    sha256: sha256(buf),
    size: buf.length,
  }));

  // `onDisk` defaults to the canonical bytes for every manifested fixture —
  // i.e. a healthy cache. Tests override entries to corrupt or drop them.
  const onDisk = opts.onDisk ?? Object.fromEntries([...canonical].map(([p, b]) => [p, b]));
  for (const [path, contents] of Object.entries(onDisk)) {
    const abs = join(modelsDir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }

  if (!opts.noManifest) {
    const text =
      opts.manifestText ??
      JSON.stringify(
        opts.manifest ?? { version: 1, base_url: 'https://example.invalid/fixtures', files },
        null,
        2,
      );
    writeFileSync(join(modelsDir, 'manifest.json'), text);
  }
  return root;
}

/** Run `--check` (plus any scoped paths) inside a synthetic root. */
function check(root, ...paths) {
  const res = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'fixtures', 'fetch-fixtures.mjs'), '--check', ...paths],
    { encoding: 'utf8' },
  );
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

/** Assert non-zero exit and that every fragment appears in the output. */
function assertRed({ status, out }, ...fragments) {
  assert.notEqual(status, 0, `expected a non-zero exit, got ${status}. Output:\n${out}`);
  for (const f of fragments) {
    assert.ok(out.includes(f), `expected output to mention ${JSON.stringify(f)}. Output:\n${out}`);
  }
}

// --- direction 1: every way a cache hit can be wrong, named ----------------

test('a fixture absent from the restored tree is named', () => {
  const root = makeRoot({
    fixtures: ['ara3d/a.ifc', 'various/b.ifc'],
    onDisk: { 'ara3d/a.ifc': 'ISO-10303-21;\n/* ara3d/a.ifc */\nEND-ISO-10303-21;\n' },
  });
  try {
    const r = check(root);
    assertRed(r, 'tests/models/various/b.ifc', 'missing from tests/models/', '1 of 2');
    // The healthy one must not be reported as an offender.
    assert.ok(!r.out.includes('tests/models/ara3d/a.ifc'), r.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a right-sized but byte-flipped fixture is named as a hash mismatch', () => {
  // The case presence-only checking cannot see, and the one a truncated or
  // half-written cache entry most resembles once the size happens to match.
  const good = 'ISO-10303-21;\n/* ara3d/a.ifc */\nEND-ISO-10303-21;\n';
  const flipped = good.replace('/* ara3d/a.ifc */', '/* ara3d/X.ifc */');
  assert.equal(flipped.length, good.length, 'the fixture for this test must keep the size equal');
  const root = makeRoot({ fixtures: ['ara3d/a.ifc'], onDisk: { 'ara3d/a.ifc': flipped } });
  try {
    assertRed(check(root), 'tests/models/ara3d/a.ifc', 'sha256 mismatch', sha256(Buffer.from(good)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a truncated fixture is named as a size mismatch', () => {
  const good = 'ISO-10303-21;\n/* ara3d/a.ifc */\nEND-ISO-10303-21;\n';
  const root = makeRoot({ fixtures: ['ara3d/a.ifc'], onDisk: { 'ara3d/a.ifc': good.slice(0, 10) } });
  try {
    assertRed(check(root), 'tests/models/ara3d/a.ifc', 'size mismatch', '10');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- direction 2: no way to tick having verified nothing -------------------

test('an empty tests/models under a cache hit reds, naming every entry', () => {
  const root = makeRoot({ fixtures: ['ara3d/a.ifc', 'various/b.ifc'], onDisk: {} });
  try {
    assertRed(check(root), 'tests/models/ara3d/a.ifc', 'tests/models/various/b.ifc', '2 of 2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest listing zero files reds instead of "all 0 fixtures verified"', () => {
  const root = makeRoot({
    fixtures: [],
    manifest: { version: 1, base_url: 'https://example.invalid/fixtures', files: [] },
  });
  try {
    assertRed(check(root), 'lists no files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unparseable manifest reds with the path, not a JSON.parse stack', () => {
  const root = makeRoot({ fixtures: [], manifestText: '{"version":1,"files":[' });
  try {
    const r = check(root);
    assertRed(r, 'manifest.json', 'could not be read as JSON');
    assert.ok(!r.out.includes('at JSON.parse'), `expected no raw stack trace. Output:\n${r.out}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing manifest reds', () => {
  const root = makeRoot({ fixtures: [], noManifest: true });
  try {
    assertRed(check(root), 'manifest.json', 'not found');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a scoped check naming a path the manifest does not list reds', () => {
  // benchmark.yml checks two literal paths. Filtering an unknown path away
  // let a manifest rename shrink the checked set in silence — the check ticked
  // over a corpus the job never received.
  const root = makeRoot({ fixtures: ['ara3d/a.ifc'] });
  try {
    assertRed(check(root, 'ara3d/a.ifc', 'various/renamed.ifc'), 'various/renamed.ifc', 'not listed in');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- positive controls: a healthy tree must stay green ---------------------

test('a complete corpus passes and says how many it verified', () => {
  const root = makeRoot({ fixtures: ['ara3d/a.ifc', 'various/b.ifc'] });
  try {
    const r = check(root);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('all 2 fixtures present and verified'), r.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a scoped check over known paths passes', () => {
  const root = makeRoot({ fixtures: ['ara3d/a.ifc', 'various/b.ifc'] });
  try {
    const r = check(root, 'ara3d/a.ifc', 'tests/models/various/b.ifc');
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes('all 2 fixtures present and verified'), r.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
