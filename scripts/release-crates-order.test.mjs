#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `CRATES` list in `release-crates.mjs` must be a valid publish order.
 *
 * Why this test exists rather than a comment: the Release workflow **only runs
 * on main**, and only on an actual publish. So a dependency edge added in any
 * PR sat latent until the next release, where it failed after npm had already
 * published — leaving crates.io behind npm with no failing signal anywhere
 * beforehand. That is the whole point: nothing on a PR read this ordering.
 *
 * The live instance: #2574 added `ifc-lite-clash.workspace = true` to
 * `rust/geometry`'s dev-dependencies. A workspace dep resolves to
 * `{ version = "x.y.z", path = ... }`, so it carries a VERSION, and
 * `cargo publish` resolves versioned dev-dependencies against crates.io even
 * though they add nothing to a shipping build. `geometry` was published before
 * `clash`, so it failed with:
 *
 *   error: failed to prepare local package for uploading
 *     failed to select a version for the requirement `ifc-lite-clash = "^4.7.0"`
 *
 * The distinction that matters, and the reason a blanket "no dev-deps" rule
 * would be wrong: `rust/core` has `ifc-lite-geometry = { path = "../geometry" }`
 * — path-only, no version. Cargo STRIPS that at publish time, so it imposes no
 * ordering constraint at all and core publishes cleanly despite the same shape
 * of cycle. Only a VERSIONED dependency (normal or dev) constrains the order.
 *
 * Run: node --test scripts/release-crates-order.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The publish order as the release script actually declares it. */
function publishOrder() {
  const src = readFileSync(join(ROOT, 'scripts', 'release-crates.mjs'), 'utf8');
  const block = src.match(/const CRATES = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'release-crates.mjs no longer declares a CRATES array');
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith("'") || line.startsWith('"'))
    .map((line) => line.match(/['"]([^'"]+)['"]/)[1]);
}

/**
 * Every `ifc-lite-*` dependency of `crateDir` that carries a VERSION, from
 * `[dependencies]`, `[dev-dependencies]` and `[build-dependencies]` alike.
 *
 * `foo.workspace = true` counts: it inherits the root's
 * `{ version = "...", path = "..." }`, version included. A bare
 * `{ path = "..." }` does not count — cargo strips it when packaging.
 */
function versionedIfcDeps(crateDir) {
  const manifest = join(ROOT, 'rust', crateDir, 'Cargo.toml');
  if (!existsSync(manifest)) return [];
  const out = new Set();
  let inDeps = false;
  for (const raw of readFileSync(manifest, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inDeps = /^\[(dev-|build-)?dependencies\]$/.test(line);
      continue;
    }
    if (!inDeps || line.startsWith('#') || !line.startsWith('ifc-lite-')) continue;
    const name = line.match(/^(ifc-lite-[a-z0-9-]+)/)?.[1];
    if (!name) continue;
    // Inherits the workspace entry, which carries a version. BOTH spellings
    // must be recognised, and the repo uses both: `rust/geometry` writes the
    // dotted `ifc-lite-clash.workspace = true`, while `rust/export` writes the
    // inline-table `ifc-lite-core = { workspace = true }`. Matching only the
    // dotted form left every one of export's three versioned dependencies
    // invisible here, so this gate would have passed an order that publishes
    // export before core, geometry and processing -- exactly the failure it
    // exists to prevent.
    if (/(^|[.{,\s])workspace\s*=\s*true/.test(line)) out.add(name);
    // Or states one inline.
    else if (/version\s*=/.test(line)) out.add(name);
    // Otherwise path-only: stripped at publish time, no ordering constraint.
  }
  return [...out];
}

/** crate name (`ifc-lite-core`) -> directory under rust/ (`core`). */
function crateDirs() {
  const map = new Map();
  for (const dir of readdirSync(join(ROOT, 'rust'))) {
    const manifest = join(ROOT, 'rust', dir, 'Cargo.toml');
    if (!existsSync(manifest)) continue;
    const name = readFileSync(manifest, 'utf8').match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (name) map.set(name, dir);
  }
  return map;
}

test('every published crate comes after the crates it pins by version', () => {
  const order = publishOrder();
  const dirs = crateDirs();
  const position = new Map(order.map((name, i) => [name, i]));

  const violations = [];
  for (const [i, crate] of order.entries()) {
    const dir = dirs.get(crate);
    assert.ok(dir, `${crate} is in CRATES but has no rust/*/Cargo.toml`);
    for (const dep of versionedIfcDeps(dir)) {
      if (!position.has(dep)) continue; // not published; irrelevant to order
      if (position.get(dep) > i) {
        violations.push(
          `  ${crate} (position ${i}) pins ${dep} by version, but ${dep} is published later (position ${position.get(dep)})`
        );
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `\nrelease-crates.mjs would publish a crate before something it pins by version.\n` +
      `cargo publish resolves versioned dependencies — INCLUDING dev-dependencies —\n` +
      `against crates.io, so this fails the real publish on main, after npm has already\n` +
      `gone out. Reorder CRATES, or drop the version from the dependency (a bare\n` +
      `{ path = "..." } dev-dep is stripped at publish time, as rust/core does).\n\n` +
      violations.join('\n')
  );
});

test('the ordering check can actually see a violation', () => {
  // Guards the guard: if `versionedIfcDeps` silently stopped parsing, the test
  // above would pass on any order at all and report nothing. This pins that the
  // real manifest of the real regression is still readable and still counted.
  const deps = versionedIfcDeps('geometry');
  assert.ok(
    deps.includes('ifc-lite-clash'),
    `rust/geometry should still show a versioned ifc-lite-clash dependency (the #2574 dev-dep). ` +
      `Got: ${JSON.stringify(deps)}. If that dep was intentionally removed or made path-only, ` +
      `this assertion should move to whichever crate now exercises the constraint — ` +
      `deleting it leaves the ordering test unable to fail.`
  );
});
