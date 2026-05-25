/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scoring for mined patterns.
 *
 * Combines three signals into a single ranking score:
 *
 *   - **Frequency**: raw occurrence count.
 *   - **Recency**: exponential decay from `lastSeenAt`. Patterns the
 *     user did this week outrank patterns from a month ago.
 *   - **Session diversity**: how many distinct sessions touched the
 *     pattern. A 5-times-in-one-day pattern matters less than a
 *     3-times-across-3-days one.
 *
 * Caller picks the top-K to surface. We never auto-execute suggestions;
 * the score only drives display order.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §3.2.
 */

import type { MinedPattern, ScoringOptions } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS: Required<Omit<ScoringOptions, 'now'>> = {
  frequencyWeight: 1.0,
  recencyWeight: 0.5,
  sessionsWeight: 0.3,
  recencyHalfLifeDays: 14,
};

/** Score a single pattern. The pattern is returned with its `score` field set. */
export function scorePattern(pattern: MinedPattern, opts: ScoringOptions = {}): MinedPattern {
  const o = { ...DEFAULTS, ...opts };
  const now = opts.now ?? new Date();
  const ageDays = Math.max(0, (now.getTime() - Date.parse(pattern.lastSeenAt)) / DAY_MS);
  const recency = Math.pow(0.5, ageDays / o.recencyHalfLifeDays);
  const frequency = pattern.occurrences;
  const sessions = pattern.sessionsTouched;
  const score =
    o.frequencyWeight * frequency
    + o.recencyWeight * recency * frequency
    + o.sessionsWeight * sessions;
  return { ...pattern, score };
}

/** Score and sort an array of patterns. Higher score first. Returns a new array. */
export function scorePatterns(
  patterns: readonly MinedPattern[],
  opts: ScoringOptions = {},
): MinedPattern[] {
  return patterns.map((p) => scorePattern(p, opts)).sort((a, b) => b.score - a.score);
}

/** Take the top N patterns after scoring. */
export function topPatterns(
  patterns: readonly MinedPattern[],
  n: number,
  opts: ScoringOptions = {},
): MinedPattern[] {
  return scorePatterns(patterns, opts).slice(0, Math.max(0, n));
}
