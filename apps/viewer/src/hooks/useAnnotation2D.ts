/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for 2D annotation tools (polygon area, text, cloud) and
 * annotation selection/drag/delete.
 *
 * The existing useMeasure2D hook continues to handle linear distance
 * measurements and panning.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type {
  Annotation2DTool, Point2D, TextAnnotation2D,
  SelectedAnnotation2D, Measure2DResult, PolygonArea2DResult, CloudAnnotation2D,
} from '@/store/slices/drawing2DSlice';
import { computePolygonArea, computePolygonPerimeter } from '@/components/viewer/tools/computePolygonArea';
import { nearestPointOnSegment, hitTestAnnotations as hitTestAnnotationsPure } from '@/hooks/annotation2DHitTest';

// ─── Public interfaces ──────────────────────────────────────────────────────

export interface UseAnnotation2DParams {
  drawing: Drawing2D | null;
  viewTransform: { x: number; y: number; scale: number };
  sectionAxis: 'down' | 'front' | 'side';
  containerRef: React.RefObject<HTMLDivElement | null>;
  activeTool: Annotation2DTool;
  setActiveTool: (tool: Annotation2DTool) => void;
  // Polygon area state
  polygonArea2DPoints: Point2D[];
  addPolygonArea2DPoint: (pt: Point2D) => void;
  completePolygonArea2D: (area: number, perimeter: number) => void;
  cancelPolygonArea2D: () => void;
  // Text state
  textAnnotations2D: TextAnnotation2D[];
  addTextAnnotation2D: (annotation: TextAnnotation2D) => void;
  setTextAnnotation2DEditing: (id: string | null) => void;
  // Cloud state
  cloudAnnotation2DPoints: Point2D[];
  cloudAnnotations2D: CloudAnnotation2D[];
  addCloudAnnotation2DPoint: (pt: Point2D) => void;
  completeCloudAnnotation2D: (label?: string) => void;
  cancelCloudAnnotation2D: () => void;
  // Completed results (for hit testing)
  measure2DResults: Measure2DResult[];
  polygonArea2DResults: PolygonArea2DResult[];
  // Selection
  selectedAnnotation2D: SelectedAnnotation2D | null;
  setSelectedAnnotation2D: (sel: SelectedAnnotation2D | null) => void;
  deleteSelectedAnnotation2D: () => void;
  moveAnnotation2D: (sel: SelectedAnnotation2D, newOrigin: Point2D) => void;
  // Cursor and snap
  setAnnotation2DCursorPos: (pos: Point2D | null) => void;
  setMeasure2DSnapPoint: (pt: Point2D | null) => void;
}

