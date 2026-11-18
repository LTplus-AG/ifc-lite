/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The third click of the dimension tool: from the two measured points and
 * the cursor, the orientation and signed offset of the dimension line.
 *
 * Aligned by default. With Shift the line locks to the drawing's x or y axis,
 * chosen by where the cursor has been pulled to: above or below the measured
 * points gives a horizontal dimension, beside them a vertical one (as in CAD
 * tools). A lock that would measure nothing (both points on one vertical for
 * a horizontal dimension) falls back to the other axis.
 */

import type { Point2D } from '@/store/slices/drawing2DSlice';
import { measuredDimensionValue, type Dimension2D, type Dimension2DOrientation } from '@/store/slices/drawing2DDimensions';
import { isDegenerateMeasurement } from '@/store/slices/drawing2DDegenerateGuards';

/** Unit direction of the dimension line; the offset runs along its left normal `(-dir.y, dir.x)`. */
export function dimensionDirection(a: Point2D, b: Point2D, orientation: Dimension2DOrientation): Point2D {
  if (orientation === 'horizontal') return { x: 1, y: 0 };
  if (orientation === 'vertical') return { x: 0, y: 1 };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return len > 1e-12 ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : { x: 1, y: 0 };
}

export function placementOrientation(a: Point2D, b: Point2D, cursor: Point2D, lockAxis: boolean): Dimension2DOrientation {
  if (!lockAxis) return 'aligned';
  const halfW = Math.abs(b.x - a.x) / 2;
  const halfH = Math.abs(b.y - a.y) / 2;
  const outX = Math.max(0, Math.abs(cursor.x - (a.x + b.x) / 2) - halfW);
  const outY = Math.max(0, Math.abs(cursor.y - (a.y + b.y) / 2) - halfH);
  const preferred: Dimension2DOrientation = outY >= outX ? 'horizontal' : 'vertical';
  if (!isDegenerateMeasurement(measuredDimensionValue({ a, b, orientation: preferred }))) return preferred;
  return preferred === 'horizontal' ? 'vertical' : 'horizontal';
}

/** Signed offset from the midpoint of a and b to the cursor, along the line's left normal. */
export function placementOffset(a: Point2D, b: Point2D, orientation: Dimension2DOrientation, cursor: Point2D): number {
  const dir = dimensionDirection(a, b, orientation);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return (cursor.x - mid.x) * -dir.y + (cursor.y - mid.y) * dir.x;
}

export const PREVIEW_DIMENSION_ID = 'dimension-preview';

/**
 * The dimension the tool would place now, for the live preview: with one
 * point placed, an aligned dimension on the line to the cursor; with two,
 * the dimension line follows the cursor. `null` before the first click.
 */
export function previewDimension(points: readonly Point2D[], cursor: Point2D | null, lockAxis: boolean): Dimension2D | null {
  if (!cursor || points.length === 0) return null;
  if (points.length === 1) {
    return { id: PREVIEW_DIMENSION_ID, a: points[0], b: cursor, offset: 0, orientation: 'aligned' };
  }
  const [a, b] = points;
  const orientation = placementOrientation(a, b, cursor, lockAxis);
  return { id: PREVIEW_DIMENSION_ID, a, b, orientation, offset: placementOffset(a, b, orientation, cursor) };
}
