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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Groups of paths (2+) that collide once lowercased. */
export function findCaseCollisions(paths) {
  const groups = new Map();
  for (const path of new Set(paths)) {
    const key = path.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(path);
    else groups.set(key, [path]);
  }
  return [...groups.values()].filter((group) => group.length > 1).map((group) => group.sort());
}

function main() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
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
