/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { existsOrThrow } from './exists-or-throw.mjs';

/** The parents both fail-closed gates scan today. See the dotfile note below. */
export const PACKAGE_PARENTS = ['packages', 'apps'];

/**
 * The one workspace-package walk the fail-closed gates share.
 *
 * `check-test-wiring.mjs` and `check-test-glob-coverage.mjs` each form a
 * COUNTED POPULATION and then report a number about it. That is the invariant
 * this module protects, and it is narrower than "be loud everywhere":
 *
 *     unreadable must never shrink a population a gate reports a count of.
 *
 * A refusal is one way to hold that; a calibrated floor is another, which is
 * why `verify-npm-publish.js` and `lib/rust-major-offset.mjs` legitimately
 * warn-and-floor instead. They are alternatives, not a hierarchy.
 *
 * Extracting `existsOrThrow` alone left this walk copied verbatim into both
 * gates, differing only in a constant's name and `'utf-8'` vs `'utf8'` - the
 * same habit #3347 charged for one layer down, two walks kept in agreement by
 * whoever edited one remembering the other.
 *
 * NOT shared with the other ten enumerators, deliberately. They differ on four
 * orthogonal axes: which parents, which filter (published-only, has-tsconfig,
 * all), which return shape, and a per-gate calibrated floor. One function
 * carrying four knobs is a config object with a `for` loop attached, and every
 * caller would still have to learn every knob.
 *
 * Only `fail` and `parents` are injected. Both callers use the real `fs`, so
 * threading the module through too would be indirection with a single shape.
 *
 * @param {string} root repo root, or an alternate tree under a `--root` flag.
 * @param {(message: string) => never} fail the CALLER's reporter, so each gate
 *   keeps its own prefix and its own error type. Injected rather than imported:
 *   nothing about the refusal is softened to let it travel.
 * @param {readonly string[]} parents which parents to scan.
 * @param {string[]} seenParents out-param, pushed for each parent that exists.
 *   Callers use it for their own anti-vacuity accounting; ignore it if not.
 * @returns {{ rel: string, dir: string, pkgJson: unknown }[]}
 */
export function listWorkspacePackages(root, fail, parents = PACKAGE_PARENTS, seenParents = []) {
  const out = [];
  for (const parent of parents) {
    const parentDir = join(root, parent);
    if (!existsOrThrow(parentDir, 'package parent', fail)) continue;
    seenParents.push(parent);
    for (const name of readdirSync(parentDir).sort()) {
      // Skipping a dotfile is a CONSEQUENCE of a rule this code does not yet
      // read, not a rule of its own: pnpm-workspace.yaml's globs are
      // `packages/*`, `apps/*`, `examples/*`, and a bare `*` never matches a
      // leading dot. `check-lint-ran.mjs` already parses that block properly;
      // moving its parser here and deriving BOTH the parents and this skip from
      // it is the real fix. Deliberately not this change, because making the
      // parents dynamic alters what each gate ENFORCES.
      //
      // The skip and the refusal ship together or the refusal is a flake
      // generator. macOS drops a `.DS_Store` FILE into any Finder-opened
      // directory; statting `.DS_Store/package.json` raises ENOTDIR, which
      // `existsOrThrow` refuses correctly and by design. PR #3350 fixed exactly
      // this in three sibling gates, and the tempting remedy - catch ENOTDIR
      // and continue - deletes the refusal outright. (#3350, #3347)
      if (name.startsWith('.')) continue;
      const pkgDir = join(parentDir, name);
      const pkgJsonPath = join(pkgDir, 'package.json');
      if (!existsOrThrow(pkgJsonPath, 'package manifest', fail)) continue;
      let pkgJson;
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      } catch (err) {
        fail(`${pkgJsonPath} is not valid JSON: ${err.message}`);
      }
      out.push({ rel: `${parent}/${name}`, dir: pkgDir, pkgJson });
    }
  }
  return out;
}
