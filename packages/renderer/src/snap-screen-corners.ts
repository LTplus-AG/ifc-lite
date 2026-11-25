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
import type { PickClipState } from './pick-types.js';
import { isEntityVisible } from './entity-visibility.js';
import type { MeshGeometryCache } from './snap-geometry-cache.js';
import { depthAlongRay, segDist2, closestPointOnSegmentToRay } from './snap-screen-geometry.js';
import { buildScreenGrid, candidatesFromCache, type Grid, type PieceCandidates, type ScreenSnapCamera } from './snap-screen-grid.js';

export { closestPointOnSegmentToRay, candidatesFromCache };
export type { ScreenSnapCamera };

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
  /** Per-query time budget, in ms, for building candidates of not-yet-ready pieces. Default 6. */
  buildBudgetMs?: number;
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
  /**
   * Publish the corners near the cursor as snap markers (`Renderer.cornerMarkers`),
   * for a host that draws them. Default false.
   */
  markers?: boolean;
  /** Pixel radius around the cursor within which marker corners are listed. Default 48. */
  markerRadiusPx?: number;
  /** Most marker corners listed. Default 12. */
  markerLimit?: number;
}

export const DEFAULT_CORNER_RADIUS_PX = 10;
export const DEFAULT_EDGE_RADIUS_PX = 6;
const DEFAULT_BUILD_BUDGET_MS = 6;
const DEFAULT_SETTLE_MS = 120;

export interface ScreenCornerHit {
  kind: 'corner' | 'edge';
  position: Vec3;
  expressId: number;
  /** Screen distance from the cursor to the candidate, in CSS px. */
  distancePx: number;
  /** The edge's endpoints, for an edge hit. */
  edge?: { v0: Vec3; v1: Vec3 };
}

/** A corner offered as a snap marker: where it is on screen and in the world. */
export interface ScreenCornerCandidate {
  /** CSS px, canvas space. */
  screen: { x: number; y: number };
  position: Vec3;
  expressId: number;
  /** Screen distance from the cursor, in CSS px. */
  distancePx: number;
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
function gridKey(viewKey: string, clip: PickClipState | null | undefined, w: number, h: number, ready: number,
  hidden: ReadonlySet<number> | undefined, isolated: ReadonlySet<number> | null | undefined,
  opts: Required<Pick<ScreenCornerSnapOptions, 'cornerRadiusPx'>>, eligible: ReadonlySet<number> | undefined): string {
  const clipKey = clip ? JSON.stringify([clip.sectionPlane, clip.extraPlanes, clip.clipBox, idsOf(clip.sectionExcludedIds)]) : '';
  return [viewKey, clipKey, w, h, ready, idsOf(hidden), idsOf(isolated), idsOf(eligible), opts.cornerRadiusPx].join('|');
}

export class ScreenCornerIndex {
  private candidates = new WeakMap<MeshData, PieceCandidates>();
  private grid: Grid | null = null;
  /** The grid key last seen and when it first appeared, for the settle rule. */
  private seen: { key: string; at: number } | null = null;
  /** What the last query that reached the grid searched, for `candidatesNear`; null until one did, and after one that did not. */
  private live: { grid: Grid; ready: MeshData[]; ray: Ray; maxDepth: number } | null = null;
  private selection: { pieces: readonly MeshData[]; filterKey: string; ready: MeshData[]; complete: boolean } | null = null;

  /** Drop everything built from geometry (call with the snap detector's cache). */
  clear(): void {
    this.candidates = new WeakMap();
    this.grid = null;
    this.seen = null;
    this.selection = null;
    this.live = null;
  }

  /** Forget the last query's view, so `candidatesNear` answers nothing until the next query reaches the grid. */
  dropLive(): void { this.live = null; }

