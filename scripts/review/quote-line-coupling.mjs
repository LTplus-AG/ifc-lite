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
// The SAME classifier `newFileLines` uses (#3802). Two independent answers to
// "is this line a file header" is the shape one layer up from the one this file
// exists to close.
import { unifiedDiffLineKind } from '../lib/unified-diff.mjs';
// Paths reach a log the workflow greps with anchored patterns, and a git path may
// contain any byte but NUL and `/` -- a newline included. `sanitizePath`'s
// whitespace collapse is what stops one forging a reason line (see below).
import { sanitizePath } from './lib/finding-sanitizers.mjs';

/**
 * Is `path` itself an archived unified diff (#5563)? Evidence PRs commit a
 * `.patch` or `.diff` file without applying it, so every line of that file's
 * PR patch carries TWO markers: the outer one from the PR diff and the inner
 * one from the archived diff (`++    return x;`). A reviewer quoting the source
 * line it read quotes it without the inner marker, exactly as it would quote
 * the same line in a `.ts` file without the outer one.
 *
 * BY PATH, NOT BY SNIFFING CONTENT. A line of ordinary code may start with `+`
 * or `-` (a wrapped `+ b` continuation, a `-1` literal); stripping one there
 * would accept a quote that is a FRAGMENT of the real line, which is exactly
 * what whole-line equality exists to refuse. Only a file whose documented
 * format is a unified diff has an inner marker to strip.
 *
 * @param {string | undefined} path
 */
export function isArchivedDiff(path) {
  return typeof path === 'string' && /\.(?:patch|diff)$/i.test(path);
}

/**
 * A walker over an archived diff's lines, in order, that answers each line's
 * inner-diff content, or `null` when there is no inner marker to remove.
 *
 * STATEFUL, BY POSITION, for the same reason `quotableLines` is (#3802): inside
 * the archive, `--- a/f.ts`, `+++ b/f.ts` and a `git format-patch` preamble
 * (`- bullet` in a commit message) start with a marker character but are NOT
 * inner added or removed lines. Only a line inside an inner hunk has an inner
 * marker. The inner state opens at an inner `@@` and closes at an inner
 * `diff --git` (the next file of the archive). It also closes at each OUTER hunk
 * boundary: the lines between two outer hunks were never sent, so whether the
 * next one is inside an inner hunk is unknown, and unknown keeps the pre-#5563
 * behaviour of no second form. Context lines need nothing, because their inner
 * marker is a space, which trimming already removes.
 *
 * @returns {{ outerHunk(): void, next(text: string): string | null }}
 */
function innerDiffWalker() {
  let insideInnerHunk = false;
  return {
    outerHunk() {
      insideInnerHunk = false;
    },
    next(text) {
      if (text.startsWith('diff --git ')) {
        insideInnerHunk = false;
        return null;
      }
      const kind = unifiedDiffLineKind(text, insideInnerHunk);
      if (kind === 'hunk') {
        insideInnerHunk = true;
        return null;
      }
      return insideInnerHunk && (kind === 'added' || kind === 'removed') ? text.slice(1) : null;
    },
  };
}

/**
 * The texts a single line may be quoted as, trimmed: always its own text, plus
 * its inner-diff content when it has one (#5563). Both stay whole lines, so a
 * fragment of either is still refused.
 *
 * @param {string} text - the line with its OUTER marker already removed.
 * @param {string | null} inner - from `innerDiffWalker().next`, or null.
 */
function quotableForms(text, inner) {
  const forms = [text.trim()];
  if (inner !== null) forms.push(inner.trim());
  return forms.filter((f) => f !== '');
}

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
 * Pass the file's `path` so an archived `.patch`/`.diff` also offers each
 * line's inner-diff content (see `isArchivedDiff`).
 *
 * @param {string} patch
 * @param {{ path?: string }} [opts]
 * @returns {string[]}
 */
export function quotableLines(patch, { path } = {}) {
  const inner = isArchivedDiff(path) ? innerDiffWalker() : null;
  const out = [];
  // BY POSITION, NOT BY PREFIX. `---`/`+++` are file headers only BEFORE the
  // first `@@`; after it they are content that happens to start the same way --
  // a deleted `-- old sql comment` is the raw line `--- old sql comment`, and an
  // added `++ new sql comment` is `+++ new sql comment`. #3802 moved
  // `newFileLines` onto this rule and left this function on the prefix, so the
  // two halves of one check disagreed about the same diff: `addedLinesMatching`
  // would anchor a finding that `quoteAppearsIn` then refused as metadata.
  let insideHunk = false;
  for (const line of String(patch).split(/\r?\n/)) {
    // Hunk headers, file headers and the no-newline note are diff METADATA. A
    // model that quotes one has demonstrated nothing about the code.
    const kind = unifiedDiffLineKind(line, insideHunk);
    if (kind === 'hunk') {
      insideHunk = true;
      inner?.outerHunk();
      continue;
    }
    if (kind === 'metadata' || kind === 'header') continue;
    const marker = line[0];
    const body = marker === '+' || marker === '-' || marker === ' ' ? line.slice(1) : line;
    out.push(...quotableForms(body, inner ? inner.next(body) : null));
  }
  return out;
}

