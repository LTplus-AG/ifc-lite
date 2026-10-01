/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The layers drawn with the cut (#5494): IFC annotations, DXF underlays, the
 * point-cloud scan band, and the exports that render all of them together.
 */

import { useMemo, useCallback } from 'react';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { useIfc } from '@/hooks/useIfc';
import { useTranslation } from '@/i18n';
import { drawingAnnotationFrame } from '@/lib/model-placement/drawing-annotation-frame';
import { useSymbolicAnnotationsForDrawing, symbolicAnnotationsOverlayEnabled } from '@/hooks/useSymbolicAnnotations';
import { useDxfMapToWorldTransform, dxfWorldShift, dxfUnderlayDrawingBounds } from '@/hooks/useDxfUnderlay';
import { drawingModelCenter } from '@/hooks/dxfDrawingBounds';
import { dxfPlaneDrawingMapper, dxfDrawingDeltaToPlacement } from '@/hooks/dxfReferencePlane';
import { useScanSectionLayer } from '@/hooks/useScanSectionLayer';
import { useDrawingExport } from '@/hooks/useDrawingExport';
import type { DrawingViewModel } from './useDrawingViewModel';

export function useDrawingLayers(vm: DrawingViewModel) {
  const { t } = useTranslation();
  const { ifcDataStore } = useIfc();
  const updateDxfUnderlayPlacement = useViewerStore((s) => s.updateDxfUnderlayPlacement);
  const {
    geometryResult, runtime, sectionPlane, status, displayOptions, drawing, dxfUnderlays,
    typeVisibility, models, pointCloudClassMask,
  } = vm;

  // ─── IFC annotation overlay (issue #812) ──────────────────────────────────
  // Re-derive the section's world-coord cut position from the same bounds
  // useDrawingGeneration uses, so the annotation filter stays in lockstep
  // with the cut. Empty/missing bounds collapse to an inert range → hook
  // returns empty, the overlay simply does nothing.
  const ifcAnnotationsForDrawing = useMemo(() => drawingAnnotationFrame(
    geometryResult?.coordinateInfo, runtime.sourceCoordinateInfo, sectionPlane,
  ), [geometryResult, runtime.sourceCoordinateInfo, sectionPlane]);

  const ifcAnnotationData = useSymbolicAnnotationsForDrawing({
    enabled: symbolicAnnotationsOverlayEnabled(displayOptions.showIfcAnnotations, status, typeVisibility.ifcAnnotations),
    axis: sectionPlane.axis,
    sectionPosWorld: ifcAnnotationsForDrawing.sectionPosWorld,
    viewDepth: ifcAnnotationsForDrawing.viewDepth,
    flipped: sectionPlane.flipped,
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
    const shift = dxfWorldShift(geometryResult?.coordinateInfo);
    const mirrorX = sectionPlane.flipped && sectionPlane.custom === undefined;
    const zeroOffsetEntry = {...entry,placement:{...entry.placement,offsetX:0,offsetY:0}};
    const state = useViewerStore.getState();
    const mapper = entry.referenceFrame ? dxfPlaneDrawingMapper(zeroOffsetEntry, state, drawing.config.plane) : undefined;
    if (entry.referenceFrame && !mapper) { toast.error(t('section2d.underlay.unavailableReference')); return; }
    const underlayBounds = dxfUnderlayDrawingBounds(entry, shift, mirrorX, dxfMapToWorld, dxfGeoreferenceAvailable, mapper ?? undefined);
    if (!underlayBounds) {
      // PR #1965 review: this guard fires when the underlay has no usable
      // bounds AT ALL (missing extents) OR the georeference produced a
      // non-finite corner (`dxfUnderlayDrawingBounds` collapses both into
      // `null` — see its docstring). Tell the user so a malformed
      // `IfcMapConversion` doesn't read as an unresponsive button.
      toast.error(t('section2d.underlay.missingBounds'));
      return;
    }
    const modelCenter = drawingModelCenter(vm.sourceDrawing);
    if (!modelCenter) { toast.error(t('section2d.underlay.emptyDrawing')); return; }
    const underlayCx = (underlayBounds.min.x + underlayBounds.max.x) / 2;
    const underlayCy = (underlayBounds.min.y + underlayBounds.max.y) / 2;
    const offset = dxfDrawingDeltaToPlacement(entry,state,drawing.config.plane,{x:modelCenter.x-underlayCx,y:modelCenter.y-underlayCy});
    if (!offset) { toast.error(t('section2d.underlay.incompatiblePlacement')); return; }
    const offsetX = offset.x, offsetY = offset.y;
    // Defense-in-depth (PR #1965 review): `drawing.bounds` comes from the
    // generated drawing, not the underlay, and a NaN here would otherwise be
    // written into the stored placement, which survives toggling
    // georeferencing back off.
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
      toast.error(t('section2d.underlay.nonFiniteDrawing'));
      return;
    }
    updateDxfUnderlayPlacement(id, { offsetX, offsetY });
  }, [dxfUnderlays, drawing, vm.sourceDrawing, geometryResult, sectionPlane.flipped, sectionPlane.custom, updateDxfUnderlayPlacement, dxfMapToWorld, dxfGeoreferenceAvailable, t]);

  // Point-cloud scan overlay (issue #1805): a thin band of the loaded
  // scan(s) around the active section plane, projected into the SAME
  // drawing space the cut geometry uses (see scanSectionMath.ts) — unlike
  // the DXF underlay, this works on plan AND vertical (front/side) sections.
  const scanSectionLayer = useScanSectionLayer({
    enabled: displayOptions.showScanSection && status === 'ready',
    sectionPlane,
    coordinateInfo: geometryResult?.coordinateInfo,
    thickness: displayOptions.scanSectionThickness,
    classMask: pointCloudClassMask,
    models,
    legacyPointClouds: geometryResult?.pointClouds,
  });

  const { handleExportSVG, handleExportDXF, handleExportPDF, handlePrint } = useDrawingExport({
    drawing, displayOptions, sectionPlane, activePresetId: vm.activePresetId,
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
    handleExportSVG, handleExportDXF, handleExportPDF, handlePrint,
  };
}

export type DrawingLayers = ReturnType<typeof useDrawingLayers>;