export interface UseAnnotation2DResult {
  /** Returns true if the click hit an annotation (consumed the event). */
  handleMouseDown: (e: React.MouseEvent) => boolean;
  handleMouseMove: (e: React.MouseEvent) => void;
  handleMouseUp: (e: React.MouseEvent) => void;
  handleDoubleClick: (e: React.MouseEvent) => void;
  /** Ref that is true while an annotation drag is in progress (read at call time). */
  isDraggingRef: React.RefObject<boolean>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CLOSE_POLYGON_THRESHOLD_PX = 12;
const HIT_TEST_RADIUS_PX = 10;

// ─── Hook implementation ────────────────────────────────────────────────────

export function useAnnotation2D({
  drawing,
  viewTransform,
  sectionAxis,
  containerRef,
  activeTool,
  setActiveTool,
  polygonArea2DPoints,
  addPolygonArea2DPoint,
  completePolygonArea2D,
  cancelPolygonArea2D,
  textAnnotations2D,
  addTextAnnotation2D,
  setTextAnnotation2DEditing,
  cloudAnnotation2DPoints,
  cloudAnnotations2D,
  addCloudAnnotation2DPoint,
  completeCloudAnnotation2D,
  cancelCloudAnnotation2D,
  measure2DResults,
  polygonArea2DResults,
  selectedAnnotation2D,
  setSelectedAnnotation2D,
  deleteSelectedAnnotation2D,
  moveAnnotation2D,
  setAnnotation2DCursorPos,
  setMeasure2DSnapPoint,
}: UseAnnotation2DParams): UseAnnotation2DResult {

  const shiftHeldRef = useRef(false);

  // ── Ephemeral drag state as refs (no store churn during drag) ──────────
  const isDraggingRef = useRef(false);
  const dragOffsetRef = useRef<Point2D | null>(null);
  // Keep a stable ref to the latest store mutators to avoid stale closures
  const storeRef = useRef({
    measure2DResults,
    polygonArea2DResults,
    textAnnotations2D,
    cloudAnnotations2D,
    selectedAnnotation2D,
  });
  storeRef.current = {
    measure2DResults,
    polygonArea2DResults,
    textAnnotations2D,
    cloudAnnotations2D,
    selectedAnnotation2D,
  };

  // ── Coordinate conversion (depends on individual primitives, not object) ─

  const scaleRef = useRef(viewTransform.scale);
  const txRef = useRef(viewTransform.x);
  const tyRef = useRef(viewTransform.y);
  const axisRef = useRef(sectionAxis);
  scaleRef.current = viewTransform.scale;
  txRef.current = viewTransform.x;
  tyRef.current = viewTransform.y;
  axisRef.current = sectionAxis;

  /** Convert screen px to drawing coords. Uses refs so it never goes stale. */
  const screenToDrawing = useCallback((screenX: number, screenY: number): Point2D => {
    const axis = axisRef.current;
    const scaleX = axis === 'side' ? -scaleRef.current : scaleRef.current;
    const scaleY = axis !== 'down' ? -scaleRef.current : scaleRef.current;
    return {
      x: (screenX - txRef.current) / scaleX,
      y: (screenY - tyRef.current) / scaleY,
    };
  }, []); // stable — reads from refs

  /** Convert drawing coords to screen px. */
  const drawingToScreen = useCallback((pt: Point2D): { x: number; y: number } => {
    const axis = axisRef.current;
    const scaleX = axis === 'side' ? -scaleRef.current : scaleRef.current;
    const scaleY = axis === 'down' ? scaleRef.current : -scaleRef.current;
    return {
      x: pt.x * scaleX + txRef.current,
      y: pt.y * scaleY + tyRef.current,
    };
  }, []); // stable

  // ── Orthogonal constraint (shift held) ────────────────────────────────

  const applyShiftConstraint = useCallback((anchor: Point2D, point: Point2D): Point2D => {
    const dx = Math.abs(point.x - anchor.x);
    const dy = Math.abs(point.y - anchor.y);
    return dx > dy ? { x: point.x, y: anchor.y } : { x: anchor.x, y: point.y };
  }, []);

  // ── Snap point detection ──────────────────────────────────────────────

  const findSnapPoint = useCallback((drawingCoord: Point2D): Point2D | null => {
    if (!drawing) return null;
    const snapThreshold = 10 / scaleRef.current;
    let bestSnap: Point2D | null = null;
    let bestDist = snapThreshold;

    // Check vertices first (early return on close match)
    for (const polygon of drawing.cutPolygons) {
      for (const pt of polygon.polygon.outer) {
        const dist = Math.sqrt((pt.x - drawingCoord.x) ** 2 + (pt.y - drawingCoord.y) ** 2);
        if (dist < bestDist * 0.7) return { x: pt.x, y: pt.y };
      }
      for (const hole of polygon.polygon.holes) {
        for (const pt of hole) {
          const dist = Math.sqrt((pt.x - drawingCoord.x) ** 2 + (pt.y - drawingCoord.y) ** 2);
          if (dist < bestDist * 0.7) return { x: pt.x, y: pt.y };
        }
      }
    }
    for (const line of drawing.lines) {
      for (const pt of [line.line.start, line.line.end]) {
        const dist = Math.sqrt((pt.x - drawingCoord.x) ** 2 + (pt.y - drawingCoord.y) ** 2);
        if (dist < bestDist * 0.7) return { x: pt.x, y: pt.y };
      }
    }

    // Then check edge proximity
    for (const polygon of drawing.cutPolygons) {
      const outer = polygon.polygon.outer;
      for (let i = 0; i < outer.length; i++) {
        const { point, dist } = nearestPointOnSegment(drawingCoord, outer[i], outer[(i + 1) % outer.length]);
        if (dist < bestDist) { bestDist = dist; bestSnap = point; }
      }
      for (const hole of polygon.polygon.holes) {
        for (let i = 0; i < hole.length; i++) {
          const { point, dist } = nearestPointOnSegment(drawingCoord, hole[i], hole[(i + 1) % hole.length]);
          if (dist < bestDist) { bestDist = dist; bestSnap = point; }
        }
      }
    }
    for (const line of drawing.lines) {
      const { point, dist } = nearestPointOnSegment(drawingCoord, line.line.start, line.line.end);
      if (dist < bestDist) { bestDist = dist; bestSnap = point; }
    }

    return bestSnap;
  }, [drawing]); // only recreated when the drawing changes

  // ── Hit-testing for annotation selection ──────────────────────────────

  const hitTestAnnotations = useCallback((screenX: number, screenY: number): SelectedAnnotation2D | null => {
    const { textAnnotations2D: texts, cloudAnnotations2D: clouds,
      polygonArea2DResults: polys, measure2DResults: measures } = storeRef.current;
    return hitTestAnnotationsPure({
      screenX, screenY, threshold: HIT_TEST_RADIUS_PX, drawingToScreen,
      texts, clouds, polys, measures,
    });
  }, [drawingToScreen]); // stable — reads annotation data from storeRef

  // ── Get annotation origin (reads latest data from refs) ───────────────

  const getAnnotationOrigin = useCallback((sel: SelectedAnnotation2D): Point2D | null => {
    const s = storeRef.current;
    switch (sel.type) {
      case 'measure': { const r = s.measure2DResults.find((m) => m.id === sel.id); return r ? r.start : null; }
      case 'polygon': { const r = s.polygonArea2DResults.find((p) => p.id === sel.id); return r?.points[0] ?? null; }
      case 'text': { const a = s.textAnnotations2D.find((t) => t.id === sel.id); return a ? a.position : null; }
      case 'cloud': { const c = s.cloudAnnotations2D.find((cl) => cl.id === sel.id); return c?.points[0] ?? null; }
    }
    return null;
  }, []);

  // ── Commit drag position to store (stable via ref) ─────────────────

  const moveAnnotationRef = useRef(moveAnnotation2D);
  moveAnnotationRef.current = moveAnnotation2D;

  const commitDragPosition = useCallback((sel: SelectedAnnotation2D, newOrigin: Point2D) => {
    moveAnnotationRef.current(sel, newOrigin);
  }, []);

  const isNearFirstVertex = useCallback((drawingCoord: Point2D): boolean => {
    if (polygonArea2DPoints.length < 3) return false;
    const first = polygonArea2DPoints[0];
    const threshold = CLOSE_POLYGON_THRESHOLD_PX / scaleRef.current;
    const dx = drawingCoord.x - first.x;
    const dy = drawingCoord.y - first.y;
    return Math.sqrt(dx * dx + dy * dy) < threshold;
  }, [polygonArea2DPoints]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shiftHeldRef.current = true;
      }
      if (e.key === 'Escape') {
        // 1. Cancel in-progress work
        if (activeTool === 'polygon-area') cancelPolygonArea2D();
        else if (activeTool === 'cloud') cancelCloudAnnotation2D();
        else if (activeTool === 'text') setTextAnnotation2DEditing(null);
        // 2. Exit any creation tool back to select/pan
        if (activeTool !== 'none') {
          setActiveTool('none');
        }
        // 3. Deselect
        if (storeRef.current.selectedAnnotation2D) setSelectedAnnotation2D(null);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && storeRef.current.selectedAnnotation2D) {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        deleteSelectedAnnotation2D();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftHeldRef.current = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [activeTool, setActiveTool, cancelPolygonArea2D, cancelCloudAnnotation2D,
    setTextAnnotation2DEditing, setSelectedAnnotation2D, deleteSelectedAnnotation2D]);

  // ── Mouse handlers ────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent): boolean => {
    if (e.button !== 0) return false;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return false;

    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const drawingCoord = screenToDrawing(screenX, screenY);

    // ── Tool-specific placement ─────────────────────────────────────────
    if (activeTool !== 'none' && activeTool !== 'measure') {
      const snapPoint = findSnapPoint(drawingCoord);
      let point = snapPoint || drawingCoord;

      switch (activeTool) {
        case 'polygon-area': {
          if (shiftHeldRef.current && polygonArea2DPoints.length > 0) {
            point = applyShiftConstraint(polygonArea2DPoints[polygonArea2DPoints.length - 1], point);
          }
          if (isNearFirstVertex(point)) {
            completePolygonArea2D(computePolygonArea(polygonArea2DPoints), computePolygonPerimeter(polygonArea2DPoints));
          } else {
            addPolygonArea2DPoint(point);
          }
          return true;
        }
        case 'text': {
          const annotation: TextAnnotation2D = {
            id: `text-${Date.now()}`,
            position: point,
            text: '',
            fontSize: 14,
            color: '#000000',
            backgroundColor: 'rgba(255,255,255,0.9)',
            borderColor: '#333333',
          };
          addTextAnnotation2D(annotation);
          setTextAnnotation2DEditing(annotation.id);
          return true;
        }
        case 'cloud': {
          if (shiftHeldRef.current && cloudAnnotation2DPoints.length === 1) {
            const firstPt = cloudAnnotation2DPoints[0];
            const dx = point.x - firstPt.x;
            const dy = point.y - firstPt.y;
            const maxDelta = Math.max(Math.abs(dx), Math.abs(dy));
            point = { x: firstPt.x + Math.sign(dx) * maxDelta, y: firstPt.y + Math.sign(dy) * maxDelta };
          }
          addCloudAnnotation2DPoint(point);
          if (cloudAnnotation2DPoints.length === 1) {
            setTimeout(() => completeCloudAnnotation2D(''), 0);
          }
          return true;
        }
      }
    }

    // ── Selection / drag (tool is 'none' or 'measure') ──────────────────
    const hit = hitTestAnnotations(screenX, screenY);
    if (hit) {
      setSelectedAnnotation2D(hit);
      const origin = getAnnotationOrigin(hit);
      if (origin) {
        isDraggingRef.current = true;
        dragOffsetRef.current = { x: drawingCoord.x - origin.x, y: drawingCoord.y - origin.y };
      }
      return true; // consumed — don't start panning
    }

    // Clicked empty space — deselect
    if (storeRef.current.selectedAnnotation2D) {
      setSelectedAnnotation2D(null);
    }
    return false; // not consumed — let panning proceed
  }, [activeTool, containerRef, screenToDrawing, findSnapPoint, isNearFirstVertex,
    applyShiftConstraint, polygonArea2DPoints, addPolygonArea2DPoint, completePolygonArea2D,
    addTextAnnotation2D, setTextAnnotation2DEditing,
    cloudAnnotation2DPoints, addCloudAnnotation2DPoint, completeCloudAnnotation2D,
    hitTestAnnotations, getAnnotationOrigin, setSelectedAnnotation2D]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const drawingCoord = screenToDrawing(screenX, screenY);

