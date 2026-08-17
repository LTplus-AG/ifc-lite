/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Internal software depth rasterizer backing HiddenLineClassifier.
 *
 * Rasterizes the KEPT half of the section - flip-adjusted signed depth
 * `d` in `[-occluderDepth, 0]`, see the sign-convention comment in
 * projection-bands.ts - into a per-pixel minimum buffer of VIEW DEPTHS
 * (`-d`): 0 at the cut plane, increasing into the kept half, smaller means
 * nearer the viewer. Before issue #2639 the rasterizer sampled the CUT-AWAY
 * half instead, so nothing that could actually occlude was ever rasterized.
 *
 * Depth and 2D projection reuse the exact plane-aware helpers the line
 * producers use (`signedDepth` / `projectPointForPlane`), so the buffer and
 * the lines sampled against it agree on frame and sign by construction,
 * for cardinal and custom planes alike.
 *
 * The vertex fetch, the projected-extent walk and the barycentric test are
 * shared with the shaded colour raster via `raster-core.ts`. The per-pixel
 * loop below is NOT shared: this one maps the extent onto `width - 1` (pixel
 * CENTRES sit on the bounds edges), which is right for sampling a buffer and
 * wrong for an image whose rectangle must cover the extent exactly, so
 * `color-raster.ts` maps edge-to-edge instead.
 *
 * Internal module: not exported from the package index.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Bounds2D, SectionPlaneConfig } from './types.js';
import { EPSILON } from './math.js';
import { signedDepth, projectPointForPlane } from './projection-bands.js';
import type { RasterVertex } from './raster-core.js';
import { getVertex, barycentricCoords, computeProjectedBounds } from './raster-core.js';

export interface DepthRaster {
  /** Per-pixel minimum view depth; Infinity where nothing rasterized. */
  buffer: Float32Array;
  width: number;
  height: number;
  bounds: Bounds2D;
}

/**
 * 2D bounds of every occluder vertex whose view depth lies in
 * `[0, occluderDepth]` (the kept half of the section), grown by a 1% margin
 * so geometry on the exact edge still rasterizes cleanly. Empty (non-finite)
 * when no vertex is in the window: the caller degrades to "everything
 * visible".
 */
export function computeOccluderBounds(
  meshes: MeshData[],
  plane: SectionPlaneConfig,
  occluderDepth: number,
): Bounds2D {
  return computeProjectedBounds(meshes, plane, occluderDepth, 0.01);
}

/**
 * Build the min-view-depth raster for the kept half of the section.
 * Returns `null` when the bounds are empty or degenerate (no in-window
 * occluder and none supplied): nothing can occlude, so the caller must
 * classify every line visible instead of sampling a buffer with NaN
 * coordinates (which classified EVERYTHING hidden - issue #2639).
 */
export function buildDepthRaster(
  meshes: MeshData[],
  plane: SectionPlaneConfig,
  occluderDepth: number,
  resolution: number,
  depthBias: number,
  bounds?: Bounds2D,
): DepthRaster | null {
  const b = bounds ?? computeOccluderBounds(meshes, plane, occluderDepth);
  const boundsWidth = b.max.x - b.min.x;
  const boundsHeight = b.max.y - b.min.y;

  if (
    !Number.isFinite(boundsWidth) ||
    !Number.isFinite(boundsHeight) ||
    boundsWidth < EPSILON ||
    boundsHeight < EPSILON
  ) {
    return null;
  }

  let width: number;
  let height: number;
  const aspect = boundsWidth / boundsHeight;
  if (aspect > 1) {
    width = resolution;
    height = Math.max(1, Math.floor(resolution / aspect));
  } else {
    height = resolution;
    width = Math.max(1, Math.floor(resolution * aspect));
  }

  const buffer = new Float32Array(width * height);
  buffer.fill(Infinity);

  const raster: DepthRaster = { buffer, width, height, bounds: b };

  for (const mesh of meshes) {
    rasterizeMesh(raster, mesh, plane, occluderDepth, depthBias);
  }

  return raster;
}

function rasterizeMesh(
  raster: DepthRaster,
  mesh: MeshData,
  plane: SectionPlaneConfig,
  occluderDepth: number,
  depthBias: number,
): void {
  const { positions, indices, origin } = mesh;
  const triangleCount = indices.length / 3;

  const inWindow = (viewDepth: number) => viewDepth >= 0 && viewDepth <= occluderDepth;

  for (let t = 0; t < triangleCount; t++) {
    const v0 = getVertex(positions, indices[t * 3], origin);
    const v1 = getVertex(positions, indices[t * 3 + 1], origin);
    const v2 = getVertex(positions, indices[t * 3 + 2], origin);

    const depth0 = -signedDepth(v0, plane);
    const depth1 = -signedDepth(v1, plane);
    const depth2 = -signedDepth(v2, plane);

    // Skip triangles entirely outside the kept-half window.
    if (!inWindow(depth0) && !inWindow(depth1) && !inWindow(depth2)) {
      continue;
    }

    const uv0 = projectPointForPlane(v0, plane);
    const uv1 = projectPointForPlane(v1, plane);
    const uv2 = projectPointForPlane(v2, plane);

    rasterizeTriangle(
      raster,
      { x: uv0.x, y: uv0.y, depth: depth0 },
      { x: uv1.x, y: uv1.y, depth: depth1 },
      { x: uv2.x, y: uv2.y, depth: depth2 },
      depthBias,
    );
  }
}

function rasterizeTriangle(
  raster: DepthRaster,
  p0: RasterVertex,
  p1: RasterVertex,
  p2: RasterVertex,
  depthBias: number,
): void {
  const { buffer, width, height, bounds } = raster;

  const toPixelX = (x: number) => ((x - bounds.min.x) / (bounds.max.x - bounds.min.x)) * (width - 1);
  const toPixelY = (y: number) =>
    ((y - bounds.min.y) / (bounds.max.y - bounds.min.y)) * (height - 1);

  const px0 = { x: toPixelX(p0.x), y: toPixelY(p0.y), depth: p0.depth };
  const px1 = { x: toPixelX(p1.x), y: toPixelY(p1.y), depth: p1.depth };
  const px2 = { x: toPixelX(p2.x), y: toPixelY(p2.y), depth: p2.depth };

  const minX = Math.max(0, Math.floor(Math.min(px0.x, px1.x, px2.x)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(px0.x, px1.x, px2.x)));
  const minY = Math.max(0, Math.floor(Math.min(px0.y, px1.y, px2.y)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(px0.y, px1.y, px2.y)));

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const bary = barycentricCoords(px + 0.5, py + 0.5, px0, px1, px2);

      if (bary.u >= 0 && bary.v >= 0 && bary.w >= 0) {
        const depth = bary.u * px0.depth + bary.v * px1.depth + bary.w * px2.depth;

        // The above-cut portion of a straddling triangle is cut away by the
        // section and must not occlude anything in the kept half.
        if (depth < -depthBias) {
          continue;
        }

        const idx = py * width + px;
        if (depth < buffer[idx]) {
          buffer[idx] = depth;
        }
      }
    }
  }
}
