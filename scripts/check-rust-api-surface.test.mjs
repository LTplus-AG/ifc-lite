#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-rust-api-surface.mjs (issue #4192).
 *
 * `scripts/lib/rust-public-api.test.mjs` covers the PARSER (what one crate's
 * surface looks like, including the exact #4178/#4182 field additions). This
 * file covers the GATE around it: `buildSnapshot`'s vacuity refusals (a
 * crate list shrunk below the floor, a crate with no directory, a crate
 * whose lib.rs yields nothing), and `diffCrate`'s three-way classification
 * (added / removed / changed) that the CLI's diff output and exit code rest
 * on.
 *
 * Run: node --test scripts/check-rust-api-surface.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, diffCrate, CRATE_FLOOR } from './check-rust-api-surface.mjs';

/** A scratch `rust/` root with one crate per `{ crateName: libRsText }` entry. */
function withRustRoot(crateFiles, fn) {
  const rustRoot = mkdtempSync(join(tmpdir(), 'rust-api-surface-'));
  try {
    for (const [dirName, { name, libRs }] of Object.entries(crateFiles)) {
      const dir = join(rustRoot, dirName);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "0.1.0"\n`);
      writeFileSync(join(dir, 'src', 'lib.rs'), libRs);
    }
    return fn(rustRoot);
  } finally {
    rmSync(rustRoot, { recursive: true, force: true });
  }
}

const SEVEN_CRATE_NAMES = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
const TRIVIAL_LIB_RS = 'pub const MARKER: u32 = 1;';

function sevenTrivialCrates() {
  const out = {};
  for (const name of SEVEN_CRATE_NAMES) out[name] = { name, libRs: TRIVIAL_LIB_RS };
  return out;
}

test('buildSnapshot succeeds over a floor-sized set of real crates', () => {
  withRustRoot(sevenTrivialCrates(), (rustRoot) => {
    const { snapshot, warnings } = buildSnapshot({ crates: SEVEN_CRATE_NAMES, rustRoot });
    assert.equal(Object.keys(snapshot).length, 7);
    assert.deepEqual(warnings, []);
    for (const name of SEVEN_CRATE_NAMES) assert.equal(snapshot[name].MARKER, 'const');
  });
});

test('VACUITY: an empty crate list refuses rather than reporting zero crates as clean', () => {
  assert.throws(() => buildSnapshot({ crates: [], rustRoot: '/nonexistent' }), /NO_CRATES/);
});

test(`VACUITY: fewer than CRATE_FLOOR (${CRATE_FLOOR}) crates refuses — a shrunk list must not read as a smaller-but-complete one`, () => {
  assert.throws(() => buildSnapshot({ crates: ['only-one'], rustRoot: '/nonexistent' }), /CRATE_FLOOR/);
});

test('VACUITY: a published crate with no matching rust/*/Cargo.toml directory refuses by name', () => {
  withRustRoot(sevenTrivialCrates(), (rustRoot) => {
    const crates = [...SEVEN_CRATE_NAMES.slice(0, 6), 'never-declared'];
    assert.throws(() => buildSnapshot({ crates, rustRoot }), /MISSING_CRATE_DIR.*never-declared/s);
  });
});

test('VACUITY: a crate whose lib.rs yields zero tracked items refuses rather than snapshotting an empty surface', () => {
  const files = sevenTrivialCrates();
  files.c1.libRs = 'mod internal; fn private_only() {}';
  withRustRoot(files, (rustRoot) => {
    assert.throws(() => buildSnapshot({ crates: SEVEN_CRATE_NAMES, rustRoot }), /EMPTY_SURFACE/);
  });
});

test('buildSnapshot surfaces ambiguous-name warnings per crate rather than swallowing them', () => {
  const files = sevenTrivialCrates();
  files.c1.libRs = `
    mod a;
    mod b;
    pub use a::Dup;
  `;
  // Two definitions for `Dup` across files under c1's src/.
  withRustRoot(files, (rustRoot) => {
    mkdirSync(join(rustRoot, 'c1', 'src'), { recursive: true });
    writeFileSync(join(rustRoot, 'c1', 'src', 'a.rs'), 'pub struct Dup { pub x: u32 }');
    writeFileSync(join(rustRoot, 'c1', 'src', 'b.rs'), 'pub struct Dup { pub y: u32 }');
    const { warnings } = buildSnapshot({ crates: SEVEN_CRATE_NAMES, rustRoot });
    assert.ok(warnings.some((w) => w.startsWith('c1: AMBIGUOUS: Dup')));
  });
});

test('diffCrate classifies a field addition as CHANGED, not just added+removed as separate names', () => {
  const before = { OpeningDiagnostic: 'struct { opening_id: u32 }' };
  const after = { OpeningDiagnostic: 'struct { opening_id: u32; triangle_count: usize }' };
  const { added, removed, changed } = diffCrate(before, after);
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].name, 'OpeningDiagnostic');
});

test('diffCrate reports a genuinely new name as added and a dropped name as removed', () => {
  const before = { A: 'struct (unit)' };
  const after = { B: 'struct (unit)' };
  const { added, removed, changed } = diffCrate(before, after);
  assert.deepEqual(added, ['B: struct (unit)']);
  assert.deepEqual(removed, ['A: struct (unit)']);
  assert.deepEqual(changed, []);
});

test('diffCrate over identical surfaces reports nothing — the case that must stay silent', () => {
  const surface = { A: 'struct (unit)', B: 'enum { X; Y }' };
  const { added, removed, changed } = diffCrate(surface, { ...surface });
  assert.deepEqual({ added, removed, changed }, { added: [], removed: [], changed: [] });
});


// #4233: the committed manifest is the public API compatibility contract.
// In particular, #4193 removed OpeningDiagnostic.triangle_count while #4213
// added StepStats.attribute_edits_refused; the old manifest described neither.
// Compare measured exports, not strings grepped from implementation files.
test('the committed Rust API manifest matches the current published crate surfaces (#4233)', () => {
  const committed = JSON.parse(readFileSync(new URL('./rust-api-surface.json', import.meta.url), 'utf8'));
  const { snapshot } = buildSnapshot();
  assert.deepEqual(committed, snapshot, 'Regenerate the Rust API manifest after changing a published surface');
});
