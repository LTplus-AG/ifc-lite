/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { DirtyPrScanError } from './dirty-pr-scan.mjs';

/**
 * `pullRequestBaseBranches` parses `test.yml`'s `on: pull_request: branches:`
 * filter out of the workflow's own text -- the base-branch half of the
 * #3443/#3429 gate in `dirty-pr-scan.mjs`. Split into its own module because
 * it is pure YAML-fragment parsing with no dependency on PR classification;
 * `dirty-pr-scan.mjs` re-exports `pullRequestBaseBranches` so existing
 * imports are unaffected.
 */

/**
 * The base branches `test.yml` will fire `pull_request` for.
 *
 * WHY THIS EXISTS: a missing lane has TWO causes, not one, and they need
 * opposite remedies. `.github/workflows/test.yml` opens with
 * `on: pull_request: branches: [main]`, so a stacked PR based on a feature
 * branch never fires it -- measured on #3411 (base
 * `fix-3353-snap-f32-invisible-floor`) and #3405 (base
 * `fix-3338-isolate-expansion-gate`), both reading MERGEABLE/CLEAN with 0 of
 * the 15 required lanes present. Telling such a PR to resolve a merge conflict
 * is advice that provably cannot work: the base filter still blocks the
 * workflow afterwards. This is #3429's first case; the conflicted PR is its
 * second.
 *
 * Parsed from the workflow text rather than hardcoded, for the same reason the
 * lane names are: a constant here would silently diverge the day the filter
 * changes, and the failure mode of a diverged constant is a wrong remedy, not
 * a loud error.
 *
 * @param {string} text - `.github/workflows/test.yml` contents.
 * @returns {string[] | null} the allowed base branches, or `null` when
 *   `pull_request` carries no `branches:` filter at all (every base fires).
 */
export function pullRequestBaseBranches(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new DirtyPrScanError('NO_WORKFLOW_TEXT', 'The workflow text is empty, so its `pull_request` base filter cannot be read.');
  }
  const lines = text.split(/\r?\n/);

  let i = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  if (i === -1) {
    throw new DirtyPrScanError('NO_ON_BLOCK', 'The workflow has no top-level `on:` block, so its triggers cannot be read.');
  }

  // Walk the `on:` block for `pull_request:`; a line starting in column 0 ends it.
  let prIndent = -1;
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== '' && /^\S/.test(line)) break;
    const m = /^(\s+)pull_request:\s*(#.*)?$/.exec(line);
    if (m) {
      prIndent = m[1].length;
      break;
    }
  }
  if (prIndent === -1) {
    throw new DirtyPrScanError(
      'NO_PULL_REQUEST_TRIGGER',
      'The workflow has no `pull_request:` trigger. This gate exists to explain why a ' +
        '`pull_request` lane is absent; against a workflow that has no such trigger the ' +
        'question is meaningless, and answering it anyway would be a guess.',
    );
  }

  // Walk `pull_request:`'s own body for `branches:`; anything at or left of its
  // indent ends it (that is `push:`, whose own `branches: [main]` must not be read here).
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= prIndent) return null; // `pull_request:` had no `branches:` filter.

    const flow = /^\s*branches:\s*\[([^\]]*)\]\s*(#.*)?$/.exec(line);
    if (flow) return finishBranches(splitFlowList(flow[1]));

    if (/^\s*branches:\s*(#.*)?$/.test(line)) {
      const items = [];
      for (i += 1; i < lines.length; i += 1) {
        // Blank and comment lines are legal between YAML sequence items and do
        // not end the list; breaking on them silently truncates it.
        if (lines[i].trim() === '' || /^\s*#/.test(lines[i])) continue;
        const item = /^\s*-\s*(.+?)\s*$/.exec(lines[i]);
        if (!item) break;
        items.push(stripQuotes(item[1]));
      }
      return finishBranches(items);
    }
  }
  return null;
}

/** @param {string} raw */
function splitFlowList(raw) {
  return raw
    .split(',')
    .map((v) => stripQuotes(v.trim()))
    .filter((v) => v !== '');
}

/** @param {string} v */
function stripQuotes(v) {
  return v.replace(/^['"]|['"]$/g, '');
}

/** @param {string[]} branches */
function finishBranches(branches) {
  if (branches.length === 0) {
    throw new DirtyPrScanError(
      'EMPTY_BASE_BRANCHES',
      'The workflow declares a `pull_request` `branches:` filter with no entries. Every PR ' +
        'would read as base-filtered, which is a wrong verdict rather than a missing one.',
    );
  }
  for (const b of branches) {
    if (/[*?[\]!+]/.test(b)) {
      throw new DirtyPrScanError(
        'UNSUPPORTED_BRANCH_PATTERN',
        `The \`pull_request\` \`branches:\` filter contains the glob \`${b}\`, which this gate ` +
          'does not evaluate. Matching it wrongly would hand a PR a remedy that cannot work; ' +
          'teach this function the pattern syntax instead of guessing.',
      );
    }
  }
  return branches;
}
