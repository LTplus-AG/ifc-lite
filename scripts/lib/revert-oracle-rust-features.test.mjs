/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCfgExpr, detectRequiredFeatureCombos, requiredFeatureCombos } from './revert-oracle-rust-features.mjs';

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
