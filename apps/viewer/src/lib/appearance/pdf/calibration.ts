/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { calibrateAppearancePlane, type PlaneCalibrationRequest } from '../plane-calibration.js';
import type { PdfRasterRecipe } from './types.js';

/** Landmarks are native PDF coordinates, never raster pixels or display CSS pixels. */
export interface PdfCalibration {
  sourcePoints: [[number, number], [number, number]];
  distanceMetres: number;
}

function transform(recipe: PdfRasterRecipe): [number, number, number, number, number, number] {
  const values = recipe.pixelToPdf;
  if (values.length !== 6 || !values.every(Number.isFinite)) throw new Error('The PDF page has an invalid coordinate frame.');
  const [a, b, c, d, e, f] = values;
  if (!Number.isFinite(a * d - b * c) || a * d - b * c === 0) throw new Error('The PDF page has a collapsed coordinate frame.');
  return [a, b, c, d, e, f];
}

/** UI coordinate conversion only; Rust solves the metric world placement. */
export function pdfLandmarkAt(recipe: PdfRasterRecipe, fraction: readonly [number, number]): [number, number] {
  if (!fraction.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('Choose a point inside the page image.');
  const [a, b, c, d, e, f] = transform(recipe);
  const x = fraction[0] * recipe.pixelWidth, y = fraction[1] * recipe.pixelHeight;
  return [a * x + c * y + e, b * x + d * y + f];
}

/** Display an existing native landmark after crop, DPI or page rotation changes. */
export function pdfLandmarkFraction(recipe: PdfRasterRecipe, point: readonly [number, number]): [number, number] {
  const [a, b, c, d, e, f] = transform(recipe);
  const determinant = a * d - b * c, x = point[0] - e, y = point[1] - f;
  return [(d * x - c * y) / determinant / recipe.pixelWidth,
    (-b * x + a * y) / determinant / recipe.pixelHeight];
}

export async function calibratePdfAppearance(
  recipe: PdfRasterRecipe,
  calibration: PdfCalibration,
  placement: Pick<PlaneCalibrationRequest, 'worldAnchor' | 'worldDirection' | 'planeNormal'>,
) {
  return calibrateAppearancePlane({ ...placement, ...calibration,
    rasterToSource: transform(recipe), rasterSize: [recipe.pixelWidth, recipe.pixelHeight] });
}
