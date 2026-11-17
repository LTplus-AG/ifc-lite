/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which cut segments of an open surface bound no area (#8664), read off the graph
 * they form instead of off greedy chains, whose walk could run from a solid into a
 * sheet welded to it and condemn both, depending on face order.
 *
 * Chain ends a crack apart get bridged, every such pair, so no nearby sheet can take a
 * solid's crack from it. Dangling paths are then pruned back to the first junction:
 * those are the sheets. What survives is cycles, so it encloses area.
 *
 * A crack is small both ways. Relative, or a tiny sheet's whole gap would pass;
 * absolute, or a long hairpin in a sheet would, whose gap is small only beside its
 * length. On a real corpus no chain through an IfcOpenShell product met both, and
 * cracks in solids did: 0.2 mm and 1.7 mm, the latter round a 7 m slab outline.
 */

import type { CutSegment, Point2D } from './types.js';
import { point2DDistance } from './math.js';

const CRACK_RATIO = 0.03;
const CRACK_MAX_GAP = 0.01; // metres

interface Edge {
  a: number;
  b: number;
  /** The segments along this edge; empty for a bridge across a crack. */
  segments: CutSegment[];
  length: number;
  removed: boolean;
}

export function findOpenChainSegments(segments: readonly CutSegment[], tolerance: number): Set<CutSegment> {
  const points: Point2D[] = [];
  const cells = new Map<string, number[]>();
  const cellKey = (cx: number, cy: number) => `${cx},${cy}`;
  const nodeAt = (p: Point2D): number => {
    const cx = Math.round(p.x / tolerance);
    const cy = Math.round(p.y / tolerance);
    // Neighbouring cells too: noise must not split a vertex lying on a cell boundary.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of cells.get(cellKey(cx + dx, cy + dy)) ?? []) {
          if (point2DDistance(points[id], p) < tolerance) return id;
        }
      }
    }
    const id = points.length;
    points.push(p);
    const key = cellKey(cx, cy);
    const cell = cells.get(key);
    if (cell) cell.push(id);
    else cells.set(key, [id]);
    return id;
  };

  const edges: Edge[] = [];
  const byNodes = new Map<string, Edge>();
  for (const segment of segments) {
    const a = nodeAt(segment.p0_2d);
    const b = nodeAt(segment.p1_2d);
    if (a === b) continue; // shorter than the weld: no topology, and invisible either way
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const twin = byNodes.get(key);
    if (twin) {
      // A duplicated face on a solid, or a sheet folded back on itself: one edge either
      // way, so the copies share its fate rather than cancel and open a solid's outline.
      twin.segments.push(segment);
      continue;
    }
    const edge = { a, b, segments: [segment], length: point2DDistance(segment.p0_2d, segment.p1_2d), removed: false };
    byNodes.set(key, edge);
    edges.push(edge);
  }

  const incident: Edge[][] = points.map(() => []);
  for (const edge of edges) {
    incident[edge.a].push(edge);
    incident[edge.b].push(edge);
  }

  bridgeCracks(points, incident, edges);

  const open = new Set<CutSegment>();

  // Prune dangling paths, cascading until each stops at a junction or is gone.
  const liveDegree = incident.map((list) => list.length);
  const leaves: number[] = [];
  liveDegree.forEach((degree, node) => { if (degree === 1) leaves.push(node); });
  while (leaves.length > 0) {
    const node = leaves.pop()!;
    if (liveDegree[node] !== 1) continue;
    const edge = incident[node].find((e) => !e.removed)!;
    edge.removed = true;
    for (const segment of edge.segments) open.add(segment);
    liveDegree[node] = 0;
    const other = edge.a === node ? edge.b : edge.a;
    if (--liveDegree[other] === 1) leaves.push(other);
  }

  for (const component of components(points.length, edges)) {
    const gaps = component.reduce((sum, e) => sum + (e.segments.length > 0 ? 0 : e.length), 0);
    const length = component.reduce((sum, e) => sum + (e.segments.length > 0 ? e.length : 0), 0);
    if (gaps <= length * CRACK_RATIO) continue;
    for (const edge of component) for (const segment of edge.segments) open.add(segment);
  }
  return open;
}

/** Bridges every pair of chain ends within a crack of each other. */
function bridgeCracks(points: readonly Point2D[], incident: Edge[][], edges: Edge[]): void {
  const ends = points.flatMap((_, node) => (incident[node].length === 1 ? [node] : []));
  ends.sort((p, q) => points[p].x - points[q].x || p - q);

  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length && points[ends[j]].x - points[ends[i]].x <= CRACK_MAX_GAP; j++) {
      const [a, b] = [ends[i], ends[j]];
      const gap = point2DDistance(points[a], points[b]);
      if (gap > CRACK_MAX_GAP) continue;
      const bridge: Edge = { a, b, segments: [], length: gap, removed: false };
      edges.push(bridge);
      incident[a].push(bridge);
      incident[b].push(bridge);
    }
  }
}

/** Surviving edges, grouped by connected component. */
function components(nodeCount: number, edges: readonly Edge[]): Edge[][] {
  const parent = Array.from({ length: nodeCount }, (_, i) => i);
  const find = (node: number): number => {
    let root = node;
    while (parent[root] !== root) root = parent[root];
    while (parent[node] !== root) [node, parent[node]] = [parent[node], root];
    return root;
  };
  const live = edges.filter((e) => !e.removed);
  for (const { a, b } of live) parent[find(a)] = find(b);

  const groups = new Map<number, Edge[]>();
  for (const edge of live) {
    const root = find(edge.a);
    const group = groups.get(root);
    if (group) group.push(edge);
    else groups.set(root, [edge]);
  }
  return [...groups.values()];
}
