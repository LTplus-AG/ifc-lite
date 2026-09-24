/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The comparison under a two-way count ratchet: a measured `{ key: count }`
 * map against a committed baseline of the same shape. Shared by
 * `scripts/check-jsx-a11y.mjs` (key = source file, count = jsx-a11y
 * warnings) and the axe scan in `tests/e2e/axe-baseline.ts` (key = axe
 * rule id, count = 1 while the rule is violated), so both gates agree on
 * what "went up" and "went down" mean (#5607).
 *
 * Two-way, the same rule `check-i18n-literals.mjs` and
 * `check-unused-locals.mjs` apply: a count ABOVE its row is a regression,
 * and a count BELOW its row (including a key that is gone entirely) is slack
 * the baseline must give up, or the next regression spends it unnoticed.
 * A key missing from the baseline has an allowance of zero.
 *
 * @param {Record<string, number>} counts   measured now; zero-count keys may be omitted
 * @param {Record<string, number>} baseline committed allowance
 * @returns {{
 *   regressions: Array<{ key: string, count: number, allowed: number }>,
 *   improvements: Array<{ key: string, count: number, allowed: number }>,
 * }} both sorted by key
 */
export function compareToBaseline(counts, baseline) {
  const regressions = [];
  const improvements = [];
  const keys = [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort();
  for (const key of keys) {
    const count = counts[key] ?? 0;
    const allowed = baseline[key] ?? 0;
    if (count > allowed) regressions.push({ key, count, allowed });
    else if (count < allowed) improvements.push({ key, count, allowed });
  }
  return { regressions, improvements };
}
