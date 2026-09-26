/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keyboard controls hook for the 3D viewport
 * Handles keyboard shortcuts, walk mode, continuous movement
 */

import { useEffect, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore, type SectionPlane } from '@/store';
import { goHomeFromStore } from '@/store/homeView';
import { presetViewRotation } from '@/lib/preset-view-orientation';
import { eventKey, isTextEntryTarget, WALK_MOVEMENT_KEYS } from '@/lib/keyboard-event';
import { getEntityBounds } from '../../utils/viewportUtils.js';
import { flySpeedStore } from './flySpeedStore.js';

export interface UseKeyboardControlsParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  keyboardHandlersRef: MutableRefObject<{
    handleKeyDown: ((e: KeyboardEvent) => void) | null;
    handleKeyUp: ((e: KeyboardEvent) => void) | null;
  }>;
  firstPersonModeRef: MutableRefObject<boolean>;
  geometryBoundsRef: MutableRefObject<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }>;
  coordinateInfoRef: MutableRefObject<CoordinateInfo | undefined>;
  geometryRef: MutableRefObject<MeshData[] | null>;
  selectedEntityIdRef: MutableRefObject<number | null>;
  hiddenEntitiesRef: MutableRefObject<Set<number>>;
  isolatedEntitiesRef: MutableRefObject<Set<number> | null>;
  selectedModelIndexRef: MutableRefObject<number | undefined>;
  clearColorRef: MutableRefObject<[number, number, number, number]>;
  activeToolRef: MutableRefObject<string>;
  sectionPlaneRef: MutableRefObject<SectionPlane>;
  sectionRangeRef: MutableRefObject<{ min: number; max: number } | null>;
  updateCameraRotationRealtime: (rotation: { azimuth: number; elevation: number }) => void;
  calculateScale: () => void;
}

/** Keys that trigger continuous movement (arrow keys + WASD + shift for sprint) */
const MOVEMENT_KEYS = new Set([...WALK_MOVEMENT_KEYS, 'shift']);

