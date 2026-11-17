/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The layers drawn with the cut (#5494): IFC annotations, DXF underlays, the
 * point-cloud scan band, and the exports that render all of them together.
 */

import { useMemo, useCallback, useEffect } from 'react';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { useIfc } from '@/hooks/useIfc';
import { useTranslation } from '@/i18n';
import { drawingAnnotationFrame } from '@/lib/model-placement/drawing-annotation-frame';
import { useSymbolicAnnotationsForDrawing, symbolicAnnotationsOverlayEnabled } from '@/hooks/useSymbolicAnnotations';
import { useDxfMapToWorldTransform } from '@/hooks/useDxfUnderlay';
import { centerDxfPlacement } from '@/lib/drawing/center-dxf';
import { useScanSectionLayer } from '@/hooks/useScanSectionLayer';
import { publishDrawingExportFrame } from '@/lib/drawing/export-view-frame';
import { useDrawingExport } from '@/hooks/useDrawingExport';
import type { DrawingViewModel } from './useDrawingViewModel';

export function useDrawingLayers(vm: DrawingViewModel) {
  const { t } = useTranslation();
  const { ifcDataStore } = useIfc();
  const updateDxfUnderlayPlacement = useViewerStore((s) => s.updateDxfUnderlayPlacement);
  const {
    geometryResult, runtime, drawnPlane, status, displayOptions, drawing, dxfUnderlays,
    typeVisibility, models, pointCloudClassMask,
  } = vm;

  // ─── IFC annotation overlay (issue #812) ──────────────────────────────────
  // Re-derive the section's world-coord cut position from the same bounds
  // useDrawingGeneration uses, so the annotation filter stays in lockstep
  // with the cut. Empty/missing bounds collapse to an inert range → hook
  // returns empty, the overlay simply does nothing.
  const ifcAnnotationsForDrawing = useMemo(() => drawingAnnotationFrame(
    geometryResult?.coordinateInfo, runtime.sourceCoordinateInfo, drawnPlane,
  ), [geometryResult, runtime.sourceCoordinateInfo, drawnPlane]);

  const ifcAnnotationData = useSymbolicAnnotationsForDrawing({
    enabled: symbolicAnnotationsOverlayEnabled(displayOptions.showIfcAnnotations, status, typeVisibility.ifcAnnotations),
    axis: drawnPlane.axis,
    sectionPosWorld: ifcAnnotationsForDrawing.sectionPosWorld,
    viewDepth: ifcAnnotationsForDrawing.viewDepth,
    flipped: drawnPlane.flipped,
    fallbackY: ifcAnnotationsForDrawing.fallbackY,
  });

  const dxfUnderlayData = vm.dxfUnderlayData;

  // Centre an underlay on the generated drawing: offset = model-drawing
  // centre − underlay centre at zero offset (same world→drawing mapping
  // the render hook applies, including the current rotation/scale and,
  // for a georeferenced underlay, the inverse IfcMapConversion — issue
  // #1929, same transform `dxfUnderlayData` above resolves).
  const { transform: dxfMapToWorld, available: dxfGeoreferenceAvailable } = useDxfMapToWorldTransform();
  const handleCenterDxfUnderlay = useCallback((id: string) => {
    const entry = dxfUnderlays.find((u) => u.id === id);
    if (!entry || !drawing) return;
    const result = centerDxfPlacement(entry, drawing, vm.sourceDrawing, geometryResult?.coordinateInfo,
      drawnPlane.flipped && drawnPlane.custom === undefined,
      { transform: dxfMapToWorld, available: dxfGeoreferenceAvailable }, useViewerStore.getState());
    if (result.error) { toast.error(t(`section2d.underlay.${result.error}`)); return; }
    updateDxfUnderlayPlacement(id, result.placement);
  }, [dxfUnderlays, drawing, vm.sourceDrawing, geometryResult, drawnPlane.flipped, drawnPlane.custom, updateDxfUnderlayPlacement, dxfMapToWorld, dxfGeoreferenceAvailable, t]);

  // Point-cloud scan overlay (issue #1805): a thin band of the loaded
  // scan(s) around the active section plane, projected into the SAME
  // drawing space the cut geometry uses (see scanSectionMath.ts) — unlike
  // the DXF underlay, this works on plan AND vertical (front/side) sections.
  const scanSectionLayer = useScanSectionLayer({
    enabled: displayOptions.showScanSection && status === 'ready',
    sectionPlane: drawnPlane,
    coordinateInfo: geometryResult?.coordinateInfo,
    thickness: displayOptions.scanSectionThickness,
    classMask: pointCloudClassMask,
    models,
    legacyPointClouds: geometryResult?.pointClouds,
    outline: { enabled: displayOptions.scanSectionOutline, maxGap: displayOptions.scanSectionOutlineMaxGap },
  });

  useEffect(() => { publishDrawingExportFrame({ isPinned: vm.isPinned, cachedSheetTransformRef: vm.cachedSheetTransformRef }); }, [vm.isPinned, vm.cachedSheetTransformRef]);

  const { handleExportSVG, handleExportDXF, handleExportPDF, handlePrint, getExportDimensionGraphics } = useDrawingExport({
    // Only the drawing on screen exports: a dialog left open while the cut
    // fails must not write the drawing the error now hides.
    drawing: vm.exportableDrawing, displayOptions, sectionPlane: drawnPlane, activePresetId: vm.activePresetId,
    entityColorMap: vm.entityColorMap, overridesEnabled: vm.overridesEnabled, overrideEngine: vm.overrideEngine,
    measure2DResults: vm.measure2DResults, polygonArea2DResults: vm.polygonArea2DResults,
    textAnnotations2D: vm.textAnnotations2D, cloudAnnotations2D: vm.cloudAnnotations2D,
    sheetEnabled: vm.sheetEnabled, activeSheet: vm.activeSheet, dxfUnderlays: dxfUnderlayData,
    ifcDataStore, coordinateInfo: geometryResult?.coordinateInfo,
    scanSection: scanSectionLayer,
    // Pin View state and the preview's transform cache: without these the
    // print/export path recomputed the sheet placement from the CURRENT
    // bounds while a pinned preview kept the held one, so a regenerate at a
    // new elevation printed a different layout from the one on screen. Pin
    // View defaults ON, so this was the default path. The hook only READS
    // the ref — the preview canvas owns the write.
    isPinned: vm.isPinned, cachedSheetTransformRef: vm.cachedSheetTransformRef,
  });

  return {
    ifcAnnotationData, dxfUnderlayData, dxfGeoreferenceAvailable, handleCenterDxfUnderlay,
    scanSectionLayer,
    handleExportSVG, handleExportDXF, handleExportPDF, handlePrint, getExportDimensionGraphics,
  };
}

export type DrawingLayers = ReturnType<typeof useDrawingLayers>;
