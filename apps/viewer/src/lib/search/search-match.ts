/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one match rule both search tiers apply, so a search returns the same rows
 * before the tier-1 index exists (Tier-0 scan) and after (tier-1 query).
 *
 * Per model:
 * 1. A row is a candidate when a query token is a prefix of one of its tokens
 *    (name, type, description, object type); `hits` counts such query tokens.
 * 2. A candidate scores by the substring ladder (`substringMatch`), else
 *    TOKEN_MATCH when every query token hit.
 * 3. Only when the model has no candidate at all, and the needle is shorter
 *    than 3 characters or contains a separator, every row is swept by the
 *    substring ladder.
 * An exact GlobalId match (GUID_EXACT) outranks all of it; each tier looks it
 * up in its own structure.
 *
 * Tier-1 finds candidates through its token postings, Tier-0 by scanning rows
 * with `rowTokenHits`; both then resolve through `resolveModelMatches`.
 */

import type { MatchField } from './tier0-scan.js';
import { tokenizeSearchText } from './search-tokens.js';

export const SCORE = {
  GUID_EXACT: 1000,
  NAME_EXACT: 500,
  NAME_PREFIX: 100,
  TYPE_EXACT: 80,
  TOKEN_MATCH: 70,
  TYPE_PREFIX: 60,
  NAME_SUBSTR: 40,
  OBJECTTYPE_SUBSTR: 20,
  DESCRIPTION_SUBSTR: 10,
} as const;

/** A row's searchable text, lower-cased. */
export interface SearchRowText {
  nameLower: string;
  typeNameLower: string;
  descriptionLower: string;
  objectTypeLower: string;
}

export interface SearchQuery {
  needle: string;
  tokens: readonly string[];
  /** Whether a model with no candidate is swept by substring (rule 3). */
  sweep: boolean;
}

export interface RowMatch {
  score: number;
  matchField: MatchField;
}

/** `trimmed` is the query without surrounding whitespace. */
export function prepareSearchQuery(trimmed: string): SearchQuery {
  const needle = trimmed.toLowerCase();
  return { needle, tokens: tokenizeSearchText(trimmed), sweep: needle.length < 3 || /[\s\-_./:]/.test(needle) };
}

/** The substring ladder; a later field wins only with a strictly higher score. */
export function substringMatch(row: SearchRowText, needle: string): RowMatch | null {
  let best: RowMatch | null = null;
  const bump = (score: number, matchField: MatchField) => { if (!best || best.score < score) best = { score, matchField }; };
  if (row.nameLower) {
    if (row.nameLower === needle) bump(SCORE.NAME_EXACT, 'name');
    else if (row.nameLower.startsWith(needle)) bump(SCORE.NAME_PREFIX, 'name');
    else if (row.nameLower.includes(needle)) bump(SCORE.NAME_SUBSTR, 'name');
  }
  if (row.typeNameLower === needle) bump(SCORE.TYPE_EXACT, 'type');
  else if (row.typeNameLower.startsWith(needle)) bump(SCORE.TYPE_PREFIX, 'type');
  if (row.objectTypeLower && row.objectTypeLower.includes(needle)) bump(SCORE.OBJECTTYPE_SUBSTR, 'objectType');
  if (row.descriptionLower && row.descriptionLower.includes(needle)) bump(SCORE.DESCRIPTION_SUBSTR, 'description');
  return best;
}

/**
 * How many query tokens are a prefix of one of the row's tokens (rule 1).
 * A token that occurs in no field is rejected without tokenizing the row
 * (a token prefix is a substring of its field).
 */
export function rowTokenHits(row: SearchRowText, tokens: readonly string[]): number {
  let hits = 0;
  let rowTokens: string[] | null = null;
  for (const qt of tokens) {
    if (!row.nameLower.includes(qt) && !row.typeNameLower.includes(qt) && !row.descriptionLower.includes(qt) && !row.objectTypeLower.includes(qt)) continue;
    rowTokens ??= [...tokenizeSearchText(row.nameLower), ...tokenizeSearchText(row.typeNameLower),
      ...tokenizeSearchText(row.descriptionLower), ...tokenizeSearchText(row.objectTypeLower)];
    if (rowTokens.some((t) => t.startsWith(qt))) hits++;
  }
  return hits;
}

/**
 * One model's matches (rules 1-3). `candidates` maps each candidate row to its
 * hit count. `sweepMatches` yields `substringMatch` for every row; it is only
 * consumed when the model has no candidate and the query allows a sweep.
 */
export function resolveModelMatches<R>(
  candidates: ReadonlyMap<R, number>,
  sweepMatches: () => Iterable<[R, RowMatch]>,
  text: (row: R) => SearchRowText,
  query: SearchQuery,
): Map<R, RowMatch> {
  const out = new Map<R, RowMatch>();
  for (const [row, hits] of candidates) {
    const match = substringMatch(text(row), query.needle)
      ?? (query.tokens.length > 0 && hits === query.tokens.length ? { score: SCORE.TOKEN_MATCH, matchField: 'name' as MatchField } : null);
    if (match) out.set(row, match);
  }
  if (candidates.size === 0 && query.sweep) for (const [row, match] of sweepMatches()) out.set(row, match);
  return out;
}

/** `sweepMatches` over `rows` by the substring ladder. */
export function* substringMatches<R>(rows: Iterable<R>, text: (row: R) => SearchRowText, needle: string): Iterable<[R, RowMatch]> {
  for (const row of rows) {
    const match = substringMatch(text(row), needle);
    if (match) yield [row, match];
  }
}
