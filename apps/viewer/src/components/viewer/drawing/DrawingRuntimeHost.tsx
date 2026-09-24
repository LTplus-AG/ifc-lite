/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 2D drawing runtime, with no view of its own (#5492): markup and sheet
 * persistence, the Section-tool auto-open, and drawing generation, which keeps
 * running while no drawing view is shown because the 3D cut overlay reads the
 * generated drawing. Mounted once next to the federated geometry in
 * `ViewportContainer`; views read what they need through `useDrawingRuntime`.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useIfc } from '@/hooks/useIfc';
import { usePlacementCoordinateInfo } from '@/hooks/usePlacementCoordinateInfo';
import { useDrawingGeneration } from '@/hooks/useDrawingGeneration';
import { useDrawing2DPersistence } from '@/hooks/useDrawing2DPersistence';
import { useDrawingMarkupRestoreOnLoad } from '@/hooks/useDrawingMarkupRestoreOnLoad';
import { placedViewGeometry } from '@/lib/model-placement/view-geometry';
import { publishDrawingRuntime } from '@/lib/drawing/drawing-runtime';

interface DrawingRuntimeHostProps {
  mergedGeometry?: GeometryResult | null;
  computedIsolatedIds?: Set<number> | null;
}

export function DrawingRuntimeHost({ mergedGeometry, computedIsolatedIds }: DrawingRuntimeHostProps = {}): null {
  // Both restores run with no drawing view mounted — safe together, see
  // `useDrawingMarkupRestoreOnLoad`'s module doc (#4153 vs #4159).
  useDrawing2DPersistence();
  useDrawingMarkupRestoreOnLoad();

  const panelVisible = useViewerStore((s) => s.drawing2DPanelVisible);
  const setDrawingPanelVisible = useViewerStore((s) => s.setDrawing2DPanelVisible);
  const suppressNextSection2DPanelAutoOpen = useViewerStore((s) => s.suppressNextSection2DPanelAutoOpen);
  const setSuppressNextSection2DPanelAutoOpen = useViewerStore((s) => s.setSuppressNextSection2DPanelAutoOpen);
  const sourceDrawing = useViewerStore((s) => s.drawing2D);
  const setDrawing = useViewerStore((s) => s.setDrawing2D);
  const setDrawingStatus = useViewerStore((s) => s.setDrawing2DStatus);
  const setDrawingProgress = useViewerStore((s) => s.setDrawing2DProgress);
  const setDrawingError = useViewerStore((s) => s.setDrawing2DError);
  const displayOptions = useViewerStore((s) => s.drawing2DDisplayOptions);
  // Class-level Visibility toggles — the section honours them like the 3D
  // viewport does, so a hidden IfcSpace/IfcOpeningElement is not cut (#2060).
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const activeTool = useViewerStore((s) => s.activeTool);
  const models = useViewerStore((s) => s.models);
  const { geometryResult: legacyGeometryResult, ifcDataStore } = useIfc();

  const placement = useViewerStore((state) => state.modelPlacement);
  const placedCoordinateInfo = usePlacementCoordinateInfo((mergedGeometry ?? legacyGeometryResult)?.coordinateInfo);
  const drawingActive = panelVisible || (activeTool === 'section' && displayOptions.show3DOverlay);
  const geometryResult = useMemo(() => { const source = mergedGeometry ?? legacyGeometryResult;
    return source && drawingActive ? { ...placedViewGeometry(source), coordinateInfo: placedCoordinateInfo ?? source.coordinateInfo } : source;
  }, [mergedGeometry, legacyGeometryResult, placement, placedCoordinateInfo, drawingActive]);

  // Opening the Section tool opens the drawing, unless a caller that shows a
  // cut programmatically asked to skip it once (`store/section-active.ts`).
  const prevActiveToolRef = useRef(activeTool);
  useEffect(() => {
    if (activeTool === 'section' && prevActiveToolRef.current !== 'section' && geometryResult?.meshes) {
      if (suppressNextSection2DPanelAutoOpen) {
        setSuppressNextSection2DPanelAutoOpen(false);
        prevActiveToolRef.current = activeTool;
        return;
      }
      setDrawingPanelVisible(true);
    }
    prevActiveToolRef.current = activeTool;
  }, [activeTool, geometryResult, setDrawingPanelVisible, suppressNextSection2DPanelAutoOpen, setSuppressNextSection2DPanelAutoOpen]);

  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const hiddenEntitiesByModel = useViewerStore((s) => s.hiddenEntitiesByModel);
  const isolatedEntitiesByModel = useViewerStore((s) => s.isolatedEntitiesByModel);

  // Per-model local expressIds → global IDs (idOffset), plus the legacy set.
  const combinedHiddenIds = useMemo(() => {
    const globalHiddenIds = new Set<number>(hiddenEntities);
    for (const [modelId, localHiddenIds] of hiddenEntitiesByModel) {
      const model = models.get(modelId);
      if (model && model.idOffset !== undefined) {
        for (const localId of localHiddenIds) {
          globalHiddenIds.add(toGlobalIdFromModels(models, model.id, localId));
        }
      }
    }
    return globalHiddenIds;
  }, [hiddenEntities, hiddenEntitiesByModel, models]);

  const combinedIsolatedIds = useMemo(() => {
    // Legacy isolation already holds global IDs.
    if (isolatedEntities !== null) return isolatedEntities;
    const globalIsolatedIds = new Set<number>();
    for (const [modelId, localIsolatedIds] of isolatedEntitiesByModel) {
      const model = models.get(modelId);
      if (model && model.idOffset !== undefined) {
        for (const localId of localIsolatedIds) {
          globalIsolatedIds.add(toGlobalIdFromModels(models, model.id, localId));
        }
      }
    }
    return globalIsolatedIds.size > 0 ? globalIsolatedIds : null;
  }, [isolatedEntities, isolatedEntitiesByModel, models]);

  const { generateDrawing, isRegenerating } = useDrawingGeneration({
    geometryResult, ifcDataStore, sectionPlane, displayOptions, typeVisibility,
    combinedHiddenIds, combinedIsolatedIds, computedIsolatedIds,
    models, panelVisible, activeTool, drawing: sourceDrawing,
    setDrawing, setDrawingStatus, setDrawingProgress, setDrawingError,
  });

  const sourceCoordinateInfo = (mergedGeometry ?? legacyGeometryResult)?.coordinateInfo;
  useEffect(() => {
    publishDrawingRuntime({ geometryResult, sourceCoordinateInfo, generateDrawing, isRegenerating });
  }, [geometryResult, sourceCoordinateInfo, generateDrawing, isRegenerating]);
  useEffect(() => () => publishDrawingRuntime(null), []);

  return null;
}
