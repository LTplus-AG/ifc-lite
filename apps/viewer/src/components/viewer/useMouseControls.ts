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
import type { HoverState, MeasurementConstraintEdge, OrthogonalAxis } from '@/store/types.js';
import { getEntityCenter } from '../../utils/viewportUtils.js';
import { focusedClashOrbitPivot, sceneAnchorOrbitPivot } from './orbitPivot.js';
import { orbitPivotStore } from './orbitPivotStore.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { emitCameraInteracted } from '@/lib/tours/events';
import { capturePointer, releasePointer } from '@/lib/pointer-capture';
import { useViewerStore } from '@/store';
import { handleMeasureDrag, handleMeasureHover, syncMeasureScreenCoords } from './measureHandlers.js';
import { beginMeasurePress, handleMeasureDown, handleMeasureUp, pressOutlivedReset } from './distanceClick.js';
import { pressPastClickSlop, type PointerGesture } from './pointerGesture.js';
import { resolveNavigationPointerGesture, resolveWheelNavigation } from '@/lib/navigation/presets.js';
import { noteMouseSideInput, routeMousePointers, setMeasureContext } from './touchRouting.js';
import { endMeasurePointHover, hoverMeasurePointAt } from './measurePointMode.js';
import type { MeasureCameraState } from './measureCameraState.js';
import { invalidateSelectionPick } from './referenceSelection.js';
import { createHoverPicker } from './hoverPicker.js';
import { forgetCommandPointer } from '@/lib/commands/modeling/pointer-replay';
import { routeCommandPointer } from './commandPointer.js';
import { refuseCaptureHeldPick } from '@/lib/viewport-capture';
import { createCommandPressController } from './commandPress.js';
import { handleSelectionClick, handleContextMenu as handleContextMenuSelection } from './selectionHandlers.js';
import { handleMeasureDoubleClick } from './measurementDoubleClick.js';
import { applyWheelZoom, createFineZoomModifierTracker } from './wheelZoom.js';
import { cameraPoseKey, createZoomSurfacePicker } from './zoomSurface.js';
import { createFlyController } from './flyControls.js';
import { applyDragNavigation, dragNavigationFor } from './dragNavigation.js';

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

  // Interaction state — set during drag, cleared on mouseup
  isInteractingRef: MutableRefObject<boolean>;

  // Click detection refs
  lastClickTimeRef: MutableRefObject<number>;
  lastClickPosRef: MutableRefObject<{ x: number; y: number } | null>;

  // Camera tracking
  lastCameraStateRef: MutableRefObject<MeasureCameraState | null>;

  // Callbacks
  handlePickForSelection: (pickResult: PickResult | null) => void;
  setHoverState: (state: HoverState & { entityId: number }) => void;
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
  updateMeasurementScreenCoords: (projector: (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null, viewMoved?: boolean) => void;
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
    geometryRef,
    measureRaycastPendingRef,
    measureRaycastFrameRef,
    lastMeasureRaycastDurationRef,
    lastHoverSnapTimeRef,
    lastHoverCheckRef,
    hoverTooltipsEnabledRef,
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
    let pointerGesture: PointerGesture = 'orbit';
    // The pressed orbit's pivot, shown only once the press becomes a drag.
    let pendingOrbitPivot: Parameters<typeof orbitPivotStore.begin>[0] | null = null;
    // The surface under the cursor for zoom (#5393) and the orbit pivot: the
    // CPU raycast where affordable, else the depth probe (#8769, zoomSurface.ts).
    const pickSurface = createZoomSurfacePicker(renderer, camera, getPickOptions);
    let disposed = false; // a probe landing after unmount must not touch the camera
    const hoverPicker = createHoverPicker({
      owner: { canvas, renderer, getTool: () => activeToolRef.current, getPickOptions,
        isOwnerCurrent: () => rendererRef.current === renderer && hoverTooltipsEnabledRef.current && !mouseState.isDragging },
      lastCheck: lastHoverCheckRef, throttleMs: hoverThrottleMs, clear: clearHover,
      commit: (result, position) => setHoverState({ entityId: result.expressId,
        screenX: position.clientX, screenY: position.clientY, worldXYZ: result.worldXYZ, modelIndex: result.modelIndex }),
    });

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
      // `nLen < 1e-6` alone is a magnitude test where finiteness is also at
      // stake: it is false for BOTH `Infinity` and `NaN`, so a non-finite
      // raycast normal passed the floor and then `Infinity / Infinity` made
      // the snapshot below all-NaN (#2495). The store repeats this screen —
      // this copy just avoids arming a 200ms dwell timer for a dead pick.
      if (!hit || !Number.isFinite(nLen) || nLen < 1e-6) {
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

    const commandPress = createCommandPressController(ctx);
    // Mouse controls - respect active tool
    // Uses pointer events + setPointerCapture so pointerup always fires,
    // even when the pointer leaves the canvas (e.g. dragging across panels).
    const handleMouseDown = async (e: PointerEvent) => {
      hoverPicker.cancel();
      commandPress.cancel();
      orbitPivotStore.end();
      pendingOrbitPivot = null;
      invalidateSelectionPick(canvas);
      e.preventDefault();
      // Capture the pointer so move/up events fire even outside the canvas
      capturePointer(canvas, e.pointerId);
      mouseState.isDragging = true;
      mouseState.button = e.button;
      mouseState.lastX = e.clientX;
      mouseState.lastY = e.clientY;
      mouseState.startX = e.clientX;
      mouseState.startY = e.clientY;
      mouseState.didDrag = false;
      mouseState.isRectSelecting = false;
      mouseState.isPanning = false;

      const tool = activeToolRef.current;
      const gesture = resolveNavigationPointerGesture(useViewerStore.getState().navigationPreset, {
        tool, button: e.button, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey,
        metaKey: e.metaKey, altKey: e.altKey,
        measureMode: useViewerStore.getState().measureMode,
        flyEnabled: useViewerStore.getState().interactionMode === 'all',
        distancePending: activeMeasurementRef.current !== null,
      });
      pointerGesture = gesture;
      beginMeasurePress(mouseState, tool === 'measure' && gesture === 'tool'); // #8786; any other press breaks the dblclick chain
      if (tool === 'command' && gesture === 'tool' && commandPress.begin(e)) {
        canvas.style.cursor = 'crosshair';
        return;
      }
      // Right-button fly (#4868) takes priority over ordinary pan. A frozen
      // view refuses fly and falls back to the right-button pan path below.
      if (gesture === 'fly' && fly.begin(canvas)) { clearHover(); canvas.style.cursor = 'crosshair'; return; }

      // Rectangle-select gesture: Ctrl/⌘ + LMB drag while in the
      // select tool. Suppresses orbit/pan; the rect is finalised
      // and pick happens on mouseup.
      if (tool === 'select' && gesture === 'tool' && e.button === 0) {
        mouseState.isRectSelecting = true;
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        setRectSelection?.({ x0: cx, y0: cy, x1: cx, y1: cy });
        return;
      }

      const willOrbit = gesture === 'orbit';

      // Set orbit pivot to the 3D point under the cursor so rotation feels anchored
      // to what the user is looking at. On miss, place pivot at current distance along
      // the cursor ray so orbit always feels connected to where you're pointing.
      // A focused clash with nothing selected orbits around the clashing pair (#4806).
      const clashPivot = willOrbit
        ? focusedClashOrbitPivot(useViewerStore.getState(), selectedEntityIdRef.current) : null;
      let orbitPivot = clashPivot;
      let awaitProbe: { x: number; y: number } | null = null;
      if (willOrbit && !clashPivot) {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;

        // Large models (BVH build over 200K+ meshes blocks the main thread
        // for seconds; the census counts instanced entities and triangles
        // too, see orbitPivotCensus.ts), outlier models with a robust anchor
        // (#1394, whose first-orbit BVH build stalled ~1s) and streaming skip
        // the CPU raycast; the picker answers them from the depth probe
        // (#8769), primed by the hover, else the fallbacks below.
        const hit = pickSurface(cx, cy);
        if (!hit && pickSurface.live?.()) awaitProbe = { x: cx, y: cy };
        if (hit) {
          orbitPivot = hit;
        } else if (selectedEntityIdRef.current) {
          // No geometry under cursor but object selected — use its center
          const center = getEntityCenter(geometryRef.current, selectedEntityIdRef.current);
          orbitPivot = center;
        } else {
          // No geometry hit or large model — anchor the pivot to the scene centre.
          orbitPivot = sceneAnchorOrbitPivot(camera, cx, cy, rect.width, rect.height);
        }
      }
      if (willOrbit) {
        camera.setOrbitCenter(orbitPivot);
        const pending = { point: orbitPivot ?? camera.getTarget(), camera, canvas };
        pendingOrbitPivot = pending;
        if (awaitProbe) {
          // No probe answer yet: adopt it when it lands, if this press is
          // still a click (its pivot not yet shown) and nothing moved the camera.
          const pose = cameraPoseKey(camera);
          void pickSurface.probed?.(awaitProbe.x, awaitProbe.y).then((point) => {
            if (!point || disposed || pendingOrbitPivot !== pending || cameraPoseKey(camera) !== pose) return;
            camera.setOrbitCenter(point);
            pending.point = point;
          });
        }
      }

      if (gesture === 'pan' || gesture === 'fly') {
        mouseState.isPanning = true;
        canvas.style.cursor = 'move';
      } else if (tool === 'measure' && gesture === 'tool') {
        if (handleMeasureDown(ctx, e)) return;
      }
    };
    const handleMouseMove = async (e: PointerEvent) => {
      // New input retires the old position even when this event is throttled.
      hoverPicker.cancel();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const tool = activeToolRef.current;
      if (commandPress.move(e)) return;
      if (!mouseState.isDragging) pickSurface.prime?.(x, y); // #8769: the next wheel or orbit finds the depth waiting

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

      // The distance rubber band, pressed or waiting for its second click (#8771); a navigation press keeps navigating
      if (tool === 'measure' && activeMeasurementRef.current && (!mouseState.isDragging || pointerGesture === 'tool') && !fly.isActive()) {
        if (handleMeasureDrag(ctx, e, x, y)) return;
      }

      // Handle measure tool hover preview (BEFORE dragging starts)
      // Show snap indicators to help user see where they can snap (Point mode previews with Snap off too, #8770)
      if (tool === 'measure' && !mouseState.isDragging) {
        if (useViewerStore.getState().measureMode === 'point') { hoverMeasurePointAt(ctx, x, y); return; }
        if (snapEnabledRef.current && handleMeasureHover(ctx, x, y)) return;
      }

      // A running modeling command owns the hover (#6232, commandPointer.ts).
      if (tool === 'command' && !mouseState.isDragging && routeCommandPointer(ctx, 'move', x, y, e)) return;

      // Section tool face-pick: dwell-aware hover preview (issue #243
      // follow-up). Runs INSTEAD of the generic tooltip path while
      // pick mode is armed so the overlay stays the only signal under
      // the cursor — the tooltip would just compete visually with the
      // accent quad. See `handleSectionPickHover` for the full
      // anti-jitter rules.
      if (tool === 'section' && !mouseState.isDragging && sectionPickModeRef.current) {
        handleSectionPickHover(e, x, y);
        return;
      }

      // A measure tool drag navigates only when the resolver assigned navigation.
      if (mouseState.isDragging && (fly.isActive() || pointerGesture !== 'tool')) {
        // A press is a click until it moves >3px: nudging the camera (and its interaction frame)
        // would discard the click's pick as stale. Crossing applies the whole movement since the press.
        const totalDx = Math.abs(e.clientX - mouseState.startX);
        const totalDy = Math.abs(e.clientY - mouseState.startY);
        if (!mouseState.didDrag) {
          if (fly.isActive()) {
            mouseState.didDrag = totalDx > 5 || totalDy > 5; // fly's own click slop: the menu replay needs both to agree
          } else {
            if (!pressPastClickSlop(mouseState, e)) return;
            mouseState.didDrag = true;
            if (pendingOrbitPivot) orbitPivotStore.begin(pendingOrbitPivot); pendingOrbitPivot = null;
            if (!mouseState.isPanning) canvas.style.cursor = 'grabbing';
          }
        }
        const dx = e.clientX - mouseState.lastX;
        const dy = e.clientY - mouseState.lastY;

        if (fly.isActive()) {
          fly.look(dx, dy, e.movementX, e.movementY); // pointer-locked: the cursor is pinned, so movement deltas lead
          mouseState.lastX = e.clientX; mouseState.lastY = e.clientY;
          return; // fly's onChange signals the render only when the look actually turned the view
        }

        // Always update camera state immediately (feels responsive); the touch controls share this (#9042)
        applyDragNavigation(camera, dragNavigationFor(activeToolRef.current, mouseState.isPanning), dx, dy);

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
        hoverPicker.schedule({ x, y, clientX: e.clientX, clientY: e.clientY });
      }
    };

    const handleMouseUp = (e: PointerEvent) => {
      orbitPivotStore.end();
      pendingOrbitPivot = null;
      const commandOwned = commandPress.end(e);
      releasePointer(canvas, e.pointerId);

      // Clear interaction flag so the animation loop restores post-processing
      if (isInteractingRef.current) {
        isInteractingRef.current = false;
        renderer.requestRender();
      }

      const tool = activeToolRef.current;
      if (commandOwned) {
        mouseState.isDragging = false;
        mouseState.isPanning = false;
        canvas.style.cursor = 'default';
        return;
      }
      const flyEnd = e.button === 2 ? fly.end() : 'none';
      if (flyEnd === 'flew') mouseState.didDrag = true; else if (flyEnd === 'menu' && !mouseState.didDrag) void handleContextMenuSelection(ctx, e);

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
        // Nor ids through a capture's frame (#9137): the selection stays as it is.
        if (rectSize >= 4 && !refuseCaptureHeldPick(renderer)) {
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
      if (tool === 'measure' && pointerGesture === 'tool' && activeMeasurementRef.current && e.button !== 2 && !pressOutlivedReset(mouseState)) {
        if (handleMeasureUp(ctx, e)) return;
      }

      // Genuine completed camera gesture - the tour engine (and anything
      // else) listens for this; the callback-based realtime rotation path
      // deliberately never writes the store, so this is the only signal.
      if (mouseState.isDragging && mouseState.didDrag) {
        emitCameraInteracted(mouseState.isPanning ? 'pan' : 'orbit');
      }

      mouseState.isDragging = false;
      mouseState.isPanning = false;
      canvas.style.cursor = tool === 'pan' ? 'grab' : (tool === 'walk' || tool === 'measure' || tool === 'appearance-face' ? 'crosshair' : 'default');
    };

    const handleMouseLeave = () => {
      hoverPicker.cancel();
      if (commandPress.captured()) return; // Captured command presses may finish outside the canvas.
      forgetCommandPointer();
      commandPress.cancel(); // Capture can be refused; leaving must then abandon the press.
      orbitPivotStore.end();
      const tool = activeToolRef.current;
      mouseState.isDragging = false;
      mouseState.isPanning = false;
      camera.stopInertia();
      // Section face-pick preview: cursor left the canvas, so any
      // pending dwell timer would otherwise commit a stale hover
      // when the user returns. Drop the overlay too so we don't leave
      // an accent quad orphaned on the last-seen face after leaving.
      if (sectionDwellTimerRef.current) {
        clearTimeout(sectionDwellTimerRef.current);
        sectionDwellTimerRef.current = null;
      }
      sectionLastFaceKeyRef.current = null;
      sectionLastCastPosRef.current = null;
      setSectionPickPreview(null);
      if (tool === 'measure') endMeasurePointHover(ctx);
      // Restore cursor based on active tool (same mapping as pointerup)
      canvas.style.cursor = tool === 'pan' ? 'grab' : (tool === 'walk' || tool === 'measure' || tool === 'appearance-face' ? 'crosshair' : 'default');
      clearHover();
    };
    const handlePointerCancel = (e: PointerEvent) => {
      if (!commandPress.hasPress() || commandPress.cancel(e)) handleMouseLeave();
    };
    const handleLostPointerCapture = (e: PointerEvent) => { if (commandPress.cancel(e)) handleMouseLeave(); };
    const handleWindowBlur = () => {
      hoverPicker.cancel();
      clearHover();
      if (commandPress.cancel()) handleMouseLeave();
    };

    const handleContextMenu = async (e: MouseEvent) => {
      // macOS/Linux fire this on PRESS, mid-fly; hold it until release (pointerup replays a plain click).
      if (fly.isActive() || fly.consumeMenuSuppression()) { e.preventDefault(); fly.deferContextMenu(); return; }
      await handleContextMenuSelection(ctx, e);
    };

    // Debounce: clear isInteracting 150ms after the last wheel event
    let wheelIdleTimer: ReturnType<typeof setTimeout> | null = null;

    // Ctrl/Cmd held = finer zoom step (#2683). Tracked from keyboard events
    // rather than read off the wheel event, because a trackpad pinch arrives
    // as a wheel event with `ctrlKey: true` and no key ever pressed - see
    // wheelZoom.ts.
    const fineZoomModifier = createFineZoomModifierTracker();
    const fly = createFlyController({
      camera,
      // Fly moves the camera through setters the embed `?controls=` freeze does not gate, so gate it here (#4868).
      canFly: () => useViewerStore.getState().interactionMode === 'all',
      onChange: () => {
        isInteractingRef.current = true; renderer.requestRender(); updateCameraRotationRealtime(camera.getRotation()); calculateScale();
        clearHover(); // a keys-only flight never reaches the mousemove path that clears it
      },
      // Focus or pointer lock lost mid-flight: no pointerup is coming, so end the drag as leaving the canvas does.
      onCancel: () => { handleMouseLeave(); isInteractingRef.current = false; renderer.requestRender(); },
    });

    const handleWheel = (e: WheelEvent) => {
      noteMouseSideInput('mouse'); // the Measure hint follows the last input, and a wheel or pinch is a mouse's (#8999)
      if (fly.isActive()) return fly.wheel(e); // while flying the wheel sets fly speed, not zoom
      const wheel = resolveWheelNavigation(useViewerStore.getState().navigationPreset, e);
      // Cancels the browser's own Ctrl+wheel page zoom as well as scrolling;
      // works only because the listener below is registered `passive: false`.
      e.preventDefault();
      if (wheel.panX || wheel.panY) camera.pan(wheel.panX, wheel.panY, false);
      if (wheel.zoom) {
        applyWheelZoom(e, {
          camera, canvas,
          fastZoom: e.shiftKey || params.fastZoomRef.current,
          fineModifierHeld: fineZoomModifier.isHeld(),
          pickSurface, // #5393, #8769
        });
      }
      if (!wheel.panX && !wheel.panY && !wheel.zoom) return;

      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => {
        isInteractingRef.current = false;
        renderer.requestRender();
        // One camera-interaction signal per wheel gesture, on the trailing edge.
        emitCameraInteracted(wheel.zoom ? 'zoom' : 'pan');
      }, 150);

      isInteractingRef.current = true;
      renderer.requestRender();

      // Update measurement screen coordinates immediately during zoom (only in measure mode)
      if (activeToolRef.current === 'measure') {
        // Only when the camera moved: a clamped or refused wheel step must not end a Live reading (#8828).
        if (hasPendingMeasurements()) {
          syncMeasureScreenCoords(ctx);
        }
      }
    };

    const handleClick = (e: MouseEvent) => { void handleSelectionClick(ctx, e); };

    const handleDoubleClick = (e: MouseEvent) => handleMeasureDoubleClick(ctx, e);

    // Touch, and a pen press that also arrives as touch, belong to useTouchControls;
    // a Measure tap comes back through the measure context (#5856, #9000).
    const pointers = routeMousePointers(canvas, { down: handleMouseDown, move: handleMouseMove, up: handleMouseUp, cancel: handlePointerCancel });
    const onContextMenu = pointers.after(handleContextMenu), onClick = pointers.after(handleClick), onDoubleClick = pointers.after(handleDoubleClick);
    setMeasureContext(canvas, ctx);
    canvas.addEventListener('pointerdown', pointers.down);
    canvas.addEventListener('pointermove', pointers.move);
    canvas.addEventListener('pointerup', pointers.up);
    canvas.addEventListener('pointercancel', pointers.cancel);
    canvas.addEventListener('lostpointercapture', handleLostPointerCapture);
    window.addEventListener('blur', handleWindowBlur);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('dblclick', onDoubleClick);

    return () => {
      disposed = true;
      orbitPivotStore.end();
      invalidateSelectionPick(canvas);
      hoverPicker.dispose();
      setMeasureContext(canvas, null);
      canvas.removeEventListener('pointerdown', pointers.down);
      canvas.removeEventListener('pointermove', pointers.move);
      canvas.removeEventListener('pointerup', pointers.up);
      canvas.removeEventListener('pointercancel', pointers.cancel);
      pointers.dispose();
      canvas.removeEventListener('lostpointercapture', handleLostPointerCapture);
      window.removeEventListener('blur', handleWindowBlur);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDoubleClick);
      commandPress.dispose();
      fineZoomModifier.dispose();
      fly.dispose();
      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);

      // Cancel pending raycast requests and Point mode's hover (#8770)
      endMeasurePointHover(ctx);

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
