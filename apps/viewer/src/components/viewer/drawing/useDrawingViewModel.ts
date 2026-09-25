/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drawing view's model (#5494): what the store holds about the current
 * drawing, the view transform, the markup tool handlers, the display toggles
 * and the settings-drawer slot. `DrawingPanel` renders it; `useDrawingLayers`
 * builds the overlays and exports on top of it.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { GraphicOverrideEngine } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import type { Annotation2DTool } from '@/store/slices/drawing2DSlice';
import type { DrawingInspectorTab } from '@/store/slices/drawingInspectorSlice';
import { useMeasure2D } from '@/hooks/useMeasure2D';
import { useAnnotation2D } from '@/hooks/useAnnotation2D';
import { useDrawingWithReferences } from '@/hooks/useReferenceImagesForDrawing';
import { useViewControls } from '@/hooks/useViewControls';
import { useDrawingRuntime } from '@/lib/drawing/drawing-runtime';
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key';
import { resolveDrawingPaperTheme } from './paper-theme';

/** The settings panels beside the canvas, as inspector tabs (#5495); they
 *  share one slot. Re-exported for the drawing/ subtree's existing imports. */
export type DrawingDrawer = DrawingInspectorTab;

export function useDrawingViewModel() {
  const runtime = useDrawingRuntime();
  const { geometryResult } = runtime;

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
  const theme = useViewerStore((s) => s.theme);
  // LENGTHUNIT display override for the on-canvas measure distance/perimeter
  // labels (#2199 slice not covered by #2538 — see Drawing2DCanvas.tsx).
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  // Class-level Visibility toggles — the section honours them like the 3D
  // viewport does, so a hidden IfcSpace/IfcOpeningElement is not cut (#2060).
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const activePresetId = useViewerStore((s) => s.activePresetId);
  const overridesEnabled = useViewerStore((s) => s.overridesEnabled);
  const getActiveOverrideRules = useViewerStore((s) => s.getActiveOverrideRules);
  const customOverrideRules = useViewerStore((s) => s.customOverrideRules);
  const dxfUnderlays = useViewerStore((s) => s.dxfUnderlays);
  const pointCloudClassMask = useViewerStore((s) => s.pointCloudClassMask);
  const activeSheet = useViewerStore((s) => s.activeSheet);
  const sheetEnabled = useViewerStore((s) => s.sheetEnabled);
  const titleBlockEditorVisible = useViewerStore((s) => s.titleBlockEditorVisible);
  const setTitleBlockEditorVisible = useViewerStore((s) => s.setTitleBlockEditorVisible);

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

  const annotation2DActiveTool = useViewerStore((s) => s.annotation2DActiveTool);
  const setAnnotation2DActiveTool = useViewerStore((s) => s.setAnnotation2DActiveTool);
  const annotation2DCursorPos = useViewerStore((s) => s.annotation2DCursorPos);
  const setAnnotation2DCursorPos = useViewerStore((s) => s.setAnnotation2DCursorPos);
  const polygonArea2DPoints = useViewerStore((s) => s.polygonArea2DPoints);
  const polygonArea2DResults = useViewerStore((s) => s.polygonArea2DResults);
  const addPolygonArea2DPoint = useViewerStore((s) => s.addPolygonArea2DPoint);
  const completePolygonArea2D = useViewerStore((s) => s.completePolygonArea2D);
  const cancelPolygonArea2D = useViewerStore((s) => s.cancelPolygonArea2D);
  const textAnnotations2D = useViewerStore((s) => s.textAnnotations2D);
  const textAnnotation2DEditing = useViewerStore((s) => s.textAnnotation2DEditing);
  const addTextAnnotation2D = useViewerStore((s) => s.addTextAnnotation2D);
  const updateTextAnnotation2D = useViewerStore((s) => s.updateTextAnnotation2D);
  const removeTextAnnotation2D = useViewerStore((s) => s.removeTextAnnotation2D);
  const setTextAnnotation2DEditing = useViewerStore((s) => s.setTextAnnotation2DEditing);
  const cloudAnnotation2DPoints = useViewerStore((s) => s.cloudAnnotation2DPoints);
  const cloudAnnotations2D = useViewerStore((s) => s.cloudAnnotations2D);
  const addCloudAnnotation2DPoint = useViewerStore((s) => s.addCloudAnnotation2DPoint);
  const completeCloudAnnotation2D = useViewerStore((s) => s.completeCloudAnnotation2D);
  const cancelCloudAnnotation2D = useViewerStore((s) => s.cancelCloudAnnotation2D);
  const selectedAnnotation2D = useViewerStore((s) => s.selectedAnnotation2D);
  const setSelectedAnnotation2D = useViewerStore((s) => s.setSelectedAnnotation2D);
  const deleteSelectedAnnotation2D = useViewerStore((s) => s.deleteSelectedAnnotation2D);
  const moveAnnotation2D = useViewerStore((s) => s.moveAnnotation2D);
  const clearAllAnnotations2D = useViewerStore((s) => s.clearAllAnnotations2D);

  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const models = useViewerStore((s) => s.models);

  const [isPinned, setIsPinned] = useState(true); // Default ON: keep position on regenerate
  const containerRef = useRef<HTMLDivElement>(null);
  // Cache sheet drawing transform when pinned (to keep model fixed in place)
  const cachedSheetTransformRef = useRef<CachedSheetTransform | null>(null);

  // The inspector column's tabs share one slot (#5495): a single persisted
  // store field, not a per-drawer `useState`. `sheetPanelVisible` (keyboard
  // shortcuts, teardown) stays in step with it via `registerDrawingInspectorSheetSync`
  // in `store/index.ts`.
  const openDrawer = useViewerStore((s) => s.drawingInspectorTab);
  const toggleDrawingInspectorTab = useViewerStore((s) => s.toggleDrawingInspectorTab);
  const closeDrawingInspector = useViewerStore((s) => s.closeDrawingInspector);
  const toggleDrawer = useCallback((drawer: DrawingDrawer) => {
    toggleDrawingInspectorTab(drawer);
  }, [toggleDrawingInspectorTab]);
  const closeDrawer = useCallback(() => {
    closeDrawingInspector();
  }, [closeDrawingInspector]);

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
        if (mesh.expressId && mesh.color) map.set(mesh.expressId, mesh.color);
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
      if (!consumed) measureHandlers.handleMouseDown(e);
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

  const canvasMouseHandlers = useMemo(() => ({
    onMouseDown: handleMouseDown,
    onMouseMove: handleMouseMove,
    onMouseUp: handleMouseUp,
    onMouseEnter: measureHandlers.handleMouseEnter,
    onMouseLeave: measureHandlers.handleMouseLeave,
    onDoubleClick: annotationHandlers.handleDoubleClick,
  }), [handleMouseDown, handleMouseMove, handleMouseUp, measureHandlers, annotationHandlers]);

  // Display toggles. Symbolic and construction projection change which geometry
  // the generator emits, so they clear the drawing to force a regenerate.
  const toggleIfcAnnotations = useCallback(() => {
    updateDisplayOptions({ showIfcAnnotations: !displayOptions.showIfcAnnotations });
  }, [displayOptions.showIfcAnnotations, updateDisplayOptions]);

  const toggleConstructionProjection = useCallback(() => {
    updateDisplayOptions({ showConstructionProjection: !displayOptions.showConstructionProjection });
    setDrawing(null);
    setDrawingStatus('idle');
  }, [displayOptions.showConstructionProjection, updateDisplayOptions, setDrawing, setDrawingStatus]);

  const toggle3DOverlay = useCallback(() => {
    updateDisplayOptions({ show3DOverlay: !displayOptions.show3DOverlay });
  }, [displayOptions.show3DOverlay, updateDisplayOptions]);

  const toggleSymbolicRepresentations = useCallback(() => {
    updateDisplayOptions({ useSymbolicRepresentations: !displayOptions.useSymbolicRepresentations });
    setDrawing(null);
    setDrawingStatus('idle');
  }, [displayOptions.useSymbolicRepresentations, updateDisplayOptions, setDrawing, setDrawingStatus]);

  // Print preview (#5496): a display toggle, not a regenerate — it only
  // changes the canvas's paper/ink, never the cut geometry.
  const togglePrintPreview = useCallback(() => {
    updateDisplayOptions({ showPrintPreview: !displayOptions.showPrintPreview });
  }, [displayOptions.showPrintPreview, updateDisplayOptions]);

  // The canvas's paper/ink (#5496): dark paper in dark theme, forced white by
  // print preview, always white in sheet mode (Drawing2DCanvas decides that
  // last part itself since it also owns the desk colour).
  const paperTheme = useMemo(
    () => resolveDrawingPaperTheme(theme, displayOptions.showPrintPreview),
    [theme, displayOptions.showPrintPreview],
  );

  const togglePinned = useCallback(() => setIsPinned((prev) => !prev), []);

  const selectTool = useCallback((tool: Annotation2DTool) => setAnnotation2DActiveTool(tool), [setAnnotation2DActiveTool]);

  // Text editor handlers
  const handleTextConfirm = useCallback((id: string, text: string) => {
    updateTextAnnotation2D(id, { text });
    setTextAnnotation2DEditing(null);
  }, [updateTextAnnotation2D, setTextAnnotation2DEditing]);

  const handleTextCancel = useCallback((id: string) => {
    // If text is empty (just created), remove it
    const annotation = textAnnotations2D.find((a) => a.id === id);
    if (annotation && !annotation.text.trim()) removeTextAnnotation2D(id);
    setTextAnnotation2DEditing(null);
  }, [textAnnotations2D, removeTextAnnotation2D, setTextAnnotation2DEditing]);

  const markupCounts = useMemo(() => ({
    measurements: measure2DResults.length,
    areas: polygonArea2DResults.length,
    texts: textAnnotations2D.length,
    clouds: cloudAnnotations2D.length,
  }), [measure2DResults.length, polygonArea2DResults.length, textAnnotations2D.length, cloudAnnotations2D.length]);
  const hasMarkup = markupCounts.measurements + markupCounts.areas + markupCounts.texts + markupCounts.clouds > 0;

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

  return {
    runtime, geometryResult, models,
    drawing, sourceDrawing, hasReferences, status, progress, progressPhase, drawingError,
    displayOptions, unitDisplayOverrides, typeVisibility,
    activePresetId, overridesEnabled, overrideEngine, entityColorMap,
    dxfUnderlays, pointCloudClassMask,
    activeSheet, sheetEnabled, titleBlockEditorVisible, setTitleBlockEditorVisible,
    sectionPlane,
    isPinned, togglePinned, containerRef, cachedSheetTransformRef,
    openDrawer, toggleDrawer, closeDrawer,
    viewTransform, zoomIn, zoomOut, fitToView,
    canvasMouseHandlers, cursorClass,
    measure2DMode, measure2DStart, measure2DCurrent, measure2DResults, measure2DSnapPoint, measure2DShiftLocked,
    annotation2DActiveTool, selectTool, annotation2DCursorPos,
    polygonArea2DPoints, polygonArea2DResults,
    textAnnotations2D, textAnnotation2DEditing, handleTextConfirm, handleTextCancel,
    cloudAnnotation2DPoints, cloudAnnotations2D,
    selectedAnnotation2D, clearAllAnnotations2D, markupCounts, hasMarkup,
    toggleIfcAnnotations, toggleConstructionProjection, toggle3DOverlay, toggleSymbolicRepresentations,
    togglePrintPreview, paperTheme,
  };
}

export type DrawingViewModel = ReturnType<typeof useDrawingViewModel>;
