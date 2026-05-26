/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section2DPanel - 2D architectural drawing viewer panel
 *
 * Displays generated 2D drawings (floor plans, sections) with:
 * - Canvas-based rendering with pan/zoom
 * - Toggle controls for hidden lines
 * - Export to SVG functionality
 */

import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { X, Download, Eye, EyeOff, Maximize2, ZoomIn, ZoomOut, Loader2, Printer, GripVertical, MoreHorizontal, RefreshCw, Pin, PinOff, Palette, Ruler, Trash2, FileText, Shapes, Box, PenTool, Hexagon, Type, Cloud, MousePointer2, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useIfc } from '@/hooks/useIfc';
import { GraphicOverrideEngine } from '@ifc-lite/drawing-2d';
import { type GeometryResult } from '@ifc-lite/geometry';
import { DrawingSettingsPanel } from './DrawingSettingsPanel';
import { SheetSetupPanel } from './SheetSetupPanel';
import { TitleBlockEditor } from './TitleBlockEditor';
import { TextAnnotationEditor } from './TextAnnotationEditor';
import { Drawing2DCanvas } from './Drawing2DCanvas';
import { useDrawingGeneration, AXIS_MAP } from '@/hooks/useDrawingGeneration';
import { useMeasure2D } from '@/hooks/useMeasure2D';
import { useAnnotation2D } from '@/hooks/useAnnotation2D';
import { useViewControls } from '@/hooks/useViewControls';
import { useDrawingExport } from '@/hooks/useDrawingExport';
import { useSymbolicAnnotationsForDrawing } from '@/hooks/useSymbolicAnnotations';

interface Section2DPanelProps {
  mergedGeometry?: GeometryResult | null;
  computedIsolatedIds?: Set<number> | null;
  modelIdToIndex?: Map<string, number>;
}

