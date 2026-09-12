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
import { join, dirname, relative, basename, sep, resolve } from 'node:path';

import { cargoTestOwner } from './revert-oracle-cargo.mjs';
import { claimRuntimeAdapter } from './revert-oracle-adapters.mjs';
import {
  requiredFeatureCombos,
  stripComments,
  INNER_CFG_RE,
  TEST_CFG_RE,
  UnhandledCfgShapeError,
} from './revert-oracle-rust-features.mjs';
import { pythonTestOwner } from './revert-oracle-python.mjs';

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

/** Pick an exact-file/target runner for every executable changed test file. */
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

function rustModuleOwner(crateDir, abs) {
  const root = join(crateDir, 'src', 'lib.rs');
  if (!existsSync(root)) return null;
  const queue = [{ file: root, modules: [] }];
  const visited = new Set();
  while (queue.length > 0) {
    const { file: parent, modules } = queue.shift();
    const key = `${resolve(parent)}\0${modules.join('::')}`;
    if (visited.has(key) || !existsSync(parent)) continue;
    visited.add(key);
    const text = readFileSync(parent, 'utf8');
    const declarations = /(?:#\[path\s*=\s*"([^"]+)"\]\s*)?(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
    let match;
    while ((match = declarations.exec(text)) !== null) {
      const ordinaryBase = /(?:^|[\\/])(?:lib|mod)\.rs$/.test(parent)
        ? dirname(parent)
        : join(dirname(parent), basename(parent, '.rs'));
      const target = match[1]
        ? resolve(dirname(parent), match[1])
        : [resolve(ordinaryBase, `${match[2]}.rs`), resolve(ordinaryBase, match[2], 'mod.rs')].find(existsSync);
      if (!target) continue;
      const targetModules = [...modules, match[2]];
      if (resolve(target) === resolve(abs)) return targetModules.join('::');
      queue.push({ file: target, modules: targetModules });
    }
  }
  return null;
}

export function planRuns(testPaths, root) {
  const plans = [];
  const unassigned = [];
  const support = [];

  for (const rel of testPaths) {
    const abs = join(root, rel);
    const c = cargoTestOwner(abs, root);
    if (c) {
      const within = relative(c.dir, abs).split(sep).join('/');
      const targetMatch = /^tests\/([^/]+)\.rs$/.exec(within);
      const declaredModule = targetMatch ? null : rustModuleOwner(c.dir, abs);
      if (!targetMatch && !declaredModule) {
        if (/(^|\/)(?:fixtures?|test-data|testdata|corpus)(\/|$)/.test(within)) {
          support.push(rel);
          continue;
        }
        unassigned.push({ file: rel, reason: 'Rust unit/module/support files cannot be attributed to one executable cargo target' });
        continue;
      }
      const defaults = crateDefaultFeatures(c.dir);
      let combos;
      try {
        combos = requiredFeatureCombos(root, [rel], defaults);
      } catch (error) {
        if (!(error instanceof UnhandledCfgShapeError)) throw error;
        unassigned.push({ file: rel, reason: error.message });
        continue;
      }
      const runs = combos.length > 0
        ? (requiresDefaultRun(root, [rel]) ? [[], ...combos] : combos)
        : [[]];
      for (const features of runs) {
        const suffix = features.length > 0 ? `+${features.join('+')}` : '';
        const moduleFilter = declaredModule;
        const identity = targetMatch?.[1] ?? moduleFilter;
        const claimed = claimRuntimeAdapter({ kind: 'cargo', crate: c.crate, features, target: targetMatch?.[1] ?? null, moduleFilter });
        plans.push({
          key: `cargo:${c.crate}:${identity}${suffix}`,
          file: rel,
          dir: c.dir,
          files: [rel],
          relFiles: [within],
          script: undefined,
          crate: c.crate,
          features,
          moduleFilter,
          integrationTarget: targetMatch?.[1] ?? null,
          adapter: claimed?.adapter ?? null,
          runner: claimed?.runner ?? null,
        });
      }
      continue;
    }
    if (rel.endsWith('.rs')) { unassigned.push({ file: rel, reason: 'no owning Cargo package found' }); continue; }
    if (rel.endsWith('.go')) { unassigned.push({ file: rel, reason: 'Go test entrypoints have no revert-oracle adapter' }); continue; }
    if (rel.endsWith('.py')) {
      const p = pythonTestOwner(abs, root);
      if (!p) { unassigned.push({ file: rel, reason: 'no owning Python package found' }); continue; }
      if (!/(^test_.+|.+_test)\.py$/.test(basename(rel))) { support.push(rel); continue; }
      const relFile = relative(p.dir, abs);
      const claimed = claimRuntimeAdapter({ kind: 'python', relFile });
      plans.push({ key: `python:${rel}`, file: rel, dir: p.dir, files: [rel], relFiles: [relFile], script: undefined, crate: null, adapter: claimed?.adapter ?? null, runner: claimed?.runner ?? null });
      continue;
    }
    const pkgDir = findUp(dirname(abs), 'package.json', root);
    if (!/\.(test|spec)\.[^/]+$/.test(rel)) {
      support.push(rel);
      continue;
    }
    if (!pkgDir) { unassigned.push({ file: rel, reason: 'no owning JavaScript package found' }); continue; }
    let script;
    try {
      script = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).scripts?.test;
    } catch (error) {
      unassigned.push({ file: rel, reason: `could not read package.json: ${error.message}` });
      continue;
    }
    const relFile = relative(pkgDir, abs);
    const claimed = claimRuntimeAdapter({ kind: 'javascript', file: rel, relFile, script, rootPackage: pkgDir === root });
    plans.push({ key: `test:${rel}`, file: rel, dir: pkgDir, files: [rel], relFiles: [relFile], adapter: claimed?.adapter ?? null, runner: claimed?.runner ?? null, script, crate: null });
  }
  return { plans, unassigned, support };
}
