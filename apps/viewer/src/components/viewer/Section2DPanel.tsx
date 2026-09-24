/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Workspace drawings with pan/zoom, hidden lines and vector export. */

import { drawingAnnotationFrame } from '@/lib/model-placement/drawing-annotation-frame';
import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { X, Download, FileDown, Eye, EyeOff, Maximize2, ZoomIn, ZoomOut, Loader2, Printer, MoreHorizontal, RefreshCw, Pin, PinOff, Palette, Ruler, Trash2, FileText, Shapes, Box, BoxSelect, PenTool, Hexagon, Type, Cloud, MousePointer2, Tag, Layers, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { useIfc } from '@/hooks/useIfc';
import { GraphicOverrideEngine, COMMON_SCALES } from '@ifc-lite/drawing-2d';
import { DrawingSettingsPanel } from './DrawingSettingsPanel';
import { DxfUnderlayPanel } from './DxfUnderlayPanel';
import { ScanSectionPanel } from './ScanSectionPanel';
import { SheetSetupPanel } from './SheetSetupPanel';
import { TitleBlockEditor } from './TitleBlockEditor';
import { TextAnnotationEditor } from './TextAnnotationEditor';
import { Drawing2DCanvas } from './Drawing2DCanvas';
import { useMeasure2D } from '@/hooks/useMeasure2D';
import { useAnnotation2D } from '@/hooks/useAnnotation2D';
import { useDrawingWithReferences } from '@/hooks/useReferenceImagesForDrawing';
import { useViewControls } from '@/hooks/useViewControls';
import { useDrawingExport } from '@/hooks/useDrawingExport';
import { useSymbolicAnnotationsForDrawing, symbolicAnnotationsOverlayEnabled } from '@/hooks/useSymbolicAnnotations';
import { useDxfUnderlaysForDrawing, useDxfMapToWorldTransform, dxfWorldShift, dxfUnderlayDrawingBounds } from '@/hooks/useDxfUnderlay';
import { useScanSectionLayer } from '@/hooks/useScanSectionLayer';
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key';
import { SaveMarkupToModelButton, SaveMarkupToModelMenuItem } from './SaveMarkupToModelButton';
import { useTranslation } from '@/i18n';
import { useDrawingRuntime } from '@/lib/drawing/drawing-runtime';

/** The drawing's view: the `drawing` workspace panel (#5493), docked in the
 *  bottom strip, floating, or popped out; it fills whatever region hosts it.
 *  Its runtime (generation, persistence, the Section-tool auto-open) lives in
 *  `DrawingRuntimeHost` and runs whether or not this is mounted (#5492). */
export function Section2DPanel({ onClose }: { onClose?: () => void } = {}): React.ReactElement {
  const { t } = useTranslation();
  const { geometryResult, sourceCoordinateInfo, generateDrawing, isRegenerating } = useDrawingRuntime();

  // ═══════════════════════════════════════════════════════════════════════════
  // STORE SELECTORS
  // ═══════════════════════════════════════════════════════════════════════════
  const setDrawingPanelVisible = useViewerStore((s) => s.setDrawing2DPanelVisible);
  const sourceDrawing = useViewerStore((s) => s.drawing2D);
  const { drawing, hasReferences } = useDrawingWithReferences(sourceDrawing);
  const setDrawing = useViewerStore((s) => s.setDrawing2D);
  const status = useViewerStore((s) => s.drawing2DStatus);
  const setDrawingStatus = useViewerStore((s) => s.setDrawing2DStatus);
  const progress = useViewerStore((s) => s.drawing2DProgress);
  const progressPhase = useViewerStore((s) => s.drawing2DPhase);
  const drawingError = useViewerStore((s) => s.drawing2DError);
  const displayOptions = useViewerStore((s) => s.drawing2DDisplayOptions);
  const updateDisplayOptions = useViewerStore((s) => s.updateDrawing2DDisplayOptions);
  // LENGTHUNIT display override for the on-canvas measure distance/perimeter
  // labels (#2199 slice not covered by #2538 — see Drawing2DCanvas.tsx).
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  // Class-level Visibility toggles — the section honours them like the 3D
  // viewport does, so a hidden IfcSpace/IfcOpeningElement is not cut (#2060).
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  // Graphic overrides
  const activePresetId = useViewerStore((s) => s.activePresetId);
  const overridesEnabled = useViewerStore((s) => s.overridesEnabled);
  const getActiveOverrideRules = useViewerStore((s) => s.getActiveOverrideRules);
  const customOverrideRules = useViewerStore((s) => s.customOverrideRules);

  // Settings panel visibility
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);

  // DXF underlay state (issue #1782)
  const dxfUnderlays = useViewerStore((s) => s.dxfUnderlays);
  const updateDxfUnderlayPlacement = useViewerStore((s) => s.updateDxfUnderlayPlacement);
  const [dxfPanelOpen, setDxfPanelOpen] = useState(false);

  // Point-cloud scan overlay (issue #1805)
  const pointCloudClassMask = useViewerStore((s) => s.pointCloudClassMask);
  const [scanPanelOpen, setScanPanelOpen] = useState(false);

  // Sheet state
  const activeSheet = useViewerStore((s) => s.activeSheet);
  const sheetEnabled = useViewerStore((s) => s.sheetEnabled);
  const sheetPanelVisible = useViewerStore((s) => s.sheetPanelVisible);
  const setSheetPanelVisible = useViewerStore((s) => s.setSheetPanelVisible);
  const titleBlockEditorVisible = useViewerStore((s) => s.titleBlockEditorVisible);
  const setTitleBlockEditorVisible = useViewerStore((s) => s.setTitleBlockEditorVisible);

  // 2D Measure tool state
  const measure2DMode = useViewerStore((s) => s.measure2DMode);
  const measure2DStart = useViewerStore((s) => s.measure2DStart);
  const measure2DCurrent = useViewerStore((s) => s.measure2DCurrent);
  const setMeasure2DStart = useViewerStore((s) => s.setMeasure2DStart);
  const setMeasure2DCurrent = useViewerStore((s) => s.setMeasure2DCurrent);
  const setMeasure2DShiftLocked = useViewerStore((s) => s.setMeasure2DShiftLocked);
  const measure2DShiftLocked = useViewerStore((s) => s.measure2DShiftLocked);
  const measure2DLockedAxis = useViewerStore((s) => s.measure2DLockedAxis);
  const measure2DResults = useViewerStore((s) => s.measure2DResults);
  const completeMeasure2D = useViewerStore((s) => s.completeMeasure2D);
  const cancelMeasure2D = useViewerStore((s) => s.cancelMeasure2D);
  const measure2DSnapPoint = useViewerStore((s) => s.measure2DSnapPoint);
  const setMeasure2DSnapPoint = useViewerStore((s) => s.setMeasure2DSnapPoint);

  // Annotation tool state
  const annotation2DActiveTool = useViewerStore((s) => s.annotation2DActiveTool);
  const setAnnotation2DActiveTool = useViewerStore((s) => s.setAnnotation2DActiveTool);
  const annotation2DCursorPos = useViewerStore((s) => s.annotation2DCursorPos);
  const setAnnotation2DCursorPos = useViewerStore((s) => s.setAnnotation2DCursorPos);
  // Polygon area state
  const polygonArea2DPoints = useViewerStore((s) => s.polygonArea2DPoints);
  const polygonArea2DResults = useViewerStore((s) => s.polygonArea2DResults);
  const addPolygonArea2DPoint = useViewerStore((s) => s.addPolygonArea2DPoint);
  const completePolygonArea2D = useViewerStore((s) => s.completePolygonArea2D);
  const cancelPolygonArea2D = useViewerStore((s) => s.cancelPolygonArea2D);
  // Text annotation state
  const textAnnotations2D = useViewerStore((s) => s.textAnnotations2D);
  const textAnnotation2DEditing = useViewerStore((s) => s.textAnnotation2DEditing);
  const addTextAnnotation2D = useViewerStore((s) => s.addTextAnnotation2D);
  const updateTextAnnotation2D = useViewerStore((s) => s.updateTextAnnotation2D);
  const removeTextAnnotation2D = useViewerStore((s) => s.removeTextAnnotation2D);
  const setTextAnnotation2DEditing = useViewerStore((s) => s.setTextAnnotation2DEditing);
  // Cloud annotation state
  const cloudAnnotation2DPoints = useViewerStore((s) => s.cloudAnnotation2DPoints);
  const cloudAnnotations2D = useViewerStore((s) => s.cloudAnnotations2D);
  const addCloudAnnotation2DPoint = useViewerStore((s) => s.addCloudAnnotation2DPoint);
  const completeCloudAnnotation2D = useViewerStore((s) => s.completeCloudAnnotation2D);
  const cancelCloudAnnotation2D = useViewerStore((s) => s.cancelCloudAnnotation2D);
  // Selection
  const selectedAnnotation2D = useViewerStore((s) => s.selectedAnnotation2D);
  const setSelectedAnnotation2D = useViewerStore((s) => s.setSelectedAnnotation2D);
  const deleteSelectedAnnotation2D = useViewerStore((s) => s.deleteSelectedAnnotation2D);
  const moveAnnotation2D = useViewerStore((s) => s.moveAnnotation2D);
  // Bulk
  const clearAllAnnotations2D = useViewerStore((s) => s.clearAllAnnotations2D);

  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const models = useViewerStore((s) => s.models);
  const { ifcDataStore } = useIfc();

  // ═══════════════════════════════════════════════════════════════════════════
  // LOCAL STATE
  // ═══════════════════════════════════════════════════════════════════════════
  const [isNarrow, setIsNarrow] = useState(false);  // Too narrow for every header button
  const [isPinned, setIsPinned] = useState(true);  // Default ON: keep position on regenerate
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Cache sheet drawing transform when pinned (to keep model fixed in place)
  const cachedSheetTransformRef = useRef<CachedSheetTransform | null>(null);

  // The host (bottom strip, floating window, pop-out, mobile sheet) owns the
  // size, so the header collapses on the width it actually gets.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(([entry]) => setIsNarrow(entry.contentRect.width < 480));
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  // Create graphic override engine with active rules
  const overrideEngine = useMemo(() => {
    const rules = getActiveOverrideRules();
    return new GraphicOverrideEngine(rules);
  }, [getActiveOverrideRules, activePresetId, customOverrideRules, overridesEnabled]);

  // Build entity color map from mesh material colors (for "Use IFC Materials" mode)
  const entityColorMap = useMemo(() => {
    const map = new Map<number, [number, number, number, number]>();
    if (geometryResult?.meshes) {
      for (const mesh of geometryResult.meshes) {
        if (mesh.expressId && mesh.color) {
          map.set(mesh.expressId, mesh.color);
        }
      }
    }
    return map;
  }, [geometryResult]);

  const { viewTransform, setViewTransform, zoomIn, zoomOut, fitToView } = useViewControls({
    drawing, sectionPlane, containerRef,
    // Mounted means on screen: the host only renders this view while it shows.
    panelVisible: true, status, sheetEnabled, activeSheet,
    isPinned, cachedSheetTransformRef,
  });

  const measureHandlers = useMeasure2D({
    drawing, viewTransform, setViewTransform, sectionAxis: sectionPlane.axis, containerRef,
    measure2DMode, measure2DStart, measure2DCurrent,
    measure2DShiftLocked, measure2DLockedAxis,
    setMeasure2DStart, setMeasure2DCurrent, setMeasure2DShiftLocked,
    setMeasure2DSnapPoint, cancelMeasure2D, completeMeasure2D,
  });

  // ─── IFC annotation overlay (issue #812) ──────────────────────────────────
  // Re-derive the section's world-coord cut position from the same bounds
  // useDrawingGeneration uses, so the annotation filter stays in lockstep
  // with the cut. Empty/missing bounds collapse to an inert range → hook
  // returns empty, the overlay simply does nothing.
  const ifcAnnotationsForDrawing = useMemo(() => drawingAnnotationFrame(
    geometryResult?.coordinateInfo, sourceCoordinateInfo, sectionPlane,
  ), [geometryResult, sourceCoordinateInfo, sectionPlane]);

  const ifcAnnotationData = useSymbolicAnnotationsForDrawing({
    enabled: symbolicAnnotationsOverlayEnabled(displayOptions.showIfcAnnotations, status, typeVisibility.ifcAnnotations),
    axis: sectionPlane.axis,
    sectionPosWorld: ifcAnnotationsForDrawing.sectionPosWorld,
    viewDepth: ifcAnnotationsForDrawing.viewDepth,
    flipped: sectionPlane.flipped,
    fallbackY: ifcAnnotationsForDrawing.fallbackY,
  });

  const toggleIfcAnnotations = useCallback(() => {
    updateDisplayOptions({ showIfcAnnotations: !displayOptions.showIfcAnnotations });
  }, [displayOptions.showIfcAnnotations, updateDisplayOptions]);

  // Construction projection (issue #979): toggling changes which geometry the
  // generator emits, so clear the current drawing to force a regenerate —
  // same pattern as the symbolic/section-cut toggle.
  const toggleConstructionProjection = useCallback(() => {
    updateDisplayOptions({ showConstructionProjection: !displayOptions.showConstructionProjection });
    setDrawing(null);
    setDrawingStatus('idle');
  }, [displayOptions.showConstructionProjection, updateDisplayOptions, setDrawing, setDrawingStatus]);

  const annotationHandlers = useAnnotation2D({
    drawing, viewTransform, sectionAxis: sectionPlane.axis, containerRef,
    activeTool: annotation2DActiveTool, setActiveTool: setAnnotation2DActiveTool,
    polygonArea2DPoints, addPolygonArea2DPoint, completePolygonArea2D, cancelPolygonArea2D,
    textAnnotations2D, addTextAnnotation2D, setTextAnnotation2DEditing,
    cloudAnnotation2DPoints, cloudAnnotations2D, addCloudAnnotation2DPoint, completeCloudAnnotation2D, cancelCloudAnnotation2D,
    measure2DResults, polygonArea2DResults,
    selectedAnnotation2D, setSelectedAnnotation2D, deleteSelectedAnnotation2D, moveAnnotation2D,
    setAnnotation2DCursorPos, setMeasure2DSnapPoint,
  });

  // Unified mouse handlers that dispatch to the right tool
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (annotation2DActiveTool === 'measure') {
      measureHandlers.handleMouseDown(e);
    } else if (annotation2DActiveTool === 'none') {
      // Try annotation selection/drag first; if it consumed the click, don't pan
      const consumed = annotationHandlers.handleMouseDown(e);
      if (!consumed) {
        measureHandlers.handleMouseDown(e);
      }
    } else {
      annotationHandlers.handleMouseDown(e);
    }
  }, [annotation2DActiveTool, measureHandlers, annotationHandlers]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // If dragging an annotation, let the annotation handler handle it
    if (annotationHandlers.isDraggingRef.current) {
      annotationHandlers.handleMouseMove(e);
      return;
    }
    if (annotation2DActiveTool === 'measure' || annotation2DActiveTool === 'none') {
      measureHandlers.handleMouseMove(e);
    } else {
      annotationHandlers.handleMouseMove(e);
    }
  }, [annotation2DActiveTool, measureHandlers, annotationHandlers]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    annotationHandlers.handleMouseUp(e);
    measureHandlers.handleMouseUp();
  }, [measureHandlers, annotationHandlers]);

  const handleMouseLeave = useCallback(() => {
    measureHandlers.handleMouseLeave();
  }, [measureHandlers]);

  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    measureHandlers.handleMouseEnter(e);
  }, [measureHandlers]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    annotationHandlers.handleDoubleClick(e);
  }, [annotationHandlers]);

  // DXF reference underlays mapped to drawing space (issue #1782): the hook
  // applies the render-frame origin shift, the flipped-section mirror, and
  // each underlay's placement. Plan sections only.
  const dxfUnderlayData = useDxfUnderlaysForDrawing({
    enabled: status === 'ready',
    sectionAxis: sectionPlane.axis,
    isCustomPlane: sectionPlane.custom !== undefined,
    flipped: sectionPlane.flipped,
    coordinateInfo: geometryResult?.coordinateInfo,
  });

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
    const underlayBounds = dxfUnderlayDrawingBounds(entry, shift, mirrorX, dxfMapToWorld, dxfGeoreferenceAvailable);
    if (!underlayBounds) {
      // PR #1965 review: this guard fires when the underlay has no usable
      // bounds AT ALL (missing extents) OR the georeference produced a
      // non-finite corner (`dxfUnderlayDrawingBounds` collapses both into
      // `null` — see its docstring). Either way the button used to do
      // nothing with no explanation; tell the user so a malformed
      // `IfcMapConversion` doesn't read as an unresponsive button.
      toast.error(t('section2d.underlay.missingBounds'));
      return;
    }
    const modelCx = (drawing.bounds.min.x + drawing.bounds.max.x) / 2;
    const modelCy = (drawing.bounds.min.y + drawing.bounds.max.y) / 2;
    const underlayCx = (underlayBounds.min.x + underlayBounds.max.x) / 2;
    const underlayCy = (underlayBounds.min.y + underlayBounds.max.y) / 2;
    const offsetX = modelCx - underlayCx;
    const offsetY = modelCy - underlayCy;
    // Defense-in-depth (PR #1965 review): `dxfUnderlayDrawingBounds`
    // already returns null on a non-finite bound (so `underlayBounds`
    // above would have short-circuited), but guard the DERIVED offset too
    // — `drawing.bounds` comes from the generated drawing, not the
    // underlay, and a NaN here would otherwise still get written into the
    // stored placement, which survives toggling georeferencing back off.
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
      toast.error(t('section2d.underlay.nonFiniteDrawing'));
      return;
    }
    updateDxfUnderlayPlacement(id, { offsetX, offsetY });
  }, [dxfUnderlays, drawing, geometryResult, sectionPlane.flipped, sectionPlane.custom, updateDxfUnderlayPlacement, dxfMapToWorld, dxfGeoreferenceAvailable, t]);

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
    drawing, displayOptions, sectionPlane, activePresetId,
    entityColorMap, overridesEnabled, overrideEngine,
    measure2DResults, polygonArea2DResults, textAnnotations2D, cloudAnnotations2D,
    sheetEnabled, activeSheet, dxfUnderlays: dxfUnderlayData,
    ifcDataStore, coordinateInfo: geometryResult?.coordinateInfo,
    scanSection: scanSectionLayer,
    // Pin View state and the preview's transform cache: without these the
    // print/export path recomputed the sheet placement from the CURRENT
    // bounds while a pinned preview kept the held one, so a regenerate at a
    // new elevation printed a different layout from the one on screen. Pin
    // View defaults ON, so this was the default path. The hook only READS
    // the ref — the preview canvas owns the write.
    isPinned, cachedSheetTransformRef,
  });

  // Scale prompt for the scaled PDF export (issue #2042). A proper
  // scale-selector dropdown (presets + custom input, matching the issue's
  // exact wording) is a follow-up; this is the "smallest useful version"
  // — it still gives every requested scale (defaults to "as displayed",
  // accepts any of the common presets or a fully custom denominator) and
  // never guesses silently. `window.prompt` matches this hook's existing
  // `alert`-based error surface (no toast wiring here); see useDrawingExport.
  const handleExportPdfPrompt = useCallback(() => {
    const presetHint = COMMON_SCALES.map((s) => s.name).join(', ');
    const asDisplayed = displayOptions.scale || 100;
    const input = window.prompt(
      t('section2d.pdf.prompt', { scale: asDisplayed, presets: presetHint }),
      String(asDisplayed)
    );
    if (input === null) return; // cancelled
    const trimmed = input.trim();
    if (trimmed === '') {
      handleExportPDF();
      return;
    }
    const n = Number(trimmed.replace(/^1:/, ''));
    if (!Number.isFinite(n) || n <= 0) {
      window.alert(t('section2d.pdf.invalid', { input }));
      return;
    }
    handleExportPDF(n);
  }, [displayOptions.scale, handleExportPDF, t]);

  // ═══════════════════════════════════════════════════════════════════════════
  // CALLBACKS
  // ═══════════════════════════════════════════════════════════════════════════

  // The host's close also drops a floating / popped-out drawing, not just the dock flag.
  const handleClose = useCallback(() => {
    if (onClose) onClose();
    else setDrawingPanelVisible(false);
  }, [onClose, setDrawingPanelVisible]);

  // Toggle options
  const toggle3DOverlay = useCallback(() => {
    updateDisplayOptions({ show3DOverlay: !displayOptions.show3DOverlay });
  }, [displayOptions.show3DOverlay, updateDisplayOptions]);

  const toggleSymbolicRepresentations = useCallback(() => {
    updateDisplayOptions({ useSymbolicRepresentations: !displayOptions.useSymbolicRepresentations });
    // Clear current drawing to trigger regeneration with new mode
    setDrawing(null);
    setDrawingStatus('idle');
  }, [displayOptions.useSymbolicRepresentations, updateDisplayOptions, setDrawing, setDrawingStatus]);

  const togglePinned = useCallback(() => {
    setIsPinned((prev) => !prev);
  }, []);

  // Text editor handlers
  const handleTextConfirm = useCallback((id: string, text: string) => {
    updateTextAnnotation2D(id, { text });
    setTextAnnotation2DEditing(null);
  }, [updateTextAnnotation2D, setTextAnnotation2DEditing]);

  const handleTextCancel = useCallback((id: string) => {
    // If text is empty (just created), remove it
    const annotation = textAnnotations2D.find((a) => a.id === id);
    if (annotation && !annotation.text.trim()) {
      removeTextAnnotation2D(id);
    }
    setTextAnnotation2DEditing(null);
  }, [textAnnotations2D, removeTextAnnotation2D, setTextAnnotation2DEditing]);

  // Check if any annotations exist
  const hasAnnotations = measure2DResults.length > 0 ||
    polygonArea2DResults.length > 0 ||
    textAnnotations2D.length > 0 ||
    cloudAnnotations2D.length > 0;

  // Cursor style based on active tool
  const cursorClass = useMemo(() => {
    if (selectedAnnotation2D && annotation2DActiveTool === 'none') return 'cursor-move';
    switch (annotation2DActiveTool) {
      case 'measure':
      case 'polygon-area':
      case 'cloud':
        return 'cursor-crosshair';
      case 'text':
        return 'cursor-text';
      default:
        return 'cursor-grab active:cursor-grabbing';
    }
  }, [annotation2DActiveTool, selectedAnnotation2D]);

  // ═══════════════════════════════════════════════════════════════════════════
  // MEMOIZED STYLES
  // ═══════════════════════════════════════════════════════════════════════════

  // Memoize progress bar style
  const progressBarStyle = useMemo(() => ({ width: `${progress}%` }), [progress]);

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div ref={panelRef} className="relative h-full w-full bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/50 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <h2 className="font-semibold text-xs shrink-0">{t('section2d.heading')}</h2>
        </div>

        <div className="flex items-center gap-1 min-w-0">
          {/* When panel is wide enough, show all buttons */}
          {!isNarrow && (
            <>
              {/* Display toggles */}
              <Button
                variant={displayOptions.show3DOverlay ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={toggle3DOverlay}
                title={t('section2d.overlay.toggleTitle')}
              >
                {displayOptions.show3DOverlay ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>

              {/* Symbolic vs Section Cut toggle */}
              <Button
                variant={displayOptions.useSymbolicRepresentations ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={toggleSymbolicRepresentations}
                title={displayOptions.useSymbolicRepresentations ? t('section2d.symbolic.planTitle') : t('section2d.symbolic.cutTitle')}
              >
                {displayOptions.useSymbolicRepresentations ? <Shapes className="h-4 w-4" /> : <Box className="h-4 w-4" />}
              </Button>

              {/* IFC Annotations overlay toggle (issue #812) */}
              <Button
                variant={displayOptions.showIfcAnnotations ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={toggleIfcAnnotations}
                title={displayOptions.showIfcAnnotations ? t('section2d.ifcAnnotations.hideTitle') : t('section2d.ifcAnnotations.showTitle')}
                disabled={sectionPlane.axis !== 'down'}
              >
                <Tag className="h-4 w-4" />
              </Button>

              {/* Construction projection toggle (issue #979) — cardinal cuts only */}
              <Button
                variant={displayOptions.showConstructionProjection ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={toggleConstructionProjection}
                title={
                  displayOptions.showConstructionProjection
                    ? t('section2d.construction.hideTitle')
                    : t('section2d.construction.showTitle')
                }
                disabled={sectionPlane.custom !== undefined}
              >
                <BoxSelect className="h-4 w-4" />
              </Button>

              {/* Annotation Tools Dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant={annotation2DActiveTool !== 'none' ? 'default' : 'ghost'}
                    size="icon-sm"
                    title={t('section2d.annotations.title')}
                  >
                    <PenTool className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool('none')}>
                    <MousePointer2 className="h-4 w-4 mr-2" />
                    {annotation2DActiveTool === 'none' ? t('section2d.annotations.selectActive') : t('section2d.annotations.select')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'measure' ? 'none' : 'measure')}>
                    <Ruler className="h-4 w-4 mr-2" />
                    {annotation2DActiveTool === 'measure' ? t('section2d.annotations.distanceActive') : t('section2d.annotations.distance')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'polygon-area' ? 'none' : 'polygon-area')}>
                    <Hexagon className="h-4 w-4 mr-2" />
                    {annotation2DActiveTool === 'polygon-area' ? t('section2d.annotations.areaActive') : t('section2d.annotations.area')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'text' ? 'none' : 'text')}>
                    <Type className="h-4 w-4 mr-2" />
                    {annotation2DActiveTool === 'text' ? t('section2d.annotations.textActive') : t('section2d.annotations.text')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'cloud' ? 'none' : 'cloud')}>
                    <Cloud className="h-4 w-4 mr-2" />
                    {annotation2DActiveTool === 'cloud' ? t('section2d.annotations.cloudActive') : t('section2d.annotations.cloud')}
                  </DropdownMenuItem>
                  {hasAnnotations && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={clearAllAnnotations2D}>
                        <Trash2 className="h-4 w-4 mr-2" />
                        {t('section2d.annotations.clear')}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Graphic Override Settings */}
              <Button
                variant={settingsPanelOpen || activePresetId ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={() => {
                  // The right-side slide-in panels share one slot.
                  setSettingsPanelOpen((prev) => {
                    if (!prev) {
                      setDxfPanelOpen(false);
                      setScanPanelOpen(false);
                    }
                    return !prev;
                  });
                }}
                title={t('section2d.settings.title')}
                className="relative"
              >
                <Palette className="h-4 w-4" />
                {activePresetId && !settingsPanelOpen && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-primary rounded-full" />
                )}
              </Button>

              {/* Drawing Sheet Setup */}
              <Button
                variant={sheetPanelVisible || sheetEnabled ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={() => {
                  // The right-side slide-in panels share one slot.
                  if (!sheetPanelVisible) {
                    setDxfPanelOpen(false);
                    setScanPanelOpen(false);
                  }
                  setSheetPanelVisible(!sheetPanelVisible);
                }}
                title={t('section2d.sheet.title')}
                className="relative"
              >
                <FileText className="h-4 w-4" />
                {sheetEnabled && !sheetPanelVisible && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-primary rounded-full" />
                )}
              </Button>

              {/* DXF underlays (issue #1782) */}
              <Button
                variant={dxfPanelOpen ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={() => {
                  // The right-side slide-in panels share one slot.
                  setDxfPanelOpen((prev) => {
                    if (!prev) {
                      setSheetPanelVisible(false);
                      setSettingsPanelOpen(false);
                      setScanPanelOpen(false);
                    }
                    return !prev;
                  });
                }}
                title={t('section2d.dxf.title')}
                className="relative"
              >
                <Layers className="h-4 w-4" />
                {dxfUnderlays.length > 0 && !dxfPanelOpen && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-primary rounded-full" />
                )}
              </Button>

              {/* Point-cloud scan overlay (issue #1805) */}
              <Button
                variant={scanPanelOpen || displayOptions.showScanSection ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={() => {
                  // The right-side slide-in panels share one slot.
                  setScanPanelOpen((prev) => {
                    if (!prev) {
                      setSheetPanelVisible(false);
                      setSettingsPanelOpen(false);
                      setDxfPanelOpen(false);
                    }
                    return !prev;
                  });
                }}
                title={t('section2d.scan.title')}
                className="relative"
              >
                <ScanLine className="h-4 w-4" />
                {scanSectionLayer.hasPointCloud && displayOptions.showScanSection && !scanPanelOpen && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-primary rounded-full" />
                )}
              </Button>

              <div className="w-px h-4 bg-border mx-1" />

              {/* Zoom controls */}
              <Button variant="ghost" size="icon-sm" onClick={zoomOut} title={t('section2d.zoom.out')}>
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="text-xs font-mono w-10 text-center">
                {Math.round(viewTransform.scale * 100)}%
              </span>
              <Button variant="ghost" size="icon-sm" onClick={zoomIn} title={t('section2d.zoom.in')}>
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={fitToView} title={t('section2d.zoom.fit')}>
                <Maximize2 className="h-4 w-4" />
              </Button>
              <Button
                variant={isPinned ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={togglePinned}
                title={isPinned ? t('section2d.pin.unpinTitle') : t('section2d.pin.pinTitle')}
              >
                {isPinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
              </Button>

              <div className="w-px h-4 bg-border mx-1" />

              {/* Export/Print */}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleExportSVG}
                disabled={!drawing}
                title={t('section2d.export.svg')}
              >
                <Download className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleExportDXF}
                disabled={!drawing}
                title={t('section2d.export.dxf')}
              >
                <FileDown className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleExportPdfPrompt}
                disabled={!drawing}
                title={t('section2d.export.pdf')}
              >
                <FileText className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handlePrint}
                disabled={!drawing}
                title={t('section2d.export.print')}
              >
                <Printer className="h-4 w-4" />
              </Button>
              <SaveMarkupToModelButton />

              <div className="w-px h-4 bg-border mx-1" />

              {/* Regenerate */}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => generateDrawing(false)}
                disabled={status === 'generating'}
                title={t('section2d.regenerate')}
              >
                {status === 'generating' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </>
          )}

          {/* When narrow, show minimal controls + dropdown menu */}
          {isNarrow && (
            <>
              {/* Essential zoom controls */}
              <Button variant="ghost" size="icon-sm" onClick={fitToView} title={t('section2d.zoom.fit')}>
                <Maximize2 className="h-4 w-4" />
              </Button>

              {/* Overflow menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" title={t('section2d.more')}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={toggle3DOverlay}>
                    {displayOptions.show3DOverlay ? <Eye className="h-4 w-4 mr-2" /> : <EyeOff className="h-4 w-4 mr-2" />}
                    {displayOptions.show3DOverlay ? t('section2d.menu.overlayOn') : t('section2d.menu.overlayOff')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleSymbolicRepresentations}>
                    {displayOptions.useSymbolicRepresentations ? <Shapes className="h-4 w-4 mr-2" /> : <Box className="h-4 w-4 mr-2" />}
                    {displayOptions.useSymbolicRepresentations ? t('section2d.menu.symbolicPlan') : t('section2d.menu.sectionCut')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleIfcAnnotations} disabled={sectionPlane.axis !== 'down'}>
                    <Tag className="h-4 w-4 mr-2" />
                    {displayOptions.showIfcAnnotations ? t('section2d.menu.ifcAnnotationsOn') : t('section2d.menu.ifcAnnotationsOff')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={toggleConstructionProjection}
                    disabled={sectionPlane.custom !== undefined}
                  >
                    <BoxSelect className="h-4 w-4 mr-2" />
                    {displayOptions.showConstructionProjection ? t('section2d.menu.constructionOn') : t('section2d.menu.constructionOff')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool('none')}>
                    <MousePointer2 className="h-4 w-4 mr-2" />
                    {annotation2DActiveTool === 'none' ? t('section2d.annotations.selectActive') : t('section2d.annotations.select')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'measure' ? 'none' : 'measure')}>
                    <Ruler className="h-4 w-4 mr-2" />
                    {annotation2DActiveTool === 'measure' ? t('section2d.annotations.distanceActive') : t('section2d.annotations.distance')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'polygon-area' ? 'none' : 'polygon-area')}>
                    <Hexagon className="h-4 w-4 mr-2" />
                    {annotation2DActiveTool === 'polygon-area' ? t('section2d.annotations.areaActive') : t('section2d.annotations.area')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'text' ? 'none' : 'text')}>
                    <Type className="h-4 w-4 mr-2" />
                    {annotation2DActiveTool === 'text' ? t('section2d.annotations.textActive') : t('section2d.annotations.text')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'cloud' ? 'none' : 'cloud')}>
                    <Cloud className="h-4 w-4 mr-2" />
                    {annotation2DActiveTool === 'cloud' ? t('section2d.annotations.cloudActive') : t('section2d.annotations.cloud')}
                  </DropdownMenuItem>
                  {hasAnnotations && (
                    <DropdownMenuItem onClick={clearAllAnnotations2D}>
                      <Trash2 className="h-4 w-4 mr-2" />
                      {t('section2d.annotations.clear')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => { setDxfPanelOpen(false); setSettingsPanelOpen(true); }}>
                    <Palette className="h-4 w-4 mr-2" />
                    {t('section2d.menu.settings')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setDxfPanelOpen(false); setSheetPanelVisible(true); }}>
                    <FileText className="h-4 w-4 mr-2" />
                    {sheetEnabled ? t('section2d.menu.sheetOn') : t('section2d.menu.sheetOff')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setSettingsPanelOpen(false); setSheetPanelVisible(false); setScanPanelOpen(false); setDxfPanelOpen(true); }}>
                    <Layers className="h-4 w-4 mr-2" />
                    {dxfUnderlays.length > 0 ? t('section2d.menu.dxfCount', { count: dxfUnderlays.length }) : t('section2d.menu.dxf')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setSettingsPanelOpen(false); setSheetPanelVisible(false); setDxfPanelOpen(false); setScanPanelOpen(true); }}>
                    <ScanLine className="h-4 w-4 mr-2" />
                    {displayOptions.showScanSection ? t('section2d.menu.scanOn') : t('section2d.menu.scanOff')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={zoomIn}>
                    <ZoomIn className="h-4 w-4 mr-2" />
                    {t('section2d.zoom.in')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={zoomOut}>
                    <ZoomOut className="h-4 w-4 mr-2" />
                    {t('section2d.zoom.out')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={togglePinned}>
                    {isPinned ? <Pin className="h-4 w-4 mr-2" /> : <PinOff className="h-4 w-4 mr-2" />}
                    {isPinned ? t('section2d.menu.pinOn') : t('section2d.menu.pinOff')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleExportSVG} disabled={!drawing}>
                    <Download className="h-4 w-4 mr-2" />
                    {t('section2d.export.svg')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportDXF} disabled={!drawing}>
                    <FileDown className="h-4 w-4 mr-2" />
                    {t('section2d.export.dxf')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportPdfPrompt} disabled={!drawing}>
                    <FileText className="h-4 w-4 mr-2" />
                    {t('section2d.export.pdf')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handlePrint} disabled={!drawing}>
                    <Printer className="h-4 w-4 mr-2" />
                    {t('section2d.export.print')}
                  </DropdownMenuItem>
                  <SaveMarkupToModelMenuItem />
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => generateDrawing(false)} disabled={status === 'generating'}>
                    {status === 'generating' ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    {t('section2d.regenerate')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {/* Close button always visible */}
          <Button variant="ghost" size="icon-sm" onClick={handleClose} title={t('section2d.close')}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Drawing Canvas */}
      <div
        ref={containerRef}
        className={`relative flex-1 overflow-hidden bg-white dark:bg-zinc-950 ${cursorClass}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={handleDoubleClick}
      >
        {status === 'generating' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80">
            <Loader2 className="h-8 w-8 animate-spin mb-4 text-primary" />
            <div className="text-sm font-medium">{progressPhase}</div>
            <div className="w-48 h-2 bg-muted rounded-full mt-2 overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-200"
                style={progressBarStyle}
              />
            </div>
            <div className="text-xs text-muted-foreground mt-1">{Math.round(progress)}%</div>
          </div>
        )}

        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-destructive text-center">
              <p className="font-medium">{t('section2d.error.generation')}</p>
              <p className="text-sm text-muted-foreground">
                {drawingError}
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => generateDrawing(false)}>
                {t('section2d.error.retry')}
              </Button>
            </div>
          </div>
        )}

        {status === 'ready' && drawing && (drawing.cutPolygons.length > 0 || drawing.lines?.length > 0 || dxfUnderlayData.length > 0 || hasReferences) && (
          <>
            <Drawing2DCanvas
              drawing={drawing}
              snapshotSourceDrawing={sourceDrawing ?? drawing}
              transform={viewTransform}
              showHiddenLines={displayOptions.showHiddenLines}
              overrideEngine={overrideEngine}
              overridesEnabled={overridesEnabled}
              entityColorMap={entityColorMap}
              useIfcMaterials={activePresetId === 'preset-3d-colors'}
              measureMode={measure2DMode}
              measureStart={measure2DStart}
              measureCurrent={measure2DCurrent}
              measureResults={measure2DResults}
              measureSnapPoint={measure2DSnapPoint}
              sheetEnabled={sheetEnabled}
              activeSheet={activeSheet}
              sectionAxis={sectionPlane.axis}
              isPinned={isPinned}
              cachedSheetTransformRef={cachedSheetTransformRef}
              annotation2DActiveTool={annotation2DActiveTool}
              annotation2DCursorPos={annotation2DCursorPos}
              polygonAreaPoints={polygonArea2DPoints}
              polygonAreaResults={polygonArea2DResults}
              textAnnotations={textAnnotations2D}
              textAnnotationEditing={textAnnotation2DEditing}
              cloudAnnotationPoints={cloudAnnotation2DPoints}
              cloudAnnotations={cloudAnnotations2D}
              selectedAnnotation={selectedAnnotation2D}
              ifcAnnotationLines={ifcAnnotationData.lines}
              ifcAnnotationTexts={ifcAnnotationData.texts}
              ifcAnnotationFills={ifcAnnotationData.fills}
              dxfUnderlays={dxfUnderlayData}
              scanPoints={displayOptions.showScanSection ? scanSectionLayer.points : undefined}
              scanOpacity={displayOptions.scanSectionOpacity}
              unitDisplayOverrides={unitDisplayOverrides}
            />
            {/* Subtle updating indicator - shows while regenerating without hiding the drawing */}
            {isRegenerating && (
              <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-background/80 backdrop-blur-sm px-2 py-1 rounded text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>{t('section2d.updating')}</span>
              </div>
            )}
          </>
        )}

        {/* Text Annotation Editor Overlay */}
        {textAnnotation2DEditing && (() => {
          const editingAnnotation = textAnnotations2D.find((a) => a.id === textAnnotation2DEditing);
          if (!editingAnnotation) return null;
          const scaleX = sectionPlane.axis === 'side' ? -viewTransform.scale : viewTransform.scale;
          const scaleY = sectionPlane.axis === 'down' ? viewTransform.scale : -viewTransform.scale;
          const screenX = editingAnnotation.position.x * scaleX + viewTransform.x;
          const screenY = editingAnnotation.position.y * scaleY + viewTransform.y;
          return (
            <TextAnnotationEditor
              annotation={editingAnnotation}
              screenX={screenX}
              screenY={screenY}
              onConfirm={handleTextConfirm}
              onCancel={handleTextCancel}
            />
          );
        })()}

        {/* Measure mode tip - bottom right */}
        {measure2DMode && measure2DStart && (
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <div className={`text-[10px] font-mono font-semibold ${measure2DShiftLocked ? 'text-primary' : 'text-black'}`}>
              {t('section2d.tip.shift')}
            </div>
          </div>
        )}

        {/* Polygon area tip */}
        {annotation2DActiveTool === 'polygon-area' && (
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <div className="text-[10px] text-black bg-white/80 px-1.5 py-0.5 rounded">
              {polygonArea2DPoints.length === 0 ? t('section2d.tip.polygonFirst') :
               polygonArea2DPoints.length < 3 ? t('section2d.tip.polygonNeed', { count: polygonArea2DPoints.length }) :
               t('section2d.tip.polygonClose')}
            </div>
          </div>
        )}

        {/* Cloud tool tip */}
        {annotation2DActiveTool === 'cloud' && (
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <div className="text-[10px] text-black bg-white/80 px-1.5 py-0.5 rounded">
              {cloudAnnotation2DPoints.length === 0 ? t('section2d.tip.cloudFirst') : t('section2d.tip.cloudSecond')}
            </div>
          </div>
        )}

        {/* Text tool tip */}
        {annotation2DActiveTool === 'text' && !textAnnotation2DEditing && (
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <div className="text-[10px] text-black bg-white/80 px-1.5 py-0.5 rounded">
              {t('section2d.tip.text')}
            </div>
          </div>
        )}

        {/* Selection tip */}
        {selectedAnnotation2D && annotation2DActiveTool === 'none' && (
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <div className="text-[10px] text-black bg-white/80 px-1.5 py-0.5 rounded">
              {selectedAnnotation2D.type === 'text' ? t('section2d.tip.selectionText') : t('section2d.tip.selectionOther')}
            </div>
          </div>
        )}

        {status === 'ready' && drawing && drawing.cutPolygons.length === 0 && (!drawing.lines || drawing.lines.length === 0) && dxfUnderlayData.length === 0 && !hasReferences && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <p className="font-medium">{t('section2d.empty.title')}</p>
              <p className="text-sm mt-1">{t('section2d.empty.description')}</p>
            </div>
          </div>
        )}

        {/* Empty state - just show blank canvas, no message */}
      </div>

      {/* Settings Panel - slides in from right */}
      {settingsPanelOpen && (
        <div className="absolute top-0 right-0 bottom-0 w-72 z-50 shadow-xl">
          <DrawingSettingsPanel onClose={() => setSettingsPanelOpen(false)} />
        </div>
      )}

      {/* DXF Underlay Panel - slides in from right (issue #1782) */}
      {dxfPanelOpen && (
        <div className="absolute top-0 right-0 bottom-0 w-72 z-50 shadow-xl">
          <DxfUnderlayPanel
            onClose={() => setDxfPanelOpen(false)}
            onCenterOnModel={handleCenterDxfUnderlay}
            planViewActive={sectionPlane.axis === 'down' && sectionPlane.custom === undefined}
            georeferenceAvailable={dxfGeoreferenceAvailable}
          />
        </div>
      )}

      {/* Scan Layer Panel - slides in from right (issue #1805) */}
      {scanPanelOpen && (
        <div className="absolute top-0 right-0 bottom-0 w-72 z-50 shadow-xl">
          <ScanSectionPanel
            onClose={() => setScanPanelOpen(false)}
            hasPointCloud={scanSectionLayer.hasPointCloud}
            totalInBand={scanSectionLayer.totalInBand}
            renderedCount={scanSectionLayer.renderedCount}
          />
        </div>
      )}

      {/* Sheet Setup Panel - slides in from right */}
      {sheetPanelVisible && (
        <div className="absolute top-0 right-0 bottom-0 w-72 z-50 shadow-xl">
          <SheetSetupPanel
            onClose={() => setSheetPanelVisible(false)}
            onOpenTitleBlockEditor={() => setTitleBlockEditorVisible(true)}
          />
        </div>
      )}

      {/* Title Block Editor Modal */}
      <TitleBlockEditor
        open={titleBlockEditorVisible}
        onOpenChange={setTitleBlockEditorVisible}
      />
    </div>
  );
}
