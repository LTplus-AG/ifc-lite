/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is a PR's diff only a release's version bump? The rule the release PR's
 * lean lane (scripts/ci-release-lane.mjs) applies before it may skip lanes:
 * consumed changesets, CHANGELOGs beside a package.json, and `version` in
 * package.json. Anything else is named as a problem, any Cargo.toml or
 * Cargo.lock change included: a release that bumps Rust crates runs full.
 */

import { basename, posix } from 'node:path';
import { isChangesetName } from './pending-changesets.mjs';

/**
 * Only `version` may move. Internal dependencies use `workspace:` specifiers
 * and .changeset/config.json sets bumpVersionsWithWorkspaceProtocolOnly, so a
 * release never rewrites a dependency map.
 */
function onlyVersionsMoved(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const moved = [...keys].find((k) => k !== 'version' && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return moved ? `\`${moved}\` changed` : null;
}

/**
 * What in the PR's diff is not a version bump. Empty means lean is allowed.
 *
 * @param {{ status: string, path: string }[]} entries  `git diff --name-status`
 * @param {{ show: (rev: string, path: string) => string }} git
 * @returns {string[]}
 */
export function diffProblems(entries, git) {
  const problems = [];
  if (entries.length === 0) problems.push('the diff is empty or unreadable');
  // Changesets writes a package's CHANGELOG exactly when it bumps that
  // package's version, so each must come with the other. The private root
  // package.json is the exception: it is not a workspace package, and
  // scripts/sync-versions.js (run after `changeset version`) bumps it with no
  // CHANGELOG.
  const changed = new Set(entries.map((e) => e.path));
  const sibling = (path, file) => posix.join(posix.dirname(path), file);
  for (const { status, path } of entries) {
    const name = basename(path);
    let problem = null;
    if (/^\.changeset\/[^/]+$/.test(path) && isChangesetName(name)) {
      if (status !== 'D') problem = 'a changeset may only be consumed (deleted)';
    } else if (name === 'CHANGELOG.md') {
      if (status !== 'M' && status !== 'A') problem = `status ${status}`;
      else if (!changed.has(sibling(path, 'package.json'))) problem = 'its package.json did not change, so changesets did not write it';
    } else if (name === 'package.json') {
      if (status !== 'M') problem = `status ${status}`;
      else if (path !== 'package.json' && !changed.has(sibling(path, 'CHANGELOG.md'))) problem = 'no CHANGELOG.md beside it changed, so changesets did not bump it';
      else {
        try {
          problem = onlyVersionsMoved(JSON.parse(git.show('HEAD~1', path)), JSON.parse(git.show('HEAD', path)));
        } catch (err) {
          problem = `unreadable (${err.message})`;
        }
      }
    } else if (name === 'Cargo.toml' || name === 'Cargo.lock') {
      // Not judged: each attempt at a version-only Cargo rule was found to
      // misread some TOML spelling, fail-open (#9783). Any Cargo change, of any
      // status, runs the full lanes.
      problem = 'a Cargo file changed; the lean lane does not judge Cargo edits';
    } else {
      problem = 'not a release file';
    }
    if (problem) problems.push(`${path}: ${problem}`);
  }
  return problems;
}

