/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Box arithmetic and the two spatial structures the split/merge detector needs
 * (issue #1891): a uniform grid and a union-find.
 *
 * `@ifc-lite/diff` is a zero-dependency leaf package, deliberately — it is the
 * one piece of the toolkit a third party can drop into a build with no
 * transitive surface at all. So the grid is written here rather than pulled in,
 * and it is written small: the detector needs "which of these boxes might touch
 * that one", not a general spatial index.
 *
 * Nothing here knows what an IFC entity is; it is all `EntityAabb`s and
 * indices.
 */

import { isUsableAabb } from './geometry-compare.js';
import type { EntityAabb } from './types.js';

/**
 * Slack allowed when asking whether one box sits inside another, or whether a
 * row of boxes covers an extent: `max(min, ratio * boxDiagonal)`.
 *
 * Always computed from the CONTAINER's box. A split's container is the deleted
 * element and a merge's is the added one, so "the container" is the only
 * formulation that means the same thing in both directions — padding a merge by
 * each tiny deleted piece's own diagonal would make the test say something
 * different for every piece it applied to.
 */
export function containmentPadding(box: EntityAabb, min: number, ratio: number): number {
  const dx = box.max[0] - box.min[0];
  const dy = box.max[1] - box.min[1];
  const dz = box.max[2] - box.min[2];
  return Math.max(min, ratio * Math.sqrt(dx * dx + dy * dy + dz * dz));
}

/** Does `inner` lie inside `outer` grown by `pad` on every side? */
export function boxWithin(inner: EntityAabb, outer: EntityAabb, pad: number): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (inner.min[axis] < outer.min[axis] - pad) return false;
    if (inner.max[axis] > outer.max[axis] + pad) return false;
  }
  return true;
}

/** Do the two boxes overlap when each is grown by `pad`? Touching counts. */
export function boxesTouch(a: EntityAabb, b: EntityAabb, pad: number): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (a.min[axis] - pad > b.max[axis] + pad) return false;
    if (b.min[axis] - pad > a.max[axis] + pad) return false;
  }
  return true;
}

/** The smallest box containing all of `boxes`. `boxes` must be non-empty. */
export function boxUnion(boxes: readonly EntityAabb[]): EntityAabb {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis++) {
      if (box.min[axis] < min[axis]) min[axis] = box.min[axis];
      if (box.max[axis] > max[axis]) max[axis] = box.max[axis];
    }
  }
  return { min, max };
}

/**
 * A box's three side lengths, sorted ascending.
 *
 * Sorting is what makes the `displaced` lane tolerate a move that also turned
 * the element by a multiple of 90°: the axis-aligned extents permute, so the
 * multiset survives even though no individual axis does. It is also exactly why
 * an arbitrary rotation is out of reach — 37° changes the extents themselves,
 * and nothing recoverable from an axis-aligned box says by how much.
 */
export function sortedExtents(box: EntityAabb): [number, number, number] {
  const e = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  e.sort((a, b) => a - b);
  return [e[0], e[1], e[2]];
}

/**
 * Do the pieces' projections onto each of the whole's three axes COVER its
 * extent, allowing `pad` of slack at the ends and `pad` of gap between
 * neighbours?
 *
 * The fallback when no volume is available. It is an interval-union test per
 * axis, `O(k log k)`, and it deliberately never sums box volumes: #1993
 * measured that 66% of multi-segment elements have overlapping boxes, so a sum
 * of piece box volumes is not an approximation of anything.
 *
 * What it can and cannot see is on {@link SplitMergeConfidence}: covering all
 * three axes does not mean filling the interior, so a ring of pieces around an
 * empty middle passes. This is a coverage test, not a volume test, and the
 * confidence level says so by name.
 */
export function extentCoverage(
  whole: EntityAabb,
  pieces: readonly EntityAabb[],
  pad: number,
): boolean {
  if (pieces.length === 0) return false;
  for (let axis = 0; axis < 3; axis++) {
    const intervals = pieces
      .map((piece) => [piece.min[axis], piece.max[axis]] as const)
      .sort((a, b) => a[0] - b[0]);
    let cursor = whole.min[axis];
    for (const [lo, hi] of intervals) {
      // A piece starting beyond the reach of the covered run leaves a gap
      // wider than a joint — and a later piece cannot fill it, because they
      // are sorted by where they start.
      if (lo > cursor + pad) return false;
      if (hi > cursor) cursor = hi;
      if (cursor >= whole.max[axis] - pad) break;
    }
    if (cursor < whole.max[axis] - pad) return false;
  }
  return true;
}

/**
 * Largest number of cells one query may visit before it gives up on the grid
 * and scans everything.
 *
 * Not a correctness knob — both branches return the same candidate set. It
 * bounds the cost of a query box enormously larger than the biggest indexed
 * box, where walking cells is slower than walking the boxes themselves.
 */
const MAX_QUERY_CELLS = 4096;

/**
 * A uniform grid over a set of boxes, answering "which boxes might overlap
 * this one".
 *
 * The cell is sized to the LARGEST indexed box's longest side, so every indexed
 * box touches at most eight cells and insertion is bounded per box regardless
 * of how the sizes are distributed. A grid sized to the average instead would
 * let one outsized box occupy thousands of cells.
 *
 * Answers a superset: the caller still applies the real predicate. That is the
 * whole contract — the grid exists to keep the candidate generation off `O(n·m)`,
 * not to decide anything.
 */
