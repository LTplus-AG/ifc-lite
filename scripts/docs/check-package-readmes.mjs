#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: every published (non-private) package under packages/* ships a
 * sibling README.md. npm renders it as the package landing page, so a
 * missing one is a silently shipped blank page.
 *
 * Run via `pnpm docs:check-readmes`.
 *
 * ANTI-VACUITY (#3200, finding 9). This was the last CI-wired gate still
 * carrying the idiom #3197 removed from three siblings: an absence and an
 * unreadable path answered the same way, and no floor under the count it
 * prints. On a tree whose `packages/` existed and was empty it printed
 * `✅ All 0 published packages have a README.md.` and exited 0 — a scan of
 * nothing reported as a clean scan. `existsSync` made it worse than the empty
 * case suggests: it answers false for EACCES too, so a package that could not
 * be read dropped out of `checked` and its missing README with it.
 *
 * Three guards now stand between an empty input set and that success line:
 * `packages/` not being readable is a named failure rather than a stack trace,
 * an unreadable path is distinguished from an absent one, and CHECKED_FLOOR
 * refuses a count that has collapsed. None of them fires on a healthy tree.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's own location, with no argv override: the regression
// harness (check-package-readmes.test.mjs) copies this one file into a synthetic
// tree, so the floor below is driven over real input without this gate growing a
// scan-root flag (#3200).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagesDir = join(ROOT, 'packages');

/**
 * Lower bound on how many published packages must reach the README check.
 * Measured on a healthy tree: 45 directories under `packages/` carry a
 * manifest, 42 of them published and 3 private. Set to 25 — a wide margin,
 * so a package split or a few retired ones never force an edit here, while
 * every way this gate can go blind (a wrong root, a restructured `packages/`
 * whose manifests moved a level down, a read that stops resolving) collapses
 * the count towards zero rather than to 24.
 */
const CHECKED_FLOOR = 25;

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

/**
 * Does this path exist? Refuses when the answer is UNKNOWABLE.
 *
 * `existsSync` answers false for every failure, EACCES and ENOTDIR included,
 * so an unreadable path is indistinguishable from an absent one — and here
 * "absent" means "skip this directory", which is how a package leaves the
 * audit without leaving a trace.
 *
 * DELIBERATELY NOT the shared `scripts/lib/exists-or-throw.mjs`, and this is
 * load-bearing rather than an oversight. This gate's regression harness copies
 * THIS ONE FILE into a synthetic tree and runs it there (see the note on
 * `packagesDir` above, and `check-package-readmes.test.mjs`'s `makeTree`), so
 * the file must stay import-free beyond node builtins. Migrating it onto the
 * lib was tried and turned all 9 of its tests red while the gate itself still
 * passed against the real repo - the failure only appears in the synthetic
 * tree, where `../lib/` does not exist. Change the harness first if you want
 * this deduplicated. (#3347)
 */
function existsOrFail(path, what) {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    fail(
      `cannot read ${what} ${path} (${err.code || err.message}). ` +
        'Refusing to treat an unreadable path as an absent one — that is how a ' +
        'package drops out of this audit without anyone noticing.',
    );
  }
}

let entries;
try {
  entries = readdirSync(packagesDir).sort();
} catch (err) {
  fail(
    `cannot list ${packagesDir} (${err.code || err.message}). ` +
      'This gate exists to audit published packages and found nowhere to look for them.',
  );
}

const missing = [];
let checked = 0;
for (const dir of entries) {
  // A dotfile is not a candidate package: pnpm-workspace.yaml globs
  // `packages/*` and a bare `*` never matches a leading dot. macOS drops a
  // `.DS_Store` FILE into any directory Finder has opened, and statting
  // `.DS_Store/package.json` raises ENOTDIR, which existsOrFail below refuses
  // by design. Skip the candidate rather than soften the refusal: every entry
  // that could plausibly be a package still goes through it unchanged. Same
  // shape and same reason as lib/list-workspace-packages.mjs's walk. (#3350)
  if (dir.startsWith('.')) continue;
  const pkgJsonPath = join(packagesDir, dir, 'package.json');
  if (!existsOrFail(pkgJsonPath, 'package manifest')) continue;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  if (pkg.private === true) continue;
  checked += 1;
  if (!existsOrFail(join(packagesDir, dir, 'README.md'), 'README')) {
    missing.push(`${pkg.name}  (packages/${dir}/README.md)`);
  }
}

if (missing.length > 0) {
  console.error(
    `\n❌ Published packages without a README.md (${missing.length}):\n`,
  );
  for (const m of missing) console.error(`   ${m}`);
  console.error(
    '\nEvery published package needs a README — it is the npm landing page.\n',
  );
  process.exit(1);
}

// Placed AFTER the missing-README verdict and before the success line: a run
// that examined too few packages has proved nothing about the ones it never
// opened, and saying so is the whole point of the check.
if (checked < CHECKED_FLOOR) {
  fail(
    `only ${checked} published package(s) reached the README check under ${packagesDir}, ` +
      `expected at least ${CHECKED_FLOOR}. Refusing a vacuous pass: this gate found ` +
      'almost nothing to audit, which is a failure of discovery, not a clean tree. ' +
      'If packages/ genuinely shrank this far, lower CHECKED_FLOOR in this file — ' +
      'deliberately, in a reviewable diff.',
  );
}

console.log(`✅ All ${checked} published packages have a README.md.`);
