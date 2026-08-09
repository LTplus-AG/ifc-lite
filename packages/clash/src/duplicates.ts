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
 * "Same object" is decided by {@link boxDistance} against `positionTolerance`, a
 * plain distance in metres. It used to be AABB intersection-over-union ≥ 0.9,
 * which is a ratio and so carried no physical tolerance at all: the same setting
 * allowed 5 mm across a DN100 pipe and 421 mm across an 8 m slab (see
 * `DuplicateOptions.iouThreshold`).
 *
 * Output is a normal {@link ClashResult} (rule id `duplicates`) so the existing
 * panel, grouping and BCF export render it with no special-casing. It is
 * *pairwise*: N coincident copies of one object yield N(N−1)/2 clashes. For a
 * reader-facing list use `groupDuplicateSets`, which collapses those pairs into
 * one finding per coincident set.
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
   * How far apart (m) two elements may be and still count as the same object.
   * This is the primary control and the number reported in
   * `ClashResult.settings.tolerance`. It bounds {@link boxDistance}: for two
   * equally-sized boxes that is exactly the distance between their centres, and
   * a difference in size adds to it. Default 10 mm.
   */
  positionTolerance?: number;
  /** Distance (m) at/below which a same-triangle-count pair is treated as an
   *  EXACT duplicate (severity `major`) rather than a candidate overlap
   *  (`minor`). Default 1 mm. */
  exactTolerance?: number;
  /**
   * @deprecated Superseded by {@link positionTolerance}. Minimum AABB
   * intersection-over-union for a pair to count as overlapping. IoU is a ratio,
   * so it imposed no fixed physical tolerance: for two equal boxes offset by `d`
   * along an axis of extent `e` the IoU is `(e − d) / (e + d)`, and the default
   * 0.9 therefore allowed `d ≤ e / 19` — 5 mm across a DN100 pipe but 421 mm
   * across an 8 m slab, from one setting. Passing this (or `exactThreshold`)
   * restores the whole pre-1.7 IoU behaviour for that call rather than silently
   * reinterpreting a number that means nothing in the new metric.
   */
  iouThreshold?: number;
  /** @deprecated Only meaningful in the legacy IoU mode selected by
   *  {@link iouThreshold}; use {@link exactTolerance}. */
  exactThreshold?: number;
  /** Pairs whose element keys are in here are skipped (voids/hosts/assemblies). */
  exclusions?: ExclusionSet;
}

const DEFAULTS = {
  positionTolerance: 0.01,
  exactTolerance: 0.001,
  /** Legacy IoU mode only. */
  iouThreshold: 0.9,
  /** Legacy IoU mode only. */
  exactThreshold: 0.99,
} as const satisfies Required<Omit<DuplicateOptions, 'exclusions'>>;

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

/**
 * Distance (m) between two boxes as *objects*: the largest distance any corner
 * of `a` has to travel to reach the matching corner of `b`. Because the max over
 * the eight corners picks, independently per axis, whichever face moved further,
 * it reduces to the Euclidean norm of the three per-axis face offsets — one
 * square root, no corner enumeration.
 *
 * Two properties make it the tolerance a user can reason about:
 * - **Pure translation gives exactly the translation length.** Every corner
 *   moves by `d`, so the result is `|d|`, whatever the shape and whatever the
 *   direction. That is what makes it isotropic, where IoU was not.
 * - **A size difference counts too.** Concentric boxes whose faces differ by δ
 *   are δ apart, so this is centre distance *and* a shape check in one number,
 *   with no second, dimensionless knob.
 *
 * It is still AABB-only. Two elements with the same bounds and different solids
 * inside them (a duct inside a shaft; a nested assembly) are indistinguishable
 * here — separating those needs a narrow phase this pass deliberately does not
 * run.
 */
function boxDistance(a: AABB, b: AABB): number {
  let sum = 0;
  for (let i = 0; i < 3; i += 1) {
    const d = Math.max(Math.abs(a.min[i] - b.min[i]), Math.abs(a.max[i] - b.max[i]));
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Do the boxes touch or overlap on every axis? Two elements that are disjoint
 *  in space are two objects, however close. Without this an element SMALLER than
 *  the tolerance (a 5 mm fixing at a 10 mm tolerance) would pair with a
 *  neighbour it never intersects. Touching (zero gap) counts, so coincident
 *  planar and point geometry still qualifies. */
function boxesTouch(a: AABB, b: AABB): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (Math.min(a.max[i], b.max[i]) < Math.max(a.min[i], b.min[i])) return false;
  }
  return true;
}

/** Legacy IoU similarity in `[0,1]`, falling back to box-equality for degenerate
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
 * duplicate (same triangle count + boxes within `exactTolerance`), `minor` for a
 * looser overlap candidate. `settings.tolerance` is `positionTolerance`, the
 * value that actually decided the matches.
 */
export function findDuplicates(elements: ClashElement[], options: DuplicateOptions = {}): ClashResult {
  // A caller that passes an IoU threshold is asking for IoU semantics; honour
  // them (deprecated) rather than reinterpreting the number under a metric where
  // it means nothing. Everyone else — the viewer, the CLI, every caller that
  // passes no thresholds — gets the distance gate.
  const legacyIoU = options.iouThreshold != null || options.exactThreshold != null;
  const iouThreshold = options.iouThreshold ?? DEFAULTS.iouThreshold;
  const exactThreshold = options.exactThreshold ?? DEFAULTS.exactThreshold;
  const positionTolerance = options.positionTolerance ?? DEFAULTS.positionTolerance;
  const exactTolerance = options.exactTolerance ?? DEFAULTS.exactTolerance;
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
    const sameTris = triCount(elA) > 0 && triCount(elA) === triCount(elB);

    let exact: boolean;
    if (legacyIoU) {
      const sim = similarity(elA.bounds, elB.bounds, positionTolerance);
      if (sim < iouThreshold) return;
      exact = sim >= exactThreshold && sameTris;
    } else {
      if (!boxesTouch(elA.bounds, elB.bounds)) return;
      const dist = boxDistance(elA.bounds, elB.bounds);
      if (dist > positionTolerance) return;
      exact = dist <= exactTolerance && sameTris;
    }
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
  // objects offset by a few metres (still inside a metre-scale tolerance) are
  // never skipped just because many small elements shrank an average cell size.
  // Sweep along the axis with the widest spread of box minima so the active set
  // (and thus the comparison count) stays small. Eviction is exact rather than
  // conservative: it drops only boxes that no longer touch on `axis`, and a pair
  // that does not touch is rejected by the gate anyway.
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
