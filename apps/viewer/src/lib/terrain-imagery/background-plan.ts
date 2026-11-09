/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { localViewerToProjected, projectedToLocalViewer, type ModelSpatialReference } from '@ifc-lite/geometry';
import type { GeoRasterPlacement } from './georaster';
import type { PlaneCalibrationRequest } from '@/lib/appearance/plane-calibration';
import type { RegisteredAppearanceReference } from '@/lib/appearance/references/types';

type XY = readonly [number, number];
export interface BackgroundProjection {
  forward(point: XY): XY;
  inverse(point: XY): XY;
}
export interface BackgroundPlan {
  width: number;
  height: number;
  corners: RegisteredAppearanceReference['cornersIfcWorld'];
  /** Output pixel centre to source pixel corner coordinates. */
  sourcePixel(col: number, row: number): XY;
}

/** Resample in the engineering plane, rather than stretching four reprojected
 * corners. This preserves curved CRS transforms, rotated rasters and IFC axes.
 * Height is a display plane in IFC metres, not an inferred terrain elevation. */
export function planOrthophotoBackground(
  raster: GeoRasterPlacement, reference: ModelSpatialReference,
  projection: BackgroundProjection, elevation: number, limit = 2048,
): BackgroundPlan {
  const { width, height, affine: a } = raster;
  const det = a.a * a.e - a.b * a.d;
  if (![width, height, det, elevation, limit].every(Number.isFinite)
    || width <= 0 || height <= 0 || det === 0 || limit < 1 || limit > 8192) {
    throw new Error('The orthophoto has invalid dimensions or georeferencing.');
  }
  const groundHeight = reference.localToProjected?.orthogonalHeight ?? 0;
  const toWorld = (col: number, row: number): XY => {
    const map = projection.forward([a.a * col + a.b * row + a.c, a.d * col + a.e * row + a.f]);
    const local = projectedToLocalViewer(reference, [map[0], map[1], groundHeight]);
    if (!local || !local.every(Number.isFinite)) throw new Error('The orthophoto lies outside the usable coordinate transformation.');
    return [local[0], -local[2]];
  };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  // Bound curved edges, not only corners. One output-pixel margin absorbs
  // sub-sample curvature on ordinary aerial tiles.
  for (let i = 0; i <= 256; i++) {
    const t = i / 256;
    for (const [col, row] of [[width * t, 0], [width * t, height], [0, height * t], [width, height * t]]) {
      const [x, y] = toWorld(col, row);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const spanX = maxX - minX, spanY = maxY - minY;
  if (!(spanX > 0 && spanY > 0) || !Number.isFinite(spanX + spanY)) throw new Error('The orthophoto footprint is degenerate.');
  const pixels = Math.min(limit, Math.max(width, height));
  const step = Math.max(spanX, spanY) / pixels;
  minX -= step; maxX += step; minY -= step; maxY += step;
  const outWidth = Math.max(1, Math.min(limit, Math.ceil((maxX - minX) / step)));
  const outHeight = Math.max(1, Math.min(limit, Math.ceil((maxY - minY) / step)));
  return {
    width: outWidth, height: outHeight,
    corners: [[minX, maxY, elevation], [maxX, maxY, elevation], [maxX, minY, elevation], [minX, minY, elevation]],
    sourcePixel(col, row) {
      const x = minX + (col + 0.5) / outWidth * (maxX - minX);
      const y = maxY - (row + 0.5) / outHeight * (maxY - minY);
      const map = localViewerToProjected(reference, [x, 0, -y]);
      if (!map) return [NaN, NaN];
      const source = projection.inverse([map[0], map[1]]);
      const dx = source[0] - a.c, dy = source[1] - a.f;
      return [(a.e * dx - a.b * dy) / det, (-a.d * dx + a.a * dy) / det];
    },
  };
}

/** Bilinear, premultiplied-alpha sampling; outside coverage stays transparent. */
export function sampleBackgroundRow(plan: BackgroundPlan, row: number, source: Uint8ClampedArray,
  width: number, height: number, rasterWidth: number, rasterHeight: number, output: Uint8ClampedArray): void {
  for (let col = 0; col < plan.width; col++) {
    const pixel = plan.sourcePixel(col, row);
    const x = pixel[0] / rasterWidth * width, y = pixel[1] / rasterHeight * height;
    if (!Number.isFinite(x + y) || x < 0 || y < 0 || x >= width || y >= height) continue;
    const px = Math.max(0, Math.min(width - 1, x - 0.5)), py = Math.max(0, Math.min(height - 1, y - 0.5));
    const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
    const rgba = [0, 0, 0, 0];
    for (let j = 0; j <= 1; j++) for (let i = 0; i <= 1; i++) {
      const offset = (Math.min(height - 1, iy + j) * width + Math.min(width - 1, ix + i)) * 4;
      const weight = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const alpha = source[offset + 3] / 255;
      for (let c = 0; c < 3; c++) rgba[c] += source[offset + c] * alpha * weight;
      rgba[3] += alpha * weight;
    }
    const dest = (row * plan.width + col) * 4;
    for (let c = 0; c < 3; c++) output[dest + c] = rgba[3] ? rgba[c] / rgba[3] : 0;
    output[dest + 3] = rgba[3] * 255;
  }
}

/** Keep the generated engineering-plane raster editable with the existing
 * calibrated-reference controls, including its display elevation. */
export function backgroundCalibration(plan: BackgroundPlan): PlaneCalibrationRequest {
  const [a, b, , d] = plan.corners;
  const width = b[0] - a[0], height = a[1] - d[1];
  return { rasterToSource: [width / plan.width, 0, 0, -height / plan.height, 0, height],
    rasterSize: [plan.width, plan.height], sourcePoints: [[0, height], [width, height]],
    distanceMetres: width, worldAnchor: [...a], worldDirection: [1, 0, 0], planeNormal: [0, 0, 1] };
}
