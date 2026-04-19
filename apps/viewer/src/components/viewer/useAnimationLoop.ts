/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE render loop for the 3D viewport.
 *
 * This is the single place where renderer.render() is called during normal
 * operation.  Everything else (mouse, touch, keyboard, streaming, visibility
 * changes, theme, lens) calls renderer.requestRender() to set a dirty flag.
 *
 * Each frame:
 *   1. Drain the scene's mesh queue (streaming uploads with time budget).
 *   2. Update camera (animation / inertia).
 *   3. If dirty OR animating → render with current state from refs.
 *   4. Sync ViewCube, scale bar, measurements.
 */

import { useEffect, type MutableRefObject, type RefObject } from 'react';
import type { Renderer, VisualEnhancementOptions } from '@ifc-lite/renderer';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { SectionPlane } from '@/store';

export interface UseAnimationLoopParams {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  animationFrameRef: MutableRefObject<number | null>;
  lastFrameTimeRef: MutableRefObject<number>;
  mouseIsDraggingRef: MutableRefObject<boolean>;
  activeToolRef: MutableRefObject<string>;
  /** When set, clips model below this Y value (terrain clipping for Cesium overlay). */
  terrainClipYRef: MutableRefObject<number | null>;
  hiddenEntitiesRef: MutableRefObject<Set<number>>;
  isolatedEntitiesRef: MutableRefObject<Set<number> | null>;
  selectedEntityIdRef: MutableRefObject<number | null>;
  selectedModelIndexRef: MutableRefObject<number | undefined>;
  clearColorRef: MutableRefObject<[number, number, number, number]>;
  visualEnhancementRef: MutableRefObject<VisualEnhancementOptions>;
  sectionPlaneRef: MutableRefObject<SectionPlane>;
  sectionRangeRef: MutableRefObject<{ min: number; max: number } | null>;
  selectedEntityIdsRef: MutableRefObject<Set<number> | undefined>;
  coordinateInfoRef: MutableRefObject<CoordinateInfo | undefined>;
  isInteractingRef: MutableRefObject<boolean>;
  lastCameraStateRef: MutableRefObject<{
    position: { x: number; y: number; z: number };
    rotation: { azimuth: number; elevation: number };
    distance: number;
    canvasWidth: number;
    canvasHeight: number;
  } | null>;
  updateCameraRotationRealtime: (rotation: { azimuth: number; elevation: number }) => void;
  calculateScale: () => void;
  updateMeasurementScreenCoords: (projector: (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null) => void;
  hasPendingMeasurements: () => boolean;
}

export function useAnimationLoop(params: UseAnimationLoopParams): void {
  const {
    canvasRef,
    rendererRef,
    isInitialized,
    animationFrameRef,
    lastFrameTimeRef,
    mouseIsDraggingRef,
    activeToolRef,
    terrainClipYRef,
    hiddenEntitiesRef,
    isolatedEntitiesRef,
    selectedEntityIdRef,
    selectedModelIndexRef,
    clearColorRef,
    visualEnhancementRef,
    sectionPlaneRef,
    sectionRangeRef,
    selectedEntityIdsRef,
    coordinateInfoRef,
    isInteractingRef,
    lastCameraStateRef,
    updateCameraRotationRealtime,
    calculateScale,
    updateMeasurementScreenCoords,
    hasPendingMeasurements,
  } = params;

  useEffect(() => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas || !isInitialized) return;

    const camera = renderer.getCamera();
    const scene = renderer.getScene();
    let aborted = false;

    let lastRotationUpdate = 0;
    let lastScaleUpdate = 0;
    let lastRenderTime = 0;

    // Adaptive render throttle: large models get fewer FPS during continuous
    // rendering (interaction + inertia) to prevent the main thread from being
    // overwhelmed. Model "size" is measured by total triangle count across all
    // batched geometry — individual mesh count is near 0 for batched models.
    let continuousThrottleMs = 0; // 0 = no throttle (small models)

    function updateThrottle() {
      let totalIndices = 0;
      for (const batch of scene.getBatchedMeshes()) {
        totalIndices += batch.indexCount;
      }
      // Also account for individual meshes
      totalIndices += scene.getMeshes().reduce((s, m) => s + (m.indexCount ?? 0), 0);
      const triangles = totalIndices / 3;
      if (triangles > 5_000_000) {
        continuousThrottleMs = 33; // ~30 fps — huge models (>5M triangles)
      } else if (triangles > 1_000_000) {
        continuousThrottleMs = 25; // ~40 fps — large models (>1M triangles)
      } else {
        continuousThrottleMs = 0;
      }
    }
    updateThrottle();

    const animate = (currentTime: number) => {
      if (aborted) return;

      const deltaTime = currentTime - lastFrameTimeRef.current;
      lastFrameTimeRef.current = currentTime;

      // 1. Drain mesh queue (streaming GPU uploads)
      let queueFlushed = false;
      if (scene.hasQueuedMeshes()) {
        const device = renderer.getGPUDevice();
        const pipeline = renderer.getPipeline();
        if (device && pipeline) {
          queueFlushed = scene.flushPending(device, pipeline);
          if (queueFlushed) {
            renderer.clearCaches();
            updateThrottle();
          }
        }
      }

      // 2. Camera update (animation / inertia)
      const isAnimating = camera.update(deltaTime);

      // 3. Render if anything changed
      // Peek first — only consume the flag when we actually commit to rendering.
      // This prevents a throttled frame from eating the dirty flag.
      const renderRequested = renderer.peekRenderRequest();

      // Throttle render rate during continuous rendering (interaction + inertia)
      // for large models. Without this, 200K+ mesh models at 60fps overwhelm
      // the main thread and freeze the tab. Inertia alone can run 60+ frames
      // after mouseup, each requiring a full GPU render pass.
      const isContinuousRender = isInteractingRef.current || isAnimating;
      const throttled = isContinuousRender &&
        continuousThrottleMs > 0 &&
        (currentTime - lastRenderTime) < continuousThrottleMs;

      if ((isAnimating || renderRequested || queueFlushed) && !throttled) {
        renderer.consumeRenderRequest();
        renderer.render({
          hiddenIds: hiddenEntitiesRef.current,
          isolatedIds: isolatedEntitiesRef.current,
          selectedId: selectedEntityIdRef.current,
          selectedIds: selectedEntityIdsRef.current,
          selectedModelIndex: selectedModelIndexRef.current,
          clearColor: clearColorRef.current,
          visualEnhancement: visualEnhancementRef.current,
          isInteracting: isInteractingRef.current || isAnimating,
          buildingRotation: coordinateInfoRef.current?.buildingRotation,
          sectionPlane: activeToolRef.current === 'section' ? {
            axis: sectionPlaneRef.current.axis,
            position: sectionPlaneRef.current.position,
            enabled: sectionPlaneRef.current.enabled,
            flipped: sectionPlaneRef.current.flipped,
            // Cap rendering settings — the renderer reads these to draw the
            // filled, hatched cut surfaces.
            showCap: sectionPlaneRef.current.showCap,
            showOutlines: sectionPlaneRef.current.showOutlines,
            capStyle: sectionPlaneRef.current.capStyle,
            min: sectionRangeRef.current?.min,
            max: sectionRangeRef.current?.max,
          } : undefined,
          terrainClipY: terrainClipYRef.current ?? undefined,
        });
        lastRenderTime = currentTime;
      }

      // 4. Sync UI widgets
      if (isAnimating || renderRequested || queueFlushed) {
        updateCameraRotationRealtime(camera.getRotation());
        calculateScale();
      } else if (!mouseIsDraggingRef.current && currentTime - lastRotationUpdate > 500) {
        updateCameraRotationRealtime(camera.getRotation());
        lastRotationUpdate = currentTime;
      }

      if (currentTime - lastScaleUpdate > 500) {
        calculateScale();
        lastScaleUpdate = currentTime;
      }

      // 5. Measurement screen coords
      if (activeToolRef.current === 'measure' && hasPendingMeasurements()) {
        const cameraPos = camera.getPosition();
        const cameraRot = camera.getRotation();
        const cameraDist = camera.getDistance();
        const currentCameraState = {
          position: cameraPos,
          rotation: cameraRot,
          distance: cameraDist,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
        };

        const lastState = lastCameraStateRef.current;
        const cameraChanged =
          !lastState ||
          lastState.position.x !== currentCameraState.position.x ||
          lastState.position.y !== currentCameraState.position.y ||
          lastState.position.z !== currentCameraState.position.z ||
          lastState.rotation.azimuth !== currentCameraState.rotation.azimuth ||
          lastState.rotation.elevation !== currentCameraState.rotation.elevation ||
          lastState.distance !== currentCameraState.distance ||
          lastState.canvasWidth !== currentCameraState.canvasWidth ||
          lastState.canvasHeight !== currentCameraState.canvasHeight;

        if (cameraChanged) {
          lastCameraStateRef.current = currentCameraState;
          updateMeasurementScreenCoords((worldPos) => {
            return camera.projectToScreen(worldPos, canvas.width, canvas.height);
          });
        }
      }

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    lastFrameTimeRef.current = performance.now();
    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      aborted = true;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isInitialized]);
}

export default useAnimationLoop;
