/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure helpers for reading and ordering a clash result the way a reviewer
 * thinks about it: how deep the overlap is, whether a "clash" is really just a
 * face/edge contact, and which conflicts to look at first.
 *
 * Severity itself is a property of the *element-type pair* (see
 * {@link inferClashSeverity}), NOT of the overlap geometry — so a deep pipe-vs-
 * beam interpenetration and a shallow one share a severity. These helpers add
 * the geometric dimension (depth) so the two can be combined when prioritising.
 */

import type { Clash, ClashResult, ClashRuleCoverage, ClashSeverity } from './types.js';

/** Severity ordering, most-severe first (lower rank = more severe). */
export const SEVERITY_RANK: Record<ClashSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/**
 * Overlap (penetration) depth of a clash in metres, always `>= 0`.
 *
 * A `hard` clash carries a *signed* `distance` (`< 0` = interpenetration), so
 * its depth is `-distance`. `clearance`/`touch` clashes are separated (no
 * penetration) and report depth `0`. This is the right key for "sort by how
 * badly things overlap" (#1274).
 */
export function penetrationDepth(c: Clash): number {
  return c.distance < 0 ? -c.distance : 0;
}

/** Default band (m) under which a `hard` clash is really a face/edge *contact*
 *  rather than a genuine interpenetration — see {@link isTouching}. Also the
 *  floor for {@link touchingEpsilonFor}'s scale-relative default: near the
 *  origin this constant IS the default (bit-for-bit), it only grows once the
 *  pair's own coordinate magnitude pushes the f32 noise floor past it. */
export const TOUCHING_EPSILON = 1e-4;

/**
 * f32-ULP scale factor for a "worst-case" single-precision coordinate: for a
 * value with magnitude in `[2, 4)` the true float32 ULP is `2^-22`, and for
 * larger magnitudes the ULP only grows. Same term (and reasoning) as
 * `precisionFloor` in `engine-ts/narrow.ts` and `narrowPhase`'s `planeEps` in
 * `contact/narrow-phase.ts` — kept local because this is a different job
 * (the *reported* touching band, not the narrow-phase's own depth floor) on
 * a `Clash`, which doesn't carry the element bounds those two derive from.
 */
const F32_ULP_SCALE = 1 / 4_194_304; // 2^-22

/**
 * The touching band for one specific clash, scaled to that clash's own
 * coordinate magnitude rather than a fixed constant.
 *
 * Geometry is ingested from f32 buffers, so a fixed `TOUCHING_EPSILON` is
 * only valid near the origin: the f32 ULP exceeds `1e-4` above roughly 1 km
 * from the origin (a `Clash`'s own coordinate magnitude — see below — decides
 * exactly where). Past that distance, a genuinely flush pair (a wall meeting
 * a slab) can pick up more than `1e-4` of pure rounding noise in its measured
 * penetration depth, and the fixed band then misses it, letting it reappear
 * as a hard clash in a list the user asked to de-noise.
 *
 * `Clash` carries no element bounds (that lives on `ClashElement`, not on the
 * detection result), but it does carry `bounds` — the contact/overlap region
 * itself, in the same world coordinates as the elements — so that is the
 * scale source: the max absolute coordinate over the clash's own contact
 * box. Floored at {@link TOUCHING_EPSILON} (not the raw single-unit f32
 * floor `precisionFloor` uses) so a clash near the origin gets exactly the
 * old fixed band, unchanged.
 */
function touchingEpsilonFor(c: Clash): number {
  let extent = 0;
  for (const v of [c.bounds.min, c.bounds.max]) {
    for (const coord of v) {
      const a = Math.abs(coord);
      if (a > extent) extent = a;
    }
  }
  return Math.max(TOUCHING_EPSILON, extent * F32_ULP_SCALE);
}

/**
 * Whether a clash is effectively a zero-distance *contact* rather than a real
 * overlap (#1273). True for `touch`-status clashes and for `hard` clashes whose
 * penetration is within `eps` — typically coincident faces (a wall meeting a
 * slab, a column sitting on a footing) reported with a ~0 m depth, which users
 * reasonably distrust when they appear in the clash list.
 *
 * `eps` defaults to {@link touchingEpsilonFor}, scaled to this clash's own
 * coordinate magnitude (see that function) so the touching band stays valid
 * far from the origin. An explicit `eps` overrides the default entirely.
 */
export function isTouching(c: Clash, eps: number = touchingEpsilonFor(c)): boolean {
  return c.status === 'touch' || (c.status === 'hard' && penetrationDepth(c) <= eps);
}

/**
 * Whether a rule's selectors matched anything to compare in this model. A rule
 * with an empty `a` side, or (for a two-sided rule) an empty `b` side, never
 * ran a single geometric comparison — it isn't "clean", it never ran.
 */
export function ruleHadNoMatch(coverage: ClashRuleCoverage): boolean {
  return coverage.matchedA === 0 || coverage.matchedB === 0;
}

/**
 * The three outcomes a clash run can report, distinguished by rule coverage
 * rather than by clash count — zero clashes is a legitimate result (`clean`)
 * and must be told apart from zero because the matrix never had anything to
 * test (`no-match`):
 *
 * - `clean`:      every rule matched elements on both sides; zero clashes (if
 *                 any) is a real "checked and found nothing".
 * - `partial`:    at least one rule matched, but at least one other rule in
 *                 the set matched nothing on one of its sides.
 * - `no-match`:   every single rule matched nothing on at least one side — the
 *                 matrix ran zero real comparisons, and any "0 clashes" is
 *                 meaningless. Distinct from `unknown` (no coverage data) so a
 *                 caller can render "the matrix didn't apply to this model" as
 *                 a loud, first-class state.
 * - `unknown`:    no coverage data was supplied (e.g. an older result, or a
 *                 hand-built fixture) — callers should fall back to
 *                 presenting the summary count alone.
 */
export type RuleCoverageOutcome = 'clean' | 'partial' | 'no-match' | 'unknown';

export function classifyRuleCoverage(result: Pick<ClashResult, 'ruleCoverage'>): RuleCoverageOutcome {
  const coverage = result.ruleCoverage;
  if (!coverage || coverage.length === 0) return 'unknown';
  const emptyCount = coverage.filter(ruleHadNoMatch).length;
  if (emptyCount === 0) return 'clean';
  if (emptyCount === coverage.length) return 'no-match';
  return 'partial';
}

export type ClashSortBy = 'severity' | 'depth' | 'distance';

function cmpId(a: Clash, b: Clash): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Return a NEW array of clashes ordered by the chosen key. Ties fall back to the
 * stable clash id so the order is deterministic across runs.
 * - `severity`: most severe first, then deepest overlap (the panel default).
 * - `depth`:    deepest interpenetration first (#1274 — prioritise real problems).
 * - `distance`: smallest signed distance first (deepest penetration → widest gap).
 */
export function sortClashes(clashes: readonly Clash[], by: ClashSortBy): Clash[] {
  const out = clashes.slice();
  switch (by) {
    case 'severity':
      out.sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          penetrationDepth(b) - penetrationDepth(a) ||
          cmpId(a, b),
      );
      break;
    case 'depth':
      out.sort((a, b) => penetrationDepth(b) - penetrationDepth(a) || cmpId(a, b));
      break;
    case 'distance':
      out.sort((a, b) => a.distance - b.distance || cmpId(a, b));
      break;
  }
  return out;
}
