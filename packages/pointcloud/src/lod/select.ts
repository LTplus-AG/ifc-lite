/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * View-dependent level-of-detail selection over an additive point octree
 * (#6869). Pure: no renderer, no I/O, no clock. Implemented from the
 * technique as described in the issue (priority refinement by projected
 * size, node cap, water-filled point budget), not from any other code.
 *
 * 1. Frustum-cull. A node outside the view is never selected, nor is any
 *    of its descendants.
 * 2. Refine priority-first: repeatedly take the selected node with the
 *    largest projected screen span (bounding-sphere diameter in pixels)
 *    and add its visible children, while that span exceeds
 *    `pixelThreshold` and the selection stays within `maxNodes`. The
 *    octree is additive (a parent holds a coarse subsample, children add
 *    detail), so a parent stays selected and always precedes its children.
 * 3. Share `pointBudget` across the selected nodes by water-filling: every
 *    node gets the same share, capped by its own point count, with what a
 *    small node cannot use passed on to the larger ones.
 *
 * Ties break by node id, so the result is independent of child order.
 */

import type { PointCloudBBox } from '../types.js';
import { boxIntersectsFrustum, frustumPlanes } from './frustum.js';

export interface LodNode {
  /** Unique, stable id (the tie-breaker that makes selection deterministic). */
  readonly id: string;
  /** Bounds in the camera's frame. */
  readonly bounds: PointCloudBBox;
  readonly pointCount: number;
  /** Child nodes, or `null` while this subtree's hierarchy is not loaded. */
  readonly children: readonly LodNode[] | null;
}

export interface LodCamera {
  /** Column-major view-projection into WebGPU clip space (z in [0, w], either direction). */
  viewProj: ArrayLike<number>;
  /** Eye position, same frame as the node bounds. */
  position: readonly [number, number, number];
  /** Viewport height in pixels. */
  viewportHeight: number;
  /** Projection element [1][1]: 1/tan(fovY/2), or 2/(top-bottom) when orthographic. */
  projScaleY: number;
  orthographic?: boolean;
}

export interface LodOptions {
  pointBudget: number;
  /** Refine while a node spans more than this many pixels. Default 96. */
  pixelThreshold?: number;
  /** Selection cap. Default `clamp(pointBudget / 128, 8, 1024)`. */
  maxNodes?: number;
}

export interface LodSelectedNode {
  node: LodNode;
  /** Projected bounding-sphere diameter, pixels (Infinity with the eye inside). */
  screenSpan: number;
  /** Points this node may contribute (<= node.pointCount). */
  points: number;
  /** Keep every `stride`-th point: `ceil(pointCount / stride) <= points`. */
  stride: number;
}

export interface LodSelection {
  /** Parents before children. */
  nodes: LodSelectedNode[];
  /** Nodes that should refine but whose children are not loaded yet. */
  needsChildren: LodNode[];
  /** Sum of `points`; never above the budget. */
  totalPoints: number;
  /** True when `maxNodes` stopped refinement. */
  capped: boolean;
}

export const DEFAULT_PIXEL_THRESHOLD = 96;

export function defaultMaxNodes(pointBudget: number): number {
  return Math.min(1024, Math.max(8, Math.floor(pointBudget / 128)));
}

/** Projected diameter in pixels of the node's bounding sphere. */
export function screenSpan(bounds: PointCloudBBox, camera: LodCamera): number {
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const radius = Math.hypot(dx, dy, dz) / 2;
  const scale = camera.projScaleY * camera.viewportHeight;
  if (camera.orthographic) return radius * scale;
  const cx = (bounds.min[0] + bounds.max[0]) / 2 - camera.position[0];
  const cy = (bounds.min[1] + bounds.max[1]) / 2 - camera.position[1];
  const cz = (bounds.min[2] + bounds.max[2]) / 2 - camera.position[2];
  const distance = Math.hypot(cx, cy, cz);
  if (distance <= radius) return Infinity;
  return (radius * scale) / distance;
}

interface Candidate {
  node: LodNode;
  span: number;
}

/** Larger span first; ties by id. */
function before(a: Candidate, b: Candidate): boolean {
  if (a.span !== b.span) return a.span > b.span;
  return a.node.id < b.node.id;
}

class MaxHeap {
  private items: Candidate[] = [];
  get size(): number {
    return this.items.length;
  }
  push(c: Candidate): void {
    const items = this.items;
    items.push(c);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }
  pop(): Candidate | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last) {
      items[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && before(items[l], items[best])) best = l;
        if (r < items.length && before(items[r], items[best])) best = r;
        if (best === i) break;
        [items[i], items[best]] = [items[best], items[i]];
        i = best;
      }
    }
    return top;
  }
}

