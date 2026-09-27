/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The snap solver. One call per pointer move:
 *   1. build the constraint locus from the typed locks / modifiers;
 *   2. collect candidates from the profile's sources (radius + hysteresis, so
 *      a held target stays collectable while it is in the leave band);
 *   3. add inferred candidates (extension, perpendicular, parallel, axis
 *      tracking, guide intersections);
 *   4. project every candidate onto the locus;
 *   5. rank by tier, then distance, with hysteresis;
 *   6. fall back to the constrained raw cursor.
 * The grid is an ordinary source whose `grid` kind sits in the lowest tier,
 * so it only wins when no geometric target is in range.
 *
 * Invariants (pinned by solve.test.ts): the result lies on the locus; a
 * winner's landing point is within the radius of the constrained cursor
 * (radius + hysteresis only for the held winner); a better tier in range
 * always beats a worse one.
 */

import { buildLocus, dist, locusGuides, projectCandidate, projectOntoLocus } from './constraints.js';
import { inferCandidates } from './inference.js';
import { DEFAULT_HYSTERESIS_PX, pickWinner, tierOf, type Ranked } from './rank.js';
import type { Guide, SnapCandidate, SnapProfile, SnapQuery, SnapResult, SnapSource } from './types.js';

export function solveSnap(
  q: SnapQuery,
  sources: readonly SnapSource[],
  p: SnapProfile,
  prev?: SnapResult,
): SnapResult {
  const locus = buildLocus(q, p);
  const lockGuides = locusGuides(locus);
  const locked = locus.kind !== 'free';
  const cursor = projectOntoLocus(q.cursor, locus);
  const fallback: SnapResult = { local: cursor, winner: null, guides: lockGuides, locked };
  // A fully determined lock (length + direction) leaves nothing to snap.
  if (locus.kind === 'point' || q.modifiers.alt) return fallback;
  const mpp = q.metresPerPixel;
  if (!(mpp > 0) || !Number.isFinite(mpp)) return fallback;

  const radius = p.radiusPx * mpp;
  const hysteresis = (p.hysteresisPx ?? DEFAULT_HYSTERESIS_PX) * mpp;
  const reach = radius + hysteresis;

  const candidates: SnapCandidate[] = [];
  const wanted = new Set(p.sources);
  for (const s of sources) if (wanted.has(s.id)) s.collect(q, reach, candidates);
  inferCandidates(q, cursor, reach, candidates, candidates);

  const tiers = locked ? (p.lockedTiers ?? p.tiers) : p.tiers;
  const ranked: Ranked[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const tier = tierOf(cand.kind, tiers);
    if (tier < 0) continue;
    const point = projectCandidate(cand, locus, cursor);
    if (!point) continue;
    ranked.push({ cand, point, dist: dist(point, cursor), tier, order: i });
  }

  const win = pickWinner(ranked, radius, hysteresis, prev?.winner ?? null);
  if (!win) return fallback;
  const guides: Guide[] = [...lockGuides];
  if (win.cand.guide) guides.push(win.cand.guide);
  if (win.cand.trace) guides.push(...win.cand.trace);
  return { local: win.point, winner: win.cand, guides, locked };
}
