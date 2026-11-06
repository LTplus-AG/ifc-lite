/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The real `useMouseControls` and `useTouchControls` mounted on one canvas,
 * as Viewport.tsx mounts them, with the finger, pen and mouse event sequences
 * a browser sends (#5856, #9000, #9042). Every pick lands on the plane z = 0,
 * at x = canvas x / 100, unless the renderer is overridden.
 */

import { act } from 'react';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useMouseControls, type UseMouseControlsParams, type MouseState } from '@/components/viewer/useMouseControls.js';
import { useTouchControls, type UseTouchControlsParams } from '@/components/viewer/useTouchControls.js';

const ref = <T,>(current: T) => ({ current });
const noop = () => {};

export interface ViewportControlsOptions {
  /** Replaces the matching mouse-controls params (section refs, callbacks). */
  mouse?: Partial<UseMouseControlsParams>;
  /** Replaces the matching renderer methods (e.g. `raycastScene`). */
  renderer?: Record<string, unknown>;
  /** Runs on the camera and canvas before the hooks mount. */
  setup?: (camera: Camera, canvas: HTMLCanvasElement) => void;
}

export function mountViewportControls(tool: string, pickedId: number | null = null, options: ViewportControlsOptions = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 800; canvas.height = 600;
  canvas.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 });
  Object.assign(canvas, { setPointerCapture: noop, releasePointerCapture: noop });
  document.body.appendChild(canvas);

  const camera = new Camera();
  camera.setAspect(800 / 600);
  camera.setPosition(0, 0, 10);
  camera.setTarget(0, 0, 0);
  options.setup?.(camera, canvas);
  const renderer = {
    getCamera: () => camera,
    getCanvas: () => canvas,
    requestRender: noop,
    getScene: () => ({ getMeshes: () => [], getBatchedMeshes: () => [], getInstancedEntityCount: () => 0 }),
    pick: async () => pickedId === null ? null : { expressId: pickedId },
    pickRect: async () => [],
    raycastScene: () => null,
    raycastSceneMagnetic: (x: number) => ({
      intersection: { point: { x: x / 100, y: 0, z: 0 } },
      snapTarget: null,
      edgeLock: { shouldRelease: false, shouldLock: false, edge: null },
    }),
    ...options.renderer,
  } as unknown as Renderer;
  const state = useViewerStore.getState();
  const menus: Array<{ id: number | null; x: number; y: number }> = [];
  let selections = 0;
  const activeToolRef = ref(tool);
  // One stable object, as between real frames: the select path refuses a pick whose options changed.
  const stablePickOptions = { isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null };
  const pickOptions = () => stablePickOptions;

  const mouseParams = {
    canvasRef: ref(canvas), rendererRef: ref(renderer), isInitialized: true,
    mouseStateRef: ref<MouseState>({ isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false }),
    // Distance state is store-bound, as Viewport.tsx binds it: a tap's start is the store's (#8771).
    activeToolRef, snapEnabledRef: ref(false),
    activeMeasurementRef: { get current() { return useViewerStore.getState().activeMeasurement; }, set current(_v) { /* store-owned */ } },
    edgeLockStateRef: ref(state.edgeLockState), measurementConstraintEdgeRef: ref(null),
    sectionPickModeRef: ref(false), modelBoundsRef: ref(null),
    hiddenEntitiesRef: ref(new Set<number>()), isolatedEntitiesRef: ref(null),
    selectedEntityIdRef: ref(null), selectedModelIndexRef: ref(undefined),
    clearColorRef: ref<[number, number, number, number]>([0, 0, 0, 1]),
    sectionPlaneRef: ref(state.sectionPlane), sectionRangeRef: ref(null), geometryRef: ref(null),
    measureRaycastPendingRef: ref(false), measureRaycastFrameRef: ref(null),
    lastMeasureRaycastDurationRef: ref(0), lastHoverSnapTimeRef: ref(0), lastHoverCheckRef: ref(0),
    hoverTooltipsEnabledRef: ref(false),
    isInteractingRef: ref(false), lastClickTimeRef: ref(0), lastClickPosRef: ref(null), lastCameraStateRef: ref(null),
    handlePickForSelection: () => { selections++; }, setHoverState: noop, clearHover: noop,
    openContextMenu: (id, x, y) => menus.push({ id, x, y }),
    startMeasurement: (p) => useViewerStore.getState().startMeasurement(p),
    updateMeasurement: (p) => useViewerStore.getState().updateMeasurement(p),
    finalizeMeasurement: () => useViewerStore.getState().finalizeMeasurement(),
    setSnapTarget: noop, setSnapVisualization: noop, setEdgeLock: noop, updateEdgeLockPosition: noop,
    clearEdgeLock: noop, incrementEdgeLockStrength: noop, setMeasurementConstraintEdge: noop,
    updateConstraintActiveAxis: noop, updateMeasurementScreenCoords: noop, updateCameraRotationRealtime: noop,
    toggleSelection: noop, calculateScale: noop, getPickOptions: pickOptions,
    hasPendingMeasurements: () => false, setSectionPlaneFromFace: noop, setSectionPickMode: noop, setSectionPickPreview: noop,
    HOVER_SNAP_THROTTLE_MS: 50, SLOW_RAYCAST_THRESHOLD_MS: 50, hoverThrottleMs: 50,
    fastZoomRef: ref(false),
  } satisfies UseMouseControlsParams;
  Object.assign(mouseParams, options.mouse);
  const touchParams: UseTouchControlsParams = {
    canvasRef: ref(canvas), rendererRef: ref(renderer), isInitialized: true, activeToolRef,
    hiddenEntitiesRef: ref(new Set<number>()), isolatedEntitiesRef: ref(null), selectedEntityIdRef: ref(null),
    selectedModelIndexRef: ref(undefined), clearColorRef: ref([0, 0, 0, 1]), sectionPlaneRef: ref(state.sectionPlane),
    sectionRangeRef: ref(null), geometryRef: ref(null), isInteractingRef: ref(false),
    handlePickForSelection: () => { selections++; },
    openContextMenu: (id, x, y) => menus.push({ id, x, y }),
    getPickOptions: pickOptions,
    touchStateRef: ref({ touches: [], lastDistance: 0, lastCenter: { x: 0, y: 0 }, tapStartTime: 0,
      tapStartPos: { x: 0, y: 0 }, didMove: false, multiTouch: false, twoFingerGesture: 'none' as const,
      gestureDistanceAccum: 0, gesturePanAccum: 0 }),
  };
  function Probe() {
    useMouseControls(mouseParams);
    useTouchControls(touchParams);
    return null;
  }
  render(<Probe />);
  return { canvas, camera, menus, activeToolRef, selectionCount: () => selections };
}

