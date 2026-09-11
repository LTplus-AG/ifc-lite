/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Skip a comment-delimiter-bounded region atomically, starting at the index
 * of its opening `/` marker (caller has already checked `text[i] === '/' &&
 * text[i + 1] === '*'`). Returns the index one past the region's end — the
 * matching close marker, or end-of-text when unterminated — so its content
 * (a comma, an unbalanced paren, an odd number of `'`) is skipped as one
 * unit rather than read as argument-list structure. Shared by both
 * `step-argument-parser.ts` splitters so the skip rule can't drift between
 * them again (#4227: `splitTopLevelArgs` shipped with no comment handling
 * at all while `splitTopLevelStepArguments` had this same logic inline).
 */
export function skipStepComment(text: string, i: number): number {
  const end = text.indexOf('*/', i + 2);
  return end === -1 ? text.length : end + 2;
}
