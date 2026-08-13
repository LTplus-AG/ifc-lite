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
 *
 * PR #1965 review: also returns `available` — whether an anchor
 * georeference currently resolves — because `entry.georeferenced` is now
 * tri-state (`drawing2DSlice.ts`'s field doc) and an `undefined` ("auto")
 * entry's EFFECTIVE state depends on this same availability
 * (`resolveEffectiveGeoreferenced` in `dxfUnderlayMath.ts`). Every caller
 * that gates on an entry's georeferenced state needs both the transform
 * AND this flag, so they're returned together to keep them from drifting.
 */

import { useMemo } from 'react';
import type { Point2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { buildDxfMapToWorldTransform, resolveDxfExportGeoreference } from './dxfExportGeoref';
import {
  dxfElevationRenderY,
  dxfUnderlayToDrawing,
  dxfUnderlayToWorldLines3D,
  dxfWorldShift,
} from './dxfUnderlayMath';

export {
  dxfWorldShift,
  dxfElevationRenderY,
  dxfUnderlayToDrawing,
  dxfUnderlayToWorldLines3D,
  dxfUnderlayDrawingBounds,
  type DxfUnderlayRenderData,
  type DxfUnderlayRenderLine,
  type DxfUnderlayRenderFill,
  type DxfUnderlayRenderText,
} from './dxfUnderlayMath';

import type { DxfUnderlayRenderData } from './dxfUnderlayMath';

const EMPTY_LINES_3D = new Float32Array(0);

export interface DxfMapToWorld {
  /** Map/CRS -> IFC-world transform; identity when `available` is false. */
  transform: (p: Point2D) => Point2D;
  /** Whether an anchor georeference actually resolved (drives auto-mode entries). */
  available: boolean;
}

/**
 * Resolve the map/CRS → IFC-world transform for georeferenced DXF
 * underlays (issue #1929). Identity when no loaded model has a usable
 * IfcMapConversion — the underlay's EFFECTIVE georeferenced state then has
 * nothing to apply, same as before this issue.
 */
export function useDxfMapToWorldTransform(): DxfMapToWorld {
  const models = useViewerStore((s) => s.models);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const geometryResult = useViewerStore((s) => s.geometryResult);
  const anchorModelIdOverride = useViewerStore((s) => s.anchorModelIdOverride);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  // Georef edits replace the map, but subscribe to mutationVersion too so
  // the dependency is explicit (matches useDrawingExport / useAnchorGeoreference).
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  return useMemo(() => {
    const georeference = resolveDxfExportGeoreference({
      models,
      legacyDataStore: ifcDataStore,
      // The legacy single-model coordinateInfo must be threaded exactly like
      // useDrawingExport does, or the map-absolute guard (#2526) fires on
      // export but not on this import path and the two directions disagree
      // for a map-absolute model loaded through the legacy store.
      legacyCoordinateInfo: geometryResult?.coordinateInfo,
      anchorModelIdOverride,
      georefMutations,
    });
    return { transform: buildDxfMapToWorldTransform(georeference), available: georeference !== null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, ifcDataStore, geometryResult, anchorModelIdOverride, georefMutations, mutationVersion]);
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
  const { transform: mapToWorld, available: georeferenceAvailable } = useDxfMapToWorldTransform();

  return useMemo(() => {
    // Plan-view content only: elevation/section/custom planes have no
    // meaningful mapping for a 2D site plan.
    if (!enabled || sectionAxis !== 'down' || isCustomPlane) return [];
    const visible = dxfUnderlays.filter((u) => u.visible && u.opacity > 0);
    if (visible.length === 0) return [];
    const shift = dxfWorldShift(coordinateInfo);
    // Cardinal flipped sections mirror the drawing's X axis (see
    // projectTo2D's flipped-U rule); the underlay must follow.
    return visible.map((u) => dxfUnderlayToDrawing(u, shift, flipped, mapToWorld, georeferenceAvailable));
  }, [enabled, sectionAxis, isCustomPlane, flipped, coordinateInfo, dxfUnderlays, mapToWorld, georeferenceAvailable]);
}

/**
 * DXF underlays flagged `visible3D`, flattened into one 3D line-list ready
 * for `renderer.uploadDxfLines3D` (issue #2043). Independent of the 2D
 * panel's section-axis/plan-view gating in {@link useDxfUnderlaysForDrawing}
 * — the 3D overlay renders regardless of section state, matching how the
 * alignment/grid 3D overlays are always-eligible (`useAlignmentLines3D`,
 * `useGridLines3D`).
 */
export function useDxfUnderlays3DLines(
  coordinateInfo: GeometryResult['coordinateInfo'] | undefined,
): Float32Array {
  const dxfUnderlays = useViewerStore((s) => s.dxfUnderlays);
  const { transform: mapToWorld, available: georeferenceAvailable } = useDxfMapToWorldTransform();

  return useMemo(() => {
    // PR #2114 review: `opacity` is intentionally an on/off gate here, not
    // an alpha value — the merged 3D line buffer below carries positions
    // only (no per-vertex/per-underlay alpha), and the shared
    // `Section2DOverlayRenderer.linePipeline` (also used by the grid,
    // alignment and annotation line overlays) has no blend state, so a
    // passed-through alpha wouldn't visibly blend anyway. Plumbing real
    // per-underlay opacity through would mean adding blend state to that
    // shared pipeline and splitting this single merged draw into one draw
    // per underlay — out of scope for the DXF-in-3D feature. The opacity
    // slider is labelled "Opacity (2D)" in `DxfUnderlayPanel.tsx` so this
    // is surfaced in the UI, not just here.
    const visible = dxfUnderlays.filter((u) => u.visible3D && u.opacity > 0);
    if (visible.length === 0) return EMPTY_LINES_3D;
    const shift = dxfWorldShift(coordinateInfo);
    const elevationRenderY = dxfElevationRenderY(coordinateInfo);
    const arrays = visible.map((u) =>
      dxfUnderlayToWorldLines3D(u, shift, elevationRenderY, mapToWorld, georeferenceAvailable),
    );
    let total = 0;
    for (const a of arrays) total += a.length;
    if (total === 0) return EMPTY_LINES_3D;
    if (arrays.length === 1) return arrays[0];
    const merged = new Float32Array(total);
    let offset = 0;
    for (const a of arrays) {
      merged.set(a, offset);
      offset += a.length;
    }
    return merged;
  }, [dxfUnderlays, coordinateInfo, mapToWorld, georeferenceAvailable]);
}
