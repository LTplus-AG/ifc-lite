#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fail when two tracked paths differ only in case (#6978).
 *
 * On case-insensitive filesystems (Windows, default macOS, WSL /mnt/c) only one
 * of such paths survives a checkout, which breaks typecheck and build there.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Groups of spellings (2+) that collide once lowercased, covering directory
 * prefixes too (`a/Foo/x` and `a/foo/y` collapse into one directory). */
export function findCaseCollisions(paths) {
  const spellings = new Map();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const spelling = parts.slice(0, i).join('/');
      const key = spelling.toLowerCase();
      const set = spellings.get(key);
      if (set) set.add(spelling);
      else spellings.set(key, new Set([spelling]));
    }
  }
  return [...spellings.values()].filter((set) => set.size > 1).map((set) => [...set].sort());
}

function main() {
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag > 0 ? resolve(process.argv[rootFlag + 1]) : REPO_ROOT;
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const collisions = findCaseCollisions(out.split('\0').filter(Boolean));
  if (collisions.length === 0) {
    console.log('check-path-case-collisions: no case-colliding tracked paths.');
    return;
  }
  console.error('Tracked paths that differ only in case (break case-insensitive checkouts):');
  for (const group of collisions) console.error(`  ${group.join('  <->  ')}`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
