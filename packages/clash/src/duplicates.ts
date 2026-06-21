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
 * signature (triangle count), no narrow-phase triangle work. It scales to large
 * models via a uniform hash grid, so it is cheap enough to run on every load.
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
  Vec3,
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

/** Quantise a centre to an integer grid cell at resolution `cell`. */
function cellKey(c: Vec3, cell: number): string {
  return `${Math.floor(c[0] / cell)},${Math.floor(c[1] / cell)},${Math.floor(c[2] / cell)}`;
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

  // A hash grid keyed by quantised centre. Duplicates share a centre so they
  // land in the same (or an adjacent) cell — querying the 27-cell neighbourhood
  // keeps it correct across cell boundaries while staying near-linear.
  const centers = elements.map((el) => center(el.bounds));
  // Cell size scaled to the typical element so the grid stays sparse on big
  // models; never smaller than the position tolerance.
  let avgExtent = 0;
  for (const el of elements) {
    const b = el.bounds;
    avgExtent += (b.max[0] - b.min[0] + b.max[1] - b.min[1] + b.max[2] - b.min[2]) / 3;
  }
  avgExtent = elements.length > 0 ? avgExtent / elements.length : 1;
  const cell = Math.max(positionTolerance * 4, avgExtent, 0.1);

  const grid = new Map<string, number[]>();
  for (let i = 0; i < elements.length; i += 1) {
    const key = cellKey(centers[i], cell);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

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

  for (let i = 0; i < elements.length; i += 1) {
    const [cx, cy, cz] = centers[i];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const key = `${Math.floor(cx / cell) + dx},${Math.floor(cy / cell) + dy},${Math.floor(cz / cell) + dz}`;
          const bucket = grid.get(key);
          if (!bucket) continue;
          for (const j of bucket) consider(i, j);
        }
      }
    }
  }

  clashes.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  return {
    clashes,
    summary: buildSummary(clashes),
    rulesRun: [DUPLICATES_RULE],
    settings: { tolerance: positionTolerance, excludeVoidsAndHosts: exclusions != null },
  };
}
