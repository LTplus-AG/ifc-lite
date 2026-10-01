/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Mounted real viewport handlers with a deterministic empty pick surface. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useMouseControls, type UseMouseControlsParams, type MouseState } from '@/components/viewer/useMouseControls.js';

const ref = <T,>(current: T) => ({ current });
const noop = () => {};

export function mousePointer(type: string, button: number, x: number, y: number, modifiers: PointerEventInit = {}): PointerEvent {
  const buttons = type === 'pointerdown' || type === 'pointermove' ? button === 0 ? 1 : button === 1 ? 4 : 2 : 0;
  const e = new PointerEvent(type, { button, buttons, pointerId: 1, bubbles: true, cancelable: true, ...modifiers });
  Object.defineProperties(e, {
    clientX: { value: x, configurable: true },
    clientY: { value: y, configurable: true },
  });
  return e;
}

const mounted: { root: Root; host: HTMLElement }[] = [];

export function mountMouseControls(overrides: Partial<UseMouseControlsParams> = {}, setup?: (camera: Camera, canvas: HTMLCanvasElement) => void): { canvas: HTMLCanvasElement; camera: Camera; menus: number[]; params: UseMouseControlsParams } {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  // happy-dom does not implement capture: model the DOM ownership contract,
  // including synchronous loss on release. Native capture is checked separately.
  const captures = new Set<number>();
  Object.assign(canvas, {
    setPointerCapture: (id: number) => captures.add(id),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => {
      if (captures.delete(id)) canvas.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: id }));
    },
  });
  document.body.appendChild(canvas);

  const camera = new Camera();
  camera.setPosition(0, 1.6, 10);
  camera.setTarget(0, 1.6, 0);
  setup?.(camera, canvas);
  const menus: number[] = [];
  const renderer = {
    getCamera: () => camera,
    getCanvas: () => canvas,
    getScene: () => ({ getMeshes: () => [], getBatchedMeshes: () => [], getInstancedEntityCount: () => 0 }),
    requestRender: noop,
    pick: async () => null,
    pickRect: async () => [],
    raycastScene: () => null, // wheel zoom surface pick (#5393): empty space
  } as unknown as Renderer;
  const state = useViewerStore.getState();

  const params = {
    canvasRef: ref(canvas), rendererRef: ref(renderer), isInitialized: true,
    mouseStateRef: ref<MouseState>({ isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false }),
    activeToolRef: ref('select'), activeMeasurementRef: ref(null), snapEnabledRef: ref(false),
    edgeLockStateRef: ref(state.edgeLockState), measurementConstraintEdgeRef: ref(null),
    sectionPickModeRef: ref(false), modelBoundsRef: ref(null),
    hiddenEntitiesRef: ref(new Set<number>()), isolatedEntitiesRef: ref(null),
    selectedEntityIdRef: ref(null), selectedModelIndexRef: ref(undefined),
    clearColorRef: ref<[number, number, number, number]>([0, 0, 0, 1]),
    sectionPlaneRef: ref(state.sectionPlane), sectionRangeRef: ref(null), geometryRef: ref(null),
    measureRaycastPendingRef: ref(false), measureRaycastFrameRef: ref(null),
    lastMeasureRaycastDurationRef: ref(0), lastHoverSnapTimeRef: ref(0), lastHoverCheckRef: ref(0),
    hoverTooltipsEnabledRef: ref(false), lastRenderTimeRef: ref(0), renderPendingRef: ref(false),
    isInteractingRef: ref(false), lastClickTimeRef: ref(0), lastClickPosRef: ref(null), lastCameraStateRef: ref(null),
    handlePickForSelection: noop, setHoverState: noop, clearHover: noop,
    openContextMenu: (id: number | null) => { menus.push(id ?? -1); },
    startMeasurement: noop, updateMeasurement: noop, finalizeMeasurement: noop,
    setSnapTarget: noop, setSnapVisualization: noop, setEdgeLock: noop, updateEdgeLockPosition: noop,
    clearEdgeLock: noop, incrementEdgeLockStrength: noop, setMeasurementConstraintEdge: noop,
    updateConstraintActiveAxis: noop, updateMeasurementScreenCoords: noop, updateCameraRotationRealtime: noop,
    toggleSelection: noop, calculateScale: noop,
    getPickOptions: () => ({ isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null }),
    hasPendingMeasurements: () => false, setSectionPlaneFromFace: noop, setSectionPickMode: noop, setSectionPickPreview: noop,
    HOVER_SNAP_THROTTLE_MS: 50, SLOW_RAYCAST_THRESHOLD_MS: 50, hoverThrottleMs: 50,
    RENDER_THROTTLE_MS_SMALL: 16, RENDER_THROTTLE_MS_LARGE: 33, RENDER_THROTTLE_MS_HUGE: 66,
    fastZoomRef: ref(false),
  } satisfies UseMouseControlsParams;
  Object.assign(params, overrides);

  function Probe() {
    useMouseControls(params);
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Probe />));
  mounted.push({ root, host });
  return { canvas, camera, menus, params };
}

export function cleanupMouseControls(): void {
  while (mounted.length) {
    const { root, host } = mounted.pop()!;
    act(() => root.unmount());
    host.remove();
  }
  document.body.innerHTML = '';
}