export function Section2DPanel({
  mergedGeometry,
  computedIsolatedIds,
  modelIdToIndex
}: Section2DPanelProps = {}): React.ReactElement | null {
  // ═══════════════════════════════════════════════════════════════════════════
  // STORE SELECTORS
  // ═══════════════════════════════════════════════════════════════════════════
  const panelVisible = useViewerStore((s) => s.drawing2DPanelVisible);
  const setDrawingPanelVisible = useViewerStore((s) => s.setDrawing2DPanelVisible);
  const suppressNextSection2DPanelAutoOpen = useViewerStore((s) => s.suppressNextSection2DPanelAutoOpen);
  const setSuppressNextSection2DPanelAutoOpen = useViewerStore((s) => s.setSuppressNextSection2DPanelAutoOpen);
  const drawing = useViewerStore((s) => s.drawing2D);
  const setDrawing = useViewerStore((s) => s.setDrawing2D);
  const status = useViewerStore((s) => s.drawing2DStatus);
  const setDrawingStatus = useViewerStore((s) => s.setDrawing2DStatus);
  const progress = useViewerStore((s) => s.drawing2DProgress);
  const progressPhase = useViewerStore((s) => s.drawing2DPhase);
  const setDrawingProgress = useViewerStore((s) => s.setDrawing2DProgress);
  const drawingError = useViewerStore((s) => s.drawing2DError);
  const setDrawingError = useViewerStore((s) => s.setDrawing2DError);
  const displayOptions = useViewerStore((s) => s.drawing2DDisplayOptions);
  const updateDisplayOptions = useViewerStore((s) => s.updateDrawing2DDisplayOptions);
  // Graphic overrides
  const graphicOverridePresets = useViewerStore((s) => s.graphicOverridePresets);
  const activePresetId = useViewerStore((s) => s.activePresetId);
  const setActivePreset = useViewerStore((s) => s.setActivePreset);
  const overridesEnabled = useViewerStore((s) => s.overridesEnabled);
  const toggleOverridesEnabled = useViewerStore((s) => s.toggleOverridesEnabled);
  const getActiveOverrideRules = useViewerStore((s) => s.getActiveOverrideRules);
  const customOverrideRules = useViewerStore((s) => s.customOverrideRules);

  // Settings panel visibility
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);

  // Sheet state
  const activeSheet = useViewerStore((s) => s.activeSheet);
  const sheetEnabled = useViewerStore((s) => s.sheetEnabled);
  const sheetPanelVisible = useViewerStore((s) => s.sheetPanelVisible);
  const setSheetPanelVisible = useViewerStore((s) => s.setSheetPanelVisible);
  const titleBlockEditorVisible = useViewerStore((s) => s.titleBlockEditorVisible);
  const setTitleBlockEditorVisible = useViewerStore((s) => s.setTitleBlockEditorVisible);

  // 2D Measure tool state
  const measure2DMode = useViewerStore((s) => s.measure2DMode);
  const toggleMeasure2DMode = useViewerStore((s) => s.toggleMeasure2DMode);
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
  const clearMeasure2DResults = useViewerStore((s) => s.clearMeasure2DResults);
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
  const clearPolygonArea2DResults = useViewerStore((s) => s.clearPolygonArea2DResults);
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
  const activeTool = useViewerStore((s) => s.activeTool);
  const models = useViewerStore((s) => s.models);
  const { geometryResult: legacyGeometryResult, ifcDataStore } = useIfc();

  // Use merged geometry from props if available (multi-model), otherwise fall back to legacy single-model
  const geometryResult = mergedGeometry ?? legacyGeometryResult;

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-SHOW PANEL EFFECT
  // ═══════════════════════════════════════════════════════════════════════════
  const prevActiveToolRef = useRef(activeTool);
  useEffect(() => {
    // Section tool was just activated
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

  // ═══════════════════════════════════════════════════════════════════════════
  // LOCAL STATE
  // ═══════════════════════════════════════════════════════════════════════════
  const [isExpanded, setIsExpanded] = useState(false);
  const [panelSize, setPanelSize] = useState({ width: 400, height: 300 });
  const [isNarrow, setIsNarrow] = useState(false);  // Track if panel is too narrow for all buttons
  const [isPinned, setIsPinned] = useState(true);  // Default ON: keep position on regenerate
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef<'right' | 'top' | 'corner' | null>(null);
  const resizeStartPos = useRef({ x: 0, y: 0, width: 0, height: 0 });
  // Track resize event handlers for cleanup
  const resizeHandlersRef = useRef<{ move: ((e: MouseEvent) => void) | null; up: (() => void) | null }>({ move: null, up: null });
  // Cache sheet drawing transform when pinned (to keep model fixed in place)
  const cachedSheetTransformRef = useRef<{ translateX: number; translateY: number; scaleFactor: number } | null>(null);

  // Track panel width for responsive header
  useEffect(() => {
    setIsNarrow(panelSize.width < 480);
  }, [panelSize.width]);

  // ═══════════════════════════════════════════════════════════════════════════
  // MEMOIZED VALUES
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

  // ═══════════════════════════════════════════════════════════════════════════
  // VISIBILITY STATE
  // ═══════════════════════════════════════════════════════════════════════════

  // Get visibility state from store for filtering
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const hiddenEntitiesByModel = useViewerStore((s) => s.hiddenEntitiesByModel);
  const isolatedEntitiesByModel = useViewerStore((s) => s.isolatedEntitiesByModel);

  // Build combined Set of global IDs from multi-model visibility state
  // This converts per-model local expressIds to global IDs using idOffset
  const combinedHiddenIds = useMemo(() => {
    const globalHiddenIds = new Set<number>(hiddenEntities); // Start with legacy hidden IDs

    // Add hidden entities from each model (convert local expressId to global ID)
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

  // Build combined Set of global IDs for isolation
  const combinedIsolatedIds = useMemo(() => {
    // If legacy isolation is active, use that (already contains global IDs)
    if (isolatedEntities !== null) {
      return isolatedEntities;
    }

    // Build from multi-model isolation
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

  // ═══════════════════════════════════════════════════════════════════════════
  // EXTRACTED HOOKS
  // ═══════════════════════════════════════════════════════════════════════════

  const { generateDrawing, doRegenerate, isRegenerating } = useDrawingGeneration({
    geometryResult, ifcDataStore, sectionPlane, displayOptions,
    combinedHiddenIds, combinedIsolatedIds, computedIsolatedIds,
    models, panelVisible, drawing,
    setDrawing, setDrawingStatus, setDrawingProgress, setDrawingError,
  });

  const { viewTransform, setViewTransform, zoomIn, zoomOut, fitToView } = useViewControls({
    drawing, sectionPlane, containerRef,
    panelVisible, status, sheetEnabled, activeSheet,
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
  const ifcAnnotationsForDrawing = useMemo(() => {
    const bounds = geometryResult?.coordinateInfo?.shiftedBounds;
    if (!bounds) {
      return { sectionPosWorld: 0, viewDepth: 0, fallbackY: 0 };
    }
    const axis = AXIS_MAP[sectionPlane.axis];
    const axisMin = bounds.min[axis];
    const axisMax = bounds.max[axis];
    const sectionPosWorld = axisMin + (sectionPlane.position / 100) * (axisMax - axisMin);
    const viewDepth = (axisMax - axisMin) * 0.5; // matches useDrawingGeneration's maxDepth
    // For loose annotations (no resolvable storey), fall back to mid-Y like
    // the 3D viewport does. This lets storeyless models still surface their
    // annotations on the relevant section.
    const yMin = bounds.min.y;
    const yMax = bounds.max.y;
    const fallbackY = Number.isFinite(yMin) && Number.isFinite(yMax) ? (yMin + yMax) * 0.5 : 0;
    return { sectionPosWorld, viewDepth, fallbackY };
  }, [geometryResult, sectionPlane.axis, sectionPlane.position]);

  const ifcAnnotationData = useSymbolicAnnotationsForDrawing({
    enabled: displayOptions.showIfcAnnotations && status === 'ready',
    axis: sectionPlane.axis,
    sectionPosWorld: ifcAnnotationsForDrawing.sectionPosWorld,
    viewDepth: ifcAnnotationsForDrawing.viewDepth,
    flipped: sectionPlane.flipped,
    fallbackY: ifcAnnotationsForDrawing.fallbackY,
  });

  const toggleIfcAnnotations = useCallback(() => {
    updateDisplayOptions({ showIfcAnnotations: !displayOptions.showIfcAnnotations });
  }, [displayOptions.showIfcAnnotations, updateDisplayOptions]);

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

  const { formatDistance, handleExportSVG, handlePrint } = useDrawingExport({
    drawing, displayOptions, sectionPlane, activePresetId,
    entityColorMap, overridesEnabled, overrideEngine,
    measure2DResults, polygonArea2DResults, textAnnotations2D, cloudAnnotations2D,
    sheetEnabled, activeSheet,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CALLBACKS
  // ═══════════════════════════════════════════════════════════════════════════

  // Close panel
  const handleClose = useCallback(() => {
    setDrawingPanelVisible(false);
  }, [setDrawingPanelVisible]);

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

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

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
  // RESIZE HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  const handleResizeStart = useCallback((edge: 'right' | 'top' | 'corner') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing.current = edge;
    resizeStartPos.current = {
      x: e.clientX,
      y: e.clientY,
      width: panelSize.width,
      height: panelSize.height,
    };

    // Remove any existing listeners first
    if (resizeHandlersRef.current.move) {
      window.removeEventListener('mousemove', resizeHandlersRef.current.move);
    }
    if (resizeHandlersRef.current.up) {
      window.removeEventListener('mouseup', resizeHandlersRef.current.up);
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;

      const dx = e.clientX - resizeStartPos.current.x;
      const dy = e.clientY - resizeStartPos.current.y;

      setPanelSize((prev) => {
        let newWidth = prev.width;
        let newHeight = prev.height;

        if (isResizing.current === 'right' || isResizing.current === 'corner') {
          newWidth = Math.max(300, Math.min(1200, resizeStartPos.current.width + dx));
        }
        // Top resize: dragging up (negative dy) increases height
        if (isResizing.current === 'top' || isResizing.current === 'corner') {
          newHeight = Math.max(200, Math.min(800, resizeStartPos.current.height - dy));
        }

        return { width: newWidth, height: newHeight };
      });
    };

    const handleMouseUp = () => {
      isResizing.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      resizeHandlersRef.current = { move: null, up: null };
    };

    // Store refs for cleanup
    resizeHandlersRef.current = { move: handleMouseMove, up: handleMouseUp };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [panelSize]);

  // Cleanup resize listeners on unmount
  useEffect(() => {
    return () => {
      if (resizeHandlersRef.current.move) {
        window.removeEventListener('mousemove', resizeHandlersRef.current.move);
      }
      if (resizeHandlersRef.current.up) {
        window.removeEventListener('mouseup', resizeHandlersRef.current.up);
      }
    };
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // MEMOIZED STYLES
  // ═══════════════════════════════════════════════════════════════════════════

  // Memoize panel style to avoid creating new object on every render
  const panelStyle = useMemo(() => {
    return isExpanded
      ? {}  // Expanded uses CSS classes for full sizing
      : { width: panelSize.width, height: panelSize.height };
  }, [isExpanded, panelSize.width, panelSize.height]);

  // Memoize progress bar style
  const progressBarStyle = useMemo(() => ({ width: `${progress}%` }), [progress]);

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  if (!panelVisible) return null;

  const panelClasses = isExpanded
    ? 'absolute inset-4 z-40'
    : 'absolute bottom-4 left-4 z-40';

  return (
    <div
      ref={panelRef}
      className={`${panelClasses} bg-background rounded-lg border shadow-xl flex flex-col overflow-hidden`}
      style={panelStyle}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/50 rounded-t-lg min-w-0">
        <h2 className="font-semibold text-xs shrink-0">2D Section</h2>

        <div className="flex items-center gap-1 min-w-0">
          {/* When panel is wide enough, show all buttons */}
          {!isNarrow && (
            <>
              {/* Display toggles */}
              <Button
                variant={displayOptions.show3DOverlay ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={toggle3DOverlay}
                title="Toggle 3D overlay"
              >
                {displayOptions.show3DOverlay ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>

              {/* Symbolic vs Section Cut toggle */}
              <Button
                variant={displayOptions.useSymbolicRepresentations ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={toggleSymbolicRepresentations}
                title={displayOptions.useSymbolicRepresentations ? 'Symbolic representations (Plan)' : 'Section cut (Body)'}
              >
                {displayOptions.useSymbolicRepresentations ? <Shapes className="h-4 w-4" /> : <Box className="h-4 w-4" />}
              </Button>

              {/* IFC Annotations overlay toggle (issue #812) */}
              <Button
                variant={displayOptions.showIfcAnnotations ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={toggleIfcAnnotations}
                title={displayOptions.showIfcAnnotations ? 'Hide IFC annotations on this section' : 'Show IFC annotations on this section'}
                disabled={sectionPlane.axis !== 'down'}
              >
                <Tag className="h-4 w-4" />
              </Button>

              {/* Annotation Tools Dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant={annotation2DActiveTool !== 'none' ? 'default' : 'ghost'}
                    size="icon-sm"
                    title="Annotation tools"
                  >
                    <PenTool className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool('none')}>
                    <MousePointer2 className="h-4 w-4 mr-2" />
                    Select / Pan
                    {annotation2DActiveTool === 'none' && <span className="ml-auto text-xs text-primary">Active</span>}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'measure' ? 'none' : 'measure')}>
                    <Ruler className="h-4 w-4 mr-2" />
                    Distance Measure
                    {annotation2DActiveTool === 'measure' && <span className="ml-auto text-xs text-primary">Active</span>}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'polygon-area' ? 'none' : 'polygon-area')}>
                    <Hexagon className="h-4 w-4 mr-2" />
                    Area Measure
                    {annotation2DActiveTool === 'polygon-area' && <span className="ml-auto text-xs text-primary">Active</span>}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'text' ? 'none' : 'text')}>
                    <Type className="h-4 w-4 mr-2" />
                    Text Box
                    {annotation2DActiveTool === 'text' && <span className="ml-auto text-xs text-primary">Active</span>}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'cloud' ? 'none' : 'cloud')}>
                    <Cloud className="h-4 w-4 mr-2" />
                    Revision Cloud
                    {annotation2DActiveTool === 'cloud' && <span className="ml-auto text-xs text-primary">Active</span>}
                  </DropdownMenuItem>
                  {hasAnnotations && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={clearAllAnnotations2D}>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Clear All Annotations
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Graphic Override Settings */}
              <Button
                variant={settingsPanelOpen || activePresetId ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={() => setSettingsPanelOpen((prev) => !prev)}
                title="Drawing settings"
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
                onClick={() => setSheetPanelVisible(!sheetPanelVisible)}
                title="Drawing sheet setup"
                className="relative"
              >
                <FileText className="h-4 w-4" />
                {sheetEnabled && !sheetPanelVisible && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-primary rounded-full" />
                )}
              </Button>

              <div className="w-px h-4 bg-border mx-1" />

              {/* Zoom controls */}
              <Button variant="ghost" size="icon-sm" onClick={zoomOut} title="Zoom out">
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="text-xs font-mono w-10 text-center">
                {Math.round(viewTransform.scale * 100)}%
              </span>
              <Button variant="ghost" size="icon-sm" onClick={zoomIn} title="Zoom in">
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={fitToView} title="Fit to view">
                <Maximize2 className="h-4 w-4" />
              </Button>
              <Button
                variant={isPinned ? 'default' : 'ghost'}
                size="icon-sm"
                onClick={togglePinned}
                title={isPinned ? 'Unpin view (auto-fit on regenerate)' : 'Pin view (keep position on regenerate)'}
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
                title="Download SVG"
              >
                <Download className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handlePrint}
                disabled={!drawing}
                title="Print"
              >
                <Printer className="h-4 w-4" />
              </Button>

              <div className="w-px h-4 bg-border mx-1" />

              {/* Regenerate */}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => generateDrawing(false)}
                disabled={status === 'generating'}
                title="Regenerate"
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
              <Button variant="ghost" size="icon-sm" onClick={fitToView} title="Fit to view">
                <Maximize2 className="h-4 w-4" />
              </Button>

              {/* Overflow menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" title="More options">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onClick={toggle3DOverlay}>
                    {displayOptions.show3DOverlay ? <Eye className="h-4 w-4 mr-2" /> : <EyeOff className="h-4 w-4 mr-2" />}
                    3D Overlay {displayOptions.show3DOverlay ? 'On' : 'Off'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleSymbolicRepresentations}>
                    {displayOptions.useSymbolicRepresentations ? <Shapes className="h-4 w-4 mr-2" /> : <Box className="h-4 w-4 mr-2" />}
                    {displayOptions.useSymbolicRepresentations ? 'Symbolic (Plan)' : 'Section Cut (Body)'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleIfcAnnotations} disabled={sectionPlane.axis !== 'down'}>
                    <Tag className="h-4 w-4 mr-2" />
                    IFC Annotations {displayOptions.showIfcAnnotations ? 'On' : 'Off'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool('none')}>
                    <MousePointer2 className="h-4 w-4 mr-2" />
                    Select / Pan {annotation2DActiveTool === 'none' ? '(On)' : ''}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'measure' ? 'none' : 'measure')}>
                    <Ruler className="h-4 w-4 mr-2" />
                    Distance Measure {annotation2DActiveTool === 'measure' ? '(On)' : ''}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'polygon-area' ? 'none' : 'polygon-area')}>
                    <Hexagon className="h-4 w-4 mr-2" />
                    Area Measure {annotation2DActiveTool === 'polygon-area' ? '(On)' : ''}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'text' ? 'none' : 'text')}>
                    <Type className="h-4 w-4 mr-2" />
                    Text Box {annotation2DActiveTool === 'text' ? '(On)' : ''}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAnnotation2DActiveTool(annotation2DActiveTool === 'cloud' ? 'none' : 'cloud')}>
                    <Cloud className="h-4 w-4 mr-2" />
                    Revision Cloud {annotation2DActiveTool === 'cloud' ? '(On)' : ''}
                  </DropdownMenuItem>
                  {hasAnnotations && (
                    <DropdownMenuItem onClick={clearAllAnnotations2D}>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Clear All Annotations
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setSettingsPanelOpen(true)}>
                    <Palette className="h-4 w-4 mr-2" />
                    Drawing Settings...
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSheetPanelVisible(true)}>
                    <FileText className="h-4 w-4 mr-2" />
                    Sheet Setup {sheetEnabled ? '(On)' : ''}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={zoomIn}>
                    <ZoomIn className="h-4 w-4 mr-2" />
                    Zoom In
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={zoomOut}>
                    <ZoomOut className="h-4 w-4 mr-2" />
                    Zoom Out
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={togglePinned}>
                    {isPinned ? <Pin className="h-4 w-4 mr-2" /> : <PinOff className="h-4 w-4 mr-2" />}
                    Pin View {isPinned ? 'On' : 'Off'}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleExportSVG} disabled={!drawing}>
                    <Download className="h-4 w-4 mr-2" />
                    Download SVG
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handlePrint} disabled={!drawing}>
                    <Printer className="h-4 w-4 mr-2" />
                    Print
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => generateDrawing(false)} disabled={status === 'generating'}>
                    {status === 'generating' ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    Regenerate
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {/* Close button always visible */}
          <Button variant="ghost" size="icon-sm" onClick={handleClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Drawing Canvas */}
      <div
        ref={containerRef}
        className={`relative flex-1 overflow-hidden bg-white dark:bg-zinc-950 rounded-b-lg ${cursorClass}`}
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
              <p className="font-medium">Generation failed</p>
              <p className="text-sm text-muted-foreground">
                {drawingError}
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => generateDrawing(false)}>
                Retry
              </Button>
            </div>
          </div>
        )}

        {status === 'ready' && drawing && (drawing.cutPolygons.length > 0 || drawing.lines?.length > 0) && (
          <>
            <Drawing2DCanvas
              drawing={drawing}
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
            />
            {/* Subtle updating indicator - shows while regenerating without hiding the drawing */}
            {isRegenerating && (
              <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-background/80 backdrop-blur-sm px-2 py-1 rounded text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Updating...</span>
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
            <div className="flex items-center gap-1.5 text-[10px] text-black">
              <kbd className={`px-1 py-0.5 text-[9px] font-mono font-semibold ${measure2DShiftLocked ? 'text-primary' : 'text-black'}`}>Shift</kbd>
              <span className="text-black">perpendicular</span>
            </div>
          </div>
        )}

        {/* Polygon area tip */}
        {annotation2DActiveTool === 'polygon-area' && (
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <div className="text-[10px] text-black bg-white/80 px-1.5 py-0.5 rounded">
              {polygonArea2DPoints.length === 0 ? 'Click to place first vertex · Hold Shift to constrain' :
               polygonArea2DPoints.length < 3 ? `${polygonArea2DPoints.length} vertices — need at least 3 · Shift = constrain` :
               'Double-click or click first vertex to close · Shift = constrain'}
            </div>
          </div>
        )}

        {/* Cloud tool tip */}
        {annotation2DActiveTool === 'cloud' && (
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <div className="text-[10px] text-black bg-white/80 px-1.5 py-0.5 rounded">
              {cloudAnnotation2DPoints.length === 0 ? 'Click to place first corner' : 'Click to place second corner · Shift = square'}
            </div>
          </div>
        )}

        {/* Text tool tip */}
        {annotation2DActiveTool === 'text' && !textAnnotation2DEditing && (
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <div className="text-[10px] text-black bg-white/80 px-1.5 py-0.5 rounded">
              Click to place text box
            </div>
          </div>
        )}

        {/* Selection tip */}
        {selectedAnnotation2D && annotation2DActiveTool === 'none' && (
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <div className="text-[10px] text-black bg-white/80 px-1.5 py-0.5 rounded">
              {selectedAnnotation2D.type === 'text' ? 'Del = delete · Drag to move · Double-click to edit' : 'Del = delete · Drag to move'} · Esc = deselect
            </div>
          </div>
        )}

        {status === 'ready' && drawing && drawing.cutPolygons.length === 0 && (!drawing.lines || drawing.lines.length === 0) && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <p className="font-medium">No geometry at this level</p>
              <p className="text-sm mt-1">Move the section plane to cut through geometry</p>
            </div>
          </div>
        )}

        {/* Empty state - just show blank canvas, no message */}
      </div>

      {/* Resize handles - only show when not expanded */}
      {!isExpanded && (
        <>
          {/* Right edge */}
          <div
            className="absolute top-0 right-0 w-2 h-full cursor-ew-resize hover:bg-primary/20 transition-colors"
            onMouseDown={handleResizeStart('right')}
          />
          {/* Top edge */}
          <div
            className="absolute top-0 left-0 w-full h-2 cursor-ns-resize hover:bg-primary/20 transition-colors"
            onMouseDown={handleResizeStart('top')}
          />
          {/* Top-right corner */}
          <div
            className="absolute top-0 right-0 w-4 h-4 cursor-nesw-resize flex items-center justify-center hover:bg-primary/20 transition-colors"
            onMouseDown={handleResizeStart('corner')}
          >
            <GripVertical className="h-3 w-3 text-muted-foreground rotate-[45deg]" />
          </div>
        </>
      )}

      {/* Settings Panel - slides in from right */}
      {settingsPanelOpen && (
        <div className="absolute top-0 right-0 bottom-0 w-72 z-50 shadow-xl">
          <DrawingSettingsPanel onClose={() => setSettingsPanelOpen(false)} />
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
