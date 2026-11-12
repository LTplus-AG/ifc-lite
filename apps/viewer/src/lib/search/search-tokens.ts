/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tokenizer both search tiers share (the match rule is in search-match.ts).
 */

export const TOKEN_SPLIT = /[\s\-_./:]+/;

/** Lower-cased tokens; empty fragments and one-character non-digit tokens are dropped. */
export function tokenizeSearchText(value: string): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const p of value.toLowerCase().split(TOKEN_SPLIT)) {
    // One-char letters produce ~O(entities) postings with essentially no
    // selectivity, inflating the index for no query benefit.
    if (p.length === 0) continue;
    if (p.length === 1 && !/\d/.test(p)) continue;
    out.push(p);
  }
  return out;
}
