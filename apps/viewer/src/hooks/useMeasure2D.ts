/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hook for 2D measurement tool logic
 * Extracts pan/measure mouse handling, snapping, orthogonal constraints,
 * and keyboard/global-mouseup effects from Section2DPanel.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { axisFlipForSection } from '@/hooks/pdfSectionLayout';

// ─── Public interfaces ──────────────────────────────────────────────────────

export interface UseMeasure2DParams {
  drawing: Drawing2D | null;
  viewTransform: { x: number; y: number; scale: number };
  setViewTransform: React.Dispatch<React.SetStateAction<{ x: number; y: number; scale: number }>>;
  sectionAxis: 'down' | 'front' | 'side';
  containerRef: React.RefObject<HTMLDivElement | null>;
  // Store state
  measure2DMode: boolean;
  measure2DStart: { x: number; y: number } | null;
  measure2DCurrent: { x: number; y: number } | null;
  measure2DShiftLocked: boolean;
  measure2DLockedAxis: 'x' | 'y' | null;
  setMeasure2DStart: (pt: { x: number; y: number }) => void;
  setMeasure2DCurrent: (pt: { x: number; y: number }) => void;
  setMeasure2DShiftLocked: (locked: boolean, axis?: 'x' | 'y') => void;
  setMeasure2DSnapPoint: (pt: { x: number; y: number } | null) => void;
  cancelMeasure2D: () => void;
  completeMeasure2D: () => void;
}

export interface UseMeasure2DResult {
  handleMouseDown: (e: React.MouseEvent) => void;
  handleMouseMove: (e: React.MouseEvent) => void;
  handleMouseUp: () => void;
  handleMouseLeave: () => void;
  handleMouseEnter: (e: React.MouseEvent) => void;
}

// ─── Hook implementation ────────────────────────────────────────────────────

