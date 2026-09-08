/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tag-revision file reading for scripts/check-server-bin-targets.mjs.
 *
 * Three genuinely different situations, told apart STRUCTURALLY - never by
 * matching git's English error text, because `git show` reports an absent
 * path with two different messages ("does not exist in" vs "exists on disk,
 * but not in", depending on the working tree) and matching only one of them
 * misclassified a pre-package tag as an unfetched one:
 *
 *   1. The tag ref does not resolve locally (unfetched / shallow clone):
 *      ERROR telling the operator to fetch it - never a fallback to the
 *      checked-out tree, which would recreate the vacuous pass the caller
 *      exists to prevent.
 *   2. The tag resolves but the path is absent at that revision (ls-tree
 *      answers with an empty listing): a FACT about the revision, not a
 *      read failure. Surfaced as null when `optional` is set. For a
 *      REQUIRED path it is still an ERROR - the tag predates the file (a
 *      release cut before packages/server-bin existed has no server-bin
 *      contract to verify) or the file has since moved. Deliberately NOT a
 *      "nothing to verify" pass: were this path ever renamed on the
 *      workflow ref, every older tag would lack the new path, and a quiet
 *      pass here would green real releases while verifying nothing.
 *   3. Any other git failure (corrupt object, git missing): ERROR.
 *
 * Executable proof: scripts/check-server-bin-targets.test.mjs (tag-vs-path
 * classification cases, including one against the real v1.0.0 tag).
 */

import { execFileSync } from 'node:child_process';
import { fail } from './server-bin-targets-parse.mjs';

/** Run one git command against repoRoot, capturing output. Throws on failure. */
function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Read one file at a release tag's own revision, per the rules above. */
export function readFileAtTag(repoRoot, tag, path, { optional = false } = {}) {
  try {
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  } catch {
    fail(
      `tag "${tag}" does not resolve locally; fetch the tag first ` +
      `(git fetch --depth=1 origin tag ${tag}) - refusing to fall back ` +
      `to the checked-out tree, which may not be the tag's`,
    );
  }
  let entry;
  try {
    entry = git(repoRoot, ['ls-tree', `refs/tags/${tag}`, '--', path]);
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).trim().split('\n')[0];
    fail(`cannot list ${path} at tag "${tag}" via git ls-tree (${detail})`);
  }
  if (entry.trim() === '') {
    if (optional) return null;
    fail(
      `${path} does not exist at tag "${tag}" - the tag is present locally and resolves; ` +
      `the path is simply absent at that revision. Either the tag predates ${path} ` +
      `(a release cut before packages/server-bin existed shipped no server binaries, so ` +
      `there is nothing this check can verify for it), or the file has since moved and ` +
      `this check must learn its location at that tag; refusing to guess`,
    );
  }
  try {
    return git(repoRoot, ['show', `refs/tags/${tag}:${path}`]);
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).trim().split('\n')[0];
    fail(`cannot read ${path} at tag "${tag}" via git show (${detail})`);
  }
}
