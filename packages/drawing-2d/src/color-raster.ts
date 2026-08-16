/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flat-shaded RGBA raster of a section view - the "solid, coloured" underlay
 * for the to-scale PDF export (issue #2042). The vector line work is drawn on
 * top of it, so everything an engineer measures stays a stroke; the raster
 * only supplies the surfaces the viewport shows and monochrome line work does
 * not.
 *
 * # Frame identity
 * The raster is built in the SAME 2D drawing frame as the lines: projection
 * and depth come from `projectPointForPlane` / `signedDepth`, and
 * {@link ColorRaster.bounds} is the projected extent with NO margin, spanned
 * edge-to-edge by the pixel grid:
 *
 *   `u = (x - bounds.min.x) / boundsWidth * width`
 *   `v = (bounds.max.y - y) / boundsHeight * height`
 *
 * with pixel `(i, j)` sampled at `(i + 0.5, j + 0.5)`. Row 0 is therefore the
 * TOP of the drawing (world `max.y`), which is also the top of the paper, so
 * no consumer needs a second flip. Placing the image at the rectangle you get
 * by pushing `bounds` through `worldPointToPdfMm` with the transform the
 * strokes use leaves at most half a pixel of registration error.
 *
 * Note this deliberately differs from `hidden-line-raster.ts`, which maps the
 * extent onto `width - 1` (pixel CENTRES at the bounds edges). That is right
 * for sampling a depth buffer and wrong for an image whose rectangle must
 * cover the extent exactly.
 *
 * # Shading
 * Flat per-face Lambert, `0.4 + 0.6 * abs(dot(faceNormal, viewDir))`, off a
 * normal recomputed from the triangle's own positions. Both details are
 * forced by the data: `MeshData.normals` may be absent or stale, and winding
 * is unreliable by design (see `MeshData.indices`), so a signed dot would
 * paint half the surfaces of an ordinary IFC model black.
 *
 * # Transparency
 * Two passes, no sorting: opaque meshes write colour AND depth, then
 * translucent meshes test against that depth buffer without writing it and
 * blend `a * src + (1 - a) * dst`. Translucent-over-translucent therefore
 * composites in mesh iteration order rather than back-to-front, which is an
 * approximation - and one that is strictly closer to the viewport than
 * either treating glass as opaque or dropping it.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Bounds2D, SectionPlaneConfig, Vec3 } from './types.js';
import { EPSILON } from './math.js';
import { signedDepth, projectPointForPlane, getViewDirectionForPlane } from './projection-bands.js';
import { getVertex, barycentricCoords, computeProjectedBounds } from './raster-core.js';

/** Alpha at or above which a mesh is rasterized in the opaque pass. */
const OPAQUE_ALPHA = 0.999;
/** Ambient term: the darkest a fully edge-on face may go. */
const AMBIENT = 0.4;
/** Diffuse term scaling `abs(dot(n, viewDir))`. */
const DIFFUSE = 0.6;

/** Default dots-per-inch of paper for the shaded underlay. */
export const DEFAULT_SHADING_DPI = 150;
/** Hard cap on total pixels (2^24): ~67MB RGBA + ~67MB depth while building. */
export const MAX_SHADING_PIXELS = 16_777_216;
/** Hard cap per side, chosen to stay inside canvas implementation limits. */
export const MAX_SHADING_DIMENSION_PX = 16_384;

export interface ColorRaster {
  /** RGBA8 straight alpha, row-major, ROW 0 = TOP of the drawing (world max.y). */
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  /** Drawing-frame 2D rect (metres) the pixel grid spans EXACTLY (no margin). */
  bounds: Bounds2D;
}

export interface ColorRasterOptions {
  widthPx: number;
  heightPx: number;
  /** View-depth slack for triangles straddling the cut plane. Default 0.001. */
  depthBias?: number;
}

export interface RasterFit {
  widthPx: number;
  heightPx: number;
  /** The dpi actually achieved; equals the requested dpi unless a cap engaged. */
  effectiveDpi: number;
  capped: boolean;
}

/**
 * Pixel grid for a drawing of `drawingWidthMm` x `drawingHeightMm` at `dpi`,
 * reduced to fit `maxPixels` in total and `maxDimensionPx` per side.
 *
 * Reduction scales BOTH sides by the same factor, so the aspect ratio (and
 * therefore the placement rectangle, which is derived from world bounds and
 * never from pixel counts) is unaffected: a capped raster is blurrier, never
 * mis-scaled.
 *
 * Pure arithmetic, cheap enough to call per keystroke. Throws on non-finite
 * or non-positive inputs rather than returning a plausible-looking grid, on
 * the same reasoning as `computePdfScaleLayout`.
 */
