/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The data side of the screen-space corner search (#11504): world-space corner and
 * edge candidates of one piece, and the screen grid built from them. The search and
 * its settle/occlusion rules live in `snap-screen-corners.ts`.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3 } from './raycaster.js';
import type { Camera } from './camera.js';
import type { PickClipState } from './pick-types.js';
import { entityClip } from './section-exclusions.js';
import { pointClipped } from './scene-raycaster.js';
import { planesFor } from './snap-clip.js';
import { clipSegmentInterval } from './clip-half-spaces.js';
import { MIN_CORNER_VALENCE } from './snap-edge-runs.js';
import type { MeshGeometryCache } from './snap-geometry-cache.js';
import { lerp } from './snap-screen-geometry.js';

/** The camera pieces a query needs; `Camera` satisfies it. */
export type ScreenSnapCamera = Pick<Camera, 'projectToScreen'>;

export interface PieceCandidates {
  expressId: number;
  /** x, y, z per corner. */
  corners: Float64Array;
  /** x0, y0, z0, x1, y1, z1 per edge. */
  edges: Float64Array;
}

/** Corner quantisation used to drop duplicates within a piece (0.1 mm). */
const QUANT = 1e4;

/** Feature corners and feature edges of a geometry cache as flat world-space arrays. */
export function candidatesFromCache(expressId: number, cache: MeshGeometryCache): PieceCandidates {
  const seen = new Set<string>();
  const corners: number[] = [];
  const addCorner = (p: Vec3, valence: number) => {
    if (valence < MIN_CORNER_VALENCE) return;
    const key = `${Math.round(p.x * QUANT)},${Math.round(p.y * QUANT)},${Math.round(p.z * QUANT)}`;
    if (seen.has(key)) return;
    seen.add(key);
    corners.push(p.x, p.y, p.z);
  };
  const edges = new Float64Array(cache.edges.length * 6);
  cache.edges.forEach((edge, i) => {
    edges.set([edge.v0.x, edge.v0.y, edge.v0.z, edge.v1.x, edge.v1.y, edge.v1.z], i * 6);
    addCorner(edge.v0, edge.v0Valence);
    addCorner(edge.v1, edge.v1Valence);
    for (const j of edge.junctions) addCorner(j.point, j.valence);
  });
  return { expressId, corners: Float64Array.from(corners), edges };
}

export interface Grid {
  key: string;
  cell: number;
  cols: number;
  rows: number;
  /** Per cell: indices into the corner arrays. */
  cornerCells: Map<number, number[]>;
  cx: number[]; cy: number[]; cornerPiece: number[]; cornerWorld: number[];
  /** Per cell: indices into the edge arrays. */
  edgeCells: Map<number, number[]>;
  ex0: number[]; ey0: number[]; ex1: number[]; ey1: number[]; edgePiece: number[]; edgeWorld: number[];
}

/** The screen grid of the READY pieces' candidates, projected through `camera`, clipped by `clip`. */
export function buildScreenGrid(
  key: string, ready: MeshData[], candidates: WeakMap<MeshData, PieceCandidates>, camera: ScreenSnapCamera,
  viewport: { width: number; height: number }, cell: number, clip: PickClipState | null | undefined,
): Grid {
  const cols = Math.ceil(viewport.width / cell) + 3;
  const rows = Math.ceil(viewport.height / cell) + 3;
  const g: Grid = {
    key, cell, cols, rows, cornerCells: new Map(), edgeCells: new Map(),
    cx: [], cy: [], cornerPiece: [], cornerWorld: [],
    ex0: [], ey0: [], ex1: [], ey1: [], edgePiece: [], edgeWorld: [],
  };
  const cellOf = (px: number, py: number): number | null => {
    const c = Math.floor(px / cell) + 1, r = Math.floor(py / cell) + 1;
    return c < 0 || r < 0 || c >= cols || r >= rows ? null : r * cols + c;
  };
  const push = (m: Map<number, number[]>, k: number, v: number) => {
    const list = m.get(k);
    if (list) list.push(v); else m.set(k, [v]);
  };
  const tol = 1e-4;
  ready.forEach((piece, pi) => {
    const cand = candidates.get(piece)!;
    const ec = entityClip(clip, piece.expressId);
    const planes = planesFor(piece.expressId, clip);
    for (let i = 0; i < cand.corners.length; i += 3) {
      const wx = cand.corners[i], wy = cand.corners[i + 1], wz = cand.corners[i + 2];
      if (pointClipped(ec, wx, wy, wz)) continue;
      const s = camera.projectToScreen({ x: wx, y: wy, z: wz }, viewport.width, viewport.height);
      if (!s) continue;
      const c = cellOf(s.x, s.y);
      if (c === null) continue;
      const idx = g.cx.length;
      g.cx.push(s.x); g.cy.push(s.y); g.cornerPiece.push(pi); g.cornerWorld.push(wx, wy, wz);
      push(g.cornerCells, c, idx);
    }
    for (let i = 0; i < cand.edges.length; i += 6) {
      let a: Vec3 = { x: cand.edges[i], y: cand.edges[i + 1], z: cand.edges[i + 2] };
      let b: Vec3 = { x: cand.edges[i + 3], y: cand.edges[i + 4], z: cand.edges[i + 5] };
      if (planes.length > 0) {
        const iv = clipSegmentInterval(a, b, planes, tol);
        if (!iv) continue;
        const [lo, hi] = iv;
        const a0 = a;
        a = lo > 0 ? lerp(a0, b, lo) : a;
        b = hi < 1 ? lerp(a0, b, hi) : b;
      }
      const sa = camera.projectToScreen(a, viewport.width, viewport.height);
      const sb = camera.projectToScreen(b, viewport.width, viewport.height);
      if (!sa || !sb) continue;
      const idx = g.ex0.length;
      g.ex0.push(sa.x); g.ey0.push(sa.y); g.ex1.push(sb.x); g.ey1.push(sb.y);
      g.edgePiece.push(pi); g.edgeWorld.push(a.x, a.y, a.z, b.x, b.y, b.z);
      // Register the edge in every cell it passes through (clipped to the viewport band).
      const len = Math.hypot(sb.x - sa.x, sb.y - sa.y);
      const steps = Math.min(4096, Math.max(1, Math.ceil(len / (cell / 4))));
      let last = -1;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const c = cellOf(sa.x + (sb.x - sa.x) * t, sa.y + (sb.y - sa.y) * t);
        if (c === null || c === last) continue;
        last = c;
        push(g.edgeCells, c, idx);
      }
    }
  });
  return g;
}
