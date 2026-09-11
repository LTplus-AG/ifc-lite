/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseCfgExpr,
  detectRequiredFeatureCombos,
  requiredFeatureCombos,
  UnhandledCfgShapeError,
  stripComments,
} from './revert-oracle-rust-features.mjs';
import { requiresDefaultRun } from './revert-oracle-plan-runs.mjs';

test('parseCfgExpr: any(...) -> one combo per name, each alone suffices', () => {
  assert.deepEqual(
    parseCfgExpr('any(feature = "csg_manifold_gate", feature = "csg_topology_gate")'),
    [['csg_manifold_gate'], ['csg_topology_gate']],
  );
});

test('parseCfgExpr: all(...) -> a single combo requiring every name together', () => {
  assert.deepEqual(
    parseCfgExpr('all(feature = "csg_manifold_gate", feature = "csg_topology_gate")'),
    [['csg_manifold_gate', 'csg_topology_gate']],
  );
});

test('parseCfgExpr: a bare feature = "x" -> one single-name combo', () => {
  assert.deepEqual(parseCfgExpr('feature = "observability"'), [['observability']]);
});

test('parseCfgExpr: no feature literal at all -> no combo (e.g. cfg(test), cfg(unix))', () => {
  assert.deepEqual(parseCfgExpr('test'), []);
  assert.deepEqual(parseCfgExpr('unix'), []);
});

test('#4024 shape: an item-level any() gate right above #[test] is detected', () => {
  const text = [
    'mod stuff {',
    '#[cfg(any(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]',
    '#[test]',
    'fn solo_step_accounts_for_a_batched_suffix_not_just_spine_length() { assert!(true); }',
    '}',
  ].join('\n');
  assert.deepEqual(detectRequiredFeatureCombos(text), [['csg_manifold_gate'], ['csg_topology_gate']]);
});

test('whole-file #![cfg(feature = "x")] is detected same as an item-level gate', () => {
  const text = '#![cfg(feature = "triangulation-alt")]\n#[test]\nfn f() {}\n';
  assert.deepEqual(detectRequiredFeatureCombos(text), [['triangulation-alt']]);
});

test('an all(...) item alongside an any(...) item both contribute, deduped and sorted', () => {
  const text = [
    '#[cfg(all(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]',
    '#[test]',
    'fn both() {}',
    '#[cfg(any(feature = "csg_topology_gate", feature = "csg_manifold_gate"))]',
    '#[test]',
    'fn either() {}',
  ].join('\n');
  assert.deepEqual(detectRequiredFeatureCombos(text), [
    ['csg_manifold_gate', 'csg_topology_gate'],
    ['csg_topology_gate'],
    ['csg_manifold_gate'],
  ]);
});

test('an ungated file (the overwhelming default case) contributes no combo at all', () => {
  const text = '#[test]\nfn ordinary() { assert_eq!(1 + 1, 2); }\n';
  assert.deepEqual(detectRequiredFeatureCombos(text), []);
});

test('#[cfg(test)] mod boundaries and unrelated cfg(unix)/cfg(target_os) attributes are ignored', () => {
  const text = [
    '#[cfg(test)]',
    'mod tests {',
    '  #[cfg(unix)]',
    '  #[test]',
    '  fn only_on_unix() {}',
    '}',
  ].join('\n');
  assert.deepEqual(detectRequiredFeatureCombos(text), []);
});