export function selectLod(root: LodNode, camera: LodCamera, options: LodOptions): LodSelection {
  const budget = Math.max(0, Math.floor(options.pointBudget));
  const threshold = options.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? defaultMaxNodes(budget)));
  const planes = frustumPlanes(camera.viewProj);
  const empty: LodSelection = { nodes: [], needsChildren: [], totalPoints: 0, capped: false };
  if (budget === 0 || !boxIntersectsFrustum(root.bounds, planes)) return empty;

  const chosen: Candidate[] = [{ node: root, span: screenSpan(root.bounds, camera) }];
  const needsChildren: LodNode[] = [];
  const heap = new MaxHeap();
  heap.push(chosen[0]);
  let capped = false;
  while (heap.size > 0) {
    const next = heap.pop();
    if (!next || !(next.span > threshold)) break; // the largest is small enough: done
    const children = next.node.children;
    if (children === null) {
      needsChildren.push(next.node);
      continue;
    }
    const visible = children
      .filter((child) => boxIntersectsFrustum(child.bounds, planes))
      .map((child) => ({ node: child, span: screenSpan(child.bounds, camera) }))
      .sort((a, b) => (before(a, b) ? -1 : 1));
    if (chosen.length + visible.length > maxNodes) {
      // Refinement is all-children-or-none, in strict priority order, so the
      // selection for a smaller cap is always a prefix of a larger one's.
      capped = true;
      break;
    }
    for (const child of visible) {
      chosen.push(child);
      heap.push(child);
    }
  }

  const allocation = waterFill(chosen.map((c) => c.node.pointCount), budget);
  const nodes: LodSelectedNode[] = [];
  let totalPoints = 0;
  chosen.forEach((c, i) => {
    const points = allocation[i];
    if (points <= 0) return;
    nodes.push({ node: c.node, screenSpan: c.span, points, stride: Math.ceil(c.node.pointCount / points) });
    totalPoints += points;
  });
  return { nodes, needsChildren, totalPoints, capped };
}

/**
 * Max-min fair split of `budget` over `counts`: one common level L, each
 * share `min(count, L)`, with the integer remainder going one point at a
 * time to the earliest uncapped entries. The result sums to
 * `min(budget, sum(counts))`.
 */
export function waterFill(counts: readonly number[], budget: number): number[] {
  const caps = counts.map((c) => Math.max(0, Math.floor(c)));
  const total = caps.reduce((a, b) => a + b, 0);
  if (total <= budget) return caps;
  const order = caps.map((c, i) => i).sort((a, b) => caps[a] - caps[b] || a - b);
  const out = new Array<number>(caps.length).fill(0);
  let remaining = budget;
  let open = caps.length;
  let k = 0;
  // Fill the smallest entries completely while they fit under the level.
  while (k < order.length && caps[order[k]] * open <= remaining) {
    out[order[k]] = caps[order[k]];
    remaining -= caps[order[k]];
    open--;
    k++;
  }
  const level = open > 0 ? Math.floor(remaining / open) : 0;
  let extra = open > 0 ? remaining - level * open : 0;
  const uncapped = order.slice(k).sort((a, b) => a - b);
  for (const i of uncapped) {
    out[i] = level + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
  }
  return out;
}
