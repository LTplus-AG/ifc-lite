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
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `--root <dir>` points the scan at an alternate tree, the same seam
// check-test-glob-coverage.mjs and check-server-bin-targets.mjs use, so the
// regression harness can drive the FLOOR below over a synthetic tree instead of
// nobody ever seeing it fire (#3200).
const rootFlagIdx = process.argv.indexOf('--root');
if (rootFlagIdx !== -1 && !process.argv[rootFlagIdx + 1]) {
  console.error('--root requires a directory argument');
  process.exit(2);
}
const ROOT =
  rootFlagIdx === -1
    ? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    : resolve(process.argv[rootFlagIdx + 1]);
const packagesDir = join(ROOT, 'packages');

/**
 * Lower bound on how many PUBLISHED packages this must find (#3200, finding 9).
 *
 * Measured on a healthy tree: 42. `scripts/verify-npm-publish.js` carries a
 * sibling floor over what is today the same 42 packages -- a package cull edits
 * both. Deliberately NOT a shared constant: coupling a docs gate to a release
 * gate is worse than the drift, and the two populations already differ (that one
 * also scans `apps/` and requires `name` and `version`). Set to 25, roughly 40% of headroom, so
 * retiring or privatising a handful never forces an edit here while the failure
 * this guards against still trips -- every way this gate can go blind (a wrong
 * scan root, a `packages/` that enumerates nothing, a `private: true` sweep)
 * collapses the count toward 0, not to 24.
 *
 * `readdirSync` on a missing `packages/` throws, and `JSON.parse` on an
 * unreadable manifest throws, so those two paths are already loud. The one
 * silent path left was a genuinely empty result, which is what this closes:
 * `✅ All 0 published packages have a README.md.` used to exit 0.
 */
const PUBLISHED_FLOOR = 25;

const missing = [];
let checked = 0;
for (const dir of readdirSync(packagesDir).sort()) {
  const pkgJsonPath = join(packagesDir, dir, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  if (pkg.private === true) continue;
  checked += 1;
  if (!existsSync(join(packagesDir, dir, 'README.md'))) {
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

if (checked < PUBLISHED_FLOOR) {
  console.error(
    `\n❌ Only ${checked} published package(s) found under packages/, expected at least ` +
      `${PUBLISHED_FLOOR}.\n\n` +
      '   Refusing to report a clean result over a set this gate never examined. ' +
      'Nothing here is a README problem — the SCAN is wrong.\n' +
      '   If packages were genuinely removed, lower PUBLISHED_FLOOR in the same commit.\n',
  );
  process.exit(1);
}

console.log(`✅ All ${checked} published packages have a README.md.`);