test('requiredFeatureCombos: unions distinct feature files, dedupes a repeated one, skips a missing file', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-rust-features-'));
  try {
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests/a.rs'), '#[cfg(feature = "gate_a")]\n#[test]\nfn a() {}\n');
    writeFileSync(join(root, 'tests/b.rs'), '#[cfg(feature = "gate_b")]\n#[test]\nfn b() {}\n');
    writeFileSync(join(root, 'tests/c.rs'), '#[cfg(feature = "gate_a")]\n#[test]\nfn c() {}\n');
    const combos = requiredFeatureCombos(root, ['tests/a.rs', 'tests/b.rs', 'tests/c.rs', 'tests/missing.rs']);
    assert.deepEqual(combos, [['gate_a'], ['gate_b']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requiredFeatureCombos: an all() file and an any() file both requiring the same names still dedupe', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-rust-features-'));
  try {
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests/both.rs'), '#[cfg(all(feature = "x", feature = "y"))]\n#[test]\nfn both() {}\n');
    writeFileSync(join(root, 'tests/again.rs'), '#[cfg(all(feature = "y", feature = "x"))]\n#[test]\nfn again() {}\n');
    assert.deepEqual(requiredFeatureCombos(root, ['tests/both.rs', 'tests/again.rs']), [['x', 'y']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Regression coverage for the adversarial review of #4085 -------------
// (hunt-revert-oracle-rust-features): three defects, none of which the
// branch's own suite exercised before this file.

test('#4085 defect 1: not(any(...)) directly above #[test] fails loudly, never silently drops the gate', () => {
  // The exact live shape at rust/geometry/tests/triangulation_invariance.rs:2168.
  const text = [
    '#[cfg(not(any(feature = "csg_topology_gate", feature = "csg_manifold_gate")))]',
    '#[test]',
    'fn census_rebases_real_covering_before_f32_geometry_3925() {}',
  ].join('\n');
  // Called without a crate default-feature set: the shape stays unresolvable,
  // so it still fails loudly rather than silently dropping the gate. With a
  // known default set that excludes both names it resolves to the default run
  // instead — see the parseCfgExpr not(...) tests below.
  assert.throws(() => detectRequiredFeatureCombos(text, 'triangulation_invariance.rs'), (err) => {
    assert.ok(err instanceof UnhandledCfgShapeError);
    assert.equal(err.shape, 'not(...) with unknown crate defaults');
    assert.equal(err.line, 1);
    assert.match(err.message, /triangulation_invariance\.rs:1/);
    return true;
  });
});

test('#4085 defect 1: a bare not(feature = "x") above #[test] also fails loudly (rust/geometry/tests/issue_582_583_regression_test.rs shape)', () => {
  const text = '#[cfg(not(feature = "csg_manifold_gate"))]\n#[test]\nfn f() {}\n';
  assert.throws(() => detectRequiredFeatureCombos(text, 'issue_582_583.rs'), UnhandledCfgShapeError);
});

test('#4085 defect 1: the real issue_098_v5c.rs all(not(A), B) idiom fails loudly, naming the file and line', () => {
  const text = [
    'const X: i32 = 1;',
    '#[cfg(all(not(feature = "csg_manifold_gate"), feature = "csg_topology_gate"))]',
    '#[test]',
    'fn v5c_style() {}',
  ].join('\n');
  assert.throws(() => detectRequiredFeatureCombos(text, 'issue_098_v5c.rs'), (err) => {
    assert.ok(err instanceof UnhandledCfgShapeError);
    assert.equal(err.shape, 'not(...)');
    assert.equal(err.line, 2);
    assert.match(err.message, /issue_098_v5c\.rs:2/);
    return true;
  });
});

test('#4085 defect 2: any(all(...)) nested two levels deep above #[test] fails loudly rather than silently matching zero combos', () => {
  const text = '#[cfg(any(all(feature = "a", feature = "b"), feature = "c"))]\n#[test]\nfn f() {}\n';
  assert.throws(() => detectRequiredFeatureCombos(text, 'nested.rs'), (err) => {
    assert.ok(err instanceof UnhandledCfgShapeError);
    assert.equal(err.shape, 'nested any()/all() beyond one level');
    return true;
  });
});

test('#4085 defect 2: cfg_attr(feature = "x", test) fails loudly instead of being silently invisible', () => {
  const text = '#[cfg_attr(feature = "csg_manifold_gate", test)]\nfn f() {}\n';
  assert.throws(() => detectRequiredFeatureCombos(text, 'cfg_attr.rs'), (err) => {
    assert.ok(err instanceof UnhandledCfgShapeError);
    assert.equal(err.shape, 'cfg_attr(..., test)');
    return true;
  });
});

test('#4085 defect 2: an attribute sitting between #[cfg(...)] and #[test] fails loudly instead of the gate going invisible', () => {
  const text = [
    '#[cfg(feature = "csg_manifold_gate")]',
    '#[should_panic]',
    '#[test]',
    'fn f() {}',
  ].join('\n');
  assert.throws(() => detectRequiredFeatureCombos(text, 'extra_attr.rs'), (err) => {
    assert.ok(err instanceof UnhandledCfgShapeError);
    assert.equal(err.shape, 'an attribute between #[cfg(...)] and #[test]');
    return true;
  });
});

test('#4085 defect 3: a line-commented-out cfg above #[test] is not read as a real gate', () => {
  const text = [
    '// #[cfg(feature = "ghost")]',
    '#[test]',
    'fn f() { assert!(true); }',
  ].join('\n');
  assert.deepEqual(detectRequiredFeatureCombos(text, 'commented.rs'), []);
});

test('#4085 defect 3: a block-commented-out cfg above #[test] is not read as a real gate', () => {
  const text = [
    '/* #[cfg(feature = "ghost")]',
    '   still commented */',
    '#[test]',
    'fn f() { assert!(true); }',
  ].join('\n');
  assert.deepEqual(detectRequiredFeatureCombos(text, 'block-commented.rs'), []);
});

test('#4085 defect 3: a commented-out gate does not mask a REAL gate on the very next test', () => {
  const text = [
    '// #[cfg(feature = "ghost")]',
    '#[test]',
    'fn ordinary() {}',
    '#[cfg(feature = "real_gate")]',
    '#[test]',
    'fn gated() {}',
  ].join('\n');
  assert.deepEqual(detectRequiredFeatureCombos(text, 'mixed.rs'), [['real_gate']]);
});

test('stripComments does not treat "//" inside a string literal as a comment start', () => {
  // Reproduces the reported shape: a `//` inside an ordinary double-quoted
  // string on the same line as a real #[cfg(...)], immediately above #[test].
  const text = ['let s = "//"; #[cfg(feature = "real_gate")]', '#[test]', 'fn t() {}', ''].join('\n');
  assert.equal(stripComments(text), text); // nothing here is an actual comment
  assert.deepEqual(detectRequiredFeatureCombos(text, 'string_slash.rs'), [['real_gate']]);
});

test('stripComments still blanks a real "//" comment sitting right after a string literal', () => {
  const text = 'let s = "a"; // #[cfg(feature = "ghost")]\n#[test]\nfn f() { assert!(true); }\n';
  const stripped = stripComments(text);
  assert.equal(stripped.startsWith('let s = "a"; '), true);
  assert.equal(stripped.includes('ghost'), false);
  assert.deepEqual(detectRequiredFeatureCombos(text, 'string_then_comment.rs'), []);
});

test('stripComments leaves an escaped quote inside a string alone (does not end the string early)', () => {
  const text = 'let s = "a \\" // not a comment"; #[cfg(feature = "real_gate")]\n#[test]\nfn t() {}\n';
  assert.deepEqual(detectRequiredFeatureCombos(text, 'escaped_quote.rs'), [['real_gate']]);
});

test('stripComments treats a "//" inside a raw string (r"...") as non-comment text', () => {
  const text = 'let s = r"//"; #[cfg(feature = "real_gate")]\n#[test]\nfn t() {}\n';
  assert.deepEqual(detectRequiredFeatureCombos(text, 'raw_string.rs'), [['real_gate']]);
});

test('stripComments treats a "//" inside a hashed raw string (r#"..."#, containing a bare quote) as non-comment text', () => {
  const text = 'let s = r#"he said "hi" // not a comment"#; #[cfg(feature = "real_gate")]\n#[test]\nfn t() {}\n';
  assert.deepEqual(detectRequiredFeatureCombos(text, 'raw_hash_string.rs'), [['real_gate']]);
});

test('stripComments treats a "/" char literal as non-comment text, not confused with a lifetime', () => {
  const text = "let c = '/'; let x: &'a str; #[cfg(feature = \"real_gate\")]\n#[test]\nfn t() {}\n";
  assert.deepEqual(detectRequiredFeatureCombos(text, 'char_literal.rs'), [['real_gate']]);
});

test('stripComments preserves line numbers exactly when a real comment follows a string on the same line', () => {
  const text = ['fn a() {}', 'let s = "x"; // #[cfg(feature = "ghost")]', '#[cfg(feature = "real_gate")]', '#[test]', 'fn t() {}', ''].join('\n');
  const combos = detectRequiredFeatureCombos(text, 'line_numbers.rs');
  assert.deepEqual(combos, [['real_gate']]);
});

test('parseCfgExpr: a whole-expression not(...) over NON-default features needs no combo', () => {
  // The gate holds exactly when those features are off — the default build —
  // so it names no feature to turn ON. planRuns() runs the default alongside.
  assert.deepEqual(
    parseCfgExpr('not(any(feature = "csg_topology_gate", feature = "csg_manifold_gate"))', {}, new Set()),
    [],
  );
  assert.deepEqual(parseCfgExpr('not(feature = "gate_a")', {}, new Set(['other'])), []);
});

test('parseCfgExpr: not(...) over a DEFAULT-on feature still fails loudly', () => {
  // The default build turns the feature ON, so the gated test never compiles
  // there — resolving it to the default run would be the silent miss.
  assert.throws(
    () => parseCfgExpr('not(feature = "gate_a")', {}, new Set(['gate_a'])),
    UnhandledCfgShapeError,
  );
});

test('parseCfgExpr: not(...) with unknown crate defaults still fails loudly', () => {
  assert.throws(() => parseCfgExpr('not(feature = "gate_a")', {}, null), UnhandledCfgShapeError);
});

test('parseCfgExpr: a not(...) nested inside any()/all() is still unhandled', () => {
  assert.throws(
    () => parseCfgExpr('any(not(feature = "a"), feature = "b")', {}, new Set()),
    UnhandledCfgShapeError,
  );
});

test('requiresDefaultRun: true only when a not()-gated #[test] is present', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-needs-default-'));
  try {
    mkdirSync(join(root, 'tests'));
    const alt = ['#[cfg(feature = "alt")]', '#[test]', 'fn a() {}', ''].join('\n');
    const notGated = [
      '#[cfg(not(any(feature = "g1", feature = "g2")))]',
      '#[test]',
      'fn b() {}',
      '',
    ].join('\n');
    writeFileSync(join(root, 'tests/mixed.rs'), alt + notGated);
    writeFileSync(join(root, 'tests/plain.rs'), alt);
    assert.equal(requiresDefaultRun(root, ['tests/mixed.rs']), true);
    assert.equal(requiresDefaultRun(root, ['tests/plain.rs']), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
