/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Did you mean" ranking: Damerau-Levenshtein (optimal string alignment)
 * similarity blended with token overlap, plus an optional caller boost
 * (e.g. property sets applicable to the spec's applicability entities).
 *
 * score = 0.6 · (1 − osa / maxLen) + 0.4 · jaccard(tokens) + boost
 *
 * Comparison is case-insensitive. Tokens split on case changes, digits and
 * separators, so `FireRatng` ↔ `FireRating` and `WallCommon` ↔
 * `Pset_WallCommon` both rank high.
 */

import type { GateCandidate } from './types.js';

/** Optimal-string-alignment distance (Damerau-Levenshtein with adjacent transpositions). */
export function osaDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur.push(d);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

export function tokens(s: string): Set<string> {
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
  return new Set(parts);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function similarity(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const maxLen = Math.max(q.length, c.length) || 1;
  const edit = 1 - osaDistance(q, c) / maxLen;
  return 0.6 * edit + 0.4 * jaccard(tokens(query), tokens(candidate));
}

export interface RankOptions {
  limit?: number;
  /** Candidates below this blended score (before boost) are dropped. */
  minScore?: number;
  boost?: (candidate: string) => { boost: number; reason?: string } | undefined;
}

/** The best-matching `pool` entries for `query`, best first. */
export function rankCandidates(query: string, pool: Iterable<string>, options: RankOptions = {}): GateCandidate[] {
  const { limit = 5, minScore = 0.3, boost } = options;
  const scored: GateCandidate[] = [];
  for (const value of pool) {
    const base = similarity(query, value);
    if (base < minScore) continue;
    const extra = boost?.(value);
    const score = Math.min(1, base + (extra?.boost ?? 0));
    scored.push(extra?.reason ? { value, score, reason: extra.reason } : { value, score });
  }
  scored.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
  return scored.slice(0, limit).map((c) => ({ ...c, score: Math.round(c.score * 1000) / 1000 }));
}
