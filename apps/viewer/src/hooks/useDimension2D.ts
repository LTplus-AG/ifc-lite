/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 2D drawing panel's dimension tool and the dimensions' canvas scene.
 *
 * Tool: click the first measured point, click the second, click to place the
 * dimension line. Points snap to the drawing (`findDrawingSnap`: endpoint,
 * intersection, midpoint, perpendicular from the first point, nearest); the
 * element a point snapped to is kept as its reference. Aligned by default;
 * Shift on the third click locks the line horizontal or vertical. Esc is the
 * panel's cancel command (`useAnnotation2D`): it leaves the tool, which clears
 * the placed points (`setAnnotation2DActiveTool`).
 *
 * With the Select tool, a dimension is selected and dragged like the other
 * markup kinds (Delete and move go through the slice's shared
 * `deleteSelectedAnnotation2D` / `moveAnnotation2D`). Hovering a dimension
 * from another cut reports where, so the panel can name it.
 *
 * Kept out of `useAnnotation2D` and `Drawing2DCanvas`, which are held to a
 * module-size budget: the canvas only calls `scene` through its overlay hook.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { Drawing2D, DrawingSheet } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { resolveSheetTransform } from '@/lib/drawing/sheet-transform';
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key';
import type { SectionAxis } from '@/hooks/pdfSectionLayout';
import { shapeKeyPoints } from '@/lib/drafting-core/curves';
import type { SnapMode } from '@/lib/drafting-core/types';
import { findDrawingSnap, getDrawingSnapIndex, snapToleranceForScale, type DrawingSnapSource } from '@/lib/drawing2d-markup/drawing-snap';
import { formatDimensionValue } from '@/lib/drawing2d-markup/dimension-graphics';
import { drawingViewMapping, type DrawingViewMapping } from '@/lib/drawing2d-markup/drawing-view-mapping';
import { placementOffset, placementOrientation, previewDimension } from '@/lib/drawing2d-markup/dimension-placement';
import { hitTestDimensions, insideScreenClip, sheetViewportScreenRect, type DimensionLayoutContext, type DimensionScene } from '@/components/viewer/drawing/drawDimensions2D';
import { dimensionPlaneStamp, isDimensionOnPlane, type Dimension2DElementRef } from '@/store/slices/drawing2DDimensions';
import type { DrawnSectionPlane, Point2D } from '@/store/slices/drawing2DSlice';

/** Radius around the cursor in which key points are marked while the tool is active. */
const MARKER_RADIUS_PX = 40;
const MAX_MARKERS = 200;

export interface UseDimension2DParams {
  drawing: Drawing2D | null;
  viewTransform: { x: number; y: number; scale: number };
  axis: SectionAxis;
  containerRef: React.RefObject<HTMLElement | null>;
  /** The plane drawn now (stamped on new dimensions; others are drawn dimmed). */
  drawnPlane: DrawnSectionPlane;
  /** Drawing scale denominator for direct mode (`drawing2DDisplayOptions.scale`). */
  displayScale: number;
  showHiddenLines: boolean;
  unitDisplayOverrides: Record<string, string>;
  sheet?: { sheet: DrawingSheet; isPinned: boolean; cached: CachedSheetTransform | null };
}

export interface DimensionHover {
  id: string;
  x: number;
  y: number;
}

/** The IFC element a snap landed on, when its model can name it. */
export function dimensionElementRef(source: DrawingSnapSource | undefined): Dimension2DElementRef | undefined {
  if (!source) return undefined;
  const state = useViewerStore.getState();
  const ref = resolveEntityRef(source.entityId);
  const store = ref.modelId === 'legacy' ? state.ifcDataStore : state.models.get(ref.modelId)?.ifcDataStore;
  const globalId = store?.entities?.getGlobalId(ref.expressId);
  const ifcType = store?.entities?.getTypeName(ref.expressId);
  return globalId && ifcType ? { globalId, ifcType } : undefined;
}

function useMapping(p: UseDimension2DParams): DrawingViewMapping {
  const { drawing, viewTransform, axis, sheet } = p;
  const placement = useMemo(() => (drawing && sheet ? resolveSheetTransform({
    sheet: sheet.sheet, axis, isPinned: sheet.isPinned, cached: sheet.cached,
    drawingBounds: { minX: drawing.bounds.min.x, minY: drawing.bounds.min.y, maxX: drawing.bounds.max.x, maxY: drawing.bounds.max.y },
  }).transform : null), [drawing, axis, sheet?.sheet, sheet?.isPinned, sheet?.cached]);
  return useMemo(() => drawingViewMapping(viewTransform, axis, placement),
    [viewTransform.x, viewTransform.y, viewTransform.scale, axis, placement]);
}