export interface BoxGrid {
  /** Indices whose boxes MIGHT overlap `box` grown by `pad`, ascending. */
  query(box: EntityAabb, pad: number): number[];
}

export function buildBoxGrid(boxes: readonly EntityAabb[]): BoxGrid {
  const count = boxes.length;
  let cell = 0;
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis++) {
      const extent = box.max[axis] - box.min[axis];
      if (extent > cell) cell = extent;
    }
  }
  // Every box degenerate (a set of coincident points) is a legal input; any
  // positive cell size indexes it correctly, so pick one rather than dividing
  // by zero.
  if (!(cell > 0)) cell = 1;

  const buckets = new Map<string, number[]>();
  const cellOf = (value: number): number => Math.floor(value / cell);
  const keyOf = (x: number, y: number, z: number): string => `${x},${y},${z}`;

  for (let index = 0; index < count; index++) {
    const box = boxes[index];
    for (let x = cellOf(box.min[0]); x <= cellOf(box.max[0]); x++) {
      for (let y = cellOf(box.min[1]); y <= cellOf(box.max[1]); y++) {
        for (let z = cellOf(box.min[2]); z <= cellOf(box.max[2]); z++) {
          const key = keyOf(x, y, z);
          const bucket = buckets.get(key);
          if (bucket) bucket.push(index);
          else buckets.set(key, [index]);
        }
      }
    }
  }

  // Reused across queries: a stamp per index beats allocating a Set per query,
  // and the detector runs one query per candidate whole.
  const stamp = new Int32Array(count).fill(-1);
  let generation = 0;
  const all = (): number[] => Array.from({ length: count }, (_, i) => i);

  return {
    query(box: EntityAabb, pad: number): number[] {
      if (count === 0) return [];
      const x0 = cellOf(box.min[0] - pad);
      const x1 = cellOf(box.max[0] + pad);
      const y0 = cellOf(box.min[1] - pad);
      const y1 = cellOf(box.max[1] + pad);
      const z0 = cellOf(box.min[2] - pad);
      const z1 = cellOf(box.max[2] + pad);
      const cells = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
      if (!Number.isFinite(cells) || cells > MAX_QUERY_CELLS) return all();

      const found: number[] = [];
      const mark = generation++;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            const bucket = buckets.get(keyOf(x, y, z));
            if (!bucket) continue;
            for (const index of bucket) {
              if (stamp[index] === mark) continue;
              stamp[index] = mark;
              found.push(index);
            }
          }
        }
      }
      found.sort((a, b) => a - b);
      return found;
    },
  };
}

/**
 * Connected components of `boxes` under "these two boxes touch when each is
 * grown by its own padding" — a grid-accelerated union-find.
 *
 * Each box carries its OWN padding rather than sharing one, so a cluster of
 * mixed-size pieces is joined on a rule that means the same thing for a 50 mm
 * bolt and a 6 m panel.
 *
 * Returns one array of indices per component, each ascending, the components
 * themselves ordered by their smallest member — deterministic without a sort
 * over anything the caller supplied.
 */
export function clusterByProximity(
  boxes: readonly EntityAabb[],
  paddings: readonly number[],
): number[][] {
  const count = boxes.length;
  const parent = new Int32Array(count).map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // Path compression, so a long chain of touching pieces stays near-linear.
    let walk = i;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };

  const grid = buildBoxGrid(boxes);
  // THE QUERY MUST DOMINATE THE PREDICATE. `boxesTouch` grows BOTH boxes by
  // `max(pad_i, pad_j)`, so it accepts a gap of up to twice the larger padding;
  // a query expanded by this box's own padding alone reaches half of that. A
  // pair separated by a gap in between was then found only when it happened to
  // share a grid cell, and the reverse query that would have found it is
  // skipped by `j <= i` — so whether two pieces clustered depended on where the
  // cell boundaries landed, which is nondeterminism wearing a spatial index as
  // a disguise.
  //
  // Twice the LARGEST padding, because `pad_j` is not known at query time and
  // `pad_i + maxPad` does not dominate `2 * max(pad_i, pad_j)` when the two
  // differ. Over-reaching only widens the candidate set the real predicate then
  // filters; under-reaching loses a real neighbour silently.
  let reach = 0;
  for (const padding of paddings) if (padding > reach) reach = padding;
  reach *= 2;
  for (let i = 0; i < count; i++) {
    for (const j of grid.query(boxes[i], reach)) {
      if (j <= i) continue;
      if (!boxesTouch(boxes[i], boxes[j], Math.max(paddings[i], paddings[j]))) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[a] = b;
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const members = byRoot.get(root);
    if (members) members.push(i);
    else byRoot.set(root, [i]);
  }
  const components = [...byRoot.values()];
  components.sort((a, b) => a[0] - b[0]);
  return components;
}

/** A fingerprint's box, or `undefined` when it has none the engine can use. */
export function usableAabbOf(aabb: EntityAabb | undefined): EntityAabb | undefined {
  return isUsableAabb(aabb) ? aabb : undefined;
}
