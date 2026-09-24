/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Drawing2D, DrawingSheet } from '@ifc-lite/drawing-2d';
import { sheetGeometryKeyOf, type CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key';
import { axisFlipForSection } from '@/hooks/pdfSectionLayout';

interface UseViewControlsParams {
  drawing: Drawing2D | null;
  sectionPlane: {
    axis: 'down' | 'front' | 'side';
    position: number;
    flipped: boolean;
    /** A face-picked plane; its identity (normal + pick point) is a new plane. */
    custom?: { normal: readonly number[]; pickedAt: readonly number[] };
  };
  containerRef: React.RefObject<HTMLDivElement | null>;
  panelVisible: boolean;
  status: string;
  sheetEnabled: boolean;
  activeSheet: DrawingSheet | null;
  isPinned: boolean;
  cachedSheetTransformRef: React.MutableRefObject<CachedSheetTransform | null>;
}

interface UseViewControlsResult {
  viewTransform: { x: number; y: number; scale: number };
  setViewTransform: React.Dispatch<React.SetStateAction<{ x: number; y: number; scale: number }>>;
  zoomIn: () => void;
  zoomOut: () => void;
  fitToView: () => void;
}

/** Identity of the cut plane: a change means the previous 2D transform is
 *  meaningless for the next drawing. The custom-plane distance is left out on
 *  purpose, since sliding a picked plane keeps its projection frame. */
function sectionPlaneKey(plane: UseViewControlsParams['sectionPlane']): string {
  const base = `${plane.axis}|${plane.flipped ? 'flipped' : 'normal'}`;
  if (!plane.custom) return base;
  const r = (v: number) => v.toFixed(4);
  return `${base}|${plane.custom.normal.map(r).join(',')}|${plane.custom.pickedAt.map(r).join(',')}`;
}

/** Does any part of `bounds` land inside the `rect`-sized canvas under
 *  `transform`? Mirrors the canvas's per-axis flips (see `fitToView`). */
function drawingIntersectsView(
  bounds: Drawing2D['bounds'],
  transform: { x: number; y: number; scale: number },
  axis: UseViewControlsParams['sectionPlane']['axis'],
  rect: { width: number; height: number },
): boolean {
  const { flipX, flipY } = axisFlipForSection(axis);
  const xs = [bounds.min.x, bounds.max.x].map((v) => (flipX ? -v : v) * transform.scale + transform.x);
  const ys = [bounds.min.y, bounds.max.y].map((v) => (flipY ? -v : v) * transform.scale + transform.y);
  return Math.max(...xs) > 0 && Math.min(...xs) < rect.width && Math.max(...ys) > 0 && Math.min(...ys) < rect.height;
}

function useViewControls({
  drawing,
  sectionPlane,
  containerRef,
  panelVisible,
  status,
  sheetEnabled,
  activeSheet,
  isPinned,
  cachedSheetTransformRef,
}: UseViewControlsParams): UseViewControlsResult {
  const [viewTransform, setViewTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [needsFit, setNeedsFit] = useState(true); // Force fit on first open and on a new plane
  const planeKey = sectionPlaneKey(sectionPlane);
  const prevPlaneKeyRef = useRef(planeKey);
  // Latest transform for the off-view check, read without re-running the
  // auto-fit effect on every pan (a deliberate pan must never snap back).
  const viewTransformRef = useRef(viewTransform);
  viewTransformRef.current = viewTransform;

  // Wheel zoom handler
  useEffect(() => {
    // Only attach handler when panel is visible
    if (!panelVisible) return;

    const container = containerRef.current;
    if (!container) {
      // Container not ready yet, try again on next render
      return;
    }

    const wheelHandler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const rect = container.getBoundingClientRect();

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setViewTransform((prev) => {
        const newScale = Math.max(0.01, prev.scale * delta);
        const scaleRatio = newScale / prev.scale;
        return {
          scale: newScale,
          x: x - (x - prev.x) * scaleRatio,
          y: y - (y - prev.y) * scaleRatio,
        };
      });
    };

    container.addEventListener('wheel', wheelHandler, { passive: false });
    return () => {
      container.removeEventListener('wheel', wheelHandler);
    };
  }, [panelVisible, status]); // Re-run when panel visibility or status changes to ensure container is ready

  // Zoom controls - unlimited zoom
  const zoomIn = useCallback(() => {
    setViewTransform((prev) => ({ ...prev, scale: prev.scale * 1.2 })); // No upper limit
  }, []);

  const zoomOut = useCallback(() => {
    setViewTransform((prev) => ({ ...prev, scale: Math.max(0.01, prev.scale / 1.2) }));
  }, []);

  const fitToView = useCallback(() => {
    if (!drawing || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();

    // Sheet mode: fit the entire paper into view
    if (sheetEnabled && activeSheet) {
      const paperWidth = activeSheet.paper.widthMm;
      const paperHeight = activeSheet.paper.heightMm;

      // Calculate scale to fit paper with padding (10% margin on each side)
      const padding = 0.1;
      const availableWidth = rect.width * (1 - 2 * padding);
      const availableHeight = rect.height * (1 - 2 * padding);
      const scaleX = availableWidth / paperWidth;
      const scaleY = availableHeight / paperHeight;
      const scale = Math.min(scaleX, scaleY);

      // Center the paper in the view
      setViewTransform({
        scale,
        x: (rect.width - paperWidth * scale) / 2,
        y: (rect.height - paperHeight * scale) / 2,
      });
      return;
    }

    // Non-sheet mode: fit the drawing bounds
    const { bounds } = drawing;
    const width = bounds.max.x - bounds.min.x;
    const height = bounds.max.y - bounds.min.y;

    if (width < 0.001 || height < 0.001) return;

    // Calculate scale to fit with padding (15% margin on each side)
    const padding = 0.15;
    const availableWidth = rect.width * (1 - 2 * padding);
    const availableHeight = rect.height * (1 - 2 * padding);
    const scaleX = availableWidth / width;
    const scaleY = availableHeight / height;
    // No artificial cap - let it zoom to fit the content
    const scale = Math.min(scaleX, scaleY);

    // Center the drawing in the view with axis-specific transforms
    // Must match the canvas rendering transforms:
    // - 'down' (plan view): no Y flip
    // - 'front'/'side': Y flip
    // - 'side': X flip
    const { flipX, flipY } = axisFlipForSection(sectionPlane.axis);

    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const centerY = (bounds.min.y + bounds.max.y) / 2;

    // Apply transforms matching canvas rendering
    const adjustedCenterX = flipX ? -centerX : centerX;
    const adjustedCenterY = flipY ? -centerY : centerY;

    setViewTransform({
      scale,
      x: rect.width / 2 - adjustedCenterX * scale,
      y: rect.height / 2 - adjustedCenterY * scale,
    });
  }, [drawing, sheetEnabled, activeSheet, sectionPlane.axis]);

  // Track axis changes for forced fit-to-view
  const lastFitAxisRef = useRef(sectionPlane.axis);

  // Set needsFit on a NEW PLANE: axis, flip, or a face-picked custom plane.
  // Flip mirrors the projection's U axis (see `projectTo2D` in
  // @ifc-lite/drawing-2d), so the polygon bounds jump from positive X into
  // negative X (or vice versa); a picked face projects onto its own tangent
  // frame, unrelated to the previous plane's (#5392: cutting along the FZK
  // roof kept the plan view's transform and showed a cropped corner). Either
  // way the previous transform means nothing for the new drawing.
  useEffect(() => {
    if (planeKey !== prevPlaneKeyRef.current) {
      prevPlaneKeyRef.current = planeKey;
      setNeedsFit(true);
      cachedSheetTransformRef.current = null;
    }
  }, [planeKey]);

  // Panel resize keeps the drawing centred (#5392): the canvas grows or
  // shrinks around its centre, so shift the pan by half the size change.
  // Before, only the canvas size updated and the drawing slid toward a corner.
  useEffect(() => {
    const container = containerRef.current;
    if (!panelVisible || !container) return;
    let prev: { width: number; height: number } | null = null;
    const observer = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      if (prev && (width !== prev.width || height !== prev.height)) {
        const dx = (width - prev.width) / 2;
        const dy = (height - prev.height) / 2;
        setViewTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
      }
      prev = { width, height };
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [panelVisible, status]); // Re-run when the container can (re)appear, as the wheel handler does

  // Track previous sheet mode to detect toggle
  const prevSheetEnabledRef = useRef(sheetEnabled);
  useEffect(() => {
    if (sheetEnabled !== prevSheetEnabledRef.current) {
      prevSheetEnabledRef.current = sheetEnabled;
      cachedSheetTransformRef.current = null; // Clear cached transform
      // Auto-fit when sheet mode is toggled
      if (status === 'ready' && drawing && containerRef.current) {
        const timeout = setTimeout(() => {
          fitToView();
        }, 50);
        return () => clearTimeout(timeout);
      }
    }
  }, [sheetEnabled, status, drawing, fitToView]);

  // Track everything the cached transform is actually derived FROM
  // (`calculateDrawingTransform(drawingBounds, viewport, activeSheet.scale)`
  // in Drawing2DCanvas.tsx) rather than the sheet's id: `setPaperSize`,
  // `setFrameStyle`/`updateFrameMargins` (both recompute `viewportBounds`)
  // and `setDrawingScale` all mutate the SAME `activeSheet.id` in place
  // (sheetSlice.ts), while `loadTemplate` swaps in a different id entirely.
  // Any of these must invalidate the cache even though `sheetEnabled` never
  // toggles across the change. Without this, a pinned view kept the OLD
  // sheet's transform (position/scale computed for its old paper/viewport)
  // applied to the new content until the user flipped sheet mode off and
  // back on, or changed the section axis.
  //
  // This effect-driven clear is a best-effort SECOND line of defense, not the
  // correctness guarantee: `Drawing2DCanvas` is the CHILD of whichever
  // component calls this hook, and React commits child effects before parent
  // effects on the same update — so on the very render `sheetGeometryKey`
  // changes, the canvas's drawing effect can still read the STALE cached
  // transform (this effect hasn't nulled it yet), draw one frame with it, and
  // then never redraw again since nothing else changed (PR #2853 review). The
  // actual guarantee is `Drawing2DCanvas` validating the cached entry's own
  // `key` against the CURRENT `sheetGeometryKeyOf(activeSheet)` at the READ
  // site, before ever reusing it — see the module doc there.
  const sheetGeometryKey = sheetGeometryKeyOf(activeSheet);
  const prevSheetGeometryKeyRef = useRef(sheetGeometryKey);
  useEffect(() => {
    if (sheetGeometryKey !== prevSheetGeometryKeyRef.current) {
      prevSheetGeometryKeyRef.current = sheetGeometryKey;
      cachedSheetTransformRef.current = null;
    }
  }, [sheetGeometryKey, cachedSheetTransformRef]);

  // Auto-fit when: (1) needsFit is true (first open or a new plane), (2) not
  // pinned after regenerate, or (3) pinned, but the regenerated drawing lies
  // entirely outside the current view (#5392): pin keeps the user's framing,
  // and there is no framing left to keep when nothing of the drawing is in it.
  // Only a drawing change evaluates (3), never a pan, so a deliberate pan off
  // the drawing stays put. Sheet mode fits the paper, not the drawing bounds.
  // Also re-run when panelVisible changes so we fit when panel opens with existing drawing
  useEffect(() => {
    if (status === 'ready' && drawing && containerRef.current && panelVisible) {
      const axisChanged = lastFitAxisRef.current !== sectionPlane.axis;
      const rect = containerRef.current.getBoundingClientRect();
      const offView = !sheetEnabled
        && !drawingIntersectsView(drawing.bounds, viewTransformRef.current, sectionPlane.axis, rect);

      if (needsFit || !isPinned || axisChanged || offView) {
        // Small delay to ensure canvas is rendered
        const timeout = setTimeout(() => {
          fitToView();
          lastFitAxisRef.current = sectionPlane.axis;
          if (needsFit) {
            setNeedsFit(false); // Clear the flag after fitting
          }
        }, 50);
        return () => clearTimeout(timeout);
      }
    }
  }, [status, drawing, fitToView, isPinned, needsFit, sectionPlane.axis, panelVisible, sheetEnabled]);

  return {
    viewTransform,
    setViewTransform,
    zoomIn,
    zoomOut,
    fitToView,
  };
}

export { useViewControls };
export default useViewControls;
