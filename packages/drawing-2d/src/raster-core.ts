/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared software-rasterizer primitives.
 *
 * Two rasterizers run over the same meshes in the same 2D drawing frame:
 * `hidden-line-raster.ts` (a per-pixel minimum VIEW DEPTH buffer used to
 * classify lines hidden) and `color-raster.ts` (the shaded RGBA underlay for
 * the to-scale PDF export). They write different buffers, so they keep their
 * own inner scan loops, but they MUST agree on how a mesh vertex becomes a
 * world point, how a pixel becomes barycentric weights, and how the projected
 * extent of a mesh set is measured. Those three live here so a fix to one
 * cannot leave the other behind.
 *
 * Projection and depth themselves are NOT re-derived here: callers use
 * `projectPointForPlane` / `signedDepth` from `projection-bands.ts`, the same
 * helpers every line producer uses, which is what makes the raster and the
 * strokes share a frame by construction.
 *
 * Internal module: not exported from the package index.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3, Bounds2D, SectionPlaneConfig } from './types.js';
import { vec3, boundsEmpty, boundsExtendPoint } from './math.js';
import { signedDepth, projectPointForPlane } from './projection-bands.js';

/** A projected vertex in drawing 2D space, carrying its view depth. */
export interface RasterVertex {
  x: number;
  y: number;
  depth: number;
}

/**
 * World-space position of vertex `index`. Positions are stored in the
 * element's local frame (`world = origin + local`) - see section-cutter.ts /
 * edge-extractor.ts - so `origin` must be folded in for depth and projection.
 */
export function getVertex(
  positions: Float32Array,
  index: number,
  origin?: [number, number, number],
): Vec3 {
  const base = index * 3;
  return origin
    ? vec3(
        positions[base] + origin[0],
        positions[base + 1] + origin[1],
        positions[base + 2] + origin[2],
      )
    : vec3(positions[base], positions[base + 1], positions[base + 2]);
}

/**
 * 2D bounds of every vertex whose view depth lies in `[0, depthWindow]` (the
 * kept half of the section), optionally grown by `marginFraction` of the
 * larger side on all four sides. Empty (non-finite) when no vertex is in the
 * window - callers must check before dividing by the extent.
 *
 * `marginFraction` exists because the two consumers want different things:
 * the hidden-line raster grows the box slightly so geometry exactly on the
 * edge still rasterizes cleanly, while the colour raster needs bounds that
 * are EXACTLY the projected extent, because that rectangle is what gets
 * placed on the PDF page at an exact millimetre size.
 */
export function computeProjectedBounds(
  meshes: readonly MeshData[],
  plane: SectionPlaneConfig,
  depthWindow: number,
  marginFraction: number,
): Bounds2D {
  let bounds = boundsEmpty();

  for (const mesh of meshes) {
    const { positions, origin } = mesh;
    const vertexCount = positions.length / 3;
    for (let i = 0; i < vertexCount; i++) {
      const v = getVertex(positions, i, origin);
      const viewDepth = -signedDepth(v, plane);
      if (viewDepth >= 0 && viewDepth <= depthWindow) {
        bounds = boundsExtendPoint(bounds, projectPointForPlane(v, plane));
      }
    }
  }

  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return bounds; // empty: caller decides how to degrade
  }

  if (marginFraction > 0) {
    const margin = Math.max(width, height) * marginFraction;
    bounds.min.x -= margin;
    bounds.min.y -= margin;
    bounds.max.x += margin;
    bounds.max.y += margin;
  }

  return bounds;
}

/**
 * Barycentric weights of `(px, py)` against a 2D triangle. All three weights
 * are >= 0 exactly when the point is inside (or on) the triangle. Returns
 * `{ u: -1, v: -1, w: -1 }` for a degenerate (zero-area) triangle, which no
 * inside test accepts.
 *
 * Orientation-independent (the denominator is a Gram determinant, always
 * positive for a non-degenerate triangle), so a caller may flip an axis when
 * mapping to pixel space without inverting the inside test.
 */
export function barycentricCoords(
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