export function useKeyboardControls(params: UseKeyboardControlsParams): void {
  const {
    rendererRef,
    isInitialized,
    keyboardHandlersRef,
    firstPersonModeRef,
    geometryBoundsRef,
    coordinateInfoRef,
    geometryRef,
    selectedEntityIdRef,
    hiddenEntitiesRef,
    isolatedEntitiesRef,
    selectedModelIndexRef,
    clearColorRef,
    activeToolRef,
    sectionPlaneRef,
    sectionRangeRef,
    updateCameraRotationRealtime,
    calculateScale,
  } = params;

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    const camera = renderer.getCamera();
    let aborted = false;

    const keyState: { [key: string]: boolean } = {};
    let moveLoopRunning = false;
    let moveFrameId: number | null = null;

    const renderScene = () => {
      renderer.requestRender();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextEntryTarget(e)) {
        return;
      }

      // Browsers may dispatch a key event with no `key` (autofill, synthetic
      // events) — see lib/keyboard-event.ts. Nothing below could match such an
      // event, so skipping it is behaviour-preserving.
      const key = eventKey(e);
      if (key === null) return;

      keyState[key] = true;

      // Start movement loop when a movement key is pressed
      if (MOVEMENT_KEYS.has(key) && !moveLoopRunning) {
        moveLoopRunning = true;
        keyboardMove();
      }

      // The camera shortcuts below are plain keys. With Ctrl/Meta/Alt held the
      // key belongs to another binding (Ctrl+Z undo, Ctrl+F search, Alt+1
      // panel), which must not also move the camera (#5596).
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Preset views - set view and re-render
      const setViewAndRender = (view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right') => {
        // Match the viewcube: when the Cesium world-context basemap is rendering,
        // TOP/BOTTOM read north-up rather than following the building's IfcSite
        // axes (#1532). cesiumAvailable guards a stale cesiumEnabled after georef
        // disappears.
        const { cesiumEnabled, cesiumAvailable } = useViewerStore.getState();
        const rotation = presetViewRotation(
          view,
          coordinateInfoRef.current?.buildingRotation,
          cesiumEnabled && cesiumAvailable,
        );
        camera.setPresetView(view, geometryBoundsRef.current, rotation);
        renderScene();
        updateCameraRotationRealtime(camera.getRotation());
        calculateScale();
      };

      if (e.key === '1') setViewAndRender('top');
      if (e.key === '2') setViewAndRender('bottom');
      if (e.key === '3') setViewAndRender('front');
      if (e.key === '4') setViewAndRender('back');
      if (e.key === '5') setViewAndRender('left');
      if (e.key === '6') setViewAndRender('right');

      // Frame selection (F) - zoom to fit selection, or fit all if nothing
      // selected. Delegates to `cameraCallbacks.frameSelection` — the SAME
      // callback the toolbar/ribbon "Frame selection" button, search,
      // hierarchy, properties, compare and clash all use — rather than
      // reimplementing it: `frameSelection` unions the full multi-selection
      // set (not just this hook's single `selectedEntityIdRef`) and resolves
      // a geometry-less assembly to the aggregated parts that carry geometry
      // (#1133) before giving up on bounds. A local reimplementation here
      // would silently regain both bugs (Viewport.tsx documents #1133 at the
      // `frameSelection` definition).
      if (e.key === 'f' || e.key === 'F') {
        const state = useViewerStore.getState();
        const hasSelection = state.selectedEntityIds.size > 0 || selectedEntityIdRef.current !== null;
        if (hasSelection && state.cameraCallbacks.frameSelection) {
          state.cameraCallbacks.frameSelection();
        } else if (selectedEntityIdRef.current !== null) {
          // No frameSelection callback registered (renderer not mounted) —
          // fall back to the direct bounds lookup so the shortcut still does
          // something rather than nothing.
          const bounds = getEntityBounds(geometryRef.current, selectedEntityIdRef.current);
          if (bounds) camera.frameBounds(bounds.min, bounds.max, 300);
          calculateScale();
        } else {
          // Nothing selected: Fit All, framing what is visible (#5884).
          state.cameraCallbacks.fitAll?.();
        }
      }

      // Home view (H) - reset to isometric
      if (e.key === 'h' || e.key === 'H') {
        goHomeFromStore();
      }

      // Fit all / Zoom extents (Z): the one Fit All, which frames what is
      // visible rather than the load-time bounds (#5884).
      if (e.key === 'z' || e.key === 'Z') {
        useViewerStore.getState().cameraCallbacks.fitAll?.();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Deliberately NOT gated on isTextEntryTarget: a movement key pressed in
      // the viewport and released after focus moved into a text field must
      // still clear, or the fly-through keeps panning forever.
      //
      // A key-less event (autofill `keyup`, see lib/keyboard-event.ts) tells us
      // nothing about which key was released, so leave `keyState` untouched —
      // but still fall through to the held-key check, which is idempotent.
      const key = eventKey(e);
      if (key !== null) keyState[key] = false;

      // Stop movement loop when no movement keys are held
      const anyHeld = Array.from(MOVEMENT_KEYS).some(k => keyState[k]);
      if (!anyHeld && moveLoopRunning) {
        moveLoopRunning = false;
        if (moveFrameId !== null) {
          cancelAnimationFrame(moveFrameId);
          moveFrameId = null;
        }
      }
    };

    keyboardHandlersRef.current.handleKeyDown = handleKeyDown;
    keyboardHandlersRef.current.handleKeyUp = handleKeyUp;

    const keyboardMove = () => {
      if (aborted || !moveLoopRunning) return;

      // A right-button flight owns the camera: a key held from before the press
      // would otherwise add walk/pan movement on top of the fly speed (#4868
      // review). Stand down but keep the loop alive, so key-ups still clear and
      // a still-held key resumes once the flight ends.
      if (flySpeedStore.get().active) {
        moveFrameId = requestAnimationFrame(keyboardMove);
        return;
      }

      let moved = false;
      const isWalkMode = activeToolRef.current === 'walk';

      if (isWalkMode) {
        // Walk mode: arrow keys + WASD move on horizontal plane
        // Up/W = forward, Down/S = backward, Left/A = strafe left, Right/D = strafe right
        const fwd = (keyState['arrowup'] || keyState['w'] ? 1 : 0) + (keyState['arrowdown'] || keyState['s'] ? -1 : 0);
        const strafe = (keyState['arrowleft'] || keyState['a'] ? -1 : 0) + (keyState['arrowright'] || keyState['d'] ? 1 : 0);
        if (fwd !== 0 || strafe !== 0) {
          const sprint = keyState['shift'] ? 2 : 1;
          camera.moveFirstPerson(fwd * sprint, strafe * sprint, 0);
          moved = true;
        }
      } else {
        // Normal mode: arrow keys pan the view
        const panSpeed = 5;
        if (keyState['arrowup']) { camera.pan(0, -panSpeed, false); moved = true; }
        if (keyState['arrowdown']) { camera.pan(0, panSpeed, false); moved = true; }
        if (keyState['arrowleft']) { camera.pan(panSpeed, 0, false); moved = true; }
        if (keyState['arrowright']) { camera.pan(-panSpeed, 0, false); moved = true; }
      }

      if (moved) {
        renderScene();
      }
      moveFrameId = requestAnimationFrame(keyboardMove);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      aborted = true;
      moveLoopRunning = false;
      if (moveFrameId !== null) {
        cancelAnimationFrame(moveFrameId);
      }
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isInitialized]);
}

export default useKeyboardControls;
