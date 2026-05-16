/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mouse controls orchestrator hook for the 3D viewport.
 * Handles orbit, pan, wheel, hover, and mouse-leave logic directly.
 * Delegates measurement interactions to measureHandlers.ts and
 * selection/context-menu interactions to selectionHandlers.ts.
 */

import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import type { Renderer, PickResult, SnapTarget } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import type {
  MeasurePoint,
  SnapVisualization,
  ActiveMeasurement,
  EdgeLockState,
  SectionPlane,
} from '@/store';
import type { MeasurementConstraintEdge, OrthogonalAxis, Vec3 } from '@/store/types.js';
import { getEntityCenter } from '../../utils/viewportUtils.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { useViewerStore } from '@/store';
import {
  handleMeasureDown,
  handleMeasureDrag,
  handleMeasureHover,
  handleMeasureUp,
  updateMeasureScreenCoords,
} from './measureHandlers.js';
import { handleSelectionClick, handleContextMenu as handleContextMenuSelection, handleAddElementHover, handleSplitHover } from './selectionHandlers.js';

export interface MouseState {
  isDragging: boolean;
  isPanning: boolean;
  lastX: number;
  lastY: number;
  button: number;
  startX: number;
  startY: number;
  didDrag: boolean;
  /**
   * True while the user is mid-drag in rectangle-select mode (Ctrl/⌘
   * held over the canvas in select tool). Suppresses orbit/pan in
   * the drag handlers and triggers `pickRect` on mouseup.
   */
  isRectSelecting?: boolean;
}

export interface UseMouseControlsParams {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;

  // Mouse state
  mouseStateRef: MutableRefObject<MouseState>;

  // Tool/state refs
  activeToolRef: MutableRefObject<string>;
  activeMeasurementRef: MutableRefObject<ActiveMeasurement | null>;
  snapEnabledRef: MutableRefObject<boolean>;
  edgeLockStateRef: MutableRefObject<EdgeLockState>;
  measurementConstraintEdgeRef: MutableRefObject<MeasurementConstraintEdge | null>;
  /** Section tool: when true, the next click picks a face for the clip plane (issue #243). */
  sectionPickModeRef: MutableRefObject<boolean>;
  /** Renderer model bounds; passed to face-pick so the cardinal-fallback `position` % is correct. */
  modelBoundsRef: MutableRefObject<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null>;

  // Visibility/selection refs
  hiddenEntitiesRef: MutableRefObject<Set<number>>;
  isolatedEntitiesRef: MutableRefObject<Set<number> | null>;
  selectedEntityIdRef: MutableRefObject<number | null>;
  selectedModelIndexRef: MutableRefObject<number | undefined>;
  clearColorRef: MutableRefObject<[number, number, number, number]>;

  // Section/geometry refs
  sectionPlaneRef: MutableRefObject<SectionPlane>;
  sectionRangeRef: MutableRefObject<{ min: number; max: number } | null>;
  geometryRef: MutableRefObject<MeshData[] | null>;

  // Measure raycast refs
  measureRaycastPendingRef: MutableRefObject<boolean>;
  measureRaycastFrameRef: MutableRefObject<number | null>;
  lastMeasureRaycastDurationRef: MutableRefObject<number>;
  lastHoverSnapTimeRef: MutableRefObject<number>;

  // Hover refs
  lastHoverCheckRef: MutableRefObject<number>;
  hoverTooltipsEnabledRef: MutableRefObject<boolean>;

  // Render throttle refs
  lastRenderTimeRef: MutableRefObject<number>;
  renderPendingRef: MutableRefObject<boolean>;

  // Interaction state — set during drag, cleared on mouseup
  isInteractingRef: MutableRefObject<boolean>;

  // Click detection refs
  lastClickTimeRef: MutableRefObject<number>;
  lastClickPosRef: MutableRefObject<{ x: number; y: number } | null>;

  // Camera tracking
  lastCameraStateRef: MutableRefObject<{
    position: { x: number; y: number; z: number };
    rotation: { azimuth: number; elevation: number };
    distance: number;
    canvasWidth: number;
    canvasHeight: number;
  } | null>;