/**
 * Does `quote` name a whole line of `patch`, and is it long enough to be evidence?
 *
 * @param {string} patch
 * @param {string} quote
 * @param {number} minChars
 * @param {{ path?: string }} [opts] - the file's path; see `quotableLines`.
 */
export function quoteAppearsIn(patch, quote, minChars, opts = {}) {
  const needle = String(quote).trim();
  if (needle.length < minChars) return false;
  return quotableLines(patch, opts).includes(needle);
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
 *   - AN ARCHIVED `.patch`/`.diff` (#5563). A line matches on its own text OR
 *     on its inner-diff content, the same two forms `quotableLines` offers, so
 *     the per-finding anchor and the proof-of-work quote accept the same
 *     quotes. Pass the file's `path` to get this. One consequence: a quote
 *     can now match two added lines (a `+x` and an `x` in the same archive),
 *     and a finding whose `line` names neither is then dropped rather than
 *     re-anchored, as for any repeated line.
 *
 * @param {string} patch
 * @param {string} quote
 * @param {{ path?: string }} [opts]
 * @returns {number[]}
 */
export function addedLinesMatching(patch, quote, { path } = {}) {
  const needle = String(quote).trim();
  if (needle === '') return [];
  const inner = isArchivedDiff(path) ? innerDiffWalker() : null;
  const out = [];
  // Every row goes through the walker, context and removed included, because
  // the inner hunk state depends on all of them; only ADDED rows can match.
  for (const row of newFileLines(patch)) {
    if (row.kind === 'hunk') {
      inner?.outerHunk();
      continue;
    }
    const innerText = inner ? inner.next(row.text) : null;
    if (row.kind === 'added' && quotableForms(row.text, innerText).includes(needle)) out.push(row.line);
  }
  return out;
}

/**
 * Explain a proof quote attributed to the wrong reviewed file (#3769).
 * Diagnostic only: the caller has already rejected the quote against its
 * claimed patch. Finding it elsewhere improves the one corrective retry but
 * never weakens the proof-of-work decision.
 *
 * THE SEARCH IS OVER ADDED LINES, not `quoteAppearsIn`. That helper answers "is
 * this a line of the patch", CONTEXT and REMOVED lines included -- text the PR
 * did not add. Naming a file on that basis produces a CONFIDENT remedy pointing
 * at the wrong hunk ("the correct `riskiest_change.path` is X" about a line X
 * never added), which is worse for the one corrective retry than the plain
 * refusal it falls back to. `addedLinesMatching` is the predicate the
 * per-finding anchor already uses, so the diagnosis and the anchor agree; the
 * length floor is applied here because that helper has none.
 */
export function quotedLineFailureMessage(files, claimedPath, quote, minChars) {
  const claimedKey = normalizePathForSelfMatch(claimedPath);
  const elsewhere = [];
  const longEnough = String(quote).trim().length >= minChars;
  for (const [path, file] of files) {
    if (!longEnough) break;
    if (normalizePathForSelfMatch(path) === claimedKey) continue;
    if (addedLinesMatching(file.patch, quote, { path }).length > 0) elsewhere.push(path);
  }
  const base =
    `\`riskiest_change.quoted_line\` is not a line of \`${sanitizePath(claimedPath)}\`'s patch (or is shorter than ` +
    `${minChars} characters, which would not be evidence of anything): ` +
    `${JSON.stringify(String(quote).slice(0, 120))}.`;
  if (elsewhere.length === 1) {
    return (
      `${base} This exact line IS an added line of \`${sanitizePath(elsewhere[0])}\`'s patch instead -- the ` +
      `file attribution is wrong, not the quote. REMEDY: re-run; the correct \`riskiest_change.path\` is ` +
      `\`${sanitizePath(elsewhere[0])}\`.`
    );
  }
  if (elsewhere.length > 1) {
    const named = elsewhere.map((path) => `\`${sanitizePath(path)}\``).join(', ');
    return (
      `${base} This exact line IS an added line of ${elsewhere.length} other reviewed files instead (${named}) ` +
      '-- the file attribution is wrong, but which one it belongs to cannot be told from the quote alone. ' +
      'REMEDY: re-run and name the specific file the quote came from.'
    );
  }
  return (
    `${base} This is the one thing a model that quit early cannot fake. REMEDY: re-run. Quote a WHOLE ` +
    'line, not a fragment; and if the line you nominated is too long to reproduce exactly, nominate a ' +
    'SHORTER line from the same file instead -- any real line of the diff proves you read it.'
  );
}

/** Compare spellings only for excluding the claimed file from the search. */
function normalizePathForSelfMatch(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '');
}
