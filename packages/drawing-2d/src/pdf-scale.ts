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

  // Inputs were validated finite above, but finite inputs can still
  // multiply/divide out to a non-finite output — e.g. a vanishingly small
  // (but positive, so it passes the scaleFactor check) scale factor makes
  // `worldToMm` overflow to Infinity, or enormous bounds combined with a
  // large worldToMm overflow `page.widthMm`/`heightMm`. These are exactly
  // the numbers that reach jsPDF's page-size/coordinate arguments, so catch
  // it here rather than let jsPDF fail (or silently emit a garbage page).
  if (
    !Number.isFinite(worldToMm) ||
    !Number.isFinite(page.widthMm) || !Number.isFinite(page.heightMm) ||
    !Number.isFinite(offsetXMm) || !Number.isFinite(offsetYMm)
  ) {
    throw new Error(
      `PDF export layout produced non-finite dimensions (worldToMm=${worldToMm}, ` +
        `page=${page.widthMm}x${page.heightMm}mm) from scaleFactor=${scaleFactor} and bounds ` +
        `${width}x${height}. Choose a less extreme scale.`
    );
  }

  return { transform: { worldToMm, offsetXMm, offsetYMm }, page };
}

/** Which axes a caller intends to negate before mapping a point (matches the
 *  "as displayed" flips `useDrawingExport.ts` applies per section axis —
 *  `front`/`side` mirror the world X and/or Y before mapping to paper). */
export interface AxisFlip {
  flipX: boolean;
  flipY: boolean;
}

/**
 * Flip `bounds` around world zero on the requested axes — i.e. the bounds
 * of the geometry *as it will actually be drawn* after a caller negates
 * point coordinates per `flip`.
 *
 * This exists because `computePdfScaleLayout`'s offsets are derived from
 * `bounds.min`, which only lands the drawing on the page if the points
 * handed to `worldPointToPdfMm` are drawn in that same, un-negated frame.
 * A caller that negates X/Y when mapping points (as `front`/`side` section
 * exports do) but derives the layout from the *original* bounds gets
 * offsets computed for a frame the geometry was never actually drawn in —
 * correct only when `bounds` happens to be symmetric about zero, and
 * silently off-page for the common case of a model at positive world
 * coordinates. Always deriving the layout from `flipBounds2D(bounds, flip)`
 * keeps the two in sync regardless of where the drawing sits in world space.
 */
export function flipBounds2D(bounds: Bounds2D, flip: AxisFlip): Bounds2D {
  return {
    min: {
      x: flip.flipX ? -bounds.max.x : bounds.min.x,
      y: flip.flipY ? -bounds.max.y : bounds.min.y,
    },
    max: {
      x: flip.flipX ? -bounds.min.x : bounds.max.x,
      y: flip.flipY ? -bounds.min.y : bounds.max.y,
    },
  };
}

/**
 * Format a "1:N" scale factor for a filename/label, rounding float noise
 * away rather than truncating it: 2 decimal places, trailing zeros (and a
 * bare trailing dot) stripped, so `99.5` reads "99.5" and `100.0000001`
 * reads "100" rather than either carrying noise or rounding to a materially
 * different scale.
 *
 * Extracted from `SVGExporter`'s title-block scale label (PR #2131, "stop
 * the title block from lying about a clamped scale") so every place that
 * turns a scale factor into a human-readable "N" — the title block, and the
 * PDF export filename below — agrees on one rounding rule instead of each
 * re-deriving (and potentially disagreeing on) its own.
 */
export function formatScaleFactorLabel(factor: number): string {
  const rounded = Math.round(factor * 100) / 100;
  return rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Relative gap below which a 2-decimal label is the factor rather than a
 * rounding OF it. Float round-tripping (`1000 / (1000 / f)`) moves a factor by
 * about 1e-16 relative; a real rounding — 87.3456 shown as "87.35" — moves it
 * by about 1e-5. Anything in between does not occur, so this sits far from
 * both and is not a tuned threshold.
 */
const LABEL_EXACTNESS = 1e-9;

/**
 * The ratio a sheet prints for `factor`: `"1:100"` when the label IS the
 * factor, `"about 1:87.35"` when {@link formatScaleFactorLabel} had to round it.
 *
 * WHY THE HEDGE EXISTS. A to-scale sheet is a promise that a distance measured
 * off the paper converts back at the printed ratio. "As displayed" hands over
 * whatever factor the viewport happens to sit at — 1:87.3456 — and printing a
 * bare "1:87.35" would state a scale the drawing was not drawn at, which is the
 * same defect as an unlabelled sheet wearing a different hat: a number an
 * engineer would trust and should not. The word says the printed ratio is the
 * nearest hundredth, and the drawn scale bar next to it carries the exact
 * length regardless.
 *
 * The number itself is left at 2 decimals so the sheet and the export filename
 * (which goes through the same formatter) can never quote different ratios.
 */
export function formatSheetScaleLabel(factor: number): string {
  const label = formatScaleFactorLabel(factor);
  const printed = Number(label);
  const exact =
    Number.isFinite(printed) && Math.abs(printed - factor) <= Math.abs(factor) * LABEL_EXACTNESS;
  return exact ? `1:${label}` : `about 1:${label}`;
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
