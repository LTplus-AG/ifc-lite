/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { annotationFrame } from '../create-annotation';
import { rasterLandmarkFraction } from '../raster-calibration';
import type { RegisteredAppearanceReference } from '../references/types';
import type { PdfAffine } from './vector-types';
import { pdfCalibrationFrame } from './calibration';

/** Coordinate adapter only: the saved corners already came from native calibration. */
export function referenceVectorFrame(reference: RegisteredAppearanceReference) {
  const pdf = reference.pdf;
  if (!pdf || !reference.calibration) throw new Error('Register this drawing from its original PDF to use PDF vectors.');
  const recipe = pdf.recipe;
  if (recipe.cropPoints.some((value, index) => Math.abs(value - [0, 0, recipe.page.widthPoints, recipe.page.heightPoints][index]) > 1e-8)) {
    throw new Error('PDF vectors currently require a whole PDF page. Use Image for this cropped drawing, or register the whole page.');
  }
  const frame = annotationFrame(reference), [width, height] = frame.sizeMetres;
  const calibration = pdfCalibrationFrame(recipe);
  // Use page-scale baselines rather than subtracting two almost equal unit probes.
  const [x, y, right, top] = recipe.page.viewBox, dx = right - x, dy = top - y;
  const at = (px: number, py: number) => {
    const fraction = rasterLandmarkFraction(calibration, [px, py]);
    return [fraction[0] * width, (1 - fraction[1]) * height] as const;
  };
  const a = at(x, y), b = at(right, y), c = at(x, top);
  const xx = (b[0] - a[0]) / dx, xy = (b[1] - a[1]) / dx;
  const yx = (c[0] - a[0]) / dy, yy = (c[1] - a[1]) / dy;
  const modelMetresFromPdf: PdfAffine = [xx, xy, yx, yy, a[0] - xx * x - yx * y, a[1] - xy * x - yy * y];
  if (!modelMetresFromPdf.every(Number.isFinite)) throw new Error('The PDF page has an invalid registered coordinate transform.');
  return { frame, modelMetresFromPdf };
}
