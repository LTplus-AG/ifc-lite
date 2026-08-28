/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { existsOrThrow } from './exists-or-throw.mjs';

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
 * NOT shared with the repo's other package enumerators, deliberately. They
 * differ on four
 * orthogonal axes: which parents, which filter (published-only, has-tsconfig,
 * all), which return shape, and a per-gate calibrated floor. One function
 * carrying four knobs is a config object with a `for` loop attached, and every
 * caller would still have to learn every knob.
 *
 * Only `fail` and `parents` are injected. Both callers use the real `fs`, so
 * threading the module through too would be indirection with a single shape.
 *
 * `parents` is REQUIRED rather than defaulted. Each gate already keeps its own
 * literal, because `check-ci-path-coverage` derives a gate's trigger paths from
 * that gate's own source text and does not follow imports. A default here would
 * be a third copy that nothing forces anyone to keep in step with those two,
 * and the one caller that took it was already scanning a different list from
 * its own file's other caller.
 *
 * @param {string} root repo root, or an alternate tree under a `--root` flag.
 * @param {(message: string) => never} fail the CALLER's reporter, so each gate
 *   keeps its own prefix and its own error type. Injected rather than imported:
 *   nothing about the refusal is softened to let it travel.
 * @param {readonly string[]} parents which parents to scan.
 * @returns {{ packages: { rel: string, dir: string, pkgJson: unknown }[],
 *   seenParents: string[] }} `seenParents` lists the parents that exist, for
 *   the callers' own anti-vacuity accounting. It is returned rather than filled
 *   through an out-param, and it is not derivable from `packages`: a parent can
 *   exist and hold no package at all.
 */
export function listWorkspacePackages(root, fail, parents) {
  const out = [];
  const seenParents = [];
  for (const parent of parents) {
    const parentDir = join(root, parent);
    if (!existsOrThrow(parentDir, 'package parent', fail)) continue;
    seenParents.push(parent);
    // existsOrThrow answers "is it there", and for a DIRECTORY that is all it
    // can answer: the mode bits gate opendir(3), not stat(2), so a mode-000
    // parent stats clean and the refusal above never fires for the case its
    // own label names. Unguarded, the scandir below then threw a raw EACCES
    // with no gate message at all. Both halves are needed, and neither
    // subsumes the other: stat catches a MISSING or non-directory parent,
    // this catches an unreadable one.
    let entries;
    try {
      entries = readdirSync(parentDir).sort();
    } catch (err) {
      fail(
        `cannot read package parent ${parentDir}: ${err.code || err.message}. ` +
          'Refusing to treat an unreadable parent as an empty one -- that is how ' +
          'every package under it drops out of the audit at once.',
      );
      // Unreachable with either gate's `fail`, which throws. Carried for the
      // same reason exists-or-throw.mjs carries one: a caller whose `fail`
      // RETURNS would leave `entries` undefined and the loop below would throw
      // a TypeError, destroying the diagnosis this branch exists to produce.
      throw err;
    }
    for (const name of entries) {
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
      // Read and parse are separate so they cannot be reported as each other.
      // Folded together, an unreadable manifest came back as "is not valid
      // JSON: EACCES", sending the reader to fix syntax on a file whose syntax
      // is fine -- and the `cannot read package manifest` message above is
      // unreachable for a mode-000 FILE, since statSync succeeds on one.
      let raw;
      try {
        raw = readFileSync(pkgJsonPath, 'utf8');
      } catch (err) {
        fail(
          `cannot read package manifest ${pkgJsonPath}: ${err.code || err.message}. ` +
            'Refusing to treat an unreadable manifest as an absent one.',
        );
        // The one that MATTERS, not just insurance. With a `fail` that
        // returns, `raw` stays undefined, JSON.parse(undefined) throws a
        // SYNTAX error, that fail returns too, and the package is pushed with
        // `pkgJson: undefined` -- an unreadable package entering the counted
        // population, which is the exact invariant this module protects.
        throw err;
      }
      let pkgJson;
      try {
        pkgJson = JSON.parse(raw);
      } catch (err) {
        fail(`${pkgJsonPath} is not valid JSON: ${err.message}`);
        // The read branch above is not the only way in. With a `fail` that
        // returns, a MALFORMED manifest reached this same catch and the package
        // was pushed with `pkgJson: undefined` - the identical corruption,
        // through the parse branch instead of the read one.
        throw err;
      }
      out.push({ rel: `${parent}/${name}`, dir: pkgDir, pkgJson });
    }
  }
  return { packages: out, seenParents };
}
