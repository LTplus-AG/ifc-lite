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
import { requiredFeatureCombos } from './revert-oracle-rust-features.mjs';
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
      const combos = requiredFeatureCombos(root, g.files);
      for (const features of combos.length > 0 ? combos : [[]]) {
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
