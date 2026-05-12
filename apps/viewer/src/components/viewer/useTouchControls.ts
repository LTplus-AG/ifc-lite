/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Touch controls hook for the 3D viewport
 * Handles multi-touch gesture handling (orbit, pinch-zoom, pan, tap-to-select)
 */

import { useEffect, type MutableRefObject, type RefObject } from 'react';
import type { Renderer, PickResult } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import type { SectionPlane } from '@/store';

/** Locked gesture mode for 2-finger interactions */
type TwoFingerGesture = 'none' | 'pinch' | 'pan';

export interface TouchState {
  touches: Touch[];
  lastDistance: number;
  lastCenter: { x: number; y: number };
  tapStartTime: number;
  tapStartPos: { x: number; y: number };
  didMove: boolean;
  multiTouch: boolean;
  /** Locked 2-finger gesture mode (reset on finger lift) */
  twoFingerGesture: TwoFingerGesture;
  /** Accumulated distance change since 2-finger gesture start */
  gestureDistanceAccum: number;
  /** Accumulated center movement since 2-finger gesture start */
  gesturePanAccum: number;
}

export interface UseTouchControlsParams {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  touchStateRef: MutableRefObject<TouchState>;
  activeToolRef: MutableRefObject<string>;
  hiddenEntitiesRef: MutableRefObject<Set<number>>;
  isolatedEntitiesRef: MutableRefObject<Set<number> | null>;
  selectedEntityIdRef: MutableRefObject<number | null>;
  selectedModelIndexRef: MutableRefObject<number | undefined>;
  clearColorRef: MutableRefObject<[number, number, number, number]>;
  sectionPlaneRef: MutableRefObject<SectionPlane>;
  sectionRangeRef: MutableRefObject<{ min: number; max: number } | null>;
  geometryRef: MutableRefObject<MeshData[] | null>;
  isInteractingRef: MutableRefObject<boolean>;
  handlePickForSelection: (pickResult: PickResult | null) => void;
  getPickOptions: () => { isStreaming: boolean; hiddenIds: Set<number>; isolatedIds: Set<number> | null };
}

