/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tokenizer both search tiers share. Tier-1 indexes these tokens and, when
 * no field contains the whole query, matches an entry whose tokens cover every
 * query token as a prefix (TOKEN_MATCH). Tier-0 applies the same fallback, so a
 * multi-word query ("Room A", "wall basement") returns the same rows before and
 * after the tier-1 index is ready.
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

/**
 * True when every query token is a prefix of some token of the given fields
 * (tier-1's TOKEN_MATCH rule). `fields` are already lower-cased. Allocation-free
 * until every token has passed the cheap substring check (a prefix of a field
 * token is a substring of that field), which rejects almost every row.
 */
export function tokensCover(queryTokens: readonly string[], a: string, b: string, c: string, d: string): boolean {
  for (const qt of queryTokens) {
    if (!a.includes(qt) && !b.includes(qt) && !c.includes(qt) && !d.includes(qt)) return false;
  }
  const tokens = [...tokenizeSearchText(a), ...tokenizeSearchText(b), ...tokenizeSearchText(c), ...tokenizeSearchText(d)];
  return queryTokens.every((qt) => tokens.some((t) => t.startsWith(qt)));
}