export function pointer(type: string, pointerType: 'touch' | 'mouse' | 'pen', x: number, y: number, buttons = 0): PointerEvent {
  const e = new PointerEvent(type, { button: 0, buttons, pointerId: 1, bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    clientX: { value: x, configurable: true },
    clientY: { value: y, configurable: true },
    pointerType: { value: pointerType, configurable: true },
  });
  return e;
}

export function touchEvent(kind: string, canvas: HTMLCanvasElement, points: Array<[number, number]>, touchType?: 'direct' | 'stylus'): Event {
  const event = new window.Event(kind, { bubbles: true, cancelable: true });
  const touches = points.map(([x, y], i) => ({ identifier: i + 1, target: canvas, clientX: x, clientY: y, touchType }));
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'changedTouches', { value: touches });
  return event;
}

export async function tap(canvas: HTMLCanvasElement, x: number, y: number): Promise<void> {
  await act(async () => {
    canvas.dispatchEvent(touchEvent('touchstart', canvas, [[x, y]]));
    canvas.dispatchEvent(touchEvent('touchend', canvas, []));
  });
}

export function pointerDrag(canvas: HTMLCanvasElement, pointerType: 'touch' | 'mouse' | 'pen'): void {
  act(() => {
    canvas.dispatchEvent(pointer('pointerdown', pointerType, 400, 300));
    for (let i = 1; i <= 5; i++) canvas.dispatchEvent(pointer('pointermove', pointerType, 400 + 20 * i, 300));
    canvas.dispatchEvent(pointer('pointerup', pointerType, 500, 300));
  });
}

export const pos = (camera: Camera) => JSON.stringify(camera.getPosition());

export const settle = () => new Promise((r) => setTimeout(r, 0));

/** A click; `pointerType` null is an engine whose click is no PointerEvent. */
export const click = (x: number, y: number, pointerType: string | null = 'pen') => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y });
  if (pointerType) Object.defineProperty(e, 'pointerType', { value: pointerType });
  return e;
};

/** iOS order: pointerdown, touchstart, pointermove, touchmove ... pointerup, touchend, then a possible click. */
export async function pencilTap(canvas: HTMLCanvasElement, x: number, y: number, touchType: 'stylus' | undefined = 'stylus') {
  await act(async () => {
    canvas.dispatchEvent(pointer('pointerdown', 'pen', x, y));
    canvas.dispatchEvent(touchEvent('touchstart', canvas, [[x, y]], touchType));
    await settle();
    canvas.dispatchEvent(pointer('pointerup', 'pen', x, y));
    canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    canvas.dispatchEvent(click(x, y));
    await settle();
  });
}

/** A 100 px drag right from (400, 300), in five 20 px steps. */
export function pencilDrag(canvas: HTMLCanvasElement, touchFirst = false, touchType: 'stylus' | undefined = 'stylus') {
  act(() => {
    const down = [pointer('pointerdown', 'pen', 400, 300), touchEvent('touchstart', canvas, [[400, 300]], touchType)];
    for (const e of touchFirst ? down.reverse() : down) canvas.dispatchEvent(e);
  });
  act(() => {
    for (let i = 1; i <= 5; i++) {
      canvas.dispatchEvent(pointer('pointermove', 'pen', 400 + 20 * i, 300, 1));
      canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 + 20 * i, 300]], touchType));
    }
    canvas.dispatchEvent(pointer('pointerup', 'pen', 500, 300));
    canvas.dispatchEvent(touchEvent('touchend', canvas, []));
  });
}

/** The same drag as `pencilDrag`, with a finger. */
export function fingerDrag(canvas: HTMLCanvasElement) {
  act(() => {
    canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
    for (let i = 1; i <= 5; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 + 20 * i, 300]]));
    canvas.dispatchEvent(touchEvent('touchend', canvas, []));
  });
}
