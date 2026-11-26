/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CAD-style corner snapping (#11504): find the nearest feature corner (then
 * feature edge) of the ELIGIBLE meshes whose projection lies within a few
 * pixels of the cursor, whether or not the ray hits that element.
 *
 * The ray-based path (`SnapDetector`) only looks at the intersected mesh, so
 * approaching a corner over background or over another element gave nothing.
 * This path works in screen space instead and costs, per mouse move:
 *
 * - candidates per piece (feature corners + feature edges, world space) are
 *   built ONCE from the snap geometry cache, a few pieces per move under a
 *   time budget, so a large model never stalls one frame;
 * - a coarse screen-space grid of the projected candidates is rebuilt only
 *   when the camera, clip, visibility, eligibility or the ready piece set
 *   changes, never per move;
 * - a query reads the 3 x 3 grid cells around the cursor.
 *
 * Corners are endpoints (and junctions) of the geometry cache's feature edges
 * (boundary and crease edges, collinear runs merged), not triangle seams, so a
 * wall with openings offers its true corners. Corners outrank edges inside
 * their radius. The 3D point of an edge snap is the point of the edge nearest
 * the cursor RAY, so it stays exact under perspective.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3, Ray } from './raycaster.js';
import type { Camera } from './camera.js';
import type { PickClipState } from './pick-types.js';
import { isEntityVisible } from './entity-visibility.js';
import { entityClip } from './section-exclusions.js';
import { pointClipped } from './scene-raycaster.js';
import { planesFor } from './snap-clip.js';
import { clipSegmentInterval } from './clip-half-spaces.js';
import { MIN_CORNER_VALENCE } from './snap-edge-runs.js';
import type { MeshGeometryCache } from './snap-geometry-cache.js';

/** Options of the screen-space corner search. Pass `{}` for the defaults. */
export interface ScreenCornerSnapOptions {
  /** Pixel radius within which a corner is snapped to. Default 10. */
  cornerRadiusPx?: number;
  /** Pixel radius within which an edge is snapped to when no corner is. Default 6. */
  edgeRadiusPx?: number;
  /**
   * Only meshes whose `modelIndex` is in this set take part (the models
   * eligible for the current pick). Absent: every model. A mesh without a
   * `modelIndex` counts as index 0.
   */
  eligibleModelIndices?: ReadonlySet<number>;
  /** Per-query time budget, in ms, for building candidates of not-yet-ready pieces while the view moves. Default 6. */
  buildBudgetMs?: number;
  /**
   * Per-query budget for the same work once the view has been still for `settleMs`: a large model's candidates
   * are then built within a few seconds of hovering instead of a few pieces per move. Default 24.
   */
  settledBuildBudgetMs?: number;
  /**
   * Quiet time, in ms, the view must have kept still before the screen grid is
   * (re)built. A rebuild is a ~100 ms pass over every candidate, so it never
   * runs inside an orbit; until it has run, queries answer null and the caller
   * keeps its ray-based snap. Default 120.
   */
  settleMs?: number;
  /**
   * Snap to corners and edges hidden behind other geometry (the later X-ray
   * mode). Default false: when the ray hit something, candidates farther along
   * the ray than the hit by more than `occlusionTolerance` are skipped.
   */
  ignoreOcclusion?: boolean;
  /** Depth slack, in world units, for the occlusion rule. Default 0.05 + 1 % of the hit distance. */
  occlusionTolerance?: number;
}

export const DEFAULT_CORNER_RADIUS_PX = 10;
export const DEFAULT_EDGE_RADIUS_PX = 6;
const DEFAULT_BUILD_BUDGET_MS = 6;
const DEFAULT_SETTLE_MS = 120;
const DEFAULT_SETTLED_BUILD_BUDGET_MS = 24;
/** A grid that lacks pieces is rebuilt once the ready pieces outnumber its own by this factor. */
const GRID_REGROW_FACTOR = 1.5;

export interface ScreenCornerHit {
  kind: 'corner' | 'edge';
  position: Vec3;
  expressId: number;
  /** Screen distance from the cursor to the candidate, in CSS px. */
  distancePx: number;
  /** The edge's endpoints, for an edge hit. */
  edge?: { v0: Vec3; v1: Vec3 };
}

