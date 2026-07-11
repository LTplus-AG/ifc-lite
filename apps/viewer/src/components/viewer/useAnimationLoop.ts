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
import type { Renderer, VisualEnhancementOptions, LightingEnvironment } from '@ifc-lite/renderer';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { SectionPlane } from '@/store';
import { projectToCssScreen } from '../../utils/projectScreen.js';
import { getContributionCullConfig } from '../../utils/renderCullConfig.js';
import { getLodScreenPx } from '../../utils/lodConfig.js';

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
  /** X-Ray context: ghost every entity NOT in this set (null = no ghosting). */
  ghostExceptEntitiesRef: MutableRefObject<Set<number> | null>;
  selectedEntityIdRef: MutableRefObject<number | null>;
  selectedModelIndexRef: MutableRefObject<number | undefined>;
  clearColorRef: MutableRefObject<[number, number, number, number]>;
  visualEnhancementRef: MutableRefObject<VisualEnhancementOptions>;
  /** Lighting environment (sun, hemisphere ambient, exposure, sky pass). */
  environmentRef: MutableRefObject<LightingEnvironment>;
  sectionPlaneRef: MutableRefObject<SectionPlane>;
  sectionRangeRef: MutableRefObject<{ min: number; max: number } | null>;
  /**
   * Mirror of the renderer's model bounds, written each frame after
   * render. Read by the section face-pick handler so the cardinal-
   * fallback `position` % can be computed against the live extents.
   */
  modelBoundsRef?: MutableRefObject<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null>;
  selectedEntityIdsRef: MutableRefObject<Set<number> | undefined>;
  /** Non-empty while a clash is focused → emphasize (pop) the override colours. */
  clashHighlightColorsRef: MutableRefObject<Map<number, [number, number, number, number]> | null | undefined>;
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
    ghostExceptEntitiesRef,
    selectedEntityIdRef,
    selectedModelIndexRef,
    clearColorRef,
    visualEnhancementRef,
    environmentRef,
    sectionPlaneRef,
    sectionRangeRef,
    modelBoundsRef,
    selectedEntityIdsRef,
    clashHighlightColorsRef,
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

    // Contribution culling + LOD (issue #1682): resolved once per session —
    // the knobs are load-time A/B switches, not live settings. Only this loop
    // passes them; snapshot renders (clash/IDS/BCF) stay exhaustive and
    // full-detail.
    const contributionCull = getContributionCullConfig();
    const lodScreenPx = getLodScreenPx();
    const lod = lodScreenPx !== null ? { screenPx: lodScreenPx } : undefined;

    let lastRotationUpdate = 0;
    let lastScaleUpdate = 0;
    let lastRenderTime = 0;
    let wasAnimating = false;
    let residencyRestoreErrorLogged = false;

    // Adaptive render throttle: cap the continuous-render cadence (interaction
    // + inertia) from the MEASURED cost of recent renders, not a triangle-count
    // guess. The old tiers (25ms above 1M triangles, 33ms above 5M) capped
    // orbiting at 40/30 fps even when frames were cheap — culling means a 6M-
    // triangle model can render in a few ms, and the cap itself was the
    // choppiness on CATIA-class models. renderer.render() wall time covers
    // encoder work AND swap-chain backpressure (getCurrentTexture blocks when
    // the GPU falls behind), so genuinely heavy scenes still degrade to the
    // same 40/30 fps floors within a few frames; a 200K-mesh model that takes
    // 30ms a frame cannot overwhelm the main thread any more than before.
    let continuousThrottleMs = 0; // 0 = no throttle
    let emaRenderMs = 0;          // EMA of render() wall time, rendered frames only

    function updateThrottle(renderMs: number) {
      emaRenderMs = emaRenderMs === 0 ? renderMs : renderMs * 0.2 + emaRenderMs * 0.8;
      // Hysteresis ladder — engage above, release below, hold in between,
      // so the cadence doesn't flap around a band edge mid-gesture.
      if (emaRenderMs >= 26) {
        continuousThrottleMs = 33; // ~30 fps
      } else if (emaRenderMs >= 14) {
        if (continuousThrottleMs !== 33 || emaRenderMs < 20) {
          continuousThrottleMs = 25; // ~40 fps
        }
      } else if (emaRenderMs <= 10) {
        continuousThrottleMs = 0;
      }
    }

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
          }
        }
      }

      // 1b. Rebuild GPU-evicted batches the last frame asked for (residency
      // budget, issue #1682 phase 3a). Time-budgeted; requests a render so
      // the restored batches appear on the next frame. Guarded like the
      // instanced-shard drain: an uncaught throw here (e.g. buffer creation
      // on a lost device) would kill the rAF loop and blank the canvas.
      if (scene.hasResidencyRestoreWork()) {
        try {
          const device = renderer.getGPUDevice();
          const pipeline = renderer.getPipeline();
          if (device && pipeline && scene.processResidencyRestores(device, pipeline) > 0) {
            renderer.requestRender();
          }
        } catch (err) {
          if (!residencyRestoreErrorLogged) {
            residencyRestoreErrorLogged = true;
            console.warn('[useAnimationLoop] residency restore failed (will keep rendering):', err);
          }
        }
      }

      // 2. Camera update (animation / inertia)
      const isAnimating = camera.update(deltaTime);

      // Camera tweens (Home / view cube / zoom-extent) render their frames
      // with isInteracting=true; without a settle render the last tween frame
      // could stay on screen at degraded quality until the next incidental
      // render. Mouse/wheel/touch paths already request their own settle
      // frame on release — this covers the animation path.
      if (wasAnimating && !isAnimating && !isInteractingRef.current) {
        renderer.requestRender();
      }
      wasAnimating = isAnimating;

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

      // Render continuously while the user is interacting (issue #1394), not
      // just when a pointermove happens to set the dirty flag. Pointer events
      // can arrive sparsely (coalesced / slow drag), which left the swap chain
      // unrefreshed for hundreds of ms between renders. Compositors that don't
      // preserve canvas contents between frames then show BLANK while orbiting
      // and only "reappear" on release — the reported bug. The large-model
      // interaction throttle still caps the cadence via `throttled`.
      const willRender =
        (isAnimating || renderRequested || queueFlushed || isInteractingRef.current) && !throttled;

      if (willRender) {
        renderer.consumeRenderRequest();
        const renderStart = performance.now();
        renderer.render({
          hiddenIds: hiddenEntitiesRef.current,
          isolatedIds: isolatedEntitiesRef.current,
          ghostExceptIds: ghostExceptEntitiesRef.current,
          selectedId: selectedEntityIdRef.current,
          selectedIds: selectedEntityIdsRef.current,
          emphasizeOverrides: (clashHighlightColorsRef.current?.size ?? 0) > 0,
          selectedModelIndex: selectedModelIndexRef.current,
          clearColor: clearColorRef.current,
          visualEnhancement: visualEnhancementRef.current,
          environment: environmentRef.current,
          isInteracting: isInteractingRef.current || isAnimating,
          // Let the effects governor judge missed frames against the
          // intentional large-model throttle instead of display refresh.
          interactionFrameIntervalMs: continuousThrottleMs || undefined,
          contributionCull,
          lod,
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
            // Custom (face-picked) plane override (issue #243). When set
            // the renderer uses these verbatim and ignores axis/position/
            // min/max for the clip math; cap polygons are still emitted
            // through the same Section2DOverlayRenderer with a custom
            // basis so the silhouette lands on the tilted plane.
            normal:   sectionPlaneRef.current.custom?.normal,
            distance: sectionPlaneRef.current.custom?.distance,
          } : undefined,
          terrainClipY: terrainClipYRef.current ?? undefined,
        });
        updateThrottle(performance.now() - renderStart);
        lastRenderTime = currentTime;
        // Snapshot the renderer's current model bounds so the section
        // face-pick handler can compute a correct cardinal-fallback
        // `position` percentage. Cheap (a few field reads) and avoids a
        // race where the click handler reads stale bounds during the
        // first few frames after a model loads.
        if (modelBoundsRef) {
          modelBoundsRef.current = renderer.getModelBounds() ?? modelBoundsRef.current;
        }
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
            // CSS-space coords so the measure line/labels track the geometry
            // under the cursor (buffer width is alignToWebGPU-rounded down from
            // the CSS width; raw buffer coords drift left — issue #1107).
            return projectToCssScreen(camera, canvas, worldPos);
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
