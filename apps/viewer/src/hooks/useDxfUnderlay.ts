/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF underlay → 2D drawing space (issue #1782). The mapping math lives in
 * `dxfUnderlayMath.ts` (store-free, unit-tested); this hook wires it to the
 * viewer store and filters by section axis: underlays are plan content, so
 * anything but a cardinal 'down' section yields no data.
 *
 * `useDxfMapToWorldTransform` (issue #1929) resolves the federation
 * anchor's effective georeference the SAME way the DXF export path does
 * (`resolveDxfExportGeoreference`, which folds in `georefMutations` edits)
 * and builds the inverse-IfcMapConversion transform underlays flagged
 * `georeferenced` need. `Section2DPanel`'s "Center on model" handler uses
 * it too, so centering agrees with what's actually rendered.
 */

import { useMemo } from 'react';
import type { Point2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { buildDxfMapToWorldTransform, resolveDxfExportGeoreference } from './dxfExportGeoref';
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

/**
 * Resolve the map/CRS → IFC-world transform for georeferenced DXF
 * underlays (issue #1929). Identity when no loaded model has a usable
 * IfcMapConversion — the underlay's `georeferenced` flag then has nothing
 * to apply, same as before this issue.
 */
export function useDxfMapToWorldTransform(): (p: Point2D) => Point2D {
  const models = useViewerStore((s) => s.models);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const anchorModelIdOverride = useViewerStore((s) => s.anchorModelIdOverride);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  // Georef edits replace the map, but subscribe to mutationVersion too so
  // the dependency is explicit (matches useDrawingExport / useAnchorGeoreference).
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  return useMemo(() => {
    const georeference = resolveDxfExportGeoreference({
      models,
      legacyDataStore: ifcDataStore,
      anchorModelIdOverride,
      georefMutations,
    });
    return buildDxfMapToWorldTransform(georeference);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, ifcDataStore, anchorModelIdOverride, georefMutations, mutationVersion]);
}

export function useDxfUnderlaysForDrawing(params: {
  enabled: boolean;
  sectionAxis: 'down' | 'front' | 'side';
  isCustomPlane: boolean;
  flipped: boolean;
  coordinateInfo: GeometryResult['coordinateInfo'] | undefined;
}): readonly DxfUnderlayRenderData[] {
  const { enabled, sectionAxis, isCustomPlane, flipped, coordinateInfo } = params;
  const dxfUnderlays = useViewerStore((s) => s.dxfUnderlays);
  const mapToWorld = useDxfMapToWorldTransform();

  return useMemo(() => {
    // Plan-view content only: elevation/section/custom planes have no
    // meaningful mapping for a 2D site plan.
    if (!enabled || sectionAxis !== 'down' || isCustomPlane) return [];
    const visible = dxfUnderlays.filter((u) => u.visible && u.opacity > 0);
    if (visible.length === 0) return [];
    const shift = dxfWorldShift(coordinateInfo);
    // Cardinal flipped sections mirror the drawing's X axis (see
    // projectTo2D's flipped-U rule); the underlay must follow.
    return visible.map((u) => dxfUnderlayToDrawing(u, shift, flipped, mapToWorld));
  }, [enabled, sectionAxis, isCustomPlane, flipped, coordinateInfo, dxfUnderlays, mapToWorld]);
}
