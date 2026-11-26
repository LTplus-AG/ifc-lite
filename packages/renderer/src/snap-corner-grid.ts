/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The screen-space grid of projected snap candidates (#11504). It is filled
 * one piece at a time (`addPiece`) so an idle slice can stop between pieces,
 * and it answers queries while it is still filling: a query only reads the
 * 3 x 3 cells around the cursor.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3, Ray } from './raycaster.js';
import type { PickClipState } from './pick-types.js';
import { entityClip } from './section-exclusions.js';
import { pointClipped } from './scene-raycaster.js';
import { planesFor } from './snap-clip.js';
import { clipSegmentInterval } from './clip-half-spaces.js';
import type { PieceCandidates } from './snap-corner-candidates.js';
import type { Camera } from './camera.js';

/** The camera pieces a query needs; `Camera` satisfies it. */
export type ScreenSnapCamera = Pick<Camera, 'projectToScreen'>;

export interface ScreenCornerHit {
  kind: 'corner' | 'edge';
  position: Vec3;
  expressId: number;
  /** Screen distance from the cursor to the candidate, in CSS px. */
  distancePx: number;
  /** The edge's endpoints, for an edge hit. */
  edge?: { v0: Vec3; v1: Vec3 };
}

const CLIP_TOL = 1e-4;

export class CornerGrid {
  /** The pieces `cornerPiece` / `edgePiece` index into, in the order they were added. */
  readonly pieces: MeshData[] = [];
  private readonly added = new WeakSet<MeshData>();
  private readonly cols: number;
  private readonly rows: number;
  /** Per cell: indices into the corner arrays. */
  private readonly cornerCells = new Map<number, number[]>();
  private readonly cx: number[] = []; private readonly cy: number[] = [];
  /** Corner i: its piece's index and its ordinal in that piece's candidates (its world position is read from there). */
  private readonly cornerPiece: number[] = []; private readonly cornerOrd: number[] = [];
  /** The candidates of `pieces[i]`, whose arrays hold every world position the grid reports. */
  private readonly cands: PieceCandidates[] = [];
  /** Per cell: indices into the edge arrays. */
  private readonly edgeCells = new Map<number, number[]>();
  private readonly ex0: number[] = []; private readonly ey0: number[] = [];
  private readonly ex1: number[] = []; private readonly ey1: number[] = [];
  private readonly edgePiece: number[] = []; private readonly edgeOrd: number[] = [];
  /** World endpoints of the edges a section plane shortened; every other edge reads its candidates. */
  private readonly clippedEnds = new Map<number, Float64Array>();

  constructor(
    /** What the view was when the grid was started (see `gridKey`). */
    readonly key: string,
    private readonly camera: ScreenSnapCamera,
    private readonly viewport: { width: number; height: number },
    private readonly cell: number,
    private readonly clip: PickClipState | null | undefined,
  ) {
    this.cols = Math.ceil(viewport.width / cell) + 3;
    this.rows = Math.ceil(viewport.height / cell) + 3;
  }

  has(piece: MeshData): boolean { return this.added.has(piece); }

  private cellOf(px: number, py: number): number | null {
    const c = Math.floor(px / this.cell) + 1, r = Math.floor(py / this.cell) + 1;
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? null : r * this.cols + c;
  }

  private static push(m: Map<number, number[]>, k: number, v: number): void {
    const list = m.get(k);
    if (list) list.push(v); else m.set(k, [v]);
  }

