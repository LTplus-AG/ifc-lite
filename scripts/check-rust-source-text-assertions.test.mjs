#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the Rust source-text-assertion gate (issue #3195). Everything runs
 * against synthetic Rust written into an `mkdtemp` tree, never against `rust/`,
 * so a change in a real crate can neither break these nor make them vacuously
 * green -- the construction scripts/check-refwalk-guards.test.mjs and
 * scripts/check-source-text-assertions.test.mjs both use.
 *
 * Three groups, and the second two are not decoration:
 *
 *  - FIRING. A gate nobody has watched fail is the thing #3195 is about.
 *  - NOT FIRING. A gate with false positives gets suppressed and then it
 *    protects nothing, so every legitimate shape in the real tree -- a fixture
 *    read, a doc comment naming a `.rs` path, a `.rs` literal that is not a
 *    read at all -- is pinned as passing.
 *  - VACUITY. Three sibling gates shipped exiting 0 having examined nothing
 *    (#3194 / PR #3197). `missingRoot`, `emptyRoot`, `noTestFiles` and
 *    `readFloor` pin that this one fails loudly instead.
 *
 * Run: node --test scripts/check-rust-source-text-assertions.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCheck } from './check-rust-source-text-assertions.mjs';
import { analyze, lex } from './lib/rust-source-text-detect.mjs';

const ROOT = 'rust';
const TESTFILE = `${ROOT}/core/tests/subject_parity.rs`;

/**
 * Build a temp tree of `{ 'rust/…/x.rs': '…' }` and run the check against it.
 * Defaults keep the repo's own floor and allowlist out of play.
 *
 * @param {Record<string, string>} files
 * @param {object} [opts]
 */
