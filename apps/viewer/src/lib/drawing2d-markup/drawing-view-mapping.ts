/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a drawing point lands on the 2D canvas, and back.
 *
 * Markup that keeps drawing metres (dimensions) must map the same way the
 * drawing itself is painted. In direct mode the canvas scales drawing metres
 * straight to pixels with the section's axis signs. In sheet mode it first
 * places the drawing on paper (`resolveSheetTransform`: flip, then metres to
 * millimetres), and the view transform scales paper millimetres to pixels.
 * Either way the flips are `axisFlipForSection(axis)`, so the same flip
 * feeds `dimensionGraphics` and the text it lays out reads upright on screen.
 */

import { axisFlipForSection, type SectionAxis } from '@/hooks/pdfSectionLayout';
import type { Point2D } from '@/store/slices/drawing2DSlice';

export interface ViewTransform {
  x: number;
  y: number;
  /** Pixels per drawing metre (direct mode) or per paper millimetre (sheet mode). */
  scale: number;
}

/** Drawing metres to paper millimetres, as `resolveSheetTransform` returns it. */
export interface SheetPlacement {
  translateX: number;
  translateY: number;
  scaleFactor: number;
}

export interface DrawingViewMapping {
  toScreen(p: Point2D): Point2D;
  toDrawing(p: Point2D): Point2D;
  /** Screen pixels per drawing metre. */
  pxPerMetre: number;
  flip: { flipX: boolean; flipY: boolean };
}

export function drawingViewMapping(transform: ViewTransform, axis: SectionAxis, sheet?: SheetPlacement | null): DrawingViewMapping {
  const flip = axisFlipForSection(axis);
  const sx = flip.flipX ? -1 : 1;
  const sy = flip.flipY ? -1 : 1;
  const k = sheet ? sheet.scaleFactor : 1;
  const tx = sheet ? sheet.translateX : 0;
  const ty = sheet ? sheet.translateY : 0;
  const s = transform.scale;
  return {
    toScreen: (p) => ({ x: (p.x * sx * k + tx) * s + transform.x, y: (p.y * sy * k + ty) * s + transform.y }),
    toDrawing: (p) => ({ x: (((p.x - transform.x) / s - tx) / k) * sx, y: (((p.y - transform.y) / s - ty) / k) * sy }),
    pxPerMetre: s * k,
    flip,
  };
}
