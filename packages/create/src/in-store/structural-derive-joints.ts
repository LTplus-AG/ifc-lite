/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Joints between curve members, the "Joints" rule in
 * `structural-derive-types.ts`: free member ends move along their own axis to
 * meet another member's axis, and a member met in its interior is split there.
 * Pure: world metres in, adjusted lines and the record of every move out.
 */

import { vecLen as length } from '../ifc-creator-math.js';
import { add, dot, scale, sub } from './structural-derive-idealise.js';
import type { ExtendedEnd, Vec3 } from './structural-derive-types.js';

export interface JointLine {
  elementId: number;
  start: Vec3;
  end: Vec3;
  /** Larger cross-section dimension, metres; null when unknown. */
  section: number | null;
}

/** Union-find over points, bucketed on a `tolerance` grid: the root of each point's cluster. */
export function clusterEnds(points: readonly Vec3[], tolerance: number): number[] {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const cell = (p: Vec3) => p.map((v) => Math.floor(v / tolerance));
  const grid = new Map<string, number[]>();
  points.forEach((p, i) => {
    const [x, y, z] = cell(p);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
        if (length(sub(p, points[j])) <= tolerance) parent[find(i)] = find(j);
      }
    }
    const key = `${x},${y},${z}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });
  return points.map((_, i) => find(i));
}

/** Most cells one segment is filed under; a longer one goes on a list every query reads. */
const MAX_CELLS_PER_SEGMENT = 4096;

/** Segments filed under every grid cell their bounds, grown by a margin, touch; a query reads one cell. */
export class SegmentGrid {
  private readonly cells = new Map<string, number[]>();
  private readonly everywhere: number[] = [];

  constructor(private readonly size: number) {}

  insert(index: number, a: Vec3, b: Vec3, margin: number): void {
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(a[k], b[k]) - margin) / this.size));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(a[k], b[k]) + margin) / this.size));
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > MAX_CELLS_PER_SEGMENT) {
      this.everywhere.push(index);
      return;
    }
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const key = `${x},${y},${z}`;
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(index);
      else this.cells.set(key, [index]);
    }
  }

  near(p: Vec3): readonly number[] {
    const key = p.map((v) => Math.floor(v / this.size)).join(',');
    const local = this.cells.get(key) ?? [];
    return this.everywhere.length === 0 ? local : [...local, ...this.everywhere];
  }
}

interface Hit { j: number; t: number; target: Vec3; along: number; otherEnd: number | null }

/**
 * Move free ends along their own axes to meet other members, split members met
 * inside. `supported` says whether a point already has a support (a footing):
 * such an end is not free. Returns the lines after the moves, split into
 * pieces (each piece keeps its source line's index), and every move.
 */
export function joinEnds(
  lines: readonly JointLine[],
  tolerance: number,
  jointReach: number | null,
  supported: (p: Vec3) => boolean,
): { pieces: Array<{ source: number; start: Vec3; end: Vec3 }>; extended: ExtendedEnd[] } {
  const reachOf = (section: number | null) => jointReach ?? (section === null ? tolerance : section / 2 + tolerance);
  const maxReach = lines.reduce((m, line) => Math.max(m, reachOf(line.section)), tolerance);
  const ends = lines.flatMap((line): Vec3[] => [[...line.start], [...line.end]]);
  const roots = clusterEnds(ends, tolerance);
  const clusterSize = new Map<number, number>();
  for (const root of roots) clusterSize.set(root, (clusterSize.get(root) ?? 0) + 1);
  const free = ends.map((p, e) => clusterSize.get(roots[e]) === 1 && !supported(p));
  const grid = new SegmentGrid(Math.max(1, 2 * maxReach));
  lines.forEach((line, i) => grid.insert(i, line.start, line.end, maxReach + tolerance));
  const splits: Vec3[][] = lines.map(() => []);
  const joined = new Set<number>();
  const extended: ExtendedEnd[] = [];
  const endName = (e: number): ExtendedEnd['end'] => (e % 2 === 0 ? 'start' : 'end');

  for (let e = 0; e < ends.length; e++) {
    const i = e >> 1;
    const p = ends[e];
    const span = length(sub(p, ends[e ^ 1]));
    if (span <= tolerance) continue;
    const u = scale(sub(p, ends[e ^ 1]), 1 / span); // outward along this member
    const canMove = free[e] && !joined.has(e);
    let best: Hit | null = null;
    for (const j of grid.near(p)) {
      // Not itself, and not a member this end already shares a node with.
      if (j === i || roots[2 * j] === roots[e] || roots[2 * j + 1] === roots[e]) continue;
      const a = ends[2 * j], v = sub(ends[2 * j + 1], a), lv = length(v);
      if (lv <= tolerance) continue;
      const w = sub(p, a), uv = dot(u, v), vv = lv * lv, uw = dot(u, w), vw = dot(v, w);
      const denom = vv - uv * uv;
      if (denom <= 1e-9 * vv) continue; // parallel axes never meet
      const t = (uv * vw - vv * uw) / denom;
      const s = (vw - uv * uw) / denom;
      const target = add(a, scale(v, s));
      if (length(sub(add(p, scale(u, t)), target)) > tolerance) continue; // the axes pass each other
      if (Math.abs(t) > (canMove ? reachOf(lines[j].section) : tolerance) || span + t <= tolerance) continue;
      const along = s * lv;
      let otherEnd: number | null = null;
      if (along < -tolerance || along > lv + tolerance) {
        // Past the other member's end: that end must be free to move to the meeting point too.
        const k = along < 0 ? 2 * j : 2 * j + 1;
        const past = along < 0 ? -along : along - lv;
        if (!canMove || !free[k] || joined.has(k) || past > reachOf(lines[i].section)) continue;
        otherEnd = k;
      }
      if (!best || Math.abs(t) < Math.abs(best.t)) best = { j, t, target, along, otherEnd };
    }
    if (!best) continue;
    if (canMove && Math.abs(best.t) > 1e-9) {
      ends[e] = add(p, scale(u, best.t));
      extended.push({ elementId: lines[i].elementId, end: endName(e), distance: best.t, toElementId: lines[best.j].elementId });
    }
    joined.add(e);
    if (best.otherEnd !== null) {
      const k = best.otherEnd;
      extended.push({ elementId: lines[best.j].elementId, end: endName(k), distance: length(sub(best.target, ends[k])), toElementId: lines[i].elementId });
      ends[k] = best.target;
      joined.add(k);
    } else splits[best.j].push(best.target); // cuts at the member's ends are dropped below
  }

  const pieces: Array<{ source: number; start: Vec3; end: Vec3 }> = [];
  lines.forEach((_, i) => {
    const start = ends[2 * i], end = ends[2 * i + 1], axis = sub(end, start), lv = length(axis);
    const cuts = splits[i].map((p) => dot(sub(p, start), axis) / lv).filter((d) => d > tolerance && d < lv - tolerance).sort((x, y) => x - y)
      .filter((d, k, all) => k === 0 || d - all[k - 1] > tolerance);
    let from = start;
    for (const d of cuts) {
      const at = add(start, scale(axis, d / lv));
      pieces.push({ source: i, start: from, end: at });
      from = at;
    }
    pieces.push({ source: i, start: from, end });
  });
  return { pieces, extended };
}
