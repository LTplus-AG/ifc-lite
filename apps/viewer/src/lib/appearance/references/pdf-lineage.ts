/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceSourceOption } from '../draft-types.js';
import type { PdfRasterRecipe } from '../pdf/types.js';
import { PDF_LIMITS } from '../pdf/types.js';
import { getPdfDocument } from '../pdf/documents.js';
import { ownPdfRasterRecipe } from '../pdf/own-raster-recipe.js';
import type { PlaneCalibrationRequest } from '../plane-calibration.js';

export interface ReferencePdfLineage {
  readonly documentSha256: string;
  readonly recipe: PdfRasterRecipe;
}
/** Persist a validated copy, never the live catalog slot's mutable page selection. */
export function ownReferencePdfLineage(value: unknown, calibration?: PlaneCalibrationRequest): ReferencePdfLineage {
  if (!value || typeof value !== 'object') throw new Error('Invalid registered PDF provenance.');
  const v = value as Record<string, unknown>;
  if (typeof v.documentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.documentSha256)) throw new Error('Invalid original PDF digest.');
  const recipe = ownPdfRasterRecipe(v.recipe), page = recipe.page;
  if (page.pageNumber > PDF_LIMITS.maxPages || recipe.pixelWidth > PDF_LIMITS.maxDimension || recipe.pixelHeight > PDF_LIMITS.maxDimension
    || recipe.pixelWidth * recipe.pixelHeight > PDF_LIMITS.maxPixels || page.viewBox[2] <= page.viewBox[0] || page.viewBox[3] <= page.viewBox[1]
    || recipe.cropPoints[0] < 0 || recipe.cropPoints[1] < 0 || recipe.cropPoints[2] <= 0 || recipe.cropPoints[3] <= 0
    || recipe.cropPoints[0] + recipe.cropPoints[2] > page.widthPoints + 1e-8 || recipe.cropPoints[1] + recipe.cropPoints[3] > page.heightPoints + 1e-8
    || recipe.paperSizeMetres.some(value => value <= 0) || !calibration
    || calibration.rasterSize[0] !== recipe.pixelWidth || calibration.rasterSize[1] !== recipe.pixelHeight
    || recipe.pixelToPdf.some((value, index) => value !== calibration.rasterToSource[index])) {
    throw new Error('The registered PDF page recipe does not match its frozen image calibration.');
  }
  for (const array of [page.viewBox, page.pdfToPage, recipe.cropPoints, recipe.paperSizeMetres, recipe.pixelToPdf]) Object.freeze(array);
  Object.freeze(page); Object.freeze(recipe);
  return Object.freeze({ documentSha256: v.documentSha256, recipe });
}
export function captureReferencePdfLineage(source: AppearanceSourceOption, calibration: PlaneCalibrationRequest): ReferencePdfLineage | undefined {
  if (source.pdfLineage) return ownReferencePdfLineage(source.pdfLineage, calibration);
  if (!source.pdf) return;
  const document = getPdfDocument(source.pdf.documentKey);
  if (!document) throw new Error('The original PDF was removed. Reopen it before registering the page.');
  return ownReferencePdfLineage({ documentSha256: document.id, recipe: source.pdf.recipe }, calibration);
}
