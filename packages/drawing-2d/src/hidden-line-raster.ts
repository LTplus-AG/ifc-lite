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
 * Internal module: not exported from the package index.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3, Bounds2D, SectionPlaneConfig } from './types.js';
import { vec3, boundsEmpty, boundsExtendPoint, EPSILON } from './math.js';
import { signedDepth, projectPointForPlane } from './projection-bands.js';

export interface DepthRaster {
  /** Per-pixel minimum view depth; Infinity where nothing rasterized. */
  buffer: Float32Array;
  width: number;
  height: number;
  bounds: Bounds2D;
}

interface RasterVertex {
  x: number;
  y: number;
  depth: number;
}

function getVertex(
  positions: Float32Array,
  index: number,
  origin?: [number, number, number],
): Vec3 {
  const base = index * 3;
  // World space: positions are stored in the element's local frame
  // (world = origin + local) - see section-cutter.ts / edge-extractor.ts.
  return origin
    ? vec3(
        positions[base] + origin[0],
        positions[base + 1] + origin[1],
        positions[base + 2] + origin[2],
      )
    : vec3(positions[base], positions[base + 1], positions[base + 2]);
}

/**
 * 2D bounds of every occluder vertex whose view depth lies in
 * `[0, occluderDepth]` (the kept half of the section). Empty (non-finite)
 * when no vertex is in the window.
 */
export function computeOccluderBounds(
  meshes: MeshData[],
  plane: SectionPlaneConfig,
  occluderDepth: number,
): Bounds2D {
  let bounds = boundsEmpty();

  for (const mesh of meshes) {
    const { positions, origin } = mesh;
    const vertexCount = positions.length / 3;
    for (let i = 0; i < vertexCount; i++) {
      const v = getVertex(positions, i, origin);
      const viewDepth = -signedDepth(v, plane);
      if (viewDepth >= 0 && viewDepth <= occluderDepth) {
        bounds = boundsExtendPoint(bounds, projectPointForPlane(v, plane));
      }
    }
  }

  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return bounds; // empty: caller degrades to "everything visible"
  }

  // Small margin so geometry on the exact edge still rasterizes cleanly.
  const margin = Math.max(width, height) * 0.01;
  bounds.min.x -= margin;
  bounds.min.y -= margin;
  bounds.max.x += margin;
  bounds.max.y += margin;

  return bounds;
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

function barycentricCoords(
  px: number,
  py: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): { u: number; v: number; w: number } {
  const v0x = p1.x - p0.x;
  const v0y = p1.y - p0.y;
  const v1x = p2.x - p0.x;
  const v1y = p2.y - p0.y;
  const v2x = px - p0.x;
  const v2y = py - p0.y;

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;

  const denom = dot00 * dot11 - dot01 * dot01;
  // Handle degenerate triangles (zero area) by returning invalid coordinates
  if (Math.abs(denom) < 1e-10) {
    return { u: -1, v: -1, w: -1 };
  }
  const invDenom = 1 / denom;
  const v = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const w = (dot00 * dot12 - dot01 * dot02) * invDenom;
  const u = 1 - v - w;

  return { u, v, w };
}
