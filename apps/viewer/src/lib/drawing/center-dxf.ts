/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice';
import { dxfWorldShift, dxfUnderlayDrawingBounds, type DxfMapToWorld } from '@/hooks/useDxfUnderlay';
import { drawingModelCenter } from '@/hooks/dxfDrawingBounds';
import { dxfPlaneDrawingMapper, dxfDrawingDeltaToPlacement } from '@/hooks/dxfReferencePlane';
export function centerDxfPlacement(entry: DxfUnderlayState, drawing: Drawing2D, sourceDrawing: Drawing2D | null, coordinateInfo: GeometryResult['coordinateInfo'] | undefined, mirrorX: boolean, frame: DxfMapToWorld, state: ViewerState) {
  const zero = { ...entry, placement: { ...entry.placement, offsetX: 0, offsetY: 0 } };
  const mapper = entry.referenceFrame ? dxfPlaneDrawingMapper(zero, state, drawing.config.plane) : undefined;
  if (entry.referenceFrame && !mapper) return { error: 'unavailableReference' } as const;
  const bounds = dxfUnderlayDrawingBounds(entry, dxfWorldShift(coordinateInfo), mirrorX, frame.transform, frame.available, mapper ?? undefined);
  if (!bounds) return { error: 'missingBounds' } as const;
  const center = drawingModelCenter(sourceDrawing);
  if (!center) return { error: 'emptyDrawing' } as const;
  const offset = dxfDrawingDeltaToPlacement(entry, state, drawing.config.plane, { x: center.x - (bounds.min.x + bounds.max.x) / 2, y: center.y - (bounds.min.y + bounds.max.y) / 2 });
  if (!offset) return { error: 'incompatiblePlacement' } as const;
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) return { error: 'nonFiniteDrawing' } as const;
  return { placement: { offsetX: offset.x, offsetY: offset.y } } as const;
}
