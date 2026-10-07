/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is a repo-relative path spelled the way the repository spells it? (#7026)
 *
 * THE CONTRACT. A string names one of the repository's paths only under the
 * spelling the repository tracks it by: every component must equal an entry of
 * its parent directory byte for byte. For a clean checkout those entries are
 * the `git ls-files` spellings. A path that merely RESOLVES is not enough,
 * because whether it resolves depends on the host: on a case-insensitive
 * filesystem (default macOS, Windows) `existsSync('Deploy')` is true when
 * `deploy/` exists and `existsSync('readme.md')` is true when `README.md`
 * does. A gate that asks "is this string literal one of the repo's files?"
 * with `existsSync` alone then reads prose and fixture strings as file inputs
 * on those hosts and not on Linux CI, so one commit gets two verdicts.
 *
 * This is NOT the collision gate (scripts/check-path-case-collisions.mjs,
 * #6983). That one asks whether two tracked paths differ only in case. This
 * asks whether one spelling is the tracked one.
 *
 * The directory lookup is injected (`namesIn`) so the rule can be tested
 * against a lookup that folds case on any host. A directory that cannot be
 * listed (`namesIn` returns null: EACCES, a file where a directory was
 * expected) cannot be shown to differ in case, so it does not veto the path;
 * existence is the caller's separate question.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The entry names of `dir` under `root` exactly as the directory holds them, or null if it cannot be listed. */
function readNames(root, dir) {
  try {
    return new Set(readdirSync(join(root, dir)));
  } catch {
    return null;
  }
}

/**
 * @param {string} root directory that repo-relative paths are resolved against
 * @param {(dir: string) => Set<string> | null} [namesIn] entry names of a
 *   repo-relative directory (`''` is the root), or null when it cannot be
 *   listed; defaults to reading `root`, each directory once
 * @returns {(rel: string) => boolean} true when every component of `rel` is an exact entry name
 */
export function createSpelledExactly(root, namesIn) {
  /** @type {Map<string, Set<string> | null>} */
  const cache = new Map();
  const names = (dir) => {
    if (!cache.has(dir)) cache.set(dir, namesIn ? namesIn(dir) : readNames(root, dir));
    return cache.get(dir);
  };
  return (rel) => {
    let dir = '';
    for (const part of rel.split('/')) {
      if (part === '' || part === '.') continue;
      const held = names(dir);
      if (held !== null && !held.has(part)) return false;
      dir = dir === '' ? part : `${dir}/${part}`;
    }
    return true;
  };
}
