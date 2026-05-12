/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Drawing2D, DrawingSheet } from '@ifc-lite/drawing-2d';

interface UseViewControlsParams {
  drawing: Drawing2D | null;
  sectionPlane: { axis: 'down' | 'front' | 'side'; position: number; flipped: boolean };
  containerRef: React.RefObject<HTMLDivElement | null>;
  panelVisible: boolean;
  status: string;
  sheetEnabled: boolean;
  activeSheet: DrawingSheet | null;
  isPinned: boolean;
  cachedSheetTransformRef: React.MutableRefObject<{
    translateX: number;
    translateY: number;
    scaleFactor: number;
  } | null>;
}

interface UseViewControlsResult {
  viewTransform: { x: number; y: number; scale: number };
  setViewTransform: React.Dispatch<React.SetStateAction<{ x: number; y: number; scale: number }>>;
  zoomIn: () => void;
  zoomOut: () => void;
  fitToView: () => void;
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
  const [needsFit, setNeedsFit] = useState(true); // Force fit on first open and axis change
  const prevAxisRef = useRef(sectionPlane.axis); // Track axis changes
  const prevFlippedRef = useRef(sectionPlane.flipped); // Track flip changes

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
    const currentAxis = sectionPlane.axis;
    const flipY = currentAxis !== 'down';
    const flipX = currentAxis === 'side';

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

  // Set needsFit when axis OR flip changes. Flip mirrors the projection's U
  // axis (see `projectTo2D` in @ifc-lite/drawing-2d), so the polygon bounds
  // jump from positive X into negative X (or vice versa). Without re-fitting
  // the new bounds end up off-screen and the user sees "empty 2D panel after
  // I pressed Flip" — that was the bug behind the recent screenshot report.
  useEffect(() => {
    const axisChanged = sectionPlane.axis !== prevAxisRef.current;
    const flipChanged = sectionPlane.flipped !== prevFlippedRef.current;
    if (axisChanged || flipChanged) {
      prevAxisRef.current = sectionPlane.axis;
      prevFlippedRef.current = sectionPlane.flipped;
      setNeedsFit(true);
      cachedSheetTransformRef.current = null;
    }
  }, [sectionPlane.axis, sectionPlane.flipped]);

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

  // Auto-fit when: (1) needsFit is true (first open or axis change), or (2) not pinned after regenerate
  // ALWAYS fit when axis changed, regardless of pin state
  // Also re-run when panelVisible changes so we fit when panel opens with existing drawing
  useEffect(() => {
    if (status === 'ready' && drawing && containerRef.current && panelVisible) {
      const axisChanged = lastFitAxisRef.current !== sectionPlane.axis;

      // Fit if needsFit (first open/axis change) OR if not pinned OR if axis just changed
      if (needsFit || !isPinned || axisChanged) {
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
  }, [status, drawing, fitToView, isPinned, needsFit, sectionPlane.axis, panelVisible]);

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
