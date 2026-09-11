/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PDFPageProxy } from 'pdfjs-dist';
import {
  PDF_LIMITS,
  PdfAppearanceError,
  type PdfPageInfo,
  type PdfRasterRecipe,
  type PdfRasterRequest,
} from './types.js';
export function pageInfo(page: PDFPageProxy, rotation = 0): PdfPageInfo {
  const viewport = page.getViewport({
    scale: 1,
    rotation: (page.rotate + rotation) % 360,
  });
  if (
    ![viewport.width, viewport.height, page.userUnit].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    throw new PdfAppearanceError(
      'invalid-pdf',
      'This PDF page has invalid physical dimensions.',
    );
  }
  return {
    pageNumber: page.pageNumber,
    viewBox: [...page.view] as [number, number, number, number],
    userUnit: page.userUnit,
    intrinsicRotation: page.rotate,
    widthPoints: viewport.width,
    heightPoints: viewport.height,
    pdfToPage: [...viewport.transform],
  };
}
export function rasterRecipe(
  page: PDFPageProxy,
  request: PdfRasterRequest,
): PdfRasterRecipe {
  const rotation = request.rotation ?? 0;
  if (![0, 90, 180, 270].includes(rotation))
    throw new PdfAppearanceError(
      'invalid-pdf',
      'Choose a quarter-turn page rotation.',
    );
  const info = pageInfo(page, rotation);
  const crop = request.cropPoints ?? [
    0,
    0,
    info.widthPoints,
    info.heightPoints,
  ];
  if (
    crop.length !== 4 ||
    !crop.every(Number.isFinite) ||
    crop[0] < 0 ||
    crop[1] < 0 ||
    crop[2] <= 0 ||
    crop[3] <= 0 ||
    crop[0] + crop[2] > info.widthPoints ||
    crop[1] + crop[3] > info.heightPoints
  ) {
    throw new PdfAppearanceError(
      'invalid-pdf',
      'The crop must be a positive rectangle inside the rotated page.',
    );
  }
  const dpi = request.dpi ?? 144,
    maxPixels = request.maxPixels ?? PDF_LIMITS.maxPixels;
  const maxDimension = request.maxDimension ?? PDF_LIMITS.maxDimension;
  if (
    !Number.isFinite(dpi) ||
    dpi <= 0 ||
    dpi > 600 ||
    !Number.isSafeInteger(maxPixels) ||
    maxPixels < 1 ||
    maxPixels > PDF_LIMITS.maxPixels ||
    !Number.isSafeInteger(maxDimension) ||
    maxDimension < 1 ||
    maxDimension > PDF_LIMITS.maxDimension
  ) {
    throw new PdfAppearanceError(
      'budget',
      'Choose at most 600 DPI within the page image pixel budget.',
    );
  }
  let scale = Math.min(
    dpi / 72,
    maxDimension / crop[2],
    maxDimension / crop[3],
    Math.sqrt(maxPixels / (crop[2] * crop[3])),
  );
  let width = Math.max(1, Math.ceil(crop[2] * scale)),
    height = Math.max(1, Math.ceil(crop[3] * scale));
  for (
    let iteration = 0;
    iteration < 8 &&
    (width * height > maxPixels ||
      width > maxDimension ||
      height > maxDimension);
    iteration++
  ) {
    scale *=
      Math.min(
        Math.sqrt(maxPixels / (width * height)),
        maxDimension / width,
        maxDimension / height,
      ) * 0.99;
    width = Math.max(1, Math.ceil(crop[2] * scale));
    height = Math.max(1, Math.ceil(crop[3] * scale));
  }
  if (
    width * height > maxPixels ||
    width > maxDimension ||
    height > maxDimension
  )
    throw new PdfAppearanceError(
      'budget',
      'This crop cannot fit the image budget.',
    );
  // Integer raster dimensions can round differently on each axis. Map the exact
  // crop to the full PNG extent, so its corners retain their physical position.
  const scaleX = width / crop[2],
    scaleY = height / crop[3];
  const [pa, pb, pc, pd, pe, pf] = info.pdfToPage;
  const [a, b, c, d, e, f] = [
    pa * scaleX,
    pb * scaleY,
    pc * scaleX,
    pd * scaleY,
    (pe - crop[0]) * scaleX,
    (pf - crop[1]) * scaleY,
  ];
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0)
    throw new PdfAppearanceError(
      'invalid-pdf',
      'The page transform is singular.',
    );
  return {
    page: info,
    rotation,
    cropPoints: [...crop],
    requestedDpi: dpi,
    effectiveDpi: Math.min(scaleX, scaleY) * 72,
    pixelWidth: width,
    pixelHeight: height,
    paperSizeMetres: [(crop[2] / 72) * 0.0254, (crop[3] / 72) * 0.0254],
    pixelToPdf: [
      d / determinant,
      -b / determinant,
      -c / determinant,
      a / determinant,
      (c * f - d * e) / determinant,
      (b * e - a * f) / determinant,
    ],
  };
}