  // Callbacks
  handlePickForSelection: (pickResult: PickResult | null) => void;
  setHoverState: (state: {
    entityId: number;
    screenX: number;
    screenY: number;
    worldXYZ?: { x: number; y: number; z: number };
  }) => void;
  /**
   * Called during a rectangle-selection drag with the current rect
   * (CSS pixels, canvas-relative). Passed `null` on drag end to clear
   * any visual overlay. The hook handles the actual `pickRect` call
   * + selection update internally; this callback is only for the
   * overlay visual.
   */
  setRectSelection?: (rect: { x0: number; y0: number; x1: number; y1: number } | null) => void;
  clearHover: () => void;
  openContextMenu: (entityId: number | null, screenX: number, screenY: number) => void;
  startMeasurement: (point: MeasurePoint) => void;
  updateMeasurement: (point: MeasurePoint) => void;
  finalizeMeasurement: () => void;
  setSnapTarget: (target: SnapTarget | null) => void;
  setSnapVisualization: (viz: Partial<SnapVisualization> | null) => void;
  setEdgeLock: (edge: { v0: { x: number; y: number; z: number }; v1: { x: number; y: number; z: number } }, meshExpressId: number, edgeT: number) => void;
  updateEdgeLockPosition: (edgeT: number, isCorner: boolean, cornerValence: number) => void;
  clearEdgeLock: () => void;
  incrementEdgeLockStrength: () => void;
  setMeasurementConstraintEdge: (edge: MeasurementConstraintEdge) => void;
  updateConstraintActiveAxis: (axis: OrthogonalAxis | null) => void;
  updateMeasurementScreenCoords: (projector: (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null) => void;
  updateCameraRotationRealtime: (rotation: { azimuth: number; elevation: number }) => void;
  toggleSelection: (entityId: number) => void;
  calculateScale: () => void;
  getPickOptions: () => { isStreaming: boolean; hiddenIds: Set<number>; isolatedIds: Set<number> | null };
  hasPendingMeasurements: () => boolean;
  /** Section face-pick: set the clip plane through a world-space face (issue #243). */
  setSectionPlaneFromFace: (
    normal: [number, number, number],
    point:  [number, number, number],
    bounds?: { min: [number, number, number]; max: [number, number, number] },
  ) => void;
  /** Section face-pick: arm/disarm the "next click picks a face" mode. */
  setSectionPickMode: (enabled: boolean) => void;
  /**
   * Section face-pick hover preview (issue #243 follow-up). Set by the
   * dwell handler when the cursor pauses ~200ms over a face; cleared
   * (passed `null`) when the cursor leaves the canvas, moves to a
   * different face, or pick mode is disarmed. Purely visual — does not
   * touch `sectionPlane`.
   */
  setSectionPickPreview: (
    preview: { normal: [number, number, number]; point: [number, number, number]; faceKey: string } | null,
  ) => void;

  // Constants
  HOVER_SNAP_THROTTLE_MS: number;
  SLOW_RAYCAST_THRESHOLD_MS: number;
  hoverThrottleMs: number;
  RENDER_THROTTLE_MS_SMALL: number;
  RENDER_THROTTLE_MS_LARGE: number;
  RENDER_THROTTLE_MS_HUGE: number;
  /** When true, wheel zoom uses unrestricted pure-dolly mode (Cesium) */
  fastZoomRef: MutableRefObject<boolean>;
}

export function useMouseControls(params: UseMouseControlsParams): void {
  const {
    canvasRef,
    rendererRef,
    isInitialized,
    mouseStateRef,
    activeToolRef,
    activeMeasurementRef,
    snapEnabledRef,
    edgeLockStateRef,
    measurementConstraintEdgeRef,
    sectionPickModeRef,
    modelBoundsRef,
    hiddenEntitiesRef,
    isolatedEntitiesRef,
    selectedEntityIdRef,
    selectedModelIndexRef,
    clearColorRef,
    sectionPlaneRef,
    sectionRangeRef,
    geometryRef,
    measureRaycastPendingRef,
    measureRaycastFrameRef,
    lastMeasureRaycastDurationRef,
    lastHoverSnapTimeRef,
    lastHoverCheckRef,
    hoverTooltipsEnabledRef,
    lastRenderTimeRef,
    renderPendingRef,
    isInteractingRef,
    lastClickTimeRef,
    lastClickPosRef,
    lastCameraStateRef,
    handlePickForSelection,
    setHoverState,
    clearHover,
    openContextMenu,
    startMeasurement,
    updateMeasurement,
    finalizeMeasurement,
    setSnapTarget,
    setSnapVisualization,
    setEdgeLock,
    updateEdgeLockPosition,
    clearEdgeLock,
    incrementEdgeLockStrength,
    setMeasurementConstraintEdge,
    updateConstraintActiveAxis,
    updateMeasurementScreenCoords,
    updateCameraRotationRealtime,
    toggleSelection,
    calculateScale,
    getPickOptions,
    hasPendingMeasurements,
    setSectionPlaneFromFace,
    setSectionPickMode,
    setSectionPickPreview,
    setRectSelection,
    HOVER_SNAP_THROTTLE_MS,
    SLOW_RAYCAST_THRESHOLD_MS,
    hoverThrottleMs,
    RENDER_THROTTLE_MS_SMALL,
    RENDER_THROTTLE_MS_LARGE,
    RENDER_THROTTLE_MS_HUGE,
  } = params;

  // ─── Section face-pick hover preview (issue #243 follow-up) ──────────
  // Refs persist across render so the dwell timer + sticky-face state
  // survive the throttled mousemove path. Critical for the anti-jitter
  // contract: cursor wobble within the same triangle/face must NOT
  // restart the dwell or repaint the overlay. See `handleSectionPickHover`
  // in this file for the full UX rules.
  const sectionDwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sectionLastFaceKeyRef = useRef<string | null>(null);
  const sectionLastCastPosRef = useRef<{ x: number; y: number } | null>(null);
  const sectionLastCastTsRef = useRef<number>(0);

  // When `sectionPickMode` flips off (Esc, second toggle press, tool
  // change), make sure any in-flight dwell timer is cancelled so it
  // can't call `setSectionPickPreview(...)` after the slice has
  // already been disarmed. The slice's own guard would no-op the
  // call, but it's clearer to stop the timer at the source rather
  // than relying on the late guard.
  useEffect(() => {
    const unsub = useViewerStore.subscribe((s, prev) => {
      if (prev.sectionPickMode && !s.sectionPickMode) {
        if (sectionDwellTimerRef.current) {
          clearTimeout(sectionDwellTimerRef.current);
          sectionDwellTimerRef.current = null;
        }
        sectionLastFaceKeyRef.current = null;
        sectionLastCastPosRef.current = null;
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer || !isInitialized) return;

    const camera = renderer.getCamera();
    const mouseState = mouseStateRef.current;

    // Build shared context for extracted handler functions
    const ctx: MouseHandlerContext = {
      canvas,
      renderer,
      camera,
      mouseState,
      activeToolRef,
      activeMeasurementRef,
      snapEnabledRef,
      edgeLockStateRef,
      measurementConstraintEdgeRef,
      sectionPickModeRef,
      modelBoundsRef,
      hiddenEntitiesRef,
      isolatedEntitiesRef,
      geometryRef,
      measureRaycastPendingRef,
      measureRaycastFrameRef,
      lastMeasureRaycastDurationRef,
      lastHoverSnapTimeRef,
      lastCameraStateRef,
      lastClickTimeRef,
      lastClickPosRef,
      startMeasurement,
      updateMeasurement,
      finalizeMeasurement,
      setSnapTarget,
      setSnapVisualization,
      setEdgeLock,
      updateEdgeLockPosition,
      clearEdgeLock,
      incrementEdgeLockStrength,
      setMeasurementConstraintEdge,
      updateConstraintActiveAxis,
      updateMeasurementScreenCoords,
      handlePickForSelection,
      toggleSelection,
      openContextMenu,
      hasPendingMeasurements,
      getPickOptions,
      setSectionPlaneFromFace,
      setSectionPickMode,
      setSectionPickPreview,
      HOVER_SNAP_THROTTLE_MS,
      SLOW_RAYCAST_THRESHOLD_MS,
    };

    /**
     * Section face-pick hover preview (issue #243 follow-up).
     *
     * Anti-jitter contract — these are the rules the dwell handler
     * MUST honour, in order:
     *   1. < 16ms since last raycast → skip (60fps cap).
     *   2. < 2px movement since last raycast → skip (cheap throttle).
     *   3. No hit OR degenerate normal → cancel timer + clear preview.
     *   4. Hit on the SAME face as last cast → no-op (don't restart
     *      dwell, don't repaint — this is the critical rule that keeps
     *      cursor wobble inside a flat wall from flickering).
     *   5. Hit on a NEW face → cancel old timer + clear preview, start
     *      a fresh 200ms dwell.
     *   6. Dwell elapses → camera-orient the normal (matches the click
     *      commit policy in `selectionHandlers.ts` so the previewed
     *      arrow always points the same direction the actual cut will
     *      keep), then publish to the slice.
     *
     * `faceKey` heuristic: we use the closed-form
     * `${expressId}:${meshIndex}:${triangleIndex}` from the renderer's
     * `Intersection`. That uniquely identifies the triangle and is
     * stable under cursor wobble within a single triangle. For two
     * adjacent triangles of the same flat wall the keys differ but the
     * normals are nearly equal — that yields a brief reset of the
     * dwell timer when crossing the diagonal, which is acceptable
     * (matches the "moved to a new triangle" intuition and avoids the
     * complexity of clustering coplanar triangles). The user only
     * waits a fresh 200ms once per crossing; the per-triangle key
     * still suppresses the in-triangle wobble that drove the
     * jitter complaint.
     */
    const handleSectionPickHover = (e: MouseEvent, x: number, y: number): void => {
      const now = performance.now();
      // 60fps cap — keeps the raycast off the hot path of high-Hz
      // pointer devices. Reading-clock rate doesn't have to align
      // with the display refresh; the dwell timer below paints at
      // 200ms regardless.
      if (now - sectionLastCastTsRef.current < 16) return;
      // 2px deadband — fights spurious mousemove events from drift /
      // touchpad jitter so we don't burn raycasts when the cursor is
      // effectively still.
      const last = sectionLastCastPosRef.current;
      if (last) {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        if (dx * dx + dy * dy < 4) return;
      }
      sectionLastCastPosRef.current = { x: e.clientX, y: e.clientY };
      sectionLastCastTsRef.current = now;

      const hit = renderer.raycastScene(x, y, {
        hiddenIds:   hiddenEntitiesRef.current,
        isolatedIds: isolatedEntitiesRef.current,
      });

      // Reject misses and degenerate normals. The renderer's
      // raycaster *should* always hand back a unit-length normal but
      // BVH meshes occasionally yield tiny-magnitude normals on
      // co-planar triangle pairs; the slice would warn and refuse a
      // commit anyway, so don't waste a preview on it.
      const nLen = hit ? Math.hypot(hit.intersection.normal.x, hit.intersection.normal.y, hit.intersection.normal.z) : 0;
      if (!hit || nLen < 1e-6) {
        if (sectionDwellTimerRef.current) {
          clearTimeout(sectionDwellTimerRef.current);
          sectionDwellTimerRef.current = null;
        }
        sectionLastFaceKeyRef.current = null;
        setSectionPickPreview(null);
        return;
      }

      const ix = hit.intersection;
      // Triangle-stable face key — see the JSDoc above for the
      // adjacent-triangle behaviour.
      const faceKey = `${ix.expressId}:${ix.meshIndex}:${ix.triangleIndex}`;
      if (faceKey === sectionLastFaceKeyRef.current) {
        // Same face — cursor is just wobbling within the triangle.
        // The preview (if any) is already painted in the right place;
        // the dwell timer (if any) is already counting down for this
        // face. Doing nothing here is the entire point of the sticky
        // faceKey rule.
        return;
      }
      sectionLastFaceKeyRef.current = faceKey;

      // New face — cancel the previous face's pending dwell + drop
      // any preview still pinned to it so the user doesn't see the
      // overlay linger on the wrong surface during the new face's
      // 200ms wait.
      if (sectionDwellTimerRef.current) clearTimeout(sectionDwellTimerRef.current);
      setSectionPickPreview(null);

      // Snapshot what we need so the timer closure doesn't capture
      // a hit object that the raycaster will mutate on the next cast.
      const px = ix.point.x, py = ix.point.y, pz = ix.point.z;
      const nx = ix.normal.x / nLen, ny = ix.normal.y / nLen, nz = ix.normal.z / nLen;

      sectionDwellTimerRef.current = setTimeout(() => {
        sectionDwellTimerRef.current = null;
        // Camera-aware normal flip — mirrors the commit logic in
        // `selectionHandlers.ts` so the previewed arrow direction
        // matches what the click will actually produce. Without this
        // the preview would point one way and the cap (post-click)
        // could end up the other, which the user would read as a
        // bug.
        const cam = renderer.getCamera().getPosition();
        const vx = cam.x - px, vy = cam.y - py, vz = cam.z - pz;
        const sign = (vx * nx + vy * ny + vz * nz) < 0 ? -1 : 1;
        setSectionPickPreview({
          normal: [sign * nx, sign * ny, sign * nz],
          point:  [px, py, pz],
          faceKey,
        });
      }, 200);
    };

    // Mouse controls - respect active tool
    // Uses pointer events + setPointerCapture so pointerup always fires,
    // even when the pointer leaves the canvas (e.g. dragging across panels).
    const handleMouseDown = async (e: PointerEvent) => {
      e.preventDefault();
      // Capture the pointer so move/up events fire even outside the canvas
      canvas.setPointerCapture(e.pointerId);
      mouseState.isDragging = true;
      mouseState.button = e.button;
      mouseState.lastX = e.clientX;
      mouseState.lastY = e.clientY;
      mouseState.startX = e.clientX;
      mouseState.startY = e.clientY;
      mouseState.didDrag = false;
      mouseState.isRectSelecting = false;

      // Determine action based on active tool and mouse button
      const tool = activeToolRef.current;

      // Rectangle-select gesture: Ctrl/⌘ + LMB drag while in the
      // select tool. Suppresses orbit/pan; the rect is finalised
      // and pick happens on mouseup.
      if (tool === 'select' && e.button === 0 && (e.ctrlKey || e.metaKey)) {
        mouseState.isRectSelecting = true;
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        setRectSelection?.({ x0: cx, y0: cy, x1: cx, y1: cy });
        return;
      }

      // Will this mousedown lead to an orbit drag?
      const isPanGesture = tool === 'pan' || e.button === 1 || e.button === 2 ||
        (tool === 'select' && e.shiftKey);
      const willOrbit = !isPanGesture && (
        tool === 'select' ||
        (tool === 'measure' && e.shiftKey) ||
        !e.shiftKey // default tools: no shift = orbit
      );

      // Set orbit pivot to the 3D point under the cursor so rotation feels anchored
      // to what the user is looking at. On miss, place pivot at current distance along
      // the cursor ray so orbit always feels connected to where you're pointing.
      if (willOrbit) {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;

        // For large models, skip the expensive CPU raycast (collectVisibleMeshData +
        // BVH build over 200K+ meshes can block the main thread for seconds).
        // Instead, project the camera target onto the cursor ray for a fast pivot.
        const scene = renderer.getScene();
        const batchedMeshes = scene.getBatchedMeshes();
        let totalEntities = scene.getMeshes().length;
        for (const b of batchedMeshes) totalEntities += b.expressIds.length;
        const isLargeModel = totalEntities > 50_000;

        let hit: { intersection: { point: { x: number; y: number; z: number } } } | null = null;
        if (!isLargeModel) {
          hit = renderer.raycastScene(cx, cy, {
            hiddenIds: hiddenEntitiesRef.current,
            isolatedIds: isolatedEntitiesRef.current,
          });
        }

        if (hit?.intersection) {
          camera.setOrbitCenter(hit.intersection.point);
        } else if (selectedEntityIdRef.current) {
          // No geometry under cursor but object selected — use its center
          const center = getEntityCenter(geometryRef.current, selectedEntityIdRef.current);
          if (center) {
            camera.setOrbitCenter(center);
          } else {
            camera.setOrbitCenter(null);
          }
        } else {
          // No geometry hit or large model — project camera target onto the cursor ray.
          // Places pivot at the model's depth but under the cursor.
          const ray = camera.unprojectToRay(cx, cy, canvas.width, canvas.height);
          const target = camera.getTarget();
          const toTarget = {
            x: target.x - ray.origin.x,
            y: target.y - ray.origin.y,
            z: target.z - ray.origin.z,
          };
          const d = Math.max(1, toTarget.x * ray.direction.x + toTarget.y * ray.direction.y + toTarget.z * ray.direction.z);
          camera.setOrbitCenter({
            x: ray.origin.x + ray.direction.x * d,
            y: ray.origin.y + ray.direction.y * d,
            z: ray.origin.z + ray.direction.z * d,
          });
        }
      }

      if (tool === 'pan' || e.button === 1 || e.button === 2) {
        mouseState.isPanning = true;
        canvas.style.cursor = 'move';
      } else if (tool === 'select') {
        // Select tool: shift+drag = pan, normal drag = orbit
        mouseState.isPanning = e.shiftKey;
        canvas.style.cursor = e.shiftKey ? 'move' : 'grabbing';
      } else if (tool === 'measure') {
        // Measure tool - shift+drag = orbit, normal drag = measure
        if (e.shiftKey) {
          // Shift pressed: allow orbit (not pan) when no measurement is active
          mouseState.isDragging = true;
          mouseState.isPanning = false;
          canvas.style.cursor = 'grabbing';
          // Fall through to allow orbit handling in mousemove
        } else {
          // Normal drag: delegate to measurement handler
          if (handleMeasureDown(ctx, e)) return;
        }
      } else {
        // Default behavior
        mouseState.isPanning = e.shiftKey;
        canvas.style.cursor = e.shiftKey ? 'move' : 'grabbing';
      }
    };

    const handleMouseMove = async (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const tool = activeToolRef.current;

      // Rectangle-select drag: just update the visual; no orbit / pan
      // / pick / hover work happens in this branch.
      if (mouseState.isRectSelecting) {
        setRectSelection?.({
          x0: mouseState.startX - rect.left,
          y0: mouseState.startY - rect.top,
          x1: x,
          y1: y,
        });
        return;
      }

      // Handle measure tool live preview while dragging
      // IMPORTANT: Check tool first, not activeMeasurement, to prevent orbit conflict
      if (tool === 'measure' && mouseState.isDragging && activeMeasurementRef.current) {
        if (handleMeasureDrag(ctx, e, x, y)) return;
      }

      // Handle measure tool hover preview (BEFORE dragging starts)
      // Show snap indicators to help user see where they can snap
      if (tool === 'measure' && !mouseState.isDragging && snapEnabledRef.current) {
        if (handleMeasureHover(ctx, x, y)) return;
      }

      // Add-element tool hover preview. Always runs (regardless of
      // snap toggle) so the live edge/rectangle/polygon overlay can
      // track the cursor; magnetic snap is layered on when enabled.
      if (tool === 'addElement' && !mouseState.isDragging) {
        if (handleAddElementHover(ctx, x, y)) return;
      }

      // Split-tool hover preview — projects the cursor onto the
      // hovered wall's axis and pushes the cut distance into the
      // store so SplitOverlay renders the perpendicular guide.
      if (tool === 'split' && !mouseState.isDragging) {
        if (handleSplitHover(ctx, x, y)) return;
      }

      // Section tool face-pick: dwell-aware hover preview (issue #243
      // follow-up). Runs INSTEAD of the generic tooltip path while
      // pick mode is armed so the overlay stays the only signal under
      // the cursor — the tooltip would just compete visually with the
      // violet quad. See `handleSectionPickHover` for the full
      // anti-jitter rules.
      if (tool === 'section' && !mouseState.isDragging && sectionPickModeRef.current) {
        handleSectionPickHover(e, x, y);
        return;
      }

      // Handle orbit/pan for other tools (or measure tool with shift+drag or no active measurement)
      if (mouseState.isDragging && (tool !== 'measure' || !activeMeasurementRef.current)) {
        const dx = e.clientX - mouseState.lastX;
        const dy = e.clientY - mouseState.lastY;

        // Check if this counts as a drag (moved more than 5px from start)
        const totalDx = e.clientX - mouseState.startX;
        const totalDy = e.clientY - mouseState.startY;
        if (Math.abs(totalDx) > 5 || Math.abs(totalDy) > 5) {
          mouseState.didDrag = true;
        }

        // Always update camera state immediately (feels responsive)
        if (mouseState.isPanning || tool === 'pan') {
          camera.pan(dx, dy, false);
        } else if (tool === 'walk') {
          // Walk mode: mouse drag looks around (full orbit)
          camera.orbit(dx, dy, false);
        } else {
          camera.orbit(dx, dy, false);
        }

        mouseState.lastX = e.clientX;
        mouseState.lastY = e.clientY;

        // Signal the animation loop to render.
        // No throttle needed — the loop runs at display refresh rate and
        // coalesces multiple requestRender() calls into one frame.
        isInteractingRef.current = true;
        renderer.requestRender();
        updateCameraRotationRealtime(camera.getRotation());
        calculateScale();



        // Clear hover while dragging
        clearHover();
      } else if (hoverTooltipsEnabledRef.current) {
        // Hover detection (throttled) - only if tooltips are enabled
        const now = Date.now();
        if (now - lastHoverCheckRef.current > hoverThrottleMs) {
          lastHoverCheckRef.current = now;
          // Uses visibility filtering so hidden elements don't show hover tooltips
          const pickResult = await renderer.pick(x, y, getPickOptions());
          if (pickResult) {
            setHoverState({
              entityId: pickResult.expressId,
              screenX: e.clientX,
              screenY: e.clientY,
              worldXYZ: pickResult.worldXYZ,
            });
          } else {
            clearHover();
          }
        }
      }
    };

    const handleMouseUp = (e: PointerEvent) => {
      // Release pointer capture (safe to call even if not captured)
      canvas.releasePointerCapture(e.pointerId);

      // Clear interaction flag so the animation loop restores post-processing
      if (isInteractingRef.current) {
        isInteractingRef.current = false;
        renderer.requestRender();
      }

      const tool = activeToolRef.current;

      // Rectangle-select finalisation: run pickRect against the
      // dragged rect, replace the current selection with the result,
      // then clear the visual.
      if (mouseState.isRectSelecting) {
        const canvasRect = canvas.getBoundingClientRect();
        const x0 = mouseState.startX - canvasRect.left;
        const y0 = mouseState.startY - canvasRect.top;
        const x1 = e.clientX - canvasRect.left;
        const y1 = e.clientY - canvasRect.top;
        // Tiny rect (just a click + tiny twitch) → no-op so we don't
        // accidentally clear selection on a missed Ctrl-click.
        const rectSize = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        if (rectSize >= 4) {
          // pickRect can reject on WebGPU validation / device-loss
          // paths — swallow the error so the pointer event doesn't
          // surface an unhandled rejection. Selection stays
          // untouched on failure (better UX than clearing it).
          void renderer
            .pickRect(x0, y0, x1, y1, getPickOptions())
            .then((ids) => {
              useViewerStore.getState().setSelectedEntityIds(Array.from(ids));
            })
            .catch((error) => {
              console.warn('[useMouseControls] Rectangle selection failed:', error);
            });
        }
        setRectSelection?.(null);
        mouseState.isRectSelecting = false;
        mouseState.isDragging = false;
        mouseState.isPanning = false;
        return;
      }

      // Handle measure tool completion
      if (tool === 'measure' && activeMeasurementRef.current) {
        if (handleMeasureUp(ctx, e)) return;
      }

      mouseState.isDragging = false;
      mouseState.isPanning = false;
      canvas.style.cursor = tool === 'pan' ? 'grab' : (tool === 'walk' ? 'crosshair' : (tool === 'measure' ? 'crosshair' : 'default'));
    };

    const handleMouseLeave = () => {
      const tool = activeToolRef.current;
      mouseState.isDragging = false;
      mouseState.isPanning = false;
      camera.stopInertia();
      // Section face-pick preview: cursor left the canvas, so any
      // pending dwell timer would otherwise commit a stale hover
      // when the user returns. Drop the overlay too so we don't leave
      // a violet quad orphaned on the last-seen face after leaving.
      if (sectionDwellTimerRef.current) {
        clearTimeout(sectionDwellTimerRef.current);
        sectionDwellTimerRef.current = null;
      }
      sectionLastFaceKeyRef.current = null;
      sectionLastCastPosRef.current = null;
      setSectionPickPreview(null);
      // Restore cursor based on active tool
      if (tool === 'measure') {
        canvas.style.cursor = 'crosshair';
      } else if (tool === 'pan') {
        canvas.style.cursor = 'grab';
      } else if (tool === 'walk') {
        canvas.style.cursor = 'crosshair';
      } else {
        canvas.style.cursor = 'default';
      }
      clearHover();
    };

    const handleContextMenu = async (e: MouseEvent) => {
      await handleContextMenuSelection(ctx, e);
    };

    // Debounce: clear isInteracting 150ms after the last wheel event
    let wheelIdleTimer: ReturnType<typeof setTimeout> | null = null;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => {
        isInteractingRef.current = false;
        renderer.requestRender();
      }, 150);
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const fastZoom = e.shiftKey || params.fastZoomRef.current;
      camera.zoom(e.deltaY, false, mouseX, mouseY, canvas.width, canvas.height, fastZoom);

      isInteractingRef.current = true;
      renderer.requestRender();

      // Update measurement screen coordinates immediately during zoom (only in measure mode)
      if (activeToolRef.current === 'measure') {
        if (hasPendingMeasurements()) {
          updateMeasureScreenCoords(ctx);
        }
      }
    };

    // Click handling — delegated to selectionHandlers
    const handleClick = async (e: MouseEvent) => {
      await handleSelectionClick(ctx, e);
    };

    canvas.addEventListener('pointerdown', handleMouseDown);
    canvas.addEventListener('pointermove', handleMouseMove);
    canvas.addEventListener('pointerup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('contextmenu', handleContextMenu);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('click', handleClick);

    return () => {
      canvas.removeEventListener('pointerdown', handleMouseDown);
      canvas.removeEventListener('pointermove', handleMouseMove);
      canvas.removeEventListener('pointerup', handleMouseUp);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('contextmenu', handleContextMenu);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('click', handleClick);
      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);

      // Cancel pending raycast requests
      if (measureRaycastFrameRef.current !== null) {
        cancelAnimationFrame(measureRaycastFrameRef.current);
        measureRaycastFrameRef.current = null;
      }

      // Section face-pick: drop any pending dwell so the timer
      // doesn't fire after unmount and call into a stale renderer.
      if (sectionDwellTimerRef.current) {
        clearTimeout(sectionDwellTimerRef.current);
        sectionDwellTimerRef.current = null;
      }
      sectionLastFaceKeyRef.current = null;
      sectionLastCastPosRef.current = null;
    };
  }, [isInitialized]);
}

export default useMouseControls;
