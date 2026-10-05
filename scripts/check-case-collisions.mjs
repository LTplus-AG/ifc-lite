#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fail when tracked paths would collide on a case-insensitive filesystem
 * (macOS default, Windows): paths that fold to one name, or files whose
 * extension-less stems differ only by case (`Foo.tsx` + `foo.ts`, which makes
 * the specifier `./Foo` resolve to the wrong file, TS1261, while Linux CI
 * stays green). The rules live in scripts/lib/case-collisions.mjs.
 */

import { execFileSync } from 'node:child_process';
import { findCollisions } from './lib/case-collisions.mjs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter(Boolean);

const collisions = findCollisions(files);
if (collisions.length > 0) {
  console.error('check-case-collisions: paths that differ only by case (break tsc/vite/checkout on macOS and Windows):');
  for (const paths of collisions) console.error(`  ${paths.join('  <->  ')}`);
  console.error('Rename one of each pair so the names differ by more than case.');
  process.exitCode = 1;
} else {
  console.log(`check-case-collisions: ok (${files.length} tracked files)`);
}