  /**
   * The corners of the LAST query's grid within `radiusPx` of (x, y), nearest first, at most `limit`: the markers a
   * host draws round the cursor. Same eligibility, visibility, clipping and occlusion as the query that preceded it
   * (`ignoreOcclusion` included), so a marker is never offered that the snap would refuse. Empty until that query
   * reached a built grid, so nothing is listed while the camera is still moving. Edges are not listed.
   */
  candidatesNear(x: number, y: number, radiusPx: number, limit = 12): ScreenCornerCandidate[] {
    const live = this.live;
    if (!live || !(radiusPx > 0) || !(limit > 0)) return [];
    const { grid: g, ready, ray, maxDepth } = live;
    const span = Math.ceil(radiusPx / g.cell);
    const c0 = Math.floor(x / g.cell) + 1, r0 = Math.floor(y / g.cell) + 1;
    const found: { i: number; d: number }[] = [];
    for (let r = r0 - span; r <= r0 + span; r++) {
      for (let c = c0 - span; c <= c0 + span; c++) {
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        for (const i of g.cornerCells.get(r * g.cols + c) ?? []) {
          const d = Math.hypot(g.cx[i] - x, g.cy[i] - y);
          if (d > radiusPx) continue;
          if (maxDepth !== Infinity && depthAlongRay(ray, g.cornerWorld[i * 3], g.cornerWorld[i * 3 + 1], g.cornerWorld[i * 3 + 2]) > maxDepth) continue;
          found.push({ i, d });
        }
      }
    }
    found.sort((a, b) => Math.abs(a.d - b.d) > 1e-9 ? a.d - b.d : this.cornerBefore(g, ready, a.i, b.i, ray) ? -1 : 1);
    return found.slice(0, limit).map(({ i, d }) => ({
      screen: { x: g.cx[i], y: g.cy[i] },
      position: { x: g.cornerWorld[i * 3], y: g.cornerWorld[i * 3 + 1], z: g.cornerWorld[i * 3 + 2] },
      expressId: ready[g.cornerPiece[i]].expressId,
      distancePx: d,
    }));
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

    // The filtered piece list is reused until the pieces, visibility or eligibility change.
    const filterKey = `${idsOf(args.hiddenIds)}|${idsOf(args.isolatedIds)}|${idsOf(eligible)}`;
    let sel = this.selection;
    if (!sel || sel.pieces !== args.pieces || sel.filterKey !== filterKey || !sel.complete) {
      const active = args.pieces.filter((p) =>
        (eligible === undefined || eligible.has(p.modelIndex ?? 0))
        && isEntityVisible(p.expressId, args.hiddenIds, args.isolatedIds));
      // Build candidates for a few pieces per call; the rest wait for later moves.
      const deadline = now() + (options.buildBudgetMs ?? DEFAULT_BUILD_BUDGET_MS);
      for (const piece of active) {
        if (this.candidates.has(piece)) continue;
        if (now() > deadline) break;
        this.candidates.set(piece, candidatesFromCache(piece.expressId, args.geometryFor(piece)));
      }
      const ready = active.filter((p) => this.candidates.has(p));
      sel = this.selection = { pieces: args.pieces, filterKey, ready, complete: ready.length === active.length };
    }
    const ready = sel.ready;
    this.live = null;
    if (ready.length === 0) return null;

    const key = gridKey(args.viewKey, args.clip, viewport.width, viewport.height, ready.length,
      args.hiddenIds, args.isolatedIds, { cornerRadiusPx: Math.max(cornerR, edgeR) }, eligible);
    if (!this.grid || this.grid.key !== key) {
      const t = now();
      if (this.seen?.key !== key) this.seen = { key, at: t };
      if (t - this.seen.at < (options.settleMs ?? DEFAULT_SETTLE_MS)) return null;
      this.grid = buildScreenGrid(key, ready, this.candidates, args.camera, viewport, Math.max(cornerR, edgeR), args.clip);
    }
    const hit = args.hitDistance;
    const maxDepth = options.ignoreOcclusion || hit == null || !Number.isFinite(hit) ? Infinity
      : hit + (options.occlusionTolerance ?? 0.05 + 0.01 * hit);
    this.live = { grid: this.grid, ready, ray: args.ray, maxDepth };
    return this.search(this.grid, ready, x, y, args.ray, cornerR, edgeR, maxDepth);
  }

  private search(g: Grid, ready: MeshData[], x: number, y: number, ray: Ray, cornerR: number, edgeR: number, maxDepth: number): ScreenCornerHit | null {
    const depthOf = (px: number, py: number, pz: number) => depthAlongRay(ray, px, py, pz);
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
          if (d < bestCornerD - 1e-9 || (Math.abs(d - bestCornerD) <= 1e-9 && bestCorner >= 0 && this.cornerBefore(g, ready, i, bestCorner, ray))) {
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
        expressId: ready[g.cornerPiece[bestCorner]].expressId,
        distancePx: Math.sqrt(bestCornerD),
      };
    }
    if (bestEdge >= 0) {
      const w = g.edgeWorld, o = bestEdge * 6;
      const v0 = { x: w[o], y: w[o + 1], z: w[o + 2] }, v1 = { x: w[o + 3], y: w[o + 4], z: w[o + 5] };
      return {
        kind: 'edge',
        position: closestPointOnSegmentToRay(v0, v1, ray),
        expressId: ready[g.edgePiece[bestEdge]].expressId,
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
  private cornerBefore(g: Grid, ready: MeshData[], i: number, j: number, ray: Ray): boolean {
    const depth = (k: number) => depthAlongRay(ray, g.cornerWorld[k * 3], g.cornerWorld[k * 3 + 1], g.cornerWorld[k * 3 + 2]);
    const di = depth(i), dj = depth(j);
    if (Math.abs(di - dj) > 1e-6) return di < dj;
    const ei = ready[g.cornerPiece[i]].expressId, ej = ready[g.cornerPiece[j]].expressId;
    if (ei !== ej) return ei < ej;
    for (let a = 0; a < 3; a++) {
      const vi = g.cornerWorld[i * 3 + a], vj = g.cornerWorld[j * 3 + a];
      if (vi !== vj) return vi < vj;
    }
    return false;
  }
}
