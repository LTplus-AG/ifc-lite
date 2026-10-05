#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fail when a relative import specifier names a tracked file with the wrong
 * letter case.
 *
 * On a case-insensitive filesystem (macOS default, Windows) `import './Foo'`
 * resolves to `foo.ts`; on Linux CI and in the Docker image it does not, so the
 * mistake only shows up after the push. This resolves every relative specifier
 * in tracked source against `git ls-files` case-sensitively. A specifier that
 * resolves to nothing at all is NOT reported here (generated, untracked or
 * asset paths are other gates' business); only "no exact match, but a match
 * that differs by case" is.
 *
 * Complements a tracked-pair collision check (two files differing only by case).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findCasingMismatches } from './lib/import-casing.mjs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter(Boolean);
const mismatches = findCasingMismatches(files, (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch (err) {
    // A tracked path deleted in the working tree (mid-rebase) has no content.
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
});
if (mismatches.length > 0) {
  console.error('check-import-casing: relative imports whose casing differs from the tracked file (works on macOS/Windows, fails on Linux):');
  for (const m of mismatches) console.error(`  ${m.file}: '${m.specifier}' -> ${m.actual}`);
  process.exitCode = 1;
} else {
  console.log(`check-import-casing: ok (${files.length} tracked files)`);
}