export function useDimension2D(p: UseDimension2DParams) {
  const { drawing, containerRef, drawnPlane, showHiddenLines, unitDisplayOverrides } = p;
  const activeTool = useViewerStore((s) => s.annotation2DActiveTool);
  const dimensions = useViewerStore((s) => s.dimensions2D);
  const points = useViewerStore((s) => s.dimension2DPoints);
  const selected = useViewerStore((s) => s.selectedAnnotation2D);
  const toolActive = activeTool === 'dimension';

  const [cursor, setCursor] = useState<Point2D | null>(null);
  const [lockAxis, setLockAxis] = useState(false);
  const [snap, setSnap] = useState<{ point: Point2D; mode: SnapMode; source: DrawingSnapSource } | null>(null);
  const [markers, setMarkers] = useState<Point2D[]>([]);
  const [hover, setHover] = useState<DimensionHover | null>(null);
  const refs = useRef<(Dimension2DElementRef | undefined)[]>([]);
  const dragging = useRef<{ id: string; grab: Point2D } | null>(null);

  const mapping = useMapping(p);
  const paperScale = p.sheet ? p.sheet.sheet.scale.factor : p.displayScale;
  const layout: DimensionLayoutContext = useMemo(() => ({
    mapping, paperScale, format: (m: number) => formatDimensionValue(m, unitDisplayOverrides),
  }), [mapping, paperScale, unitDisplayOverrides]);
  // Sheet mode clips dimensions to the viewport (the canvas's own rect); outside it
  // nothing is hit, hovered or placed, so the frame and title block stay inert.
  const viewport = p.sheet?.sheet.viewportBounds;
  const { x: vx, y: vy, scale: vs } = p.viewTransform;
  const clip = useMemo(() => (viewport ? sheetViewportScreenRect(viewport, { x: vx, y: vy, scale: vs }) : null), [viewport, vx, vy, vs]);

  // Leaving the tool (Esc, another tool) drops the preview and pending references.
  useEffect(() => {
    if (toolActive) return;
    setCursor(null); setSnap(null); setMarkers([]);
  }, [toolActive]);
  useEffect(() => { if (points.length === 0) refs.current = []; }, [points.length]);
  // A new or regenerated drawing: the snap glyph, key-point markers and hover note (its
  // "Other cut" verdict) belong to the old geometry and cut; hover otherwise updates only on pointer moves.
  useEffect(() => { setSnap(null); setMarkers([]); setHover(null); }, [drawing]);
  // Points placed on one cut cannot be completed on another: a cut change drops them.
  const planeKey = JSON.stringify(dimensionPlaneStamp(drawnPlane) ?? null);
  const lastPlaneKey = useRef(planeKey);
  useEffect(() => {
    if (lastPlaneKey.current === planeKey) return;
    lastPlaneKey.current = planeKey;
    useViewerStore.getState().cancelDimension2D();
  }, [planeKey]);
  // Shift pressed or released without moving the pointer: the preview follows,
  // so it shows the orientation the next click commits.
  useEffect(() => {
    if (!toolActive) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Shift') setLockAxis(e.type === 'keydown'); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); };
  }, [toolActive]);
  useEffect(() => {
    const release = () => { dragging.current = null; };
    window.addEventListener('mouseup', release);
    return () => window.removeEventListener('mouseup', release);
  }, []);

  const screenPoint = (e: React.MouseEvent): Point2D | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : null;
  };

  /** The cursor in drawing metres, snapped while one of the two measured points is being placed. */
  const resolvePoint = useCallback((screen: Point2D) => {
    const raw = mapping.toDrawing(screen);
    const state = useViewerStore.getState();
    const placed = state.dimension2DPoints;
    if (!drawing || placed.length >= 2) return { point: raw, hit: null };
    const hit = findDrawingSnap(drawing, raw, {
      tolerance: snapToleranceForScale(mapping.pxPerMetre),
      from: placed[0] ?? null,
      includeHiddenLines: showHiddenLines,
    });
    return { point: hit?.point ?? raw, hit };
  }, [drawing, mapping, showHiddenLines]);

  const nearbyKeyPoints = useCallback((at: Point2D): Point2D[] => {
    if (!drawing) return [];
    const r = MARKER_RADIUS_PX / mapping.pxPerMetre;
    const snapIndex = getDrawingSnapIndex(drawing, { includeHiddenLines: showHiddenLines });
    const out: Point2D[] = [];
    for (const i of snapIndex.index.query({ x: at.x - r, y: at.y - r }, { x: at.x + r, y: at.y + r })) {
      const kp = shapeKeyPoints(snapIndex.shapes[i]);
      for (const q of [...kp.endpoints, ...kp.midpoints]) {
        if (Math.hypot(q.x - at.x, q.y - at.y) <= r) out.push(q);
        if (out.length >= MAX_MARKERS) return out;
      }
    }
    return out;
  }, [drawing, mapping, showHiddenLines]);

  function handleMouseDown(e: React.MouseEvent): boolean {
    if (e.button !== 0) return false;
    const screen = screenPoint(e);
    if (!screen) return false;
    const state = useViewerStore.getState();
    if (state.annotation2DActiveTool === 'dimension') {
      if (!insideScreenClip(clip, screen)) return true;
      const placed = state.dimension2DPoints;
      const { point, hit } = resolvePoint(screen);
      if (placed.length < 2) {
        refs.current[placed.length] = dimensionElementRef(hit?.source);
        state.addDimension2DPoint(point);
      } else {
        const [a, b] = placed;
        const orientation = placementOrientation(a, b, point, e.shiftKey);
        const [refA, refB] = refs.current;
        state.completeDimension2D({
          offset: placementOffset(a, b, orientation, point),
          orientation,
          plane: drawnPlane,
          ...(refA || refB ? { refs: { ...(refA ? { a: refA } : {}), ...(refB ? { b: refB } : {}) } } : {}),
        });
        refs.current = [];
        setSnap(null);
      }
      return true;
    }
    if (state.annotation2DActiveTool !== 'none' || !insideScreenClip(clip, screen)) return false;
    const hitDim = hitTestDimensions(state.dimensions2D, screen, layout);
    if (!hitDim) return false;
    state.setSelectedAnnotation2D({ type: 'dimension', id: hitDim.id });
    const at = mapping.toDrawing(screen);
    dragging.current = { id: hitDim.id, grab: { x: at.x - hitDim.a.x, y: at.y - hitDim.a.y } };
    return true;
  }

  function handleMouseMove(e: React.MouseEvent): boolean {
    const screen = screenPoint(e);
    if (!screen) return false;
    const state = useViewerStore.getState();
    const drag = dragging.current;
    if (drag) {
      const at = mapping.toDrawing(screen);
      state.moveAnnotation2D({ type: 'dimension', id: drag.id }, { x: at.x - drag.grab.x, y: at.y - drag.grab.y });
      return true;
    }
    if (state.annotation2DActiveTool === 'dimension') {
      if (hover) setHover(null);
      if (!insideScreenClip(clip, screen)) {
        setCursor(null); setSnap(null); setMarkers([]);
        return true;
      }
      const { point, hit } = resolvePoint(screen);
      setCursor(point);
      setLockAxis(e.shiftKey);
      setSnap(hit);
      setMarkers(state.dimension2DPoints.length < 2 ? nearbyKeyPoints(point) : []);
      return true;
    }
    const hitDim = insideScreenClip(clip, screen) ? hitTestDimensions(state.dimensions2D, screen, layout) : null;
    const next = hitDim && !isDimensionOnPlane(hitDim, drawnPlane) ? hitDim.id : null;
    if (next !== (hover?.id ?? null)) setHover(next ? { id: next, x: screen.x, y: screen.y } : null);
    return false;
  }

  /** The pointer left the canvas: drop the preview, snap glyph and hover note; placed points stay. */
  const handleMouseLeave = useCallback(() => {
    setCursor(null); setSnap(null); setMarkers([]); setHover(null);
  }, []);

  const scene: DimensionScene | null = useMemo(() => {
    if (dimensions.length === 0 && !toolActive) return null;
    return {
      dimensions,
      currentPlane: drawnPlane,
      selectedId: selected?.type === 'dimension' ? selected.id : null,
      layout,
      ...(toolActive ? {
        preview: previewDimension(points, cursor, lockAxis),
        placedPoints: points,
        snap,
        markers,
      } : {}),
    };
  }, [dimensions, drawnPlane, selected, layout, toolActive, points, cursor, lockAxis, snap, markers]);

  return {
    handleMouseDown,
    handleMouseMove,
    handleMouseLeave,
    scene,
    hover,
    snapMode: toolActive ? snap?.mode ?? null : null,
    step: points.length,
    lockAxis,
  };
}

export type DimensionTool = ReturnType<typeof useDimension2D>;
