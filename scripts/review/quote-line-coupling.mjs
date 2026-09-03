#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE QUOTE/LINE COUPLING CHECK, split out of `validate-findings.mjs` because
 * that file crossed its size budget, not because this stopped belonging there.
 *
 * A finding from the reviewer names a `quote` (the evidence) and a `line` (where
 * it claims that evidence lives). These four functions are the whole machinery
 * `validate-findings.mjs` uses to hold those two claims to the same diff: is the
 * quote the text of some line of the patch at all (`quotableLines`,
 * `quoteAppearsIn`), and does the claimed line number actually fall inside the
 * lines the PR added (`lineIsAdded`, `addedLinesMatching`)? Re-exported from
 * `validate-findings.mjs` so every existing import path is unchanged.
 */

// The SAME walker `addedLineRanges` is built on, not a second hand-rolled one.
// A per-finding check that re-derived new-file line numbers on its own would be
// exactly the failure this file exists to close one layer up: two things that
// must agree, computed twice, agreeing with each other only until a hunk that
// does not start at line 1 shows they never did. See `addedLinesMatching` below.
import { newFileLines } from './build-review-input.mjs';

/**
 * The lines of a unified diff a quote may legitimately come from, each with its
 * diff marker removed and trimmed.
 *
 * NOT `patch.includes(quote)`. That accepts a fragment spanning a line boundary,
 * a substring of a longer identifier, and -- the one that matters -- the text of
 * the hunk header or the `+++ b/path` line, none of which require having read any
 * code. Whole-line equality after trimming is both stricter (no fragments) and
 * more forgiving where it should be (trailing whitespace and the diff marker do
 * not decide whether a quote counts).
 *
 * @param {string} patch
 * @returns {string[]}
 */
export function quotableLines(patch) {
  const out = [];
  for (const line of String(patch).split(/\r?\n/)) {
    // Hunk headers, file headers and the no-newline note are diff METADATA. A
    // model that quotes one has demonstrated nothing about the code.
    if (line.startsWith('@@') || line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('\\')) {
      continue;
    }
    const marker = line[0];
    const body = marker === '+' || marker === '-' || marker === ' ' ? line.slice(1) : line;
    const trimmed = body.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

/**
 * Does `quote` name a whole line of `patch`, and is it long enough to be evidence?
 *
 * @param {string} patch
 * @param {string} quote
 * @param {number} minChars
 */
export function quoteAppearsIn(patch, quote, minChars) {
  const needle = String(quote).trim();
  if (needle.length < minChars) return false;
  return quotableLines(patch).includes(needle);
}

/** @param {number} line @param {[number, number][]} ranges */
export function lineIsAdded(line, ranges) {
  if (!Number.isInteger(line) || line < 1) return false;
  return ranges.some(([start, end]) => line >= start && line <= end);
}

/**
 * The COUPLING CHECK: new-file line numbers of `patch`'s ADDED lines whose
 * text -- trimmed the same way `quotableLines` trims -- equals `quote` trimmed.
 *
 * ADDED lines only, on purpose. `newFileLines` also numbers context and removed
 * lines, and a quote that matches one of those is not evidence the PR added
 * anything at that line -- `lineIsAdded` would refuse it anyway, but this stays
 * consistent with that gate rather than silently accepting a wider set here.
 *
 * AMBIGUOUS CASES, decided:
 *   - THE QUOTE APPEARS MORE THAN ONCE (two added lines with identical text,
 *     e.g. two blank `return null;` guards). Both line numbers come back here;
 *     the caller does not have to pick one, because it already has a claimed
 *     `f.line` to check membership against. Matching AT a specific line is what
 *     makes "appears somewhere" ambiguity irrelevant -- the finding is valid
 *     exactly when its own claimed line is one of the matches, whichever line
 *     that is.
 *   - WHITESPACE / INDENTATION. Trimmed on both sides, same as `quotableLines`
 *     and `newFileLines` -- a quote is not disqualified by re-indentation, and
 *     was never required to reproduce it.
 *   - A QUOTE SPANNING MULTIPLE LINES. Never matches: `newFileLines` yields one
 *     row per source line, so a multi-line `quote` cannot equal any single
 *     row's `text`. This is the same behaviour `quotableLines` already had --
 *     a multi-line quote never matched a single element of that array either --
 *     so nothing here is loosened or tightened by not special-casing it.
 *   - THE QUOTE DOES NOT APPEAR AT ALL. Returns `[]`, and the caller drops the
 *     finding with "quote is not the text of any added line".
 *
 * @param {string} patch
 * @param {string} quote
 * @returns {number[]}
 */
export function addedLinesMatching(patch, quote) {
  const needle = String(quote).trim();
  if (needle === '') return [];
  const out = [];
  for (const row of newFileLines(patch)) {
    if (row.kind === 'added' && row.text.trim() === needle) out.push(row.line);
  }
  return out;
}