export function useMeasure2D({
  drawing,
  viewTransform,
  setViewTransform,
  sectionAxis,
  containerRef,
  measure2DMode,
  measure2DStart,
  measure2DCurrent,
  measure2DShiftLocked,
  measure2DLockedAxis,
  setMeasure2DStart,
  setMeasure2DCurrent,
  setMeasure2DShiftLocked,
  setMeasure2DSnapPoint,
  cancelMeasure2D,
  completeMeasure2D,
}: UseMeasure2DParams): UseMeasure2DResult {
  // ── Internal refs ───────────────────────────────────────────────────────
  const isPanning = useRef(false);
  const lastPanPoint = useRef({ x: 0, y: 0 });
  const isMouseButtonDown = useRef(false);
  const isMouseInsidePanel = useRef(true);

  // ═══════════════════════════════════════════════════════════════════════
  // 2D MEASURE TOOL HELPER FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════

  // Convert screen coordinates to drawing coordinates
  const screenToDrawing = useCallback((screenX: number, screenY: number): { x: number; y: number } => {
    // Screen coord → drawing coord
    // Apply axis-specific inverse transforms (matching canvas rendering)
    const { flipX, flipY } = axisFlipForSection(sectionAxis);

    // Inverse of: screenX = drawingX * scaleX + transform.x
    // where scaleX = flipX ? -scale : scale
    const scaleX = flipX ? -viewTransform.scale : viewTransform.scale;
    const scaleY = flipY ? -viewTransform.scale : viewTransform.scale;

    const x = (screenX - viewTransform.x) / scaleX;
    const y = (screenY - viewTransform.y) / scaleY;
    return { x, y };
  }, [viewTransform, sectionAxis]);

  // Find nearest point on a line segment
  const nearestPointOnSegment = useCallback((
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number }
  ): { point: { x: number; y: number }; dist: number } => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;

    if (lenSq < 0.0001) {
      // Degenerate segment
      const d = Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
      return { point: a, dist: d };
    }

    // Parameter t along segment [0,1]
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const nearest = { x: a.x + t * dx, y: a.y + t * dy };
    const dist = Math.sqrt((p.x - nearest.x) ** 2 + (p.y - nearest.y) ** 2);

    return { point: nearest, dist };
  }, []);

  // Find snap point near cursor (check polygon vertices, edges, and line endpoints)
  const findSnapPoint = useCallback((drawingCoord: { x: number; y: number }): { x: number; y: number } | null => {
    if (!drawing) return null;

    const snapThreshold = 10 / viewTransform.scale; // 10 screen pixels
    let bestSnap: { x: number; y: number } | null = null;
    let bestDist = snapThreshold;

    // Priority 1: Check polygon vertices (endpoints are highest priority)
    for (const polygon of drawing.cutPolygons) {
      for (const pt of polygon.polygon.outer) {
        const dist = Math.sqrt((pt.x - drawingCoord.x) ** 2 + (pt.y - drawingCoord.y) ** 2);
        if (dist < bestDist * 0.7) { // Vertices get priority (70% threshold)
          return { x: pt.x, y: pt.y }; // Return immediately for vertex snaps
        }
      }
      for (const hole of polygon.polygon.holes) {
        for (const pt of hole) {
          const dist = Math.sqrt((pt.x - drawingCoord.x) ** 2 + (pt.y - drawingCoord.y) ** 2);
          if (dist < bestDist * 0.7) {
            return { x: pt.x, y: pt.y };
          }
        }
      }
    }

    // Priority 2: Check line endpoints
    for (const line of drawing.lines) {
      const { start, end } = line.line;
      for (const pt of [start, end]) {
        const dist = Math.sqrt((pt.x - drawingCoord.x) ** 2 + (pt.y - drawingCoord.y) ** 2);
        if (dist < bestDist * 0.7) {
          return { x: pt.x, y: pt.y };
        }
      }
    }

    // Priority 3: Check polygon edges
    for (const polygon of drawing.cutPolygons) {
      const outer = polygon.polygon.outer;
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i];
        const b = outer[(i + 1) % outer.length];
        const { point, dist } = nearestPointOnSegment(drawingCoord, a, b);
        if (dist < bestDist) {
          bestDist = dist;
          bestSnap = point;
        }
      }
      for (const hole of polygon.polygon.holes) {
        for (let i = 0; i < hole.length; i++) {
          const a = hole[i];
          const b = hole[(i + 1) % hole.length];
          const { point, dist } = nearestPointOnSegment(drawingCoord, a, b);
          if (dist < bestDist) {
            bestDist = dist;
            bestSnap = point;
          }
        }
      }
    }

    // Priority 4: Check drawing lines
    for (const line of drawing.lines) {
      const { start, end } = line.line;
      const { point, dist } = nearestPointOnSegment(drawingCoord, start, end);
      if (dist < bestDist) {
        bestDist = dist;
        bestSnap = point;
      }
    }

    return bestSnap;
  }, [drawing, viewTransform.scale, nearestPointOnSegment]);

  // Apply orthogonal constraint if shift is held
  const applyOrthogonalConstraint = useCallback((start: { x: number; y: number }, current: { x: number; y: number }, lockedAxis: 'x' | 'y' | null): { x: number; y: number } => {
    if (!lockedAxis) return current;

    if (lockedAxis === 'x') {
      return { x: current.x, y: start.y };
    } else {
      return { x: start.x, y: current.y };
    }
  }, []);

  // ═══════════════════════════════════════════════════════════════════════
  // EFFECTS
  // ═══════════════════════════════════════════════════════════════════════

  // Keyboard handlers for shift key (orthogonal constraint)
  useEffect(() => {
    if (!measure2DMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && measure2DStart && measure2DCurrent && !measure2DShiftLocked) {
        // Determine axis based on dominant direction
        const dx = Math.abs(measure2DCurrent.x - measure2DStart.x);
        const dy = Math.abs(measure2DCurrent.y - measure2DStart.y);
        const axis = dx > dy ? 'x' : 'y';
        setMeasure2DShiftLocked(true, axis);
      }
      if (e.key === 'Escape') {
        cancelMeasure2D();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setMeasure2DShiftLocked(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [measure2DMode, measure2DStart, measure2DCurrent, measure2DShiftLocked, setMeasure2DShiftLocked, cancelMeasure2D]);

  // Global mouseup handler to cancel measurement if released outside panel
  useEffect(() => {
    if (!measure2DMode) return;

    const handleGlobalMouseUp = (e: MouseEvent) => {
      // If mouse button is released and we're outside the panel with a measurement started, cancel it
      if (!isMouseInsidePanel.current && measure2DStart && e.button === 0) {
        cancelMeasure2D();
      }
      isMouseButtonDown.current = false;
    };

    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [measure2DMode, measure2DStart, cancelMeasure2D]);

  // ═══════════════════════════════════════════════════════════════════════
  // PAN / MEASURE HANDLERS
  // ═══════════════════════════════════════════════════════════════════════

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;

    isMouseButtonDown.current = true;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    if (measure2DMode) {
      // Measure mode: set start point
      const drawingCoord = screenToDrawing(screenX, screenY);
      const snapPoint = findSnapPoint(drawingCoord);
      const startPoint = snapPoint || drawingCoord;
      setMeasure2DStart(startPoint);
      setMeasure2DCurrent(startPoint);
    } else {
      // Pan mode
      isPanning.current = true;
      lastPanPoint.current = { x: e.clientX, y: e.clientY };
    }
  }, [measure2DMode, screenToDrawing, findSnapPoint, setMeasure2DStart, setMeasure2DCurrent]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    if (measure2DMode) {
      const drawingCoord = screenToDrawing(screenX, screenY);

      // Find snap point and update
      const snapPoint = findSnapPoint(drawingCoord);
      setMeasure2DSnapPoint(snapPoint);

      if (measure2DStart) {
        // If measuring, update current point
        let currentPoint = snapPoint || drawingCoord;

        // Apply orthogonal constraint if shift is held
        if (measure2DShiftLocked && measure2DLockedAxis) {
          currentPoint = applyOrthogonalConstraint(measure2DStart, currentPoint, measure2DLockedAxis);
        }

        setMeasure2DCurrent(currentPoint);
      }
    } else if (isPanning.current) {
      // Pan mode
      const dx = e.clientX - lastPanPoint.current.x;
      const dy = e.clientY - lastPanPoint.current.y;
      lastPanPoint.current = { x: e.clientX, y: e.clientY };
      setViewTransform((prev) => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy,
      }));
    }
  }, [measure2DMode, measure2DStart, measure2DShiftLocked, measure2DLockedAxis, screenToDrawing, findSnapPoint, setMeasure2DSnapPoint, setMeasure2DCurrent, applyOrthogonalConstraint]);

  const handleMouseUp = useCallback(() => {
    isMouseButtonDown.current = false;
    if (measure2DMode && measure2DStart && measure2DCurrent) {
      // Complete the measurement
      completeMeasure2D();
    }
    isPanning.current = false;
  }, [measure2DMode, measure2DStart, measure2DCurrent, completeMeasure2D]);

  const handleMouseLeave = useCallback(() => {
    isMouseInsidePanel.current = false;
    // Don't cancel if button is still down - user might re-enter
    // Cancel will happen on global mouseup if released outside
    isPanning.current = false;
  }, []);

  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    isMouseInsidePanel.current = true;
    // If re-entering with button down and measurement started, resume tracking
    if (isMouseButtonDown.current && measure2DMode && measure2DStart) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const drawingCoord = screenToDrawing(screenX, screenY);
        const snapPoint = findSnapPoint(drawingCoord);
        const currentPoint = snapPoint || drawingCoord;
        setMeasure2DCurrent(currentPoint);
      }
    }
  }, [measure2DMode, measure2DStart, screenToDrawing, findSnapPoint, setMeasure2DCurrent]);

  return {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleMouseEnter,
  };
}

export default useMeasure2D;
