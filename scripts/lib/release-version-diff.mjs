/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is a PR's diff only a release's version bump? The rule the release PR's
 * lean lane (scripts/ci-release-lane.mjs) applies before it may skip lanes:
 * consumed changesets, and per package a CHANGELOG with a package.json in
 * which `version`, and only `version`, moved (the private root: the
 * package.json alone). Anything else is named as a problem, any Cargo.toml or
 * Cargo.lock change included: a release that bumps Rust crates runs full.
 */

import { basename, posix } from 'node:path';
import { isChangesetName } from './pending-changesets.mjs';

// semver.org's grammar: no leading zeros in numeric identifiers, no empty ones.
const NUM = '(?:0|[1-9]\\d*)';
const PRE = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE}(?:\\.${PRE})*))?$`);

/** BigInt: numeric identifiers are unbounded, and Number loses digits past 2^53. */
function cmpBig(x, y) {
  const [p, q] = [BigInt(x), BigInt(y)];
  return p === q ? 0 : p < q ? -1 : 1;
}

/**
 * Semver precedence (semver.org, section 11) of two SEMVER matches: below 0
 * when `a` is lower. A prerelease is lower than its own release, so
 * 1.0.0 -> 1.0.0-next.0 moves backward (#9783 review).
 */
function comparePrecedence(a, b) {
  for (const i of [1, 2, 3]) {
    const d = cmpBig(a[i], b[i]);
    if (d !== 0) return d;
  }
  if (a[4] === undefined || b[4] === undefined) return (a[4] === undefined) - (b[4] === undefined);
  const [x, y] = [a[4].split('.'), b[4].split('.')];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [p, q] = [x[i], y[i]];
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    // Numeric identifiers compare as numbers and rank below alphanumeric ones.
    if (pn && qn) {
      const d = cmpBig(p, q);
      if (d !== 0) return d;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return Math.sign(x.length - y.length);
}

/**
 * `version` must move, and nothing else may. Internal dependencies use
 * `workspace:` specifiers and .changeset/config.json sets
 * bumpVersionsWithWorkspaceProtocolOnly, so a release never rewrites a
 * dependency map.
 */
function versionBumpProblem(before, after) {
  const [from, to] = [before.version, after.version].map((v) => (typeof v === 'string' ? SEMVER.exec(v) : null));
  if (!from || !to) return `\`version\` is not semver on both sides (${JSON.stringify(before.version)} -> ${JSON.stringify(after.version)})`;
  if (before.version === after.version) return '`version` did not move';
  // Changesets only moves a version forward, prerelease steps included.
  if (comparePrecedence(to, from) <= 0) return `\`version\` did not move forward (${before.version} -> ${after.version})`;
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
      else if (path === 'CHANGELOG.md') problem = 'changesets writes no CHANGELOG for the private root';
      else if (!changed.has(sibling(path, 'package.json'))) problem = 'its package.json did not change, so changesets did not write it';
    } else if (name === 'package.json') {
      if (status !== 'M') problem = `status ${status}`;
      else if (path !== 'package.json' && !changed.has(sibling(path, 'CHANGELOG.md'))) problem = 'no CHANGELOG.md beside it changed, so changesets did not bump it';
      else {
        try {
          problem = versionBumpProblem(JSON.parse(git.show('HEAD~1', path)), JSON.parse(git.show('HEAD', path)));
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

