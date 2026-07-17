/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF underlay → 2D drawing space (issue #1782). The mapping math lives in
 * `dxfUnderlayMath.ts` (store-free, unit-tested); this hook wires it to the
 * viewer store and filters by section axis: underlays are plan content, so
 * anything but a cardinal 'down' section yields no data.
 */

import { useMemo } from 'react';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { dxfUnderlayToDrawing, dxfWorldShift } from './dxfUnderlayMath';

export {
  dxfWorldShift,
  dxfUnderlayToDrawing,
  dxfUnderlayDrawingBounds,
  type DxfUnderlayRenderData,
  type DxfUnderlayRenderLine,
  type DxfUnderlayRenderFill,
  type DxfUnderlayRenderText,
} from './dxfUnderlayMath';

import type { DxfUnderlayRenderData } from './dxfUnderlayMath';

export function useDxfUnderlaysForDrawing(params: {
  enabled: boolean;
  sectionAxis: 'down' | 'front' | 'side';
  isCustomPlane: boolean;
  flipped: boolean;
  coordinateInfo: GeometryResult['coordinateInfo'] | undefined;
}): readonly DxfUnderlayRenderData[] {
  const { enabled, sectionAxis, isCustomPlane, flipped, coordinateInfo } = params;
  const dxfUnderlays = useViewerStore((s) => s.dxfUnderlays);

  return useMemo(() => {
    // Plan-view content only: elevation/section/custom planes have no
    // meaningful mapping for a 2D site plan.
    if (!enabled || sectionAxis !== 'down' || isCustomPlane) return [];
    const visible = dxfUnderlays.filter((u) => u.visible && u.opacity > 0);
    if (visible.length === 0) return [];
    const shift = dxfWorldShift(coordinateInfo);
    // Cardinal flipped sections mirror the drawing's X axis (see
    // projectTo2D's flipped-U rule); the underlay must follow.
    return visible.map((u) => dxfUnderlayToDrawing(u, shift, flipped));
  }, [enabled, sectionAxis, isCustomPlane, flipped, coordinateInfo, dxfUnderlays]);
}
