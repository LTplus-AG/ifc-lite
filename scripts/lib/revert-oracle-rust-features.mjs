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
 * SCOPE. Only three cfg shapes appear anywhere in this repo's Rust test tree
 * today: a bare `feature = "a"`, `any(feature = "a", feature = "b", ...)`
 * (each name alone suffices to compile the item in), and `all(feature = "a",
 * feature = "b", ...)` (every name must be on at once). Nested
 * `any(all(...))` does not occur. This is a detector for the shapes that
 * exist, not a general cfg-expression evaluator; `parseCfgExpr` reads only
 * those three shapes and is silent (contributes no combo) on anything else,
 * which is the safe direction — a combo this module fails to see runs the
 * test under fewer feature sets, which the oracle reports honestly as
 * whatever it collects, never as a false OBSERVED.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Whole-file gate: `#![cfg(feature = "x")]` at the top of a test file. */
const INNER_CFG_RE = /#!\[cfg\(((?:[^()]|\([^()]*\))*)\)\]/g;
/** Item-level gate: the `#[cfg(...)]` immediately guarding a `#[test]` fn. */
const TEST_CFG_RE = /#\[cfg\(((?:[^()]|\([^()]*\))*)\)\]\s*\n\s*#\[test\]/g;

/**
 * @param {string} expr the text inside a `cfg(...)`
 * @returns {string[][]} feature-name combinations that must be enabled
 *   TOGETHER for the expression to hold. `all(a, b)` -> `[[a, b]]`;
 *   `any(a, b)` and a bare `feature = "a"` both -> `[[a], [b]]` / `[[a]]`,
 *   since any one name alone is enough.
 */
export function parseCfgExpr(expr) {
  const names = [...expr.matchAll(/feature\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (/^\s*all\s*\(/.test(expr)) return names.length > 0 ? [names] : [];
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

/** Every feature-combo this file's cfg attributes require, deduped. */
export function detectRequiredFeatureCombos(text) {
  const combos = [];
  for (const re of [INNER_CFG_RE, TEST_CFG_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) combos.push(...parseCfgExpr(m[1]));
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
    combos.push(...detectRequiredFeatureCombos(text));
  }
  return dedupeCombos(combos);
}