interface PieceCandidates {
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

const setStamps = new WeakMap<object, number>();
let nextSetStamp = 1;
/**
 * A set's identity plus its size: hashing thousands of hidden ids on every
 * mouse move would cost more than the query. Hosts replace these sets when
 * visibility changes; an in-place edit that keeps the size is not seen.
 */
function idsOf(s: ReadonlySet<number> | null | undefined): string {
  if (s == null) return '-';
  let id = setStamps.get(s);
  if (id === undefined) setStamps.set(s, id = nextSetStamp++);
  return `${id}:${s.size}`;
}

/** What a screen grid was built for; any difference rebuilds it. */
function gridKey(viewKey: string, clip: PickClipState | null | undefined, w: number, h: number,
  hidden: ReadonlySet<number> | undefined, isolated: ReadonlySet<number> | null | undefined,
  opts: Required<Pick<ScreenCornerSnapOptions, 'cornerRadiusPx'>>, eligible: ReadonlySet<number> | undefined): string {
  const clipKey = clip ? JSON.stringify([clip.sectionPlane, clip.extraPlanes, clip.clipBox, idsOf(clip.sectionExcludedIds)]) : '';
  return [viewKey, clipKey, w, h, idsOf(hidden), idsOf(isolated), idsOf(eligible), opts.cornerRadiusPx].join('|');
}

interface Grid {
  /** What the view was when the grid was built (see `gridKey`). */
  key: string;
  /** How many ready pieces the grid holds; later-built pieces need a rebuild (see `grownEnough`). */
  readyCount: number;
  /** The pieces the grid's `cornerPiece` / `edgePiece` indices refer to (a snapshot: the live list may have grown). */
  pieces: readonly MeshData[];
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

/** The camera pieces a query needs; `Camera` satisfies it. */
export type ScreenSnapCamera = Pick<Camera, 'projectToScreen'>;

export class ScreenCornerIndex {
  private candidates = new WeakMap<MeshData, PieceCandidates>();
  private grid: Grid | null = null;
  /** The grid key last seen and when it first appeared, for the settle rule. */
  private seen: { key: string; at: number } | null = null;
  private selection: { pieces: readonly MeshData[]; filterKey: string; ready: MeshData[]; complete: boolean } | null = null;

  /** Drop everything built from geometry (call with the snap detector's cache). */
  clear(): void {
    this.candidates = new WeakMap();
    this.grid = null;
    this.seen = null;
    this.selection = null;
  }

  /**
   * The nearest corner, else nearest edge, of `pieces` near (x, y).
   *
   * `pieces` are all the scene's flat pieces: eligibility, visibility and
   * clipping are applied here. `geometryFor` builds a piece's snap cache and is
   * only called for pieces that pass those filters and are not built yet, a few
   * per call under `buildBudgetMs`.
   */
  query(args: {
    x: number; y: number; ray: Ray;
    camera: ScreenSnapCamera; viewKey: string;
    viewport: { width: number; height: number };
    pieces: readonly MeshData[];
    geometryFor: (mesh: MeshData) => MeshGeometryCache;
    options: ScreenCornerSnapOptions;
    hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null;
    clip?: PickClipState | null;
    /** Distance along the ray to the first surface it hit, or null when it hit nothing. */
    hitDistance?: number | null;
    now?: () => number;
  }): ScreenCornerHit | null {
    const { x, y, viewport, options } = args;
    const cornerR = options.cornerRadiusPx ?? DEFAULT_CORNER_RADIUS_PX;
    const edgeR = options.edgeRadiusPx ?? DEFAULT_EDGE_RADIUS_PX;
    if (!(cornerR > 0) && !(edgeR > 0)) return null;
    const eligible = options.eligibleModelIndices;
    const now = args.now ?? (() => performance.now());

    // The view as the grid sees it. The settle timer runs on this key alone: it must not restart each time
    // another piece's candidates become ready, or a model with more pieces than one move can build never settles.
    const viewKey = gridKey(args.viewKey, args.clip, viewport.width, viewport.height,
      args.hiddenIds, args.isolatedIds, { cornerRadiusPx: Math.max(cornerR, edgeR) }, eligible);
    const t0 = now();
    if (this.seen?.key !== viewKey) this.seen = { key: viewKey, at: t0 };
    const settled = t0 - this.seen.at >= (options.settleMs ?? DEFAULT_SETTLE_MS);

    // The filtered piece list is reused until the pieces, visibility or eligibility change.
    const filterKey = `${idsOf(args.hiddenIds)}|${idsOf(args.isolatedIds)}|${idsOf(eligible)}`;
    let sel = this.selection;
    if (!sel || sel.pieces !== args.pieces || sel.filterKey !== filterKey || !sel.complete) {
      const active = args.pieces.filter((p) =>
        (eligible === undefined || eligible.has(p.modelIndex ?? 0))
        && isEntityVisible(p.expressId, args.hiddenIds, args.isolatedIds));
      // Build candidates for a few pieces per call (more once the view is still); the rest wait for later moves.
      const budget = settled
        ? Math.max(options.buildBudgetMs ?? DEFAULT_BUILD_BUDGET_MS, options.settledBuildBudgetMs ?? DEFAULT_SETTLED_BUILD_BUDGET_MS)
        : options.buildBudgetMs ?? DEFAULT_BUILD_BUDGET_MS;
      const deadline = now() + budget;
      for (const piece of active) {
        if (this.candidates.has(piece)) continue;
        if (now() > deadline) break;
        this.candidates.set(piece, candidatesFromCache(piece.expressId, args.geometryFor(piece)));
      }
      const ready = active.filter((p) => this.candidates.has(p));
      sel = this.selection = { pieces: args.pieces, filterKey, ready, complete: ready.length === active.length };
    }
    const ready = sel.ready;
    if (ready.length === 0) return null;

    const sameView = this.grid?.key === viewKey;
    // A grid built before every piece was ready is rebuilt when it has grown enough, or the last piece arrived.
    const grownEnough = !!this.grid && ready.length > this.grid.readyCount
      && (sel.complete || ready.length >= this.grid.readyCount * GRID_REGROW_FACTOR);
    if (!this.grid || !sameView || grownEnough) {
      // Never inside a camera move; a grid of this very view that merely lacks a few pieces keeps answering meanwhile.
      if (settled) this.grid = this.buildGrid(viewKey, ready, args.camera, viewport, Math.max(cornerR, edgeR), args.clip);
      else if (!this.grid || !sameView) return null;
    }
    const hit = args.hitDistance;
    const maxDepth = options.ignoreOcclusion || hit == null || !Number.isFinite(hit) ? Infinity
      : hit + (options.occlusionTolerance ?? 0.05 + 0.01 * hit);
    return this.search(this.grid!, x, y, args.ray, cornerR, edgeR, maxDepth);
  }

