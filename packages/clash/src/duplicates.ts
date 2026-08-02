/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Duplicate / fully-overlapping element detection (#1280).
 *
 * The first thing people do when reviewing a single discipline model is hunt for
 * accidentally duplicated or coincident objects — re-imported geometry, a wall
 * pasted twice, a column modelled on top of another. That is *not* a discipline
 * clash, so it gets its own lightweight pass: purely AABB + a cheap geometry
 * signature (triangle count), no narrow-phase triangle work. The broad phase is
 * a one-axis sort-and-sweep, which handles mixed-scale models correctly (no grid
 * cell size to mis-tune), so it is cheap enough to run on every load.
 *
 * Output is a normal {@link ClashResult} (rule id `duplicates`) so the existing
 * panel, grouping and BCF export render it with no special-casing.
 */

import type { AABB } from '@ifc-lite/spatial';
import { center, overlapBounds } from './math/aabb.js';
import { isExcluded, qualifiedKey } from './exclude.js';
import type {
  Clash,
  ClashElement,
  ClashElementRef,
  ClashResult,
  ClashRule,
  ClashSeverity,
  ClashSummary,
  ExclusionSet,
} from './types.js';

export interface DuplicateOptions {
  /**
   * Minimum AABB intersection-over-union for a pair to count as overlapping.
   * `1` = identical boxes; the default catches near-coincident objects while
   * leaving merely-adjacent ones (a slab and its finish) alone.
   */
  iouThreshold?: number;
  /** IoU at/above which a same-triangle-count pair is treated as an EXACT
   *  duplicate (severity `major`) rather than a candidate overlap (`minor`). */
  exactThreshold?: number;
  /** Centre-distance (m) under which two degenerate (planar) elements with no
   *  AABB volume are still considered coincident. */
  positionTolerance?: number;
  /** Pairs whose element keys are in here are skipped (voids/hosts/assemblies). */
  exclusions?: ExclusionSet;
}

const DEFAULTS: Required<Omit<DuplicateOptions, 'exclusions'>> = {
  iouThreshold: 0.9,
  exactThreshold: 0.99,
  positionTolerance: 0.01,
};

export const DUPLICATES_RULE: ClashRule = {
  id: 'duplicates',
  name: 'Duplicate / overlapping',
  a: '*',
  mode: 'hard',
};

function aabbVolume(b: AABB): number {
  const dx = Math.max(0, b.max[0] - b.min[0]);
  const dy = Math.max(0, b.max[1] - b.min[1]);
  const dz = Math.max(0, b.max[2] - b.min[2]);
  return dx * dy * dz;
}

/** Intersection-over-union of two AABBs (0 when disjoint). */
function aabbIoU(a: AABB, b: AABB): number {
  const ox = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const oy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  const oz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
  if (ox <= 0 || oy <= 0 || oz <= 0) return 0;
  const inter = ox * oy * oz;
  const union = aabbVolume(a) + aabbVolume(b) - inter;
  return union > 0 ? inter / union : 0;
}

function aabbApproxEqual(a: AABB, b: AABB, tol: number): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(a.min[i] - b.min[i]) > tol) return false;
    if (Math.abs(a.max[i] - b.max[i]) > tol) return false;
  }
  return true;
}

/** Similarity in `[0,1]`: AABB IoU, falling back to box-equality for degenerate
 *  (zero-volume / planar) elements where IoU is undefined. */
function similarity(a: AABB, b: AABB, tol: number): number {
  const iou = aabbIoU(a, b);
  if (iou > 0) return iou;
  // Both (near) degenerate: an exact box match still means "same place".
  if (aabbVolume(a) <= 0 || aabbVolume(b) <= 0) {
    return aabbApproxEqual(a, b, tol) ? 1 : 0;
  }
  return 0;
}

/** Shortest dimension of a box — the depth one element is embedded in another. */
function minExtent(b: AABB): number {
  return Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}

function triCount(el: ClashElement): number {
  return Math.floor(el.indices.length / 3);
}

function toRef(el: ClashElement): ClashElementRef {
  return { key: el.key, ref: el.ref, model: el.model, tag: el.tag, name: el.name };
}