export function fitRasterPixels(
  drawingWidthMm: number,
  drawingHeightMm: number,
  dpi: number,
  maxPixels: number,
  maxDimensionPx: number,
): RasterFit {
  for (const [name, value] of [
    ['drawingWidthMm', drawingWidthMm],
    ['drawingHeightMm', drawingHeightMm],
    ['dpi', dpi],
    ['maxPixels', maxPixels],
    ['maxDimensionPx', maxDimensionPx],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid shading raster ${name}: ${value}. Expected a positive finite number.`);
    }
  }

  let widthPx = Math.max(1, Math.ceil((drawingWidthMm * dpi) / 25.4));
  let heightPx = Math.max(1, Math.ceil((drawingHeightMm * dpi) / 25.4));

  const requestedPixels = widthPx * heightPx;
  let scale = 1;
  if (requestedPixels > maxPixels) {
    scale = Math.sqrt(maxPixels / requestedPixels);
  }
  if (widthPx * scale > maxDimensionPx) {
    scale = Math.min(scale, maxDimensionPx / widthPx);
  }
  if (heightPx * scale > maxDimensionPx) {
    scale = Math.min(scale, maxDimensionPx / heightPx);
  }

  const capped = scale < 1;
  if (capped) {
    widthPx = Math.max(1, Math.floor(widthPx * scale));
    heightPx = Math.max(1, Math.floor(heightPx * scale));
  }

  return { widthPx, heightPx, effectiveDpi: dpi * scale, capped };
}

interface RasterTarget {
  pixels: Uint8ClampedArray;
  depth: Float32Array;
  width: number;
  height: number;
  bounds: Bounds2D;
}

interface ShadedVertex {
  x: number;
  y: number;
  depth: number;
}

/**
 * Rasterize `meshes` into a shaded RGBA image covering their projected extent
 * in the kept half of the section (`viewDepth` in `[0, occluderDepth]`).
 *
 * Returns `null` when nothing lands in that window or the extent is
 * degenerate: there is no rectangle to place an image at, and the caller must
 * fall back to line work only rather than emit a zero-size image.
 */
export function buildColorRaster(
  meshes: readonly MeshData[],
  plane: SectionPlaneConfig,
  occluderDepth: number,
  options: ColorRasterOptions,
): ColorRaster | null {
  const width = Math.floor(options.widthPx);
  const height = Math.floor(options.heightPx);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error(
      `Invalid colour raster size: ${options.widthPx}x${options.heightPx}px. Expected at least 1x1 (use fitRasterPixels).`,
    );
  }

  const bounds = computeProjectedBounds(meshes, plane, occluderDepth, 0);
  const boundsWidth = bounds.max.x - bounds.min.x;
  const boundsHeight = bounds.max.y - bounds.min.y;
  if (
    !Number.isFinite(boundsWidth) ||
    !Number.isFinite(boundsHeight) ||
    boundsWidth < EPSILON ||
    boundsHeight < EPSILON
  ) {
    return null;
  }

  const depthBias = options.depthBias ?? 0.001;
  const target: RasterTarget = {
    // Zero-filled: fully transparent, so the paper shows through anywhere no
    // surface projects.
    pixels: new Uint8ClampedArray(width * height * 4),
    depth: new Float32Array(width * height).fill(Infinity),
    width,
    height,
    bounds,
  };

  const viewDir = getViewDirectionForPlane(plane);

  for (const mesh of meshes) {
    if (mesh.color[3] >= OPAQUE_ALPHA) {
      rasterizeShadedMesh(target, mesh, plane, viewDir, occluderDepth, depthBias, false);
    }
  }
  for (const mesh of meshes) {
    if (mesh.color[3] < OPAQUE_ALPHA) {
      rasterizeShadedMesh(target, mesh, plane, viewDir, occluderDepth, depthBias, true);
    }
  }

  return { pixels: target.pixels, width, height, bounds };
}

function rasterizeShadedMesh(
  target: RasterTarget,
  mesh: MeshData,
  plane: SectionPlaneConfig,
  viewDir: Vec3,
  occluderDepth: number,
  depthBias: number,
  blend: boolean,
): void {
  const { positions, indices, origin, color } = mesh;
  const triangleCount = Math.floor(indices.length / 3);
  const alpha = color[3];

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    // Face normal from LOCAL positions: the differences cancel `origin`, so
    // there is no world fold to do here (unlike depth/projection below).
    const lambert = faceLambert(positions, i0, i1, i2, viewDir);
    if (lambert === null) continue; // zero-area triangle

    const v0 = getVertex(positions, i0, origin);
    const v1 = getVertex(positions, i1, origin);
    const v2 = getVertex(positions, i2, origin);

    const d0 = -signedDepth(v0, plane);
    const d1 = -signedDepth(v1, plane);
    const d2 = -signedDepth(v2, plane);
    const inWindow = (d: number) => d >= 0 && d <= occluderDepth;
    if (!inWindow(d0) && !inWindow(d1) && !inWindow(d2)) continue;

    const uv0 = projectPointForPlane(v0, plane);
    const uv1 = projectPointForPlane(v1, plane);
    const uv2 = projectPointForPlane(v2, plane);

    const r = Math.round(255 * color[0] * lambert);
    const g = Math.round(255 * color[1] * lambert);
    const b = Math.round(255 * color[2] * lambert);

    rasterizeShadedTriangle(
      target,
      { x: uv0.x, y: uv0.y, depth: d0 },
      { x: uv1.x, y: uv1.y, depth: d1 },
      { x: uv2.x, y: uv2.y, depth: d2 },
      r,
      g,
      b,
      alpha,
      depthBias,
      blend,
    );
  }
}

/**
 * `0.4 + 0.6 * abs(dot(n, viewDir))` for the triangle's own plane, or `null`
 * when the triangle has no area (no normal exists, nothing to shade).
 */
function faceLambert(
  positions: Float32Array,
  i0: number,
  i1: number,
  i2: number,
  viewDir: Vec3,
): number | null {
  const ax = positions[i1 * 3] - positions[i0 * 3];
  const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
  const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
  const bx = positions[i2 * 3] - positions[i0 * 3];
  const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
  const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];

  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(len > 0)) return null;

  const dot = (nx * viewDir.x + ny * viewDir.y + nz * viewDir.z) / len;
  return AMBIENT + DIFFUSE * Math.abs(dot);
}

function rasterizeShadedTriangle(
  target: RasterTarget,
  p0: ShadedVertex,
  p1: ShadedVertex,
  p2: ShadedVertex,
  r: number,
  g: number,
  b: number,
  alpha: number,
  depthBias: number,
  blend: boolean,
): void {
  const { pixels, depth, width, height, bounds } = target;
  const boundsWidth = bounds.max.x - bounds.min.x;
  const boundsHeight = bounds.max.y - bounds.min.y;

  // Edge-to-edge mapping (see the module docblock): the grid spans `bounds`
  // exactly, and row 0 is the TOP (world max.y).
  const toPixelX = (x: number) => ((x - bounds.min.x) / boundsWidth) * width;
  const toPixelY = (y: number) => ((bounds.max.y - y) / boundsHeight) * height;

  const px0 = { x: toPixelX(p0.x), y: toPixelY(p0.y) };
  const px1 = { x: toPixelX(p1.x), y: toPixelY(p1.y) };
  const px2 = { x: toPixelX(p2.x), y: toPixelY(p2.y) };

  const minX = Math.max(0, Math.floor(Math.min(px0.x, px1.x, px2.x)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(px0.x, px1.x, px2.x)));
  const minY = Math.max(0, Math.floor(Math.min(px0.y, px1.y, px2.y)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(px0.y, px1.y, px2.y)));

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const bary = barycentricCoords(px + 0.5, py + 0.5, px0, px1, px2);
      if (bary.u < 0 || bary.v < 0 || bary.w < 0) continue;

      const d = bary.u * p0.depth + bary.v * p1.depth + bary.w * p2.depth;
      // The above-cut portion of a straddling triangle is cut away by the
      // section and must not paint anything in the kept half.
      if (d < -depthBias) continue;

      const idx = py * width + px;
      const o = idx * 4;

      if (!blend) {
        if (d >= depth[idx]) continue;
        depth[idx] = d;
        pixels[o] = r;
        pixels[o + 1] = g;
        pixels[o + 2] = b;
        pixels[o + 3] = 255;
        continue;
      }

      // Translucent pass: tested against the opaque depth buffer, never
      // writing it, so glass in front of a wall composites over the wall and
      // glass behind it is dropped.
      if (d > depth[idx] + depthBias) continue;
      const inv = 1 - alpha;
      pixels[o] = Math.round(alpha * r + inv * pixels[o]);
      pixels[o + 1] = Math.round(alpha * g + inv * pixels[o + 1]);
      pixels[o + 2] = Math.round(alpha * b + inv * pixels[o + 2]);
      pixels[o + 3] = Math.round(alpha * 255 + inv * pixels[o + 3]);
    }
  }
}