  private buildGrid(
    key: string, ready: MeshData[], camera: ScreenSnapCamera,
    viewport: { width: number; height: number }, cell: number, clip: PickClipState | null | undefined,
  ): Grid {
    const cols = Math.ceil(viewport.width / cell) + 3;
    const rows = Math.ceil(viewport.height / cell) + 3;
    const g: Grid = {
      key, readyCount: ready.length, pieces: ready, cell, cols, rows, cornerCells: new Map(), edgeCells: new Map(),
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
      const cand = this.candidates.get(piece)!;
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

  private search(g: Grid, x: number, y: number, ray: Ray, cornerR: number, edgeR: number, maxDepth: number): ScreenCornerHit | null {
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
          if (maxDepth !== Infinity && depthOf(g.cornerWorld[i * 3], g.cornerWorld[i * 3 + 1], g.cornerWorld[i * 3 + 2]) > maxDepth) continue;
          if (d < bestCornerD - 1e-9 || (Math.abs(d - bestCornerD) <= 1e-9 && bestCorner >= 0 && this.cornerBefore(g, i, bestCorner, ray))) {
            bestCorner = i; bestCornerD = d;
          }
        }
        for (const i of g.edgeCells.get(k) ?? []) {
          const d = segDist2(x, y, g.ex0[i], g.ey0[i], g.ex1[i], g.ey1[i]);
          if (d >= bestEdgeD) continue;
          if (maxDepth !== Infinity) {
            const o = i * 6, w = g.edgeWorld;
            const p = closestPointOnSegmentToRay({ x: w[o], y: w[o + 1], z: w[o + 2] }, { x: w[o + 3], y: w[o + 4], z: w[o + 5] }, ray);
            if (depthOf(p.x, p.y, p.z) > maxDepth) continue;
          }
          bestEdge = i; bestEdgeD = d;
        }
      }
    }
    if (bestCorner >= 0) {
      const w = g.cornerWorld;
      return {
        kind: 'corner',
        position: { x: w[bestCorner * 3], y: w[bestCorner * 3 + 1], z: w[bestCorner * 3 + 2] },
        expressId: g.pieces[g.cornerPiece[bestCorner]].expressId,
        distancePx: Math.sqrt(bestCornerD),
      };
    }
    if (bestEdge >= 0) {
      const w = g.edgeWorld, o = bestEdge * 6;
      const v0 = { x: w[o], y: w[o + 1], z: w[o + 2] }, v1 = { x: w[o + 3], y: w[o + 4], z: w[o + 5] };
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
  private cornerBefore(g: Grid, i: number, j: number, ray: Ray): boolean {
    const depth = (k: number) => (g.cornerWorld[k * 3] - ray.origin.x) * ray.direction.x
      + (g.cornerWorld[k * 3 + 1] - ray.origin.y) * ray.direction.y
      + (g.cornerWorld[k * 3 + 2] - ray.origin.z) * ray.direction.z;
    const di = depth(i), dj = depth(j);
    if (Math.abs(di - dj) > 1e-6) return di < dj;
    const ei = g.pieces[g.cornerPiece[i]].expressId, ej = g.pieces[g.cornerPiece[j]].expressId;
    if (ei !== ej) return ei < ej;
    for (let a = 0; a < 3; a++) {
      const vi = g.cornerWorld[i * 3 + a], vj = g.cornerWorld[j * 3 + a];
      if (vi !== vj) return vi < vj;
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
