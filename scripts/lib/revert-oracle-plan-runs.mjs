/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-file -> owning-package -> runner grouping for the revert oracle
 * (scripts/check-test-revert-oracle.mjs).
 *
 * Moved out of the dispatcher (#4090): check-test-revert-oracle.mjs sits at
 * its exact module-size budget (see scripts/module-size-allowlist.txt) with
 * zero headroom, so a merge that pulls in both this branch's Rust
 * feature-combo detection and #4079's Python test routing pushes it over.
 * Splitting `planRuns()` (and its `findUp()` helper) out here, unchanged in
 * behavior, is the same move `revert-oracle-rust-features.mjs`'s own header
 * comment already documents for this file's zero-headroom constraint.
 *
 * `ROOT` is passed in explicitly rather than closed over, since this module
 * no longer lives inside the dispatcher that freezes it as a top-level const.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

import { cargoRunner, rootScriptsRunner, detectRunner } from './revert-oracle.mjs';
import { cargoTestOwner } from './revert-oracle-cargo.mjs';
import {
  requiredFeatureCombos,
  stripComments,
  INNER_CFG_RE,
  TEST_CFG_RE,
} from './revert-oracle-rust-features.mjs';
import { pythonTestOwner, pythonRunner } from './revert-oracle-python.mjs';

/** Walk up from `startDir` looking for `filename`, stopping at `root`. */
export function findUp(startDir, filename, root) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir || !parent.startsWith(root)) return null;
    dir = parent;
  }
}

/** Group test files by the package that owns them and pick each one's runner. */
/**
 * True when any of `relFiles` gates a `#[test]` behind a whole-expression
 * `not(...)` over non-default features.
 *
 * Such a test compiles ONLY in the default build, and `requiredFeatureCombos`
 * contributes no combo for it (correctly — it names no feature to turn ON).
 * But planRuns() falls back to the default run only when NO combo was found at
 * all, so a file carrying both a `not(...)` gate and, say, a bare
 * `#[cfg(feature = "x")]` gate would run x-only and never compile the
 * `not(...)` test in. Callers must run the default ALONGSIDE the combos when
 * this returns true. `parseCfgExpr` has already thrown for the unsound shapes
 * by the time this runs, so a surviving whole-`not(...)` is one the default
 * build provably compiles.
 */
export function requiresDefaultRun(root, relFiles) {
  for (const rel of relFiles) {
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const stripped = stripComments(text);
    for (const re of [INNER_CFG_RE, TEST_CFG_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(stripped)) !== null) {
        if (/^\s*not\s*\([\s\S]*\)\s*$/.test(m[1])) return true;
      }
    }
  }
  return false;
}

/**
 * The crate's default-on feature names, from its Cargo.toml `[features]`
 * `default = [...]` list. Returns an empty Set when the manifest is absent or
 * declares no defaults - which is the common case and the one that makes a
 * `not(feature = "x")` gate resolvable to the default build.
 */
function crateDefaultFeatures(dir) {
  try {
    const toml = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
    const features = toml.split(/^\s*\[features\]\s*$/m)[1];
    if (!features) return new Set();
    const decl = features.split(/^\s*\[/m)[0].match(/^\s*default\s*=\s*\[([\s\S]*?)\]/m);
    if (!decl) return new Set();
    return new Set([...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  } catch {
    return new Set();
  }
}

export function planRuns(testPaths, root) {
  /** @type {Map<string, {dir: string, files: string[], script: string|undefined, crate: string|null}>} */
  const groups = new Map();
  const unassigned = [];

  for (const rel of testPaths) {
    const abs = join(root, rel);
    const c = cargoTestOwner(abs, root);
    if (c) {
      const key = `cargo:${c.crate}`;
      if (!groups.has(key)) groups.set(key, { dir: c.dir, files: [], script: undefined, crate: c.crate });
      groups.get(key).files.push(rel);
      continue;
    }
    if (rel.endsWith('.rs')) { unassigned.push(rel); continue; }
    if (rel.endsWith('.py')) {
      const p = pythonTestOwner(abs, root);
      if (!p) { unassigned.push(rel); continue; }
      const key = `python:${p.dir}`;
      if (!groups.has(key)) groups.set(key, { dir: p.dir, files: [], script: undefined, crate: null, python: true });
      groups.get(key).files.push(rel); continue;
    }
    const pkgDir = findUp(dirname(abs), 'package.json', root);
    if (!pkgDir) { unassigned.push(rel); continue; }
    if (!groups.has(pkgDir)) {
      let script;
      try {
        script = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).scripts?.test;
      } catch {
        script = undefined;
      }
      groups.set(pkgDir, { dir: pkgDir, files: [], script, crate: null });
    }
    groups.get(pkgDir).files.push(rel);
  }

  const plans = [];
  for (const [key, g] of groups) {
    const relFiles = g.files.map((f) => relative(g.dir, join(root, f)) || f);
    // #4050/#4024: a default build compiles a `#[cfg(feature = "x")]` test OUT
    // entirely, so run one cargo invocation per feature-combo the changed
    // files require; none found -> the old, single default-features run.
    if (g.crate) {
      // Crate default features: treating a `not(feature = "x")` gate as
      // "the default build compiles it" is only sound when x is NOT default-on.
      const defaults = crateDefaultFeatures(g.dir);
      const combos = requiredFeatureCombos(root, g.files, defaults);
      // A not()-gated test compiles only in the default build and contributes
      // no combo, so the default run must happen ALONGSIDE any combos found.
      const runs = combos.length > 0
        ? (requiresDefaultRun(root, g.files) ? [[], ...combos] : combos)
        : [[]];
      for (const features of runs) {
        const label = features.length > 0 ? `${key}+${features.join('+')}` : key;
        plans.push({ key: label, dir: g.dir, files: g.files, relFiles, script: g.script, crate: g.crate, runner: cargoRunner(g.crate, features) });
      }
      continue;
    }
    const runner = g.python
      ? pythonRunner(relFiles)
      : (g.dir === root ? rootScriptsRunner(g.files) : null) ?? detectRunner(g.script, relFiles);
    plans.push({ key, dir: g.dir, files: g.files, relFiles, runner, script: g.script, crate: null });
  }
  return { plans, unassigned };
}