export function useTouchControls(params: UseTouchControlsParams): void {
  const {
    canvasRef,
    rendererRef,
    isInitialized,
    touchStateRef,
    activeToolRef,
    hiddenEntitiesRef,
    isolatedEntitiesRef,
    selectedEntityIdRef,
    selectedModelIndexRef,
    clearColorRef,
    sectionPlaneRef,
    sectionRangeRef,
    geometryRef,
    isInteractingRef,
    handlePickForSelection,
    getPickOptions,
  } = params;

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer || !isInitialized) return;

    const camera = renderer.getCamera();
    const touchState = touchStateRef.current;

    // Anchor the orbit pivot to the 3D point directly under a finger.
    // Touch UX: prefer the finger's actual hit, then fall back to ray-projection
    // at current view distance — never to a selected entity's center, which
    // would pivot far from the user's touch and feel disconnected.
    const anchorOrbitPivotUnderFinger = (touch: Touch) => {
      const rect = canvas.getBoundingClientRect();
      const tx = touch.clientX - rect.left;
      const ty = touch.clientY - rect.top;
      const hit = renderer.raycastScene(tx, ty, {
        hiddenIds: hiddenEntitiesRef.current,
        isolatedIds: isolatedEntitiesRef.current,
      });
      if (hit?.intersection) {
        camera.setOrbitCenter(hit.intersection.point);
        return;
      }
      const ray = camera.unprojectToRay(tx, ty, canvas.width, canvas.height);
      const target = camera.getTarget();
      const toTarget = {
        x: target.x - ray.origin.x,
        y: target.y - ray.origin.y,
        z: target.z - ray.origin.z,
      };
      const d = Math.max(
        1,
        toTarget.x * ray.direction.x + toTarget.y * ray.direction.y + toTarget.z * ray.direction.z,
      );
      camera.setOrbitCenter({
        x: ray.origin.x + ray.direction.x * d,
        y: ray.origin.y + ray.direction.y * d,
        z: ray.origin.z + ray.direction.z * d,
      });
    };

    const handleTouchStart = async (e: TouchEvent) => {
      e.preventDefault();
      touchState.touches = Array.from(e.touches);

      // Track multi-touch to prevent false tap-select after pinch/zoom
      if (touchState.touches.length > 1) {
        touchState.multiTouch = true;
      }

      if (touchState.touches.length === 1 && !touchState.multiTouch) {
        touchState.lastCenter = {
          x: touchState.touches[0].clientX,
          y: touchState.touches[0].clientY,
        };
        // Record tap start for tap-to-select detection
        touchState.tapStartTime = Date.now();
        touchState.tapStartPos = {
          x: touchState.touches[0].clientX,
          y: touchState.touches[0].clientY,
        };
        touchState.didMove = false;

        anchorOrbitPivotUnderFinger(touchState.touches[0]);
      } else if (touchState.touches.length === 1) {
        // Single touch after multi-touch - just update center for orbit
        touchState.lastCenter = {
          x: touchState.touches[0].clientX,
          y: touchState.touches[0].clientY,
        };
      } else if (touchState.touches.length === 2) {
        const dx = touchState.touches[1].clientX - touchState.touches[0].clientX;
        const dy = touchState.touches[1].clientY - touchState.touches[0].clientY;
        touchState.lastDistance = Math.sqrt(dx * dx + dy * dy);
        touchState.lastCenter = {
          x: (touchState.touches[0].clientX + touchState.touches[1].clientX) / 2,
          y: (touchState.touches[0].clientY + touchState.touches[1].clientY) / 2,
        };
        // Reset gesture lock for new 2-finger interaction
        touchState.twoFingerGesture = 'none';
        touchState.gestureDistanceAccum = 0;
        touchState.gesturePanAccum = 0;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      touchState.touches = Array.from(e.touches);

      if (touchState.touches.length === 1) {
        const dx = touchState.touches[0].clientX - touchState.lastCenter.x;
        const dy = touchState.touches[0].clientY - touchState.lastCenter.y;

        // Mark as moved if significant movement (prevents tap-select during drag)
        const totalDx = touchState.touches[0].clientX - touchState.tapStartPos.x;
        const totalDy = touchState.touches[0].clientY - touchState.tapStartPos.y;
        if (Math.abs(totalDx) > 10 || Math.abs(totalDy) > 10) {
          touchState.didMove = true;
        }

        camera.orbit(dx, dy, false);
        touchState.lastCenter = {
          x: touchState.touches[0].clientX,
          y: touchState.touches[0].clientY,
        };
        isInteractingRef.current = true;
        renderer.requestRender();
      } else if (touchState.touches.length === 2) {
        const dx1 = touchState.touches[1].clientX - touchState.touches[0].clientX;
        const dy1 = touchState.touches[1].clientY - touchState.touches[0].clientY;
        const distance = Math.sqrt(dx1 * dx1 + dy1 * dy1);

        const centerX = (touchState.touches[0].clientX + touchState.touches[1].clientX) / 2;
        const centerY = (touchState.touches[0].clientY + touchState.touches[1].clientY) / 2;
        const panDx = centerX - touchState.lastCenter.x;
        const panDy = centerY - touchState.lastCenter.y;

        const zoomDelta = distance - touchState.lastDistance;

        // Determine dominant gesture if not yet locked
        if (touchState.twoFingerGesture === 'none') {
          touchState.gestureDistanceAccum += Math.abs(zoomDelta);
          touchState.gesturePanAccum += Math.abs(panDx) + Math.abs(panDy);

          // Lock gesture after enough movement (8px threshold)
          const threshold = 8;
          if (touchState.gestureDistanceAccum > threshold || touchState.gesturePanAccum > threshold) {
            touchState.twoFingerGesture =
              touchState.gestureDistanceAccum > touchState.gesturePanAccum ? 'pinch' : 'pan';
          }
        }

        // Apply only the locked gesture
        if (touchState.twoFingerGesture === 'pan') {
          camera.pan(panDx, panDy, false);
        } else if (touchState.twoFingerGesture === 'pinch') {
          const rect = canvas.getBoundingClientRect();
          camera.zoom(zoomDelta * 3, false, centerX - rect.left, centerY - rect.top, canvas.width, canvas.height);
        }
        // While gesture is 'none' (detecting), don't apply either — avoids jitter

        touchState.lastDistance = distance;
        touchState.lastCenter = { x: centerX, y: centerY };
        isInteractingRef.current = true;
        renderer.requestRender();
      }
    };

    const handleTouchEnd = async (e: TouchEvent) => {
      e.preventDefault();
      const previousTouchCount = touchState.touches.length;
      const wasMultiTouch = touchState.multiTouch;
      touchState.touches = Array.from(e.touches);

      // Multi-touch → single-touch transition: re-anchor everything to the
      // remaining finger so the next orbit move computes a clean delta from
      // the finger's actual position (not the stale 2-finger midpoint) and
      // pivots under the finger (not the old pinch pivot).
      if (previousTouchCount >= 2 && touchState.touches.length === 1) {
        touchState.lastCenter = {
          x: touchState.touches[0].clientX,
          y: touchState.touches[0].clientY,
        };
        anchorOrbitPivotUnderFinger(touchState.touches[0]);
      }

      // Only clear interaction when all fingers are lifted (gesture truly ended).
      // Clearing earlier would briefly drop interaction mode during 2-finger → 1-finger
      // transitions, triggering an expensive full-quality render mid-gesture.
      if (touchState.touches.length === 0 && isInteractingRef.current) {
        isInteractingRef.current = false;
        renderer.requestRender();
      }

      if (touchState.touches.length === 0) {
        camera.stopInertia();

        // Tap-to-select: detect quick tap without significant movement
        const tapDuration = Date.now() - touchState.tapStartTime;
        const tool = activeToolRef.current;

        // Only select if:
        // - Was a single-finger touch (not after multi-touch gesture)
        // - Tap was quick (< 300ms)
        // - Didn't move significantly
        // - Tool supports selection (not pan/walk/measure)
        if (
          previousTouchCount === 1 &&
          !wasMultiTouch &&
          tapDuration < 300 &&
          !touchState.didMove &&
          tool !== 'pan' &&
          tool !== 'walk' &&
          tool !== 'measure'
        ) {
          const rect = canvas.getBoundingClientRect();
          const x = touchState.tapStartPos.x - rect.left;
          const y = touchState.tapStartPos.y - rect.top;

          const pickResult = await renderer.pick(x, y, getPickOptions());
          handlePickForSelection(pickResult);
        }

        // Reset multi-touch and gesture lock when all touches end
        touchState.multiTouch = false;
        touchState.twoFingerGesture = 'none';
        touchState.gestureDistanceAccum = 0;
        touchState.gesturePanAccum = 0;
      }
    };

    // Also reset interaction on touchcancel — mobile browsers can cancel
    // gestures (system gestures, tab switch, lost focus) without touchend.
    const handleTouchCancel = () => {
      if (isInteractingRef.current) {
        isInteractingRef.current = false;
        renderer.requestRender();
      }
      touchState.touches = [];
      touchState.multiTouch = false;
    };

    // Use { passive: false } to ensure preventDefault() works on mobile
    // Safari and Chrome mobile require this for smooth touch handling
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', handleTouchCancel);

    // Prevent iOS Safari pull-to-refresh and elastic bounce on the canvas
    const preventOverscroll = (e: TouchEvent) => {
      if (e.target === canvas) {
        e.preventDefault();
      }
    };
    document.addEventListener('touchmove', preventOverscroll, { passive: false });

    return () => {
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      canvas.removeEventListener('touchcancel', handleTouchCancel);
      document.removeEventListener('touchmove', preventOverscroll);
    };
  }, [isInitialized]);
}

export default useTouchControls;
