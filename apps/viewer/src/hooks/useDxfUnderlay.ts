/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** DXF references projected through their registered engineering frame. */

import { dxfPlaneDrawingMapper, dxfReferenceRenderBasis, dxfReferencePointToRender } from './dxfReferencePlane';
import { anchorWorldLineVertices } from '@/lib/renderer/line-overlay-rte';
import { useMemo } from 'react';
import type { Point2D, SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { RendererLineVertices } from '@/lib/renderer/line-overlay-rte';
import { useViewerStore } from '@/store';
import { buildDxfMapToWorldTransform, resolveDxfExportGeoreference } from './dxfExportGeoref';
import {
  dxfElevationRenderY,
  dxfUnderlayToDrawing,
  dxfUnderlayToWorldLines3DAnchored,
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
  plane?: SectionPlaneConfig;
  enabled: boolean;
  sectionAxis: 'down' | 'front' | 'side';
  isCustomPlane: boolean;
  flipped: boolean;
  coordinateInfo: GeometryResult['coordinateInfo'] | undefined;
}): readonly DxfUnderlayRenderData[] {
  const { enabled, sectionAxis, isCustomPlane, flipped, coordinateInfo } = params;
  const models = useViewerStore(s => s.models), placement = useViewerStore(s => s.modelPlacement);
  const dxfUnderlays = useViewerStore((s) => s.dxfUnderlays);
  const { transform: mapToWorld, available: georeferenceAvailable } = useDxfMapToWorldTransform();

  return useMemo(() => {
    // Site plans remain plan-only; registered references project in compatible views.
    if (!enabled) return [];
    const visible = dxfUnderlays.filter((u) => u.visible && u.opacity > 0);
    if (visible.length === 0) return [];
    const shift = dxfWorldShift(coordinateInfo);
    // Cardinal flipped sections mirror the drawing's X axis (see
    // projectTo2D's flipped-U rule); the underlay must follow.
    const plane: SectionPlaneConfig = params.plane ?? {axis: sectionAxis === 'down' ? 'y' : sectionAxis === 'front' ? 'z' : 'x', position: 0, flipped};
    return visible.flatMap(u => {
      if (u.referenceFrame) {
        const mapper = dxfPlaneDrawingMapper(u, useViewerStore.getState(), plane);
        return mapper ? [dxfUnderlayToDrawing(u, shift, flipped, mapToWorld, georeferenceAvailable, mapper)] : [];
      }
      return sectionAxis === 'down' && !isCustomPlane ? [dxfUnderlayToDrawing(u, shift, flipped, mapToWorld, georeferenceAvailable)] : [];
    });
  }, [enabled, sectionAxis, isCustomPlane, flipped, coordinateInfo, dxfUnderlays, mapToWorld, georeferenceAvailable, params.plane, models, placement]);
}

/**
 * DXF underlays flagged `visible3D`, flattened into one 3D line-list ready
 * for `renderer.setLineOverlay('dxf', …)` (issue #2043). Independent of the 2D
 * panel's section-axis/plan-view gating in {@link useDxfUnderlaysForDrawing}
 * — the 3D overlay renders regardless of section state, matching how the
 * alignment 3D overlay is always-eligible (`useAlignmentLines3D`); grid 3D
 * lines are drawn by `useSymbolicAnnotations` instead (issue #3368).
 */
export type DxfLines3D = RendererLineVertices;

export function useDxfUnderlays3DLines(
  coordinateInfo: GeometryResult['coordinateInfo'] | undefined,
): DxfLines3D {
  const dxfUnderlays = useViewerStore((s) => s.dxfUnderlays);
  const models = useViewerStore(s => s.models), placement = useViewerStore(s => s.modelPlacement);
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
    const payloads = visible.map((u) => {
      if (!u.referenceFrame) return dxfUnderlayToWorldLines3DAnchored(u, shift, elevationRenderY, mapToWorld, georeferenceAvailable);
      const basis = dxfReferenceRenderBasis(u.referenceFrame, useViewerStore.getState());
      if (!basis) return null;
      const vertices: number[] = [];
      for (const layer of u.underlay.layers) {
        if (!(u.layerVisibility[layer.name] ?? layer.visible)) continue;
        for (const path of layer.paths) {
          const points = path.points.map(p => dxfReferencePointToRender(p, u, basis));
          for (let i=1;i<points.length;i++) vertices.push(...points[i-1],...points[i]);
          if (path.closed && points.length > 2) vertices.push(...points[points.length-1],...points[0]);
        }
      }
      return vertices.length ? anchorWorldLineVertices(vertices) : null;
    }).filter((value): value is RendererLineVertices => value !== null);
    const partitions = payloads.flatMap((payload) => payload instanceof Float32Array
      ? []
      : 'localVertices' in payload ? [payload] : payload);
    if (partitions.length === 0) return EMPTY_LINES_3D;
    return partitions.length === 1 ? partitions[0] : partitions;
  }, [dxfUnderlays, coordinateInfo, mapToWorld, georeferenceAvailable, models, placement]);
}
