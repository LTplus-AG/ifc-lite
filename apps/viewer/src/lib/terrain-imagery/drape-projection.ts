/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The planar projection a terrain drape uses (#5942, mapping spec §15.3).
 *
 * ONE definition for the viewer and the IFC4X3 export: the image's placement,
 * reduced to the terrain's horizontal CRS in its native plan units, as a
 * bottom-left corner `O`, orthonormal axes `U` (along the columns) and `V` (up
 * the image) and extents `W`, `H`. A vertex at plan `P = (easting, northing)`
 * maps to `u = (P − O)·U / W`, `v = (P − O)·V / H`, texture origin bottom-left.
 *
 * A planar mapping carries no skew, and a reprojection is not affine, so both
 * are MEASURED rather than assumed: the largest distance, in image pixels,
 * between where a pixel really lands and where this projection puts it. Above
 * half a pixel the drape is refused (§15.2 item 4).
 */

import type { GeoRasterPlacement, Parsed, RasterAffine } from './georaster.js';

export interface DrapeProjection {
  /** The terrain's horizontal CRS the projection is expressed in. */
  crs: string;
  /** Bottom-left image corner, terrain CRS native plan units (easting, northing). */
  origin: [number, number];
  /** Unit vector along the image columns. */
  axisU: [number, number];
  /** Unit vector up the image, perpendicular to `axisU`. */
  axisV: [number, number];
  /** Extent along `axisU` and `axisV`, native plan units. */
  extent: [number, number];
  /** Image size in pixels. */
  imageSize: [number, number];
  /** Largest measured departure of this projection from the true placement, in pixels. */
  deviationPx: number;
}

/** Image CRS → terrain CRS, plan coordinates in each CRS's native units. */
export type PlanTransform = (x: number, y: number) => [number, number];

/** Half a pixel: beyond it the drape puts some pixel on a different ground cell. */
export const MAX_DRAPE_DEVIATION_PX = 0.5;

/** Samples per image axis for the reprojection fit and the deviation measure. */
const SAMPLES = 9;

function applyAffine(affine: RasterAffine, col: number, row: number): [number, number] {
  return [affine.a * col + affine.b * row + affine.c, affine.d * col + affine.e * row + affine.f];
}

/** Texture UV (bottom-left origin) of plan position `(easting, northing)`. */
export function drapeUv(projection: DrapeProjection, easting: number, northing: number): [number, number] {
  const dx = easting - projection.origin[0];
  const dy = northing - projection.origin[1];
  return [
    (dx * projection.axisU[0] + dy * projection.axisU[1]) / projection.extent[0],
    (dx * projection.axisV[0] + dy * projection.axisV[1]) / projection.extent[1],
  ];
}

/** Whether a UV lies on the image (§15.3 "covered"). */
export function uvCovered(u: number, v: number): boolean {
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

/** Ground sample distance along each image axis, native plan units per pixel. */
export function groundSampleDistance(projection: DrapeProjection): [number, number] {
  return [projection.extent[0] / projection.imageSize[0], projection.extent[1] / projection.imageSize[1]];
}

/**
 * The orthogonal projection closest to an affine placement, keeping its column
 * axis: `U` from the column vector, `V` perpendicular to it on the side the
 * rows run away from, and `H` the rows' extent along `V`.
 */
function orthogonalFromAffine(affine: RasterAffine, width: number, height: number, crs: string): DrapeProjection | null {
  const colLength = Math.hypot(affine.a, affine.d);
  if (!(colLength > 0)) return null;
  // `+ 0` folds a negative zero (from `-b` with b = 0) into a plain zero.
  const axisU: [number, number] = [affine.a / colLength + 0, affine.d / colLength + 0];
  // Up the image is minus the row vector; drop its component along U.
  const up: [number, number] = [-affine.b, -affine.e];
  const along = up[0] * axisU[0] + up[1] * axisU[1];
  const perp: [number, number] = [up[0] - along * axisU[0], up[1] - along * axisU[1]];
  const rowLength = Math.hypot(perp[0], perp[1]);
  if (!(rowLength > 0)) return null;
  const axisV: [number, number] = [perp[0] / rowLength + 0, perp[1] / rowLength + 0];
  const origin = applyAffine(affine, 0, height);
  return {
    crs, origin, axisU, axisV,
    extent: [colLength * width, rowLength * height],
    imageSize: [width, height],
    deviationPx: 0,
  };
}

/** Least-squares fit of `target ≈ A·(col, row) + t` over sampled pixel corners. */
function fitAffine(samples: ReadonlyArray<{ col: number; row: number; x: number; y: number }>): RasterAffine | null {
  // Normal equations for [col, row, 1]; solved once per output axis.
  let s00 = 0, s01 = 0, s02 = 0, s11 = 0, s12 = 0, s22 = 0;
  let bx0 = 0, bx1 = 0, bx2 = 0, by0 = 0, by1 = 0, by2 = 0;
  for (const { col, row, x, y } of samples) {
    s00 += col * col; s01 += col * row; s02 += col; s11 += row * row; s12 += row; s22 += 1;
    bx0 += col * x; bx1 += row * x; bx2 += x; by0 += col * y; by1 += row * y; by2 += y;
  }
  const m = [[s00, s01, s02], [s01, s11, s12], [s02, s12, s22]];
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (!Number.isFinite(det) || Math.abs(det) === 0) return null;
  const solve = (b0: number, b1: number, b2: number): [number, number, number] => {
    const replace = (column: number): number => {
      const k = m.map((rowValues, index) => rowValues.map((value, c) => (c === column ? [b0, b1, b2][index] : value)));
      return (k[0][0] * (k[1][1] * k[2][2] - k[1][2] * k[2][1])
        - k[0][1] * (k[1][0] * k[2][2] - k[1][2] * k[2][0])
        + k[0][2] * (k[1][0] * k[2][1] - k[1][1] * k[2][0])) / det;
    };
    return [replace(0), replace(1), replace(2)];
  };
  const [a, b, c] = solve(bx0, bx1, bx2);
  const [d, e, f] = solve(by0, by1, by2);
  return [a, b, c, d, e, f].every(Number.isFinite) ? { a, b, c, d, e, f } : null;
}

/**
 * Reduce a raster placement to a planar projection in the terrain's CRS.
 *
 * `toTerrain` is the exact image-CRS → terrain-CRS operation, or omitted when
 * the two CRSs are the same. The returned projection's `deviationPx` is the
 * end-to-end measure over a {@link SAMPLES}² grid of pixel corners: reproject
 * each, project it back through the planar mapping, and take the distance to
 * where it started. It covers reprojection curvature and skew alike.
 */
export function drapeProjection(
  placement: GeoRasterPlacement,
  terrainCrs: string,
  toTerrain?: PlanTransform,
): Parsed<DrapeProjection> {
  const { width, height } = placement;
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) {
    return { ok: false, reason: 'The image has no pixels.' };
  }
  const samples: Array<{ col: number; row: number; x: number; y: number }> = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    for (let j = 0; j < SAMPLES; j += 1) {
      const col = (width * i) / (SAMPLES - 1);
      const row = (height * j) / (SAMPLES - 1);
      const [ix, iy] = applyAffine(placement.affine, col, row);
      const [x, y] = toTerrain ? toTerrain(ix, iy) : [ix, iy];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, reason: `The image corner at pixel (${col}, ${row}) does not reproject into ${terrainCrs}.` };
      }
      samples.push({ col, row, x, y });
    }
  }
  const affine = toTerrain ? fitAffine(samples) : placement.affine;
  const projection = affine && orthogonalFromAffine(affine, width, height, terrainCrs);
  if (!projection) return { ok: false, reason: `The image's placement in ${terrainCrs} is degenerate.` };
  let deviationPx = 0;
  for (const { col, row, x, y } of samples) {
    const [u, v] = drapeUv(projection, x, y);
    deviationPx = Math.max(deviationPx, Math.hypot(u * width - col, (1 - v) * height - row));
  }
  if (!(deviationPx <= MAX_DRAPE_DEVIATION_PX)) {
    return {
      ok: false,
      reason: `The image is not planar in ${terrainCrs} to within half a pixel: its placement departs from the `
        + `nearest planar one by ${deviationPx.toFixed(2)} px (a skewed geotransform, or a reprojection that curves `
        + 'over this extent). Reproject the image to the terrain\'s CRS first, or use a smaller extent.',
    };
  }
  return { ok: true, value: { ...projection, deviationPx } };
}
