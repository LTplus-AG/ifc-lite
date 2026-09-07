/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rust feature-gate detection for the revert oracle (scripts/check-test-revert-oracle.mjs).
 *
 * WHY. `cargoRunner()` in revert-oracle.mjs always ran a crate's default
 * feature set. #4024's regression test
 * (rust/geometry/src/processors/boolean/chain_cycle_tests.rs) lives entirely
 * behind `#[cfg(any(feature = "csg_manifold_gate", feature =
 * "csg_topology_gate"))]`, so a default `cargo test -p ifc-lite-geometry`
 * compiles it OUT: the pre-revert and reverted runs collect the identical
 * 1273 tests and the oracle reports UNOBSERVED for a change it never even
 * compiled. This module reads the cfg-gates a changed/added test file
 * actually carries and turns them into the `--features` combination(s)
 * needed to compile it in, so `planRuns()` can spawn one cargo invocation per
 * required combination instead of a single default-only one per crate.
 *
 * ON "MUST NOT BE ENABLED TOGETHER": the scoping note that carried this half
 * of #4050 forward assumed `csg_manifold_gate` and `csg_topology_gate` are
 * mutually exclusive per a Cargo.toml comment. Checked directly
 * (rust/geometry/Cargo.toml, the comment above `csg_manifold_gate`): it says
 * a CENSUS RUN needs to attribute a rejection to one gate, not that Cargo (or
 * this repo's CI) refuses the pair. `.github/workflows/test.yml` runs
 * `cargo test -p ifc-lite-geometry --features
 * csg_manifold_gate,csg_topology_gate` as its own job, and
 * `rust/geometry/tests/issue_098_v5c.rs` has live
 * `#[cfg(all(feature = "csg_manifold_gate", feature = "csg_topology_gate"))]`
 * cases. So this module does not special-case exclusivity: it reads whatever
 * combination(s) the cfg attributes actually require, including the "both
 * together" case an `all(...)` produces, and runs each combination it finds.
 *
 * SCOPE — CORRECTED. An earlier revision of this comment claimed only three
 * cfg shapes (`bare`, `any(...)`, `all(...)`) appear anywhere in this repo's
 * Rust test tree and that "nested `any(all(...))` does not occur." That is
 * false: `not(...)` nesting is live above real `#[test]` functions today —
 * `rust/geometry/tests/triangulation_invariance.rs:2168,2188` guards two
 * tests with `#[cfg(not(any(feature = "csg_topology_gate", feature =
 * "csg_manifold_gate")))]`, and `rust/geometry/src/csg/csg_tests.rs` and
 * `rust/geometry/tests/issue_582_583_regression_test.rs` each gate a test
 * with a bare `#[cfg(not(feature = "..."))]`. `rust/geometry/tests/
 * issue_098_v5c.rs:119-136` additionally shows the full cross-product —
 * `not(any(A,B))`, `all(not(A),B)`, `all(A,not(B))`, `all(A,B)` — on `const`
 * declarations (not, currently, directly above a `#[test]`, but the same
 * idiom).
 *
 * `not(...)` is deliberately NOT parsed into a feature combo here: a
 * `not(feature = "x")` gate names a run that must have `x` OFF, which is a
 * fundamentally different kind of requirement from every existing combo
 * (which names features to turn ON) and genuinely handling it means ensuring
 * the default no-features plan always runs ALONGSIDE any explicit combos
 * (`planRuns()` in check-test-revert-oracle.mjs currently only falls back to
 * the default plan when NO combo was found at all) — a change to that
 * caller's contract, not a parser extension. Rather than silently returning
 * `[]` for a shape it cannot correctly turn into a combo (the previous,
 * defective behavior — see `UnhandledCfgShapeError` below), this module now
 * detects `not(...)`, cfg nesting beyond one level (e.g. a hypothetical
 * `any(all(...))`), `cfg_attr(feature = "x", test)`, and an attribute sitting
 * between `#[cfg(...)]` and `#[test]`, and FAILS LOUDLY, naming the file, the
 * line, and the unhandled shape, rather than silently planning a run that
 * never compiles the gated test in. `parseCfgExpr` still reads only the
 * three shapes it always has (bare, `any(...)`, `all(...)`, none containing
 * `not(`); anything else is a `detectRequiredFeatureCombos` bug loudly
 * surfaced, never a quiet gap.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A cfg shape this module cannot turn into a feature combo — see SCOPE above. */
export class UnhandledCfgShapeError extends Error {
  constructor(shape, expr, { file = '<unknown file>', line = null } = {}) {
    const where = line != null ? `${file}:${line}` : file;
    super(`revert-oracle: unhandled cfg shape "${shape}" at ${where} (${expr}) — refusing to silently plan a run that may never compile this test in; extend detectRequiredFeatureCombos or fix the gate`);
    this.name = 'UnhandledCfgShapeError';
    this.shape = shape;
    this.file = file;
    this.line = line;
  }
}

// One extra level of paren nesting beyond a bare `#\[cfg\( ... \)\]` capture,
// so a shape like `not(any(a, b))` or `all(not(a), b)` is captured as text
// (for `checkHandledShape` to reject with a clear message) instead of simply
// failing to match at all, which is how the previous single-level pattern
// silently dropped these gates.
const NEST2 = '(?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*';
/** Whole-file gate: `#![cfg(feature = "x")]` at the top of a test file. */
const INNER_CFG_RE = new RegExp(`#!\\[cfg\\((${NEST2})\\)\\]`, 'g');
/** Item-level gate: the `#[cfg(...)]` immediately guarding a `#[test]` fn. */
const TEST_CFG_RE = new RegExp(`#\\[cfg\\((${NEST2})\\)\\]\\s*\\n\\s*#\\[test\\]`, 'g');
/** `#[cfg_attr(feature = "x", test)]` — a shape neither regex above matches at all. */
const CFG_ATTR_TEST_RE = /#\[cfg_attr\(([\s\S]*?),\s*test\s*\)\]/g;
/** A `#[cfg(...)]` separated from `#[test]` by one or more other attributes. */
const CFG_THEN_OTHER_ATTR_RE = new RegExp(
  `#\\[cfg\\((${NEST2})\\)\\]\\s*\\n(?:[ \\t]*#\\[(?!test\\])[^\\n]*\\]\\s*\\n)+\\s*#\\[test\\]`,
  'g',
);

/** Strip `//` and `/* *\/` comments, replacing their text with spaces so line/column numbers are unaffected. */
export function stripComments(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * @param {string} expr the text inside a `cfg(...)`
 * @returns {string[][]} feature-name combinations that must be enabled
 *   TOGETHER for the expression to hold. `all(a, b)` -> `[[a, b]]`;
 *   `any(a, b)` and a bare `feature = "a"` both -> `[[a], [b]]` / `[[a]]`,
 *   since any one name alone is enough.
 * @throws {UnhandledCfgShapeError} if `expr` contains a `not(...)` or nests
 *   `any(`/`all(` beyond one level — shapes this parser does not evaluate.
 */
export function parseCfgExpr(expr, context = {}) {
  if (/\bnot\s*\(/.test(expr)) throw new UnhandledCfgShapeError('not(...)', expr, context);
  const outer = expr.match(/^\s*(any|all)\s*\((.*)\)\s*$/s);
  if (outer && /\b(any|all)\s*\(/.test(outer[2])) {
    throw new UnhandledCfgShapeError('nested any()/all() beyond one level', expr, context);
  }
  const names = [...expr.matchAll(/feature\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (outer && outer[1] === 'all') return names.length > 0 ? [names] : [];
  return names.map((n) => [n]);
}

function dedupeCombos(combos) {
  const seen = new Set();
  const out = [];
  for (const combo of combos) {
    if (combo.length === 0) continue;
    const sorted = [...combo].sort();
    const key = sorted.join(',');
    if (!seen.has(key)) { seen.add(key); out.push(sorted); }
  }
  return out;
}

/**
 * Every feature-combo this file's cfg attributes require, deduped.
 * @throws {UnhandledCfgShapeError} on `not(...)`, deeper nesting,
 *   `cfg_attr(feature = "x", test)`, or an attribute between `#[cfg(...)]`
 *   and `#[test]` — see SCOPE above for why these fail loudly instead of
 *   silently contributing no combo.
 */
export function detectRequiredFeatureCombos(text, file = '<unknown file>') {
  const stripped = stripComments(text);

  CFG_ATTR_TEST_RE.lastIndex = 0;
  let m = CFG_ATTR_TEST_RE.exec(stripped);
  if (m) throw new UnhandledCfgShapeError('cfg_attr(..., test)', m[0], { file, line: lineOf(stripped, m.index) });

  CFG_THEN_OTHER_ATTR_RE.lastIndex = 0;
  m = CFG_THEN_OTHER_ATTR_RE.exec(stripped);
  if (m) throw new UnhandledCfgShapeError('an attribute between #[cfg(...)] and #[test]', m[0], { file, line: lineOf(stripped, m.index) });

  const combos = [];
  for (const re of [INNER_CFG_RE, TEST_CFG_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(stripped)) !== null) {
      combos.push(...parseCfgExpr(m[1], { file, line: lineOf(stripped, m.index) }));
    }
  }
  return dedupeCombos(combos);
}

/** Union of feature-combos required across a set of repo-relative files. */
export function requiredFeatureCombos(root, relFiles) {
  const combos = [];
  for (const rel of relFiles) {
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    combos.push(...detectRequiredFeatureCombos(text, rel));
  }
  return dedupeCombos(combos);
}
