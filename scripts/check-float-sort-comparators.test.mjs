/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the float sort comparator gate (#7674). Everything runs against
 * synthetic Rust, in memory or in an `mkdtemp` tree, never against the repo,
 * so a change to rust/ cannot make these vacuously green.
 *
 * Run: `node --test scripts/check-float-sort-comparators.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { isTestPath, parseAllowlist, runCheck, scanSource, stripComments } from './check-float-sort-comparators.mjs';

const PROD = 'rust/geometry/src/x.rs';
const hits = (src, path = PROD) => scanSource(path, src).hits.map((h) => h.pattern);

/** Verbatim spellings of sites #7674 fixed, as they stood at its parent commit. */
const REAL_SITES = [
  // rust/clash/src/bvh.rs (EDGE-CLASH-1), inside a sort_by closure.
  'indices.sort_by(|&a, &b| {\n    let ca = 0.0;\n    ca.partial_cmp(&cb).unwrap_or(std::cmp::Ordering::Equal)\n});',
  // rust/geometry/src/space_dcel/geom2d.rs (GEOM-12), `core::` path.
  'ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));',
  // rust/geometry/src/processors/sectioned.rs (PROC-AL-17), split over lines.
  'v.sort_by(|a, b| {\n    a.1.distance_along\n        .partial_cmp(&b.1.distance_along)\n        .unwrap_or(std::cmp::Ordering::Equal)\n});',
  // rust/geometry/src/kernel/retriangulate.rs, imported `Ordering`, chained.
  'axes.sort_by(|&a, &b| {\n    mag[ib]\n        .partial_cmp(&mag[ia])\n        .unwrap_or(Ordering::Equal)\n        .then(ia.cmp(&ib))\n});',
  // rust/export/src/rooms.rs, nested call in the argument.
  'order.sort_by(|&a, &b| area_of(b).partial_cmp(&area_of(a)).unwrap_or(std::cmp::Ordering::Equal));',
];

test('flags every real #7674 spelling', () => {
  for (const src of REAL_SITES) assert.deepEqual(hits(src), ['equal-fallback'], src);
});

test('flags ROUTER-30 partial_cmp().unwrap() and .expect() in production code', () => {
  const src = '(0..3).min_by(|&a, &b| half[a].partial_cmp(&half[b]).unwrap()).unwrap()';
  assert.deepEqual(hits(src), ['unwrap']);
  assert.deepEqual(hits('xs.sort_by(|a, b| a.partial_cmp(b).expect("finite"));'), ['unwrap']);
});

test('test files may unwrap, but not use the Equal fallback', () => {
  const unwrap = 'v.sort_by(|a, b| a.partial_cmp(b).unwrap());';
  const equal = 'v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Equal));';
  for (const path of ['rust/geometry/tests/a.rs', 'rust/geometry/src/a_tests.rs', 'rust/clash/src/tests.rs', 'rust/x/benches/b.rs']) {
    assert.ok(isTestPath(path), path);
    assert.deepEqual(hits(unwrap, path), [], path);
    assert.deepEqual(hits(equal, path), ['equal-fallback'], path);
  }
  assert.ok(!isTestPath('rust/geometry/src/contests.rs'));
});

test('flags Less and Greater fallbacks too', () => {
  assert.deepEqual(hits('a.partial_cmp(&b).unwrap_or(Ordering::Less)'), ['equal-fallback']);
  assert.deepEqual(hits('a.partial_cmp(&b).unwrap_or(cmp::Ordering::Greater)'), ['equal-fallback']);
});

test('does not flag the replacements', () => {
  for (const src of [
    'xs.sort_by(|a, b| cmp_f64_nan_last(*a, *b));',
    'xs.sort_by(f64::total_cmp);',
    'xs.sort_by(|a, b| a.total_cmp(b));',
    'match a.partial_cmp(&b) { Some(o) => o, None => a.is_nan().cmp(&b.is_nan()) }',
    'a.partial_cmp(&b).unwrap_or_else(|| a.is_nan().cmp(&b.is_nan()))',
    'x.unwrap_or(Ordering::Equal)',
  ]) {
    assert.deepEqual(hits(src), [], src);
  }
});

test('ignores the pattern in comments and string literals', () => {
  const src = [
    '//! `a.partial_cmp(b).unwrap_or(Ordering::Equal)` is not a total order.',
    '// x.partial_cmp(&y).unwrap()',
    '/* a.partial_cmp(&b).unwrap_or(Equal) /* nested */ still a comment */',
    'let s = "a.partial_cmp(&b).unwrap_or(Equal) // not a comment";',
    'let r = r#"a.partial_cmp(&b).unwrap() "quoted" "#;',
  ].join('\n');
  assert.deepEqual(hits(src), []);
});

test('char literals and lifetimes do not derail the comment stripper', () => {
  const src = [
    "fn f<'a>(s: &'a str) -> char { if s.contains('\"') { '\\'' } else { '/' } }",
    'xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Equal));',
  ].join('\n');
  const found = scanSource(PROD, src).hits;
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test('stripComments keeps line numbers', () => {
  const out = stripComments('a\n/* x\n y */\nb // c\n');
  assert.equal(out.split('\n').length, 5);
  assert.ok(!out.includes('x') && !out.includes('c'));
});

test('parseAllowlist demands a reason and rejects duplicates', () => {
  assert.deepEqual([...parseAllowlist('# header\n2 rust/a.rs  # why\n')], [['rust/a.rs', 2]]);
  assert.throws(() => parseAllowlist('1 rust/a.rs\n'), /reason/);
  assert.throws(() => parseAllowlist('1 rust/a.rs # a\n1 rust/a.rs # b\n'), /duplicate/);
});

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'float-sort-gate-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const LOOSE = { fileFloor: 0, partialCmpFloor: 0 };

test('runCheck: a hit fails, an exact allowlist row passes, a fixed hit goes stale', () => {
  const dir = tree({
    'rust/a/src/lib.rs': 'fn f(v: &mut [f64]) { v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Equal)); }',
    'apps/server/src/main.rs': 'fn main() {}',
  });
  try {
    assert.equal(runCheck(dir, LOOSE).violations.length, 1);
    const ok = runCheck(dir, { ...LOOSE, allowlist: new Map([['rust/a/src/lib.rs', 1]]) });
    assert.equal(ok.violations.length + ok.stale.length + ok.errors.length, 0);
    const stale = runCheck(dir, { ...LOOSE, allowlist: new Map([['rust/a/src/lib.rs', 2]]) });
    assert.deepEqual(stale.stale, [{ path: 'rust/a/src/lib.rs', count: 2, found: 1 }]);
    const gone = runCheck(dir, { ...LOOSE, allowlist: new Map([['rust/b.rs', 1]]) });
    assert.equal(gone.stale.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck fails loudly instead of passing vacuously', () => {
  const dir = tree({ 'rust/a/src/lib.rs': 'fn f() {}' });
  try {
    const missing = runCheck(dir, LOOSE);
    assert.ok(missing.errors.some((e) => /scan root missing: apps\/server/.test(e)));
    const small = runCheck(dir, { roots: ['rust'], fileFloor: 5, partialCmpFloor: 0 });
    assert.ok(small.errors.some((e) => /suspiciously small/.test(e)));
    const blind = runCheck(dir, { roots: ['rust'], fileFloor: 0, partialCmpFloor: 1 });
    assert.ok(blind.errors.some((e) => /partial_cmp calls/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck skips build output', () => {
  const dir = tree({
    'rust/target/debug/build/x.rs': 'a.partial_cmp(&b).unwrap_or(Equal)',
    'rust/a/src/lib.rs': 'fn f() {}',
  });
  try {
    assert.equal(runCheck(dir, { roots: ['rust'], ...LOOSE }).violations.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
