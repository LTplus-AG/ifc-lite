/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { calibrateAppearancePlane, type PlaneCalibrationRequest } from '../plane-calibration.js';
import type { PdfRasterRecipe } from './types.js';

import { rasterLandmarkAt, rasterLandmarkFraction, type RasterCalibration, type RasterCalibrationFrame } from '../raster-calibration.js';

/** PDF landmarks retain native document coordinates across derived rasters. */
export type PdfCalibration = RasterCalibration;
export function pdfCalibrationFrame(recipe: PdfRasterRecipe): RasterCalibrationFrame {
  const values = recipe.pixelToPdf;
  if (values.length !== 6) throw new Error('The PDF page has an invalid coordinate frame.');
  const [a, b, c, d, e, f] = values;
  const frame: RasterCalibrationFrame = { rasterToSource: [a, b, c, d, e, f], rasterSize: [recipe.pixelWidth, recipe.pixelHeight] };
  rasterLandmarkAt(frame, [0, 0]);
  return frame;
}
export function pdfLandmarkAt(recipe: PdfRasterRecipe, fraction: readonly [number, number]): [number, number] {
  return rasterLandmarkAt(pdfCalibrationFrame(recipe), fraction);
}
export function pdfLandmarkFraction(recipe: PdfRasterRecipe, point: readonly [number, number]): [number, number] {
  return rasterLandmarkFraction(pdfCalibrationFrame(recipe), point);
}

export async function calibratePdfAppearance(
  recipe: PdfRasterRecipe,
  calibration: PdfCalibration,
  placement: Pick<PlaneCalibrationRequest, 'worldAnchor' | 'worldDirection' | 'planeNormal'>,
) {
  return calibrateAppearancePlane({ ...placement, ...calibration,
    ...pdfCalibrationFrame(recipe) });
}
