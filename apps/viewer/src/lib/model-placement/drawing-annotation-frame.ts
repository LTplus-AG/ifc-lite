/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { AXIS_MAP, ANNOTATION_VIEW_DEPTH } from '@/hooks/useDrawingGeneration';

/** The cut uses placed bounds. A loose annotation's fallback remains in the
 * source frame, because placedSymbols applies its owning model's offset. */
export function drawingAnnotationFrame(
  placed: CoordinateInfo | undefined, source: CoordinateInfo | undefined,
  section: { axis: 'down' | 'front' | 'side'; position: number },
) {
  const bounds = placed?.shiftedBounds;
  if (!bounds) return { sectionPosWorld: 0, viewDepth: 0, fallbackY: 0 };
  const axis = AXIS_MAP[section.axis];
  const sectionPosWorld = bounds.min[axis] + (section.position / 100) * (bounds.max[axis] - bounds.min[axis]);
  const yMin = source?.shiftedBounds.min.y, yMax = source?.shiftedBounds.max.y;
  const fallbackY = yMin !== undefined && yMax !== undefined && Number.isFinite(yMin) && Number.isFinite(yMax)
    ? (yMin + yMax) * 0.5 : 0;
  return { sectionPosWorld, viewDepth: ANNOTATION_VIEW_DEPTH, fallbackY };
}
