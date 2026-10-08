/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ranking of projected snap candidates: tier first, then distance, then
 * collection order, with hysteresis against the previous winner so ±1px cursor
 * jitter at a radius boundary or between two equidistant targets cannot make
 * the snap flip-flop.
 *
 * Hysteresis is the classic enter/leave split: a target ENTERS at `radius` but
 * a held target only LEAVES beyond `radius + hysteresis`, and a same-tier
 * challenger must be closer than the held target by more than `hysteresis`.
 * A higher tier inside the radius still takes over immediately.
 */

import type { Guide, SnapCandidate, SnapKind, SnapProfile, Vec2 } from './types.js';

/** Default profile for modelling commands (wall.place, split, endpoint drag). */
export const MODELING_SNAP_PROFILE: SnapProfile = {
  radiusPx: 12,
  tiers: [
    ['endpoint', 'vertex'],
    ['intersection', 'midpoint', 'gridIntersection'],
    ['perpendicular'],
    ['edge', 'extension', 'parallel'],
    ['face'],
    ['grid'],
  ],
  sources: ['mesh', 'semantic', 'grid', 'ifc-grid'],
  angleStepDeg: 15,
  hysteresisPx: 3,
};

export const DEFAULT_HYSTERESIS_PX = 3;

export interface Ranked {
  cand: SnapCandidate;
  /** Where the candidate lands on the active locus. */
  point: Vec2;
  /** Distance from `point` to the constrained cursor. */
  dist: number;
  tier: number;
  /** Collection order; the final tie-break, so equal targets resolve like the first-found loops they replace. */
  order: number;
}

/** Index of the tier containing `kind`, or -1 when the profile never snaps to it. */
export function tierOf(kind: SnapKind, tiers: SnapProfile['tiers']): number {
  for (let i = 0; i < tiers.length; i++) if (tiers[i].includes(kind)) return i;
  return -1;
}

const sameVec = (a: Vec2, b: Vec2): boolean => a[0] === b[0] && a[1] === b[1];

function sameGuide(a: Guide, b: Guide): boolean {
  if (a.kind === 'segment' && b.kind === 'segment') {
    return (sameVec(a.a, b.a) && sameVec(a.b, b.b)) || (sameVec(a.a, b.b) && sameVec(a.b, b.a));
  }
  if ((a.kind === 'line' && b.kind === 'line') || (a.kind === 'ray' && b.kind === 'ray')) {
    return sameVec(a.origin, b.origin) && sameVec(a.dir, b.dir);
  }
  if (a.kind === 'circle' && b.kind === 'circle') return sameVec(a.center, b.center) && a.radius === b.radius;
  return false;
}

/**
 * Whether two candidates denote the same target across frames. Sources
 * recompute candidates every move, so identity is structural: same kind and
 * entity, and the same guide for edge-like targets (whose `local` follows the
 * cursor) or the same position for point targets.
 */
export function sameTarget(a: SnapCandidate, b: SnapCandidate): boolean {
  if (a.kind !== b.kind || a.source !== b.source) return false;
  if (a.entity || b.entity) {
    if (!a.entity || !b.entity) return false;
    if (a.entity.modelId !== b.entity.modelId || a.entity.expressId !== b.entity.expressId) return false;
  }
  if (a.guide && b.guide) return sameGuide(a.guide, b.guide);
  if (a.guide || b.guide) return false;
  return sameVec(a.local, b.local);
}

function better(x: Ranked, y: Ranked): boolean {
  if (x.tier !== y.tier) return x.tier < y.tier;
  if (x.dist !== y.dist) return x.dist < y.dist;
  return x.order < y.order;
}

/**
 * Pick the winner among projected candidates. `prev` is the previous frame's
 * winner (as collected), or null.
 */
export function pickWinner(
  items: readonly Ranked[],
  radius: number,
  hysteresis: number,
  prev: SnapCandidate | null,
): Ranked | null {
  let best: Ranked | null = null;
  let held: Ranked | null = null;
  for (const r of items) {
    if (r.tier < 0) continue;
    const isPrev = prev !== null && held === null && sameTarget(r.cand, prev);
    if (isPrev && r.dist <= radius + hysteresis) held = r;
    if (!(r.dist <= radius)) continue; // also drops a NaN distance (non-finite cursor or target)
    if (!best || better(r, best)) best = r;
  }
  if (!held) return best;
  if (!best || best === held) return held;
  if (best.tier !== held.tier) return best.tier < held.tier ? best : held;
  // Same tier: a challenger must beat the held target by the hysteresis margin.
  return best.dist < held.dist - hysteresis ? best : held;
}