  /** Project one piece's candidates into the grid. */
  addPiece(piece: MeshData, cand: PieceCandidates): void {
    if (this.added.has(piece)) return;
    this.added.add(piece);
    const g = this, { camera, viewport, clip, cell } = this;
    const pi = this.pieces.push(piece) - 1;
    this.cands.push(cand);
    const ec = entityClip(clip, piece.expressId);
    const planes = planesFor(piece.expressId, clip);
    for (let i = 0; i < cand.corners.length; i += 3) {
      const wx = cand.corners[i], wy = cand.corners[i + 1], wz = cand.corners[i + 2];
      if (pointClipped(ec, wx, wy, wz)) continue;
      const s = camera.projectToScreen({ x: wx, y: wy, z: wz }, viewport.width, viewport.height);
      if (!s) continue;
      const c = this.cellOf(s.x, s.y);
      if (c === null) continue;
      const idx = g.cx.length;
      g.cx.push(s.x); g.cy.push(s.y); g.cornerPiece.push(pi); g.cornerOrd.push(i / 3);
      CornerGrid.push(g.cornerCells, c, idx);
    }
    for (let i = 0; i < cand.edges.length; i += 6) {
      const a0: Vec3 = { x: cand.edges[i], y: cand.edges[i + 1], z: cand.edges[i + 2] };
      const b0: Vec3 = { x: cand.edges[i + 3], y: cand.edges[i + 4], z: cand.edges[i + 5] };
      let a = a0, b = b0;
      if (planes.length > 0) {
        const iv = clipSegmentInterval(a0, b0, planes, CLIP_TOL);
        if (!iv) continue;
        const [lo, hi] = iv;
        a = lo > 0 ? lerp(a0, b0, lo) : a0;
        b = hi < 1 ? lerp(a0, b0, hi) : b0;
      }
      const sa = camera.projectToScreen(a, viewport.width, viewport.height);
      const sb = camera.projectToScreen(b, viewport.width, viewport.height);
      if (!sa || !sb) continue;
      const idx = g.ex0.length;
      g.ex0.push(sa.x); g.ey0.push(sa.y); g.ex1.push(sb.x); g.ey1.push(sb.y);
      g.edgePiece.push(pi); g.edgeOrd.push(i / 6);
      if (a !== a0 || b !== b0) g.clippedEnds.set(idx, Float64Array.of(a.x, a.y, a.z, b.x, b.y, b.z));
      // Register the edge in every cell it passes through (clipped to the viewport band).
      const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
      const steps = Math.min(4096, Math.max(1, Math.ceil(len / (cell / 4))));
      let last = -1;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const c = this.cellOf(sa.x + (sb.x - sa.x) * t, sa.y + (sb.y - sa.y) * t);
        if (c === null || c === last) continue;
        last = c;
        CornerGrid.push(g.edgeCells, c, idx);
      }
    }
  }

  /** Rough heap held by the grid's own arrays, in bytes (8 per stored number; cell lists excluded; candidates are counted by their owner). */
  approxBytes(): number {
    return 8 * (this.cx.length * 3 + this.ex0.length * 5 + this.clippedEnds.size * 6);
  }

  private cornerAt(i: number): Vec3 {
    const c = this.cands[this.cornerPiece[i]].corners, o = this.cornerOrd[i] * 3;
    return { x: c[o], y: c[o + 1], z: c[o + 2] };
  }

  private edgeEnds(i: number): [Vec3, Vec3] {
    const w = this.clippedEnds.get(i) ?? this.cands[this.edgePiece[i]].edges.subarray(this.edgeOrd[i] * 6, this.edgeOrd[i] * 6 + 6);
    return [{ x: w[0], y: w[1], z: w[2] }, { x: w[3], y: w[4], z: w[5] }];
  }

  search(x: number, y: number, ray: Ray, cornerR: number, edgeR: number, maxDepth: number): ScreenCornerHit | null {
    const g = this;
    const depthOf = (px: number, py: number, pz: number) => (px - ray.origin.x) * ray.direction.x
      + (py - ray.origin.y) * ray.direction.y + (pz - ray.origin.z) * ray.direction.z;
    const c0 = Math.floor(x / g.cell) + 1, r0 = Math.floor(y / g.cell) + 1;
    let bestCorner = -1, bestCornerD = cornerR * cornerR;
    let bestEdge = -1, bestEdgeD = edgeR * edgeR;
    for (let r = r0 - 1; r <= r0 + 1; r++) {
      for (let c = c0 - 1; c <= c0 + 1; c++) {
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        const k = r * g.cols + c;
        for (const i of g.cornerCells.get(k) ?? []) {
          const d = (g.cx[i] - x) ** 2 + (g.cy[i] - y) ** 2;
          if (d > bestCornerD + 1e-9) continue;
          if (maxDepth !== Infinity) {
            const p = g.cornerAt(i);
            if (depthOf(p.x, p.y, p.z) > maxDepth) continue;
          }
          if (d < bestCornerD - 1e-9 || (Math.abs(d - bestCornerD) <= 1e-9 && bestCorner >= 0 && g.cornerBefore(i, bestCorner, ray))) {
            bestCorner = i; bestCornerD = d;
          }
        }
        for (const i of g.edgeCells.get(k) ?? []) {
          const d = segDist2(x, y, g.ex0[i], g.ey0[i], g.ex1[i], g.ey1[i]);
          if (d >= bestEdgeD) continue;
          if (maxDepth !== Infinity) {
            const [e0, e1] = g.edgeEnds(i);
            const p = closestPointOnSegmentToRay(e0, e1, ray);
            if (depthOf(p.x, p.y, p.z) > maxDepth) continue;
          }
          bestEdge = i; bestEdgeD = d;
        }
      }
    }
    if (bestCorner >= 0) {
      return {
        kind: 'corner',
        position: g.cornerAt(bestCorner),
        expressId: g.pieces[g.cornerPiece[bestCorner]].expressId,
        distancePx: Math.sqrt(bestCornerD),
      };
    }
    if (bestEdge >= 0) {
      const [v0, v1] = g.edgeEnds(bestEdge);
      return {
        kind: 'edge',
        position: closestPointOnSegmentToRay(v0, v1, ray),
        expressId: g.pieces[g.edgePiece[bestEdge]].expressId,
        distancePx: Math.sqrt(bestEdgeD),
        edge: { v0, v1 },
      };
    }
    return null;
  }

  /**
   * Tiebreak between corners at the same screen position: the one nearer the
   * viewer (a box's top corner over its bottom one), then lower expressId,
   * then position, so the answer never depends on piece order.
   */
  private cornerBefore(i: number, j: number, ray: Ray): boolean {
    const g = this;
    const depth = (k: number) => {
      const p = g.cornerAt(k);
      return (p.x - ray.origin.x) * ray.direction.x + (p.y - ray.origin.y) * ray.direction.y + (p.z - ray.origin.z) * ray.direction.z;
    };
    const di = depth(i), dj = depth(j);
    if (Math.abs(di - dj) > 1e-6) return di < dj;
    const ei = g.pieces[g.cornerPiece[i]].expressId, ej = g.pieces[g.cornerPiece[j]].expressId;
    if (ei !== ej) return ei < ej;
    const pi = g.cornerAt(i), pj = g.cornerAt(j);
    for (const a of ['x', 'y', 'z'] as const) {
      if (pi[a] !== pj[a]) return pi[a] < pj[a];
    }
    return false;
  }
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** Squared distance from (px, py) to segment (ax, ay)-(bx, by). */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return (px - ax - dx * t) ** 2 + (py - ay - dy * t) ** 2;
}

/** The point of segment a-b nearest the ray's line (clamped to the segment). */
export function closestPointOnSegmentToRay(a: Vec3, b: Vec3, ray: Ray): Vec3 {
  const o = ray.origin, d = ray.direction;
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const wx = a.x - o.x, wy = a.y - o.y, wz = a.z - o.z;
  const uu = ux * ux + uy * uy + uz * uz;
  const dd = d.x * d.x + d.y * d.y + d.z * d.z;
  const ud = ux * d.x + uy * d.y + uz * d.z;
  const uw = ux * wx + uy * wy + uz * wz;
  const dw = d.x * wx + d.y * wy + d.z * wz;
  const denom = uu * dd - ud * ud;
  // Parallel to the ray: any point is as near, take the midpoint.
  const t = denom > 1e-12 * uu * dd ? Math.max(0, Math.min(1, (ud * dw - dd * uw) / denom)) : 0.5;
  return lerp(a, b, t);
}
