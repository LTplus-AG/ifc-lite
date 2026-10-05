/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `existsSync`, but a path whose letter case differs from the file on disk
 * does not exist.
 *
 * On a case-insensitive filesystem (macOS default, Windows) `existsSync('Deploy')`
 * is true when `deploy/` exists, and `existsSync('readme.md')` is true when
 * `README.md` does. A gate that asks "is this string literal one of the repo's
 * files?" then reads prose (a check name, a lower-cased file name in a test
 * fixture) as a file input on those hosts and not on Linux CI, so the same
 * commit passes in CI and fails on a developer's machine.
 *
 * Each path component is compared against a directory listing of its parent.
 * Listings are cached per call site (`createExistsExactCase()`): a gate that asks
 * thousands of questions reads each directory once.
 *
 * A directory that cannot be listed (EACCES, ...) cannot be proven to differ in
 * case, so the plain `existsSync` answer stands for it rather than inventing a
 * "does not exist".
 *
 * @param {string} root directory that relative paths are resolved against
 * @returns {(rel: string) => boolean}
 */
export function createExistsExactCase(root) {
  /** @type {Map<string, Set<string> | null>} */
  const listings = new Map();
  const list = (dir) => {
    if (!listings.has(dir)) {
      try {
        listings.set(dir, new Set(readdirSync(dir)));
      } catch {
        listings.set(dir, null);
      }
    }
    return listings.get(dir);
  };
  return (rel) => {
    const target = join(root, rel);
    if (!existsSync(target)) return false;
    let dir = root;
    for (const part of rel.split(/[\\/]/)) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        dir = join(dir, '..');
        continue;
      }
      const names = list(dir);
      if (names !== null && !names.has(part)) return false;
      dir = join(dir, part);
    }
    return true;
  };
}
