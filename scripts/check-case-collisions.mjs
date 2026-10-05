#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fail when two tracked paths differ only by letter case, ignoring the file
 * extension.
 *
 * On a case-insensitive filesystem (macOS default, Windows) the import
 * `./Foo` resolves to `foo.ts` even when `Foo.tsx` exists, so a
 * `Foo.tsx` + `foo.ts` pair fails tsc (TS1261) and the vite build, while
 * Linux CI stays green. The extension is dropped before comparing because
 * module specifiers omit it. Same-case stems with different extensions
 * (`Foo.ts`, `Foo.tsx`) are not a collision.
 */

import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter(Boolean);

const byFolded = new Map();
for (const file of files) {
  const key = file.replace(/\.[^./]*$/, '').toLowerCase();
  if (!byFolded.has(key)) byFolded.set(key, []);
  byFolded.get(key).push(file);
}

const stem = (file) => file.replace(/\.[^./]*$/, '');
const collisions = [...byFolded.values()].filter((paths) => new Set(paths.map(stem)).size > 1);
if (collisions.length > 0) {
  console.error('check-case-collisions: paths that differ only by case (break tsc/vite on macOS and Windows):');
  for (const paths of collisions) console.error(`  ${paths.join('  <->  ')}`);
  console.error('Rename one of each pair so the names differ by more than case.');
  process.exitCode = 1;
} else {
  console.log(`check-case-collisions: ok (${files.length} tracked files)`);
}
