/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure scale/extent arithmetic for exporting a section drawing to a
 * dimensionally accurate ("to scale") PDF page (issue #2042).
 *
 * The drawing model (`Drawing2D.bounds`) carries its own real-world extent
 * in metres (see `types.ts`). To print "1:100" correctly, 1 metre in the
 * world must become exactly 10mm on paper — no rounding, no silent re-fit.
 *
 * This module deliberately sizes the PAGE to the drawing extent at the
 * chosen scale (plus a margin), rather than fitting the drawing into a
 * fixed named paper size (A3, A4, ...). That avoids the failure mode in
 * `sheet/sheet-types.ts`'s `calculateDrawingTransform`, which silently
 * shrinks the drawing (`fitScale = min(scaleX, scaleY, 1)`) when it does
 * not fit the configured viewport at the nominal scale — correct for an
 * on-screen preview, but wrong for a PDF whose entire purpose is to be
 * measured at the scale the user explicitly picked.
 */

import type { Bounds2D, Point2D } from './types.js';

/** World-to-paper transform: maps a world-space point (metres) to a point
 *  on the PDF page (millimetres), with Y flipped (paper Y grows downward,
 *  world Y grows "up"/"north" depending on section axis). */
export interface PdfScaleTransform {
  /** mm on paper per metre in the world. E.g. 1:100 -> 10; 1:50 -> 20. */
  worldToMm: number;
  offsetXMm: number;
  offsetYMm: number;
}

export interface PdfPage {
  widthMm: number;
  heightMm: number;
}

export interface PdfScaleLayout {
  transform: PdfScaleTransform;
  page: PdfPage;
}

/**
 * Compute the page size and world->paper-mm transform for exporting
 * `bounds` (metres) at an exact `scaleFactor` (the "100" in "1:100"),
 * with `marginMm` of blank paper around the drawing on every side.
 *
 * Throws on a non-finite/non-positive scale factor, a non-finite/negative
 * margin, or degenerate bounds — silently producing a mis-scaled or
 * zero-size PDF would look plausible and be wrong, which is the failure
 * that matters most for a document someone measures from.
 */
export function computePdfScaleLayout(
  bounds: Bounds2D,
  scaleFactor: number,
  marginMm = 10
): PdfScaleLayout {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error(
      `Invalid PDF export scale factor: ${scaleFactor}. Expected a positive finite number (the "N" in "1:N").`
    );
  }
  if (!Number.isFinite(marginMm) || marginMm < 0) {
    throw new Error(`Invalid PDF export margin: ${marginMm}mm. Expected a non-negative finite number.`);
  }

  const { min, max } = bounds;
  if (
    !Number.isFinite(min.x) || !Number.isFinite(min.y) ||
    !Number.isFinite(max.x) || !Number.isFinite(max.y)
  ) {
    throw new Error('Invalid drawing bounds for PDF export: bounds must be finite.');
  }

  const width = max.x - min.x;
  const height = max.y - min.y;
  if (width < 0 || height < 0) {
    throw new Error('Invalid drawing bounds for PDF export: max must be >= min on both axes.');
  }

  // mm on paper per metre in the world. 1:100 means 1m -> 10mm on paper.
  const worldToMm = 1000 / scaleFactor;

  const drawingWidthMm = width * worldToMm;
  const drawingHeightMm = height * worldToMm;

  const page: PdfPage = {
    widthMm: drawingWidthMm + marginMm * 2,
    heightMm: drawingHeightMm + marginMm * 2,
  };

  // x: bounds.min.x -> marginMm (left edge of drawing area)
  const offsetXMm = marginMm - min.x * worldToMm;
  // y: flipped. bounds.min.y (world "bottom") -> page.heightMm - marginMm
  // (paper bottom edge of drawing area); bounds.max.y -> marginMm (top).
  const offsetYMm = page.heightMm - marginMm + min.y * worldToMm;

  return { transform: { worldToMm, offsetXMm, offsetYMm }, page };
}

/** Map one world-space point (metres) to paper space (mm) via `transform`. */
export function worldPointToPdfMm(point: Point2D, transform: PdfScaleTransform): Point2D {
  return {
    x: point.x * transform.worldToMm + transform.offsetXMm,
    y: -point.y * transform.worldToMm + transform.offsetYMm,
  };
}

/** Convert a line weight / length already expressed in mm-on-paper terms
 *  is a no-op; this converts a MODEL-space length (metres) to mm on paper
 *  at the given transform's scale — e.g. for stroke widths authored in
 *  world units. Most line/hatch weights in this codebase are already
 *  mm-on-paper constants, so this is only needed where a length is
 *  genuinely world-space (kept separate from `worldPointToPdfMm` so
 *  callers can't accidentally apply the Y-flip/offset to a scalar).
 */
export function worldLengthToPdfMm(lengthMeters: number, transform: PdfScaleTransform): number {
  return lengthMeters * transform.worldToMm;
}