    // ── Dragging: commit position directly to store ─────────────────────
    if (isDraggingRef.current && dragOffsetRef.current) {
      // Throttle: Zustand set() is synchronous, but we skip if position
      // hasn't changed meaningfully (< 0.5 screen px)
      const newDrawingPos: Point2D = {
        x: drawingCoord.x - dragOffsetRef.current.x,
        y: drawingCoord.y - dragOffsetRef.current.y,
      };
      // We call the store action directly — it's already optimized for single-item updates
      const sel = storeRef.current.selectedAnnotation2D;
      if (sel) {
        commitDragPosition(sel, newDrawingPos);
      }
      return;
    }

    // ── Tool preview ────────────────────────────────────────────────────
    if (activeTool === 'none' || activeTool === 'measure') return;

    const snapPoint = findSnapPoint(drawingCoord);
    setMeasure2DSnapPoint(snapPoint);
    let point = snapPoint || drawingCoord;

    if (shiftHeldRef.current && activeTool === 'polygon-area' && polygonArea2DPoints.length > 0) {
      point = applyShiftConstraint(polygonArea2DPoints[polygonArea2DPoints.length - 1], point);
    }
    if (shiftHeldRef.current && activeTool === 'cloud' && cloudAnnotation2DPoints.length === 1) {
      const firstPt = cloudAnnotation2DPoints[0];
      const dx = point.x - firstPt.x;
      const dy = point.y - firstPt.y;
      const maxDelta = Math.max(Math.abs(dx), Math.abs(dy));
      point = { x: firstPt.x + Math.sign(dx) * maxDelta, y: firstPt.y + Math.sign(dy) * maxDelta };
    }

    setAnnotation2DCursorPos(point);
  }, [activeTool, containerRef, screenToDrawing, findSnapPoint, setMeasure2DSnapPoint,
    setAnnotation2DCursorPos, applyShiftConstraint, polygonArea2DPoints, cloudAnnotation2DPoints,
    commitDragPosition]);

  const handleMouseUp = useCallback((_e: React.MouseEvent) => {
    isDraggingRef.current = false;
    dragOffsetRef.current = null;
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (activeTool === 'polygon-area' && polygonArea2DPoints.length >= 3) {
      e.preventDefault();
      completePolygonArea2D(computePolygonArea(polygonArea2DPoints), computePolygonPerimeter(polygonArea2DPoints));
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const hit = hitTestAnnotations(e.clientX - rect.left, e.clientY - rect.top);
    if (hit && hit.type === 'text') {
      e.preventDefault();
      setSelectedAnnotation2D(hit);
      setTextAnnotation2DEditing(hit.id);
    }
  }, [activeTool, polygonArea2DPoints, completePolygonArea2D, containerRef,
    hitTestAnnotations, setSelectedAnnotation2D, setTextAnnotation2DEditing]);

  return {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleDoubleClick,
    isDraggingRef,
  };
}

export default useAnnotation2D;
