/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keyboard controls hook for the 3D viewport
 * Handles keyboard shortcuts, walk mode, continuous movement
 */

import { useEffect, type MutableRefObject } from 'react';
import { isEntityVisible, type Renderer } from '@ifc-lite/renderer';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore, type SectionPlane } from '@/store';
import { goHomeFromStore } from '@/store/homeView';
import { presetViewRotation } from '@/lib/preset-view-orientation';
import { eventKey, WALK_MOVEMENT_KEYS } from '@/lib/keyboard-event';
import { dispatchKeyboardDown, registerKeyboardBinding, registerKeyboardCommand, registerKeyboardKeyUp } from '@/lib/commands/dispatcher';
import { getEntityBounds } from '../../utils/viewportUtils.js';
import { flySpeedStore } from './flySpeedStore.js';
import { createWalkController, type WalkController } from './walk/walkController.js';

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
    geometryBoundsRef,
    coordinateInfoRef,
    geometryRef,
    selectedEntityIdRef,
    hiddenEntitiesRef,
    isolatedEntitiesRef,
    activeToolRef,
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

    // Walk mode: a physics walker owns the camera while the Walk tool is active.
    let walk: WalkController | null = null;
    const syncWalk = (tool: string) => {
      if (tool === 'walk' && !walk) {
        walk = createWalkController(renderer, (id) => isEntityVisible(id, hiddenEntitiesRef.current, isolatedEntitiesRef.current));
      } else if (tool !== 'walk' && walk) {
        walk.dispose();
        walk = null;
      }
    };
    syncWalk(useViewerStore.getState().activeTool);
    const unsubscribeTool = useViewerStore.subscribe((state) => syncWalk(state.activeTool));
    const holdWalkKey = (key: string) => (event: KeyboardEvent) => {
      if (!walk || event.repeat) return;
      walk.setKey(key, true);
    };

    const startMovement = (event: KeyboardEvent) => {
      const key = eventKey(event);
      if (key === null) return false;
      if (walk) {
        walk.setKey(key, true);
        return;
      }
      keyState[key] = true;
      if (MOVEMENT_KEYS.has(key) && !moveLoopRunning) {
        moveLoopRunning = true;
        keyboardMove();
      }
    };

    const setViewAndRender = (view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right') => {
      // Match the viewcube, including Cesium north-up when its basemap is live.
      const { cesiumEnabled, cesiumAvailable } = useViewerStore.getState();
      const rotation = presetViewRotation(view, coordinateInfoRef.current?.buildingRotation, cesiumEnabled && cesiumAvailable);
      camera.setPresetView(view, geometryBoundsRef.current, rotation);
      renderScene();
      updateCameraRotationRealtime(camera.getRotation());
      calculateScale();
    };

    const frameSelection = () => {
      // Use the same multi-selection callback as the toolbar (#1133). The
      // direct bounds fallback matters when a renderer lacks that callback.
      const state = useViewerStore.getState();
      const hasSelection = state.selectedEntityIds.size > 0 || selectedEntityIdRef.current !== null;
      if (hasSelection && state.cameraCallbacks.frameSelection) {
        state.cameraCallbacks.frameSelection();
      } else if (selectedEntityIdRef.current !== null) {
        const bounds = getEntityBounds(geometryRef.current, selectedEntityIdRef.current);
        if (bounds) camera.frameBounds(bounds.min, bounds.max, 300);
        calculateScale();
      } else {
        state.cameraCallbacks.fitAll?.();
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
      if (key !== null) walk?.setKey(key, false);

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

      // Arrow keys pan the view (walking is the walk controller's).
      let moved = false;
      const panSpeed = 5;
      if (keyState['arrowup']) { camera.pan(0, -panSpeed, false); moved = true; }
      if (keyState['arrowdown']) { camera.pan(0, panSpeed, false); moved = true; }
      if (keyState['arrowleft']) { camera.pan(panSpeed, 0, false); moved = true; }
      if (keyState['arrowright']) { camera.pan(-panSpeed, 0, false); moved = true; }

      if (moved) {
        renderScene();
      }
      moveFrameId = requestAnimationFrame(keyboardMove);
    };

    const isWalkMode = () => activeToolRef.current === 'walk';
    const registrations = [
      registerKeyboardCommand('walk.move', startMovement, { active: isWalkMode, ignoreModifiers: true }),
      registerKeyboardCommand('walk.moveArrows', startMovement, { active: isWalkMode, ignoreModifiers: true }),
      registerKeyboardCommand('camera.pan', startMovement, { active: () => !isWalkMode(), ignoreModifiers: true }),
      registerKeyboardBinding({ id: 'walk.sprint', when: 'tool.walk', layer: 'tool', keys: [{ key: 'shift', shift: true }], active: isWalkMode, run: startMovement }),
      // A tap can start and end between two physics ticks: queue it, as well as holding it.
      registerKeyboardCommand('walk.jump', (event) => { if (!event.repeat) walk?.queueJump(); holdWalkKey(' ')(event); }, { active: isWalkMode, ignoreModifiers: true }),
      registerKeyboardCommand('walk.crouch', holdWalkKey('z'), { active: isWalkMode }),
      registerKeyboardCommand('walk.toggleCollision', (event) => { if (!event.repeat) walk?.togglePhysics(); }, { active: isWalkMode }),
      registerKeyboardCommand('camera.viewTop', () => { setViewAndRender('top'); }),
      registerKeyboardCommand('camera.viewBottom', () => { setViewAndRender('bottom'); }),
      registerKeyboardCommand('camera.viewFront', () => { setViewAndRender('front'); }),
      registerKeyboardCommand('camera.viewBack', () => { setViewAndRender('back'); }),
      registerKeyboardCommand('camera.viewLeft', () => { setViewAndRender('left'); }),
      registerKeyboardCommand('camera.viewRight', () => { setViewAndRender('right'); }),
      registerKeyboardCommand('camera.frameSelection', () => { frameSelection(); }),
      registerKeyboardCommand('camera.home', () => { goHomeFromStore(); }),
      registerKeyboardCommand('camera.fitAll', () => { useViewerStore.getState().cameraCallbacks.fitAll?.(); }),
      registerKeyboardKeyUp(handleKeyUp),
    ];
    keyboardHandlersRef.current.handleKeyDown = dispatchKeyboardDown;
    keyboardHandlersRef.current.handleKeyUp = handleKeyUp;

    return () => {
      aborted = true;
      moveLoopRunning = false;
      if (moveFrameId !== null) {
        cancelAnimationFrame(moveFrameId);
      }
      for (const unregister of registrations) unregister();
      unsubscribeTool();
      walk?.dispose();
      walk = null;
      keyboardHandlersRef.current.handleKeyDown = null;
      keyboardHandlersRef.current.handleKeyUp = null;
    };
  }, [isInitialized]);
}

export default useKeyboardControls;