function buildSummary(clashes: Clash[]): ClashSummary {
  const byRule: Record<string, number> = {};
  const byTypePair: Record<string, number> = {};
  const bySeverity: Record<ClashSeverity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const c of clashes) {
    byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
    const pair = [c.a.tag, c.b.tag].sort().join(' vs ');
    byTypePair[pair] = (byTypePair[pair] ?? 0) + 1;
    bySeverity[c.severity] += 1;
  }
  return { total: clashes.length, byRule, byTypePair, bySeverity };
}

/**
 * Find duplicate / fully-overlapping elements. Returns a {@link ClashResult}
 * where each clash is a near-coincident pair: severity `major` for an exact
 * duplicate (same triangle count + near-identical box), `minor` for a looser
 * overlap candidate.
 */
export function findDuplicates(elements: ClashElement[], options: DuplicateOptions = {}): ClashResult {
  const iouThreshold = options.iouThreshold ?? DEFAULTS.iouThreshold;
  const exactThreshold = options.exactThreshold ?? DEFAULTS.exactThreshold;
  const positionTolerance = options.positionTolerance ?? DEFAULTS.positionTolerance;
  const exclusions = options.exclusions;

  const clashes: Clash[] = [];
  const seen = new Set<string>();

  const consider = (i: number, j: number): void => {
    if (i >= j) return; // unordered pairs once
    const elA = elements[i];
    const elB = elements[j];
    if (elA.key === elB.key && elA.model === elB.model) return;
    if (
      exclusions &&
      isExcluded(exclusions, qualifiedKey(elA.model, elA.key), qualifiedKey(elB.model, elB.key))
    ) {
      return;
    }
    const sim = similarity(elA.bounds, elB.bounds, positionTolerance);
    if (sim < iouThreshold) return;

    const sameTris = triCount(elA) > 0 && triCount(elA) === triCount(elB);
    const exact = sim >= exactThreshold && sameTris;
    const severity: ClashSeverity = exact ? 'major' : 'minor';

    const ka = `${elA.model} ${elA.key}`;
    const kb = `${elB.model} ${elB.key}`;
    const [lo, hi] = ka < kb ? [ka, kb] : [kb, ka];
    const id = `duplicates ${lo} ${hi}`;
    if (seen.has(id)) return;
    seen.add(id);

    const bounds = overlapBounds(elA.bounds, elB.bounds);
    clashes.push({
      id,
      a: toRef(elA),
      b: toRef(elB),
      rule: DUPLICATES_RULE.id,
      status: 'hard',
      // Coincident solids fully embed each other; report the embedded depth so
      // they read as real overlaps (not zero-distance contacts) and sort first.
      distance: -Math.max(0, minExtent(bounds)),
      point: center(bounds),
      bounds,
      severity,
    });
  };

  // Broad phase: one-axis sort-and-sweep over the AABBs. Unlike a fixed-size
  // hash grid, this makes NO assumption about element scale — so two large
  // objects offset by a few metres (still well above the IoU threshold) are
  // never skipped just because many small elements shrank an average cell size.
  // Sweep along the axis with the widest spread of box minima so the active set
  // (and thus the comparison count) stays small.
  let axis = 0;
  let bestSpread = -Infinity;
  for (let a = 0; a < 3; a += 1) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const el of elements) {
      const v = el.bounds.min[a];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const spread = hi - lo;
    if (spread > bestSpread) {
      bestSpread = spread;
      axis = a;
    }
  }

  const order = elements.map((_, i) => i).sort(
    (x, y) => elements[x].bounds.min[axis] - elements[y].bounds.min[axis],
  );
  // `active` holds indices whose box still extends past the current box's start
  // on `axis`; only those can overlap, so we compare against just them.
  const active: number[] = [];
  for (const idx of order) {
    const minA = elements[idx].bounds.min[axis];
    for (let k = active.length - 1; k >= 0; k -= 1) {
      if (elements[active[k]].bounds.max[axis] < minA) {
        active[k] = active[active.length - 1];
        active.pop();
      }
    }
    for (const other of active) {
      consider(Math.min(idx, other), Math.max(idx, other));
    }
    active.push(idx);
  }

  clashes.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  return {
    clashes,
    summary: buildSummary(clashes),
    rulesRun: [DUPLICATES_RULE],
    settings: { tolerance: positionTolerance, excludeVoidsAndHosts: exclusions != null },
  };
}
