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
 * This path works in screen space instead. A pick only READS a screen grid of
 * projected candidates: 3 x 3 cells around the cursor. Everything that costs
 * anything (candidates per piece from the snap geometry cache, the grid) is
 * built in idle slices by `CornerBuildPipeline`, on-screen pieces first, and
 * only while the view is still, so a pointer move never builds a candidate or
 * a grid. Until the grid of the current view has pieces a query answers null
 * and the caller keeps its ray-based snap.
 *
 * Corners are endpoints (and junctions) of the geometry cache's feature edges
 * (boundary and crease edges, collinear runs merged), not triangle seams, so a
 * wall with openings offers its true corners. Corners outrank edges inside
 * their radius. The 3D point of an edge snap is the point of the edge nearest
 * the cursor RAY, so it stays exact under perspective.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Ray } from './raycaster.js';
import type { PickClipState } from './pick-types.js';
import type { MeshGeometryCache } from './snap-geometry-cache.js';
import type { StepBuild } from './snap-geometry-build.js';
import type { IdleHost } from './snap-idle-host.js';
import type { ScreenSnapCamera, ScreenCornerHit } from './snap-corner-grid.js';
import { gridKey } from './snap-corner-key.js';
import { CornerBuildPipeline, DEFAULT_MAX_SLICE_MS, DEFAULT_SETTLE_MS, type BuildStats } from './snap-corner-pipeline.js';

export { candidatesFromCache } from './snap-corner-candidates.js';
export { closestPointOnSegmentToRay } from './snap-corner-grid.js';
export type { ScreenSnapCamera, ScreenCornerHit } from './snap-corner-grid.js';
export type { IdleHost, IdleSlice } from './snap-idle-host.js';
export type { BuildStats } from './snap-corner-pipeline.js';


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
  /** Longest one idle slice of the candidate / grid build runs, in ms (a pick never builds). Default 6. */
  maxSliceMs?: number;
  /** Where idle slices come from. Default: `requestIdleCallback`, else `setTimeout`. Tests inject a manual one. */
  idleHost?: IdleHost;
  /**
   * Quiet time, in ms, the view must have kept still before the idle build
   * starts on it. Until the grid of the current view has pieces, queries answer
   * null and the caller keeps its ray-based snap. Default 120.
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

export class ScreenCornerIndex {
  private pipeline: CornerBuildPipeline | null = null;

  /** Drop everything built from geometry (call with the snap detector's cache) and stop the idle work. */
  clear(): void {
    this.pipeline?.clear();
    this.pipeline = null;
  }

  /** Build progress, for diagnostics and tests; null before the first query. */
  stats(): BuildStats | null {
    return this.pipeline?.stats() ?? null;
  }

  /**
   * The nearest corner, else nearest edge, of `pieces` near (x, y), read from the
   * grid of the current view; null when that grid has no pieces yet.
   *
   * `pieces` are all the scene's flat pieces: eligibility, visibility and
   * clipping are applied by the idle build. `geometryFor` builds a piece's snap
   * cache and is only ever called from an idle slice, never from here.
   */
  query(args: {
    x: number; y: number; ray: Ray;
    camera: ScreenSnapCamera & { getPosition(): { x: number; y: number; z: number } }; viewKey: string;
    /** The view's stamp now, for the idle build to notice the camera moving between picks. Default: `viewKey`. */
    liveViewKey?: () => string;
    viewport: { width: number; height: number };
    pieces: readonly MeshData[];
    geometryFor: (mesh: MeshData) => MeshGeometryCache;
    /** Optional: the same cache built in bounded steps. The idle build prefers it, so one huge piece spans several slices. */
    startGeometry?: (mesh: MeshData) => StepBuild<MeshGeometryCache>;
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
    const cell = Math.max(cornerR, edgeR);
    const eligible = options.eligibleModelIndices;
    const pipeline = this.pipeline ??= new CornerBuildPipeline(options.idleHost);

    // The view as the grid sees it: what a grid is built for, and what the settle timer runs on.
    const viewKey = gridKey(args.viewKey, args.clip, viewport.width, viewport.height, args.hiddenIds, args.isolatedIds, cell, eligible);
    const liveViewKey = args.liveViewKey;
    pipeline.observe({
      pieces: args.pieces, geometryFor: args.geometryFor, startGeometry: args.startGeometry, camera: args.camera, viewport,
      liveViewKey: liveViewKey ? () => liveViewKey() : () => args.viewKey,
      hiddenIds: args.hiddenIds, isolatedIds: args.isolatedIds, eligible, clip: args.clip, cell,
      settleMs: options.settleMs ?? DEFAULT_SETTLE_MS, maxSliceMs: options.maxSliceMs ?? DEFAULT_MAX_SLICE_MS,
      now: args.now ?? (() => performance.now()),
    }, viewKey);
    const grid = pipeline.gridFor(viewKey);
    if (!grid) return null;
    const hit = args.hitDistance;
    const maxDepth = options.ignoreOcclusion || hit == null || !Number.isFinite(hit) ? Infinity
      : hit + (options.occlusionTolerance ?? 0.05 + 0.01 * hit);
    return grid.search(x, y, args.ray, cornerR, edgeR, maxDepth);
  }
}
