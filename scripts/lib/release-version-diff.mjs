/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is a PR's diff only a release's version bump? The rule the release PR's
 * lean lane (scripts/ci-release-lane.mjs) applies before it may skip lanes:
 * consumed changesets, CHANGELOGs beside a package.json, `version` in
 * package.json, and internal version strings in Cargo.toml / Cargo.lock.
 * Anything else is named as a problem.
 */

import { basename } from 'node:path';

// `rust-version` (the MSRV) is not a version bump, hence the lookbehind.
const VERSION_VALUE = /(?<![\w-])version\s*=\s*"[^"]*"/g;

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

const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/;
const DEP_TABLE = /^(workspace\.)?(target\..+\.)?(dev-|build-)?dependencies\.[^.]+$/;

/** A TOML line without its `#` comment (a `#` inside a "string" is kept). */
function stripComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== '\\') inString = !inString;
    else if (line[i] === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

/**
 * The file's lines without comments, and the table name each header line
 * opens (null elsewhere). A line is a header only outside a multi-line
 * array, so an element line like `["a"]` is not mistaken for one.
 */
function parseToml(text) {
  const lines = String(text).split('\n').map(stripComment);
  const headers = [];
  let depth = 0;
  for (const line of lines) {
    const header = depth === 0 ? TABLE_HEADER.exec(line) : null;
    headers.push(header ? header[1].replace(/\s+/g, '').replace(/"/g, '') : null);
    if (header) continue;
    for (const c of line.replace(/"(?:[^"\\]|\\.)*"/g, '')) depth += c === '[' ? 1 : c === ']' ? -1 : 0;
    if (depth < 0) depth = 0;
  }
  return { lines, headers };
}

/** The lines of the TOML table that holds line `idx`, and that table's name. */
function tableAt({ lines, headers }, idx) {
  let start = idx;
  while (start >= 0 && headers[start] === null) start--;
  let end = idx + 1;
  while (end < lines.length && headers[end] === null) end++;
  return { name: start >= 0 ? headers[start] : '', body: lines.slice(start + 1, end) };
}

/**
 * May line `idx` of the new Cargo.toml/Cargo.lock carry an internal version
 * bump? A bare `version =` counts only under `[package]` or
 * `[workspace.package]`, in a `[...dependencies.<name>]` table with a `path`,
 * or (Cargo.lock) in a `[[package]]` with no `source` (a workspace crate). An
 * inline dependency counts only with a `path`. Anything else, an external
 * crate in table form included, is not a release bump.
 */
function internalVersionLine(toml, idx, isLock) {
  const line = toml.lines[idx] ?? '';
  if (!/^\s*version\s*=/.test(line)) return /^\s*[\w-]+\s*=\s*\{.*\bpath\s*=/.test(line);
  const { name, body } = tableAt(toml, idx);
  if (isLock) return name === 'package' && !body.some((l) => /^\s*source\s*=/.test(l));
  if (name === 'package' || name === 'workspace.package') return true;
  return DEP_TABLE.test(name) && body.some((l) => /^\s*path\s*=/.test(l));
}

/**
 * Pairs every removed line with an added line in each hunk; a pair may differ
 * only in a `version = "..."` value, on a line `internalVersionLine` accepts.
 * A `checksum` change, an external requirement, `rust-version` or any other
 * edit is a problem.
 *
 * @param {string} unifiedDiff  `git diff -U0` of the file
 * @param {string} after        the file at HEAD, for the tables the lines sit in
 */
function onlyCargoVersionsMoved(unifiedDiff, after, isLock) {
  const toml = parseToml(after);
  for (const hunk of String(unifiedDiff).split(/^(?=@@ )/m).filter((h) => h.startsWith('@@ '))) {
    const at = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk);
    if (!at) return 'unreadable hunk header';
    const body = hunk.split('\n').slice(1);
    const minus = body.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
    const plus = body.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
    if (minus.length !== plus.length) return 'lines were added or removed';
    for (let i = 0; i < minus.length; i++) {
      const internal = internalVersionLine(toml, Number(at[1]) - 1 + i, isLock);
      if (!internal || minus[i].replace(VERSION_VALUE, 'version=""') !== plus[i].replace(VERSION_VALUE, 'version=""')) return `\`${plus[i].trim()}\` is not an internal version change`;
    }
  }
  return null;
}

/**
 * What in the PR's diff is not a version bump. Empty means lean is allowed.
 *
 * @param {{ status: string, path: string }[]} entries  `git diff --name-status`
 * @param {{ show: (rev: string, path: string) => string, diff: (path: string) => string }} git
 * @returns {string[]}
 */
export function diffProblems(entries, git) {
  const problems = [];
  if (entries.length === 0) problems.push('the diff is empty or unreadable');
  for (const { status, path } of entries) {
    const name = basename(path);
    let problem = null;
    if (/^\.changeset\/[^/]+\.md$/.test(path) && name !== 'README.md') {
      if (status !== 'D') problem = 'a changeset may only be consumed (deleted)';
    } else if (name === 'CHANGELOG.md') {
      if (status !== 'M' && status !== 'A') problem = `status ${status}`;
      else {
        try {
          git.show('HEAD', path.replace(/CHANGELOG\.md$/, 'package.json'));
        } catch {
          problem = 'no package.json beside it, so changesets did not write it';
        }
      }
    } else if (name === 'package.json') {
      if (status !== 'M') problem = `status ${status}`;
      else {
        try {
          problem = onlyVersionsMoved(JSON.parse(git.show('HEAD~1', path)), JSON.parse(git.show('HEAD', path)));
        } catch (err) {
          problem = `unreadable (${err.message})`;
        }
      }
    } else if (name === 'Cargo.toml' || name === 'Cargo.lock') {
      problem = status === 'M' ? onlyCargoVersionsMoved(git.diff(path), git.show('HEAD', path), name === 'Cargo.lock') : `status ${status}`;
    } else {
      problem = 'not a release file';
    }
    if (problem) problems.push(`${path}: ${problem}`);
  }
  return problems;
}

