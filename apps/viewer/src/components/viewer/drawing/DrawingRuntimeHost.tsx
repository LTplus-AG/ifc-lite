/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 2D drawing runtime, with no view of its own (#5492): markup and sheet
 * persistence, and drawing generation, which keeps running while no drawing
 * view is shown because the 3D cut overlay reads the generated drawing.
 * Mounted once next to the federated geometry in `ViewportContainer`; views
 * read what they need through `useDrawingRuntime`.
 *
 * The Section tool does NOT auto-open this panel (#5497): opening the tool
 * only shows the 3D cut. A user (or caller) opens the Drawing explicitly —
 * the section UI's "2D" button, DXF import, a BCF/basket view apply — via
 * `openPanelInHome('drawing')`. Leaving the tool parks the cut
 * (`store/section-active.ts`); a docked/floating Drawing panel keeps showing
 * the last generated drawing and surfaces that parked state itself
 * (`DrawingPanel`'s "Section parked" banner) rather than this host reopening.
 */

import { useEffect, useMemo } from 'react';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
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

  // A drawing view is on screen when the panel is docked in the bottom strip,
  // floating, or popped out (#5493). Opening another bottom panel clears the
  // dock flag but leaves a floating / popped-out drawing showing.
  const panelVisible = useViewerStore((s) => s.drawing2DPanelVisible
    || s.floatingPanels.some((p) => p.id === 'drawing') || s.poppedOutIds.includes('drawing'));
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

  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const { generateDrawing, isRegenerating } = useDrawingGeneration({
    geometryResult, ifcDataStore, sectionPlane, displayOptions, typeVisibility,
    // Both sets hold global ids, so they cover every federated model.
    combinedHiddenIds: hiddenEntities, combinedIsolatedIds: isolatedEntities, computedIsolatedIds,
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
