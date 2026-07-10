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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagesDir = join(ROOT, 'packages');

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

console.log(`✅ All ${checked} published packages have a README.md.`);
