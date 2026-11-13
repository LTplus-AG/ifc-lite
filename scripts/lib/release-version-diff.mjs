/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is a PR's diff only a release's version bump? The rule the release PR's
 * lean lane (scripts/ci-release-lane.mjs) applies before it may skip lanes:
 * consumed changesets, and per package a CHANGELOG with a package.json in
 * which `version`, and only `version`, moved (the private root: the
 * package.json alone). Cargo.toml and Cargo.lock edits pass only as the
 * release writer's own output (`cargoReplayProblems`). Anything else is named
 * as a problem.
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
 * pnpm-workspace.yaml's `packages` globs, each one directory level deep. Only
 * a workspace package gets a changesets bump, so a package.json/CHANGELOG.md
 * pair anywhere else (a test fixture, a docs sample) is not a release file
 * (#9783 review). A test pins this list to pnpm-workspace.yaml.
 */
export const WORKSPACE_PACKAGE_GLOBS = ['packages/*', 'apps/*', 'examples/*'];
const isWorkspacePackageDir = (dir) => WORKSPACE_PACKAGE_GLOBS.some((g) => {
  const [parent] = g.split('/');
  return posix.dirname(dir) === parent && !dir.slice(parent.length + 1).includes('/');
});

/**
 * The script whose output a release's Cargo edits must be. `changeset
 * version` never touches Cargo files; `pnpm run version` then runs this, and
 * it rewrites the workspace version, the internal dependency literals and the
 * two locks' path-member entries from the bumped package.json files.
 */
export const CARGO_RELEASE_WRITER = 'scripts/sync-versions.js';

export const isCargoFile = (path) => /(?:^|\/)Cargo\.(?:toml|lock)$/.test(path);

const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));

/**
 * CARGO EDITS BY REPLAY, NOT BY READING TOML (#9783). Five review rounds each
 * found a TOML spelling that a rule reading Cargo files misread, fail-open
 * (comments, array elements, literal and multi-line strings, CRLF, quoted
 * keys, nested inline tables, the writer's own loose patterns). This rule
 * reads no TOML. `git.cargoReplay()` runs the release writer
 * (CARGO_RELEASE_WRITER) over the BASE tree's Cargo files and the HEAD's
 * package.json files, which is exactly what `pnpm run version` sees, and
 * returns every Cargo file of the base tree with the bytes the writer left
 * and the bytes HEAD has. The Cargo part of the diff passes only if HEAD is
 * byte for byte that output: each changed Cargo file equals the replay, and no
 * Cargo file the replay rewrites was left alone. It runs on every diff, one
 * with no Cargo file included: the crate version derives from the npm
 * versions, so an npm-only bump can still owe a Cargo rewrite (#10048
 * review). Whatever spelling a file uses, a byte that the writer did not
 * produce refuses the lean lane, and a replay that fails refuses it too. An
 * empty list means the base tree has no Cargo file at all.
 *
 * @param {string[]} paths  Cargo files the diff modifies (status M), possibly none
 * @param {{ cargoReplay?: () => { path: string, replayed: string|Uint8Array, head: string|Uint8Array|null }[] }} git
 * @returns {string[]}
 */
export function cargoReplayProblems(paths, git) {
  let files;
  try {
    if (typeof git.cargoReplay !== 'function') throw new Error('no replay available');
    files = git.cargoReplay();
    if (!Array.isArray(files)) throw new Error('the replay did not return a list of Cargo files');
  } catch (err) {
    const why = String(err?.message ?? err).split('\n')[0];
    if (paths.length === 0) return [`Cargo files: replaying ${CARGO_RELEASE_WRITER} failed (${why}), so whether this release owes a Cargo rewrite cannot be judged`];
    return paths.map((p) => `${p}: replaying ${CARGO_RELEASE_WRITER} failed (${why}), so the Cargo edit cannot be judged`);
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const problems = [];
  for (const p of paths) {
    const f = byPath.get(p);
    if (!f) problems.push(`${p}: not a Cargo file of the base tree, so ${CARGO_RELEASE_WRITER} did not write it`);
    else if (f.head == null || !sameBytes(f.replayed, f.head)) problems.push(`${p}: differs from what ${CARGO_RELEASE_WRITER} writes on the base tree`);
  }
  const changed = new Set(paths);
  for (const f of files) {
    if (changed.has(f.path) || f.head == null) continue;
    if (!sameBytes(f.replayed, f.head)) problems.push(`${f.path}: ${CARGO_RELEASE_WRITER} rewrites it on the base tree, but this diff leaves it unchanged`);
  }
  return problems;
}

/**
 * What in the PR's diff is not a version bump. Empty means lean is allowed.
 *
 * @param {{ status: string, path: string }[]} entries  `git diff --name-status`
 * @param {{ show: (rev: string, path: string) => string, cargoReplay?: Function }} git
 *   `cargoReplay` runs on every diff (see cargoReplayProblems).
 * @returns {string[]}
 */
export function diffProblems(entries, git) {
  const problems = [];
  const cargo = [];
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
      else if (!isWorkspacePackageDir(posix.dirname(path))) problem = 'not in a workspace package (pnpm-workspace.yaml), so changesets did not write it';
      else if (!changed.has(sibling(path, 'package.json'))) problem = 'its package.json did not change, so changesets did not write it';
    } else if (name === 'package.json') {
      if (status !== 'M') problem = `status ${status}`;
      else if (path !== 'package.json' && !isWorkspacePackageDir(posix.dirname(path))) problem = 'not a workspace package (pnpm-workspace.yaml), so changesets did not bump it';
      else if (path !== 'package.json' && !changed.has(sibling(path, 'CHANGELOG.md'))) problem = 'no CHANGELOG.md beside it changed, so changesets did not bump it';
      else {
        try {
          problem = versionBumpProblem(JSON.parse(git.show('HEAD~1', path)), JSON.parse(git.show('HEAD', path)));
        } catch (err) {
          problem = `unreadable (${err.message})`;
        }
      }
    } else if (isCargoFile(path)) {
      // The writer only rewrites files in place; it never adds or deletes one.
      if (status !== 'M') problem = `status ${status}; ${CARGO_RELEASE_WRITER} only rewrites Cargo files in place`;
      else cargo.push(path);
    } else {
      problem = 'not a release file';
    }
    if (problem) problems.push(`${path}: ${problem}`);
  }
  problems.push(...cargoReplayProblems(cargo, git));
  return problems;
}

