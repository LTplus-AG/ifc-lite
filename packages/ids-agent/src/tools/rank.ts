/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lexical ranking for lookup tools. Deterministic and dependency-free: exact
 * match, then prefix, then every query token contained, then a bounded edit
 * distance for typos. The `Ifc` prefix and case are ignored.
 */

function fold(value: string): string {
  return value.toLowerCase().replace(/^ifc/, '').replace(/[\s_-]+/g, '');
}

/** Split `FireRating`, `fire rating`, `fire_rating` into lower-case tokens. */
function tokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && t !== 'ifc');
}

function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length];
}

function score(query: string, queryTokens: readonly string[], name: string): number {
  const folded = fold(name);
  if (folded === query) return 100;
  if (folded.startsWith(query)) return 80 - Math.min(20, folded.length - query.length);
  const nameTokens = tokens(name);
  const all = queryTokens.length > 0 && queryTokens.every((q) => nameTokens.some((t) => t.startsWith(q)) || folded.includes(q));
  if (all) return 60 - Math.min(20, folded.length - query.length);
  if (folded.includes(query)) return 50;
  const cap = Math.max(1, Math.floor(query.length / 4));
  const d = distance(query, folded, cap);
  return d <= cap ? 40 - d * 5 : 0;
}

/** The best `limit` names for `query`, best first; ties keep the input order. */
export function rankNames(query: string, names: readonly string[], limit: number): string[] {
  const q = fold(query);
  if (!q) return [];
  const qt = tokens(query);
  return names
    .map((name, index) => ({ name, index, s: score(q, qt, name) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.name);
}