function check(files, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rust-source-text-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return runCheck(dir, { roots: [ROOT], allowlist: new Set(), readFloor: 0, allowlistCeiling: 0, ...opts });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ─────────────────────────── FIRING ─────────────────────────── */

test('flags the planted violation from #3129 verbatim', () => {
  const r = check({
    [TESTFILE]: `
#[test]
fn t() {
    let src = std::fs::read_to_string("src/api/space_plate_input.rs").unwrap();
    assert!(src.contains("fn space_plate_input"));
}
`,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.offenders, [`${TESTFILE}:4  read_to_string of src/api/space_plate_input.rs`]);
});

test('flags include_str! of a source file', () => {
  const r = check({ [TESTFILE]: 'const SRC: &str = include_str!("../src/lib.rs");\n' });
  assert.deepEqual(r.offenders, [`${TESTFILE}:1  include_str of ../src/lib.rs`]);
});

test('flags a read whose path is a named const, the tree’s usual spelling', () => {
  const r = check({
    [TESTFILE]: `
const SUBJECT: &str = "../src/lib.rs";

#[test]
fn t() {
    let src = std::fs::read_to_string(SUBJECT).unwrap();
    assert!(src.contains("pub fn"));
}
`,
  });
  assert.deepEqual(r.offenders, [`${TESTFILE}:6  read_to_string of ../src/lib.rs`]);
});

test('flags a read inside a #[cfg(test)] mod in a src file', () => {
  const r = check({
    [`${ROOT}/core/src/thing.rs`]: `
pub fn thing() -> u32 { 1 }

#[cfg(test)]
mod tests {
    #[test]
    fn t() {
        let src = std::fs::read_to_string("src/thing.rs").unwrap();
        assert!(src.contains("pub fn thing"));
    }
}
`,
  });
  assert.deepEqual(r.offenders, [`${ROOT}/core/src/thing.rs:8  read_to_string of src/thing.rs`]);
});

test('flags a TypeScript source read from a Rust test, since the rule is about source, not language', () => {
  const r = check({ [TESTFILE]: 'const S: &str = include_str!("../../../apps/viewer/src/App.tsx");\n' });
  assert.deepEqual(r.offenders, [`${TESTFILE}:1  include_str of ../../../apps/viewer/src/App.tsx`]);
});

/* ───────────────────────── NOT FIRING ───────────────────────── */

test('does not flag a fixture read', () => {
  const r = check({
    [TESTFILE]: `
const FIXTURE: &str = "fixtures/model.ifc";

#[test]
fn t() {
    let raw = include_str!("fixtures/vectors.json");
    let bytes = std::fs::read(FIXTURE).unwrap();
    assert!(!raw.is_empty() && !bytes.is_empty());
}
`,
  });
  assert.deepEqual(r.offenders, []);
  assert.equal(r.reads, 2, 'both reads are examined — they are clean, not invisible');
});

test('PROSE IS NOT CODE: a doc comment naming a .rs file is not a read', () => {
  const r = check({
    [TESTFILE]: `
//! Mirrors the table in \`src/unit_scale.rs\`, per \`packages/data/src/units.ts\`.

/// See src/thing.rs and safe-path.test.ts for the shape this pins.
#[test]
fn t() {
    /* src/other.rs is named here too, in a block comment */
    let raw = include_str!("fixtures/vectors.json");
    assert!(!raw.is_empty());
}
`,
  });
  assert.deepEqual(r.offenders, []);
});

test('a .rs literal that is not a read argument is not a read', () => {
  // The real shape: rust/processing/tests/styling_parity.rs allowlists ITSELF
  // by name, `rel.ends_with("rust/processing/tests/styling_parity.rs")`.
  const r = check({
    [TESTFILE]: `
#[test]
fn t() {
    let allow = |rel: &str| rel.ends_with("rust/processing/tests/styling_parity.rs");
    assert!(allow("rust/processing/tests/styling_parity.rs"));
}
`,
  });
  assert.deepEqual(r.offenders, []);
  assert.equal(r.reads, 0);
});

test('a source read outside test scope is out of scope, because the rule is about tests', () => {
  const r = check({
    [`${ROOT}/core/src/tool.rs`]: `
pub fn count_lines() -> usize {
    std::fs::read_to_string("src/lib.rs").map(|s| s.lines().count()).unwrap_or(0)
}
`,
  });
  assert.deepEqual(r.offenders, []);
  assert.equal(r.testFiles, 0, 'a src file with no #[cfg(test)] is not opened as test code');
});

test('a string cannot forge a suppression marker', () => {
  const r = check({
    [TESTFILE]: `
#[test]
fn t() {
    let excuse = "@source-text-assertion-ok totally fine";
    let src = std::fs::read_to_string("src/lib.rs").unwrap();
    assert!(src.contains(excuse));
}
`,
  });
  assert.deepEqual(r.offenders, [`${TESTFILE}:5  read_to_string of src/lib.rs`]);
  assert.deepEqual(r.deadMarkers, [], 'the string is not a marker in either direction');
});

/* ─────────────────────────── MARKERS ────────────────────────── */

test('a marker above the statement suppresses the site and NAMES it', () => {
  const r = check({
    [TESTFILE]: `
#[test]
fn t() {
    // @source-text-assertion-ok mutation anchor guard
    let src = std::fs::read_to_string("src/lib.rs").unwrap();
    assert!(src.contains("anchor"));
}
`,
  });
  assert.deepEqual(r.offenders, []);
  assert.deepEqual(r.marked, [`${TESTFILE}:5  src/lib.rs  mutation anchor guard`]);
});

test('a comment INSIDE the read does not break the marker range (#3174)', () => {
  const r = check({
    [TESTFILE]: `
#[test]
fn t() {
    // @source-text-assertion-ok mutation anchor guard
    let src = std::fs::read_to_string(
        // the interior comment that broke the TypeScript gate
        "src/lib.rs",
    )
    .unwrap();
    assert!(src.contains("anchor"));
}
`,
  });
  assert.deepEqual(r.offenders, [], 'the remedy the gate prints must be one it accepts');
  assert.equal(r.deadMarkers.length, 0, 'and it must not then fail a second time for a dead marker');
});

test('a marker with no reason excuses nothing and is an error', () => {
  const r = check({
    [TESTFILE]: `
#[test]
fn t() {
    // @source-text-assertion-ok
    let src = std::fs::read_to_string("src/lib.rs").unwrap();
    assert!(src.contains("x"));
}
`,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.offenders, [`${TESTFILE}:5  read_to_string of src/lib.rs`]);
  assert.deepEqual(r.deadMarkers, [`${TESTFILE}:4`]);
});

test('a marker left behind after the read is gone is reported dead', () => {
  const r = check({
    [TESTFILE]: `
#[test]
fn t() {
    // @source-text-assertion-ok mutation anchor guard
    let raw = include_str!("fixtures/vectors.json");
    assert!(!raw.is_empty());
}
`,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.deadMarkers, [`${TESTFILE}:4`]);
});

/* ─────────────────────────── LEXER ──────────────────────────── */

test('a raw string does not blind the lexer to what follows it', () => {
  // An unterminated-string bug fails OPEN: it swallows the rest of the file and
  // the gate goes quiet. Every pre-#3174 bug in the TypeScript detector had
  // that shape, so each Rust-specific literal form gets a live read after it.
  const r = check({
    [TESTFILE]: `
#[test]
fn t() {
    let q = r#"a " quote and a // slash"#;
    let raw = r"another \\ raw";
    let b = br##"bytes " here"##;
    let src = std::fs::read_to_string("src/lib.rs").unwrap();
    assert!(src.contains(q) && !raw.is_empty() && !b.is_empty());
}
`,
  });
  assert.deepEqual(r.offenders, [`${TESTFILE}:7  read_to_string of src/lib.rs`]);
});

test('a NESTED block comment ends where Rust says it ends', () => {
  const r = check({
    [TESTFILE]: `
/* outer /* inner */ still comment, "src/decoy.rs" */
#[test]
fn t() {
    let src = std::fs::read_to_string("src/lib.rs").unwrap();
    assert!(src.contains("x"));
}
`,
  });
  assert.deepEqual(r.offenders, [`${TESTFILE}:5  read_to_string of src/lib.rs`]);
});

test('a lifetime is not an unterminated char literal', () => {
  const r = check({
    [TESTFILE]: `
struct Holder<'a> { s: &'a str }

#[test]
fn t() {
    let h = Holder { s: "x" };
    let src = std::fs::read_to_string("src/lib.rs").unwrap();
    assert!(src.contains(h.s));
}
`,
  });
  assert.deepEqual(r.offenders, [`${TESTFILE}:7  read_to_string of src/lib.rs`]);
});

test('lex masks comments and strings without moving any offset', () => {
  const text = '// a\nlet s = "bb";\n';
  const { masked } = lex(text);
  assert.equal(masked.length, text.length, 'offsets must survive masking');
  assert.equal(masked.split('\n').length, text.split('\n').length, 'line numbers must survive masking');
  assert.ok(!masked.includes('bb'), 'string contents are out of the code plane');
  assert.ok(!masked.includes('a\n') || masked.startsWith('    \n'), 'comment text is out of the code plane');
});

/* ────────────────────────── ALLOWLIST ───────────────────────── */

const VIOLATION = `
#[test]
fn t() {
    let src = std::fs::read_to_string("src/lib.rs").unwrap();
    assert!(src.contains("x"));
}
`;

test('an allowlist row suppresses exactly its own file', () => {
  const other = `${ROOT}/core/tests/other_parity.rs`;
  const r = check(
    { [TESTFILE]: VIOLATION, [other]: VIOLATION },
    { allowlist: new Set([TESTFILE]), allowlistCeiling: 1 }
  );
  assert.deepEqual(r.offenders, [`${other}:4  read_to_string of src/lib.rs`]);
});

test('an allowlist row whose file got converted is reported stale', () => {
  const r = check(
    { [TESTFILE]: 'const RAW: &str = include_str!("fixtures/vectors.json");\n' },
    { allowlist: new Set([TESTFILE]), allowlistCeiling: 1 }
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /no longer contain a source-text assertion/);
});

test('allowlist growth cannot land without editing the ceiling', () => {
  const r = check({ [TESTFILE]: VIOLATION }, { allowlist: new Set([TESTFILE]), allowlistCeiling: 0 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /ALLOWLIST_CEILING reads 0/);
});

test('allowlist shrinkage must lower the ceiling too', () => {
  const r = check({ [TESTFILE]: VIOLATION }, { allowlist: new Set(), allowlistCeiling: 1 });
  assert.match(r.errors.join('\n'), /ALLOWLIST_CEILING reads 1/);
});

/* ─────────────────────────── VACUITY ────────────────────────── */

test('a missing scan root is a failure, not a pass', () => {
  const r = check({ 'docs/readme.md': 'no rust here\n' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /scan root missing: rust/);
});

test('a scan root with no .rs files is a failure, not a pass', () => {
  const r = check({ [`${ROOT}/core/Cargo.toml`]: '[package]\n' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /contains no \.rs files/);
});

test('.rs files but no test code among them refuses a vacuous pass', () => {
  const r = check({ [`${ROOT}/core/src/lib.rs`]: 'pub fn f() -> u32 { 1 }\n' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /not one test file among them/);
});

test('a detector that stopped matching trips the read floor', () => {
  // The floor's whole job: a lexer edit or a renamed call makes the gate go
  // QUIET, and quiet reads as clean. Simulated here by holding the floor while
  // the tree offers fewer reads than it demands.
  const r = check({ [TESTFILE]: 'const RAW: &str = include_str!("fixtures/vectors.json");\n' }, { readFloor: 90 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /only 1 file reads found in Rust test code, floor is 90/);
});

test('the floor is met by the real tree, so it is a floor and not a wish', () => {
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./check-rust-source-text-assertions.mjs', import.meta.url))],
    { encoding: 'utf8' }
  );
  const m = /check-rust-source-text-assertions: OK \((\d+) \.rs files, (\d+) with test code, (\d+) reads/.exec(
    `${run.stdout}${run.stderr}`
  );
  assert.ok(m, `no success line:\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.ok(Number(m[1]) > 0, 'scanned 0 .rs files — a green that examined nothing is what this gate is for');
  assert.ok(Number(m[2]) > 0, 'found 0 files carrying test code');
  assert.ok(Number(m[3]) > 0, 'examined 0 reads');
});

/* ────────────────────── ENTRY POINT ─────────────────────────── */

/**
 * The gate is only worth anything if it RUNS, and a module that falls through
 * because `isMain` came out false prints nothing and exits 0 -- which CI reads
 * as a pass. The bug is invisible from inside the test process (an imported
 * module has `isMain === false` by design), so it has to be spawned, and the
 * discriminator has to be OUTPUT rather than exit code.
 */
test('the gate actually runs from a path containing a space', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rust source text gate '));
  try {
    assert.ok(dir.includes(' '), `temp dir must contain a space, got ${dir}`);
    const copied = join(dir, 'check-rust-source-text-assertions.mjs');
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(copied, readFileSync(new URL('./check-rust-source-text-assertions.mjs', import.meta.url)));
    writeFileSync(
      join(dir, 'lib', 'rust-source-text-detect.mjs'),
      readFileSync(new URL('./lib/rust-source-text-detect.mjs', import.meta.url))
    );

    const run = spawnSync(process.execPath, [copied], { encoding: 'utf8' });
    const output = `${run.stdout}${run.stderr}`;

    // The copy has no rust/ tree, so a gate that ran must refuse to report a
    // pass over zero files. That refusal IS the evidence that it ran.
    assert.notEqual(output.trim(), '', 'the gate produced no output at all, so `isMain` was false and it never ran');
    assert.match(
      output,
      /rust-source-text-assertions: scan root missing/,
      `expected the gate to run and refuse an empty scan, got:\n${output}`
    );
    assert.equal(run.status, 1, 'a gate that scanned nothing must exit non-zero');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ────────────────────── DETECTOR DIRECTLY ───────────────────── */

test('analyze counts reads it does not flag, so the floor measures the detector', () => {
  const r = analyze('const RAW: &str = include_str!("fixtures/a.json");\n', TESTFILE);
  assert.equal(r.reads, 1);
  assert.deepEqual(r.hits, []);
});
