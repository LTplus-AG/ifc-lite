/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5856: one touch, one input pipeline.
 *
 * A finger fires pointer events as well as touch events. The mouse controls
 * handled the touch-sourced pointer events too, so a one-finger drag was
 * orbited by both hooks, and in Measure the mouse path started a drag
 * measurement while the touch path orbited. `touchstart` also calls
 * `preventDefault`, which suppresses the compatibility click, so no Measure
 * mode could place a point by tap at all.
 *
 * Mounts the real `useMouseControls` and `useTouchControls` on one canvas.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useMouseControls, type UseMouseControlsParams, type MouseState } from './useMouseControls.js';
import { useTouchControls, type UseTouchControlsParams } from './useTouchControls.js';

const ref = <T,>(current: T) => ({ current });
const noop = () => {};

function rig(tool: string, pickedId: number | null = null) {
  const canvas = document.createElement('canvas');
  canvas.width = 800; canvas.height = 600;
  canvas.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 });
  Object.assign(canvas, { setPointerCapture: noop, releasePointerCapture: noop });
  document.body.appendChild(canvas);

  const camera = new Camera();
  camera.setAspect(800 / 600);
  camera.setPosition(0, 0, 10);
  camera.setTarget(0, 0, 0);
  // Every pick lands on the plane z = 0, at x = canvas x / 100.
  const renderer = {
    getCamera: () => camera,
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
  } as unknown as Renderer;
  const state = useViewerStore.getState();
  const menus: Array<{ id: number | null; x: number; y: number }> = [];
  let selections = 0;
  const activeToolRef = ref(tool);
  const pickOptions = () => ({ isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null });

  const mouseParams = {
    canvasRef: ref(canvas), rendererRef: ref(renderer), isInitialized: true,
    mouseStateRef: ref<MouseState>({ isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false }),
    activeToolRef, activeMeasurementRef: ref(null), snapEnabledRef: ref(false),
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
    openContextMenu: (id, x, y) => menus.push({ id, x, y }),
    startMeasurement: noop, updateMeasurement: noop, finalizeMeasurement: noop,
    setSnapTarget: noop, setSnapVisualization: noop, setEdgeLock: noop, updateEdgeLockPosition: noop,
    clearEdgeLock: noop, incrementEdgeLockStrength: noop, setMeasurementConstraintEdge: noop,
    updateConstraintActiveAxis: noop, updateMeasurementScreenCoords: noop, updateCameraRotationRealtime: noop,
    toggleSelection: noop, calculateScale: noop, getPickOptions: pickOptions,
    hasPendingMeasurements: () => false, setSectionPlaneFromFace: noop, setSectionPickMode: noop, setSectionPickPreview: noop,
    HOVER_SNAP_THROTTLE_MS: 50, SLOW_RAYCAST_THRESHOLD_MS: 50, hoverThrottleMs: 50,
    RENDER_THROTTLE_MS_SMALL: 16, RENDER_THROTTLE_MS_LARGE: 33, RENDER_THROTTLE_MS_HUGE: 66,
    fastZoomRef: ref(false),
  } satisfies UseMouseControlsParams;
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
  return { canvas, camera, menus, selectionCount: () => selections };
}

function pointer(type: string, pointerType: 'touch' | 'mouse', x: number, y: number): PointerEvent {
  const e = new PointerEvent(type, { button: 0, pointerId: 1, bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    clientX: { value: x, configurable: true },
    clientY: { value: y, configurable: true },
    pointerType: { value: pointerType, configurable: true },
  });
  return e;
}

function touchEvent(kind: string, canvas: HTMLCanvasElement, points: Array<[number, number]>): Event {
  const event = new window.Event(kind, { bubbles: true, cancelable: true });
  const touches = points.map(([x, y], i) => ({ identifier: i + 1, target: canvas, clientX: x, clientY: y }));
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'changedTouches', { value: touches });
  return event;
}

async function tap(canvas: HTMLCanvasElement, x: number, y: number): Promise<void> {
  await act(async () => {
    canvas.dispatchEvent(touchEvent('touchstart', canvas, [[x, y]]));
    canvas.dispatchEvent(touchEvent('touchend', canvas, []));
  });
}

function pointerDrag(canvas: HTMLCanvasElement, pointerType: 'touch' | 'mouse'): void {
  act(() => {
    canvas.dispatchEvent(pointer('pointerdown', pointerType, 400, 300));
    for (let i = 1; i <= 5; i++) canvas.dispatchEvent(pointer('pointermove', pointerType, 400 + 20 * i, 300));
    canvas.dispatchEvent(pointer('pointerup', pointerType, 500, 300));
  });
}

const pos = (camera: Camera) => JSON.stringify(camera.getPosition());

afterEach(() => {
  mock.timers.reset();
  cleanup();
  for (const canvas of document.querySelectorAll('canvas')) canvas.remove();
  useViewerStore.getState().clearMeasurements();
  useViewerStore.setState({ measureMode: 'drag', pendingMeasurePoint: null, activeMeasurement: null });
});

describe('touch long press (#5859)', () => {
  it('opens the shared picked menu at 500 ms, once, without orbit or tap-selection', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas, camera, menus, selectionCount } = rig('select', 42);
    const before = pos(camera);
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    mock.timers.tick(499);
    assert.deepEqual(menus, []);
    await act(async () => { mock.timers.tick(1); await Promise.resolve(); });
    assert.deepEqual(menus, [{ id: 42, x: 200, y: 300 }]);
    assert.equal(pos(camera), before);
    act(() => canvas.dispatchEvent(touchEvent('touchmove', canvas, [[240, 300]])));
    assert.equal(pos(camera), before, 'a held finger must not resume orbiting');
    const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 });
    assert.equal(canvas.dispatchEvent(native), false, 'the native menu must be suppressed');
    act(() => canvas.dispatchEvent(touchEvent('touchend', canvas, [])));
    const trailingNative = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 });
    assert.equal(canvas.dispatchEvent(trailingNative), false, 'a trailing native menu after release must be suppressed');
    assert.equal(selectionCount(), 0, 'lifting a held finger must not select');
    assert.deepEqual(menus, [{ id: 42, x: 200, y: 300 }]);
  });

  it('cancels on movement beyond tap slop or a second finger', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas, menus } = rig('select', 42);
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]]));
      canvas.dispatchEvent(touchEvent('touchmove', canvas, [[212, 300]]));
    });
    mock.timers.tick(500);
    assert.deepEqual(menus, [], 'an orbit drag opened the menu');
    act(() => canvas.dispatchEvent(touchEvent('touchend', canvas, [])));
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]]));
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300], [240, 300]]));
    });
    mock.timers.tick(500);
    assert.deepEqual(menus, [], 'a pinch opened the menu');
  });

  it('lets the remaining finger orbit after a second finger cancels a fired hold', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas, camera, menus } = rig('select', 42);
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    await act(async () => { mock.timers.tick(500); await Promise.resolve(); });
    assert.equal(menus.length, 1);
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300], [240, 300]])));
    act(() => canvas.dispatchEvent(touchEvent('touchend', canvas, [[200, 300]])));
    const before = pos(camera);
    act(() => canvas.dispatchEvent(touchEvent('touchmove', canvas, [[260, 300]])));
    assert.notEqual(pos(camera), before, 'cancelled hold must release the remaining finger to orbit');
    assert.equal(menus.length, 1, 'cancellation must not open another menu');
  });

  it('suppresses only the native menu near the held point while distant mouse right-click still works', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas, menus } = rig('select', 42);
    const context = (x: number, y: number) => new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    });
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    await act(async () => { canvas.dispatchEvent(context(500, 300)); await Promise.resolve(); });
    assert.deepEqual(menus, [{ id: 42, x: 500, y: 300 }], 'unrelated mouse menu during hold was blocked');
    await act(async () => { mock.timers.tick(500); await Promise.resolve(); });
    assert.equal(menus.length, 2, 'long press still opens its menu');
    assert.equal(canvas.dispatchEvent(context(200, 300)), false, 'native duplicate at held point was not blocked');
    await act(async () => { canvas.dispatchEvent(context(600, 300)); await Promise.resolve(); });
    assert.deepEqual(menus[2], { id: 42, x: 600, y: 300 }, 'distant mouse menu after hold was blocked');
  });
});

describe('touch goes through the touch pipeline only (#5856)', () => {
  it('the mouse controls ignore touch-sourced pointer events', () => {
    const { canvas, camera } = rig('select');
    const before = pos(camera);
    pointerDrag(canvas, 'touch');
    assert.equal(pos(camera), before, 'a touch-sourced pointer drag orbited through the mouse controls');
  });

  it('a mouse pointer drag still orbits (control)', () => {
    const { canvas, camera } = rig('select');
    const before = pos(camera);
    pointerDrag(canvas, 'mouse');
    assert.notEqual(pos(camera), before, 'the mouse drag no longer orbits');
  });
});

describe('Measure by tap (#5856)', () => {
  it('two taps in Drag mode measure the distance between them', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const { canvas } = rig('measure');
    await tap(canvas, 200, 300);
    await tap(canvas, 500, 300);
    const { measurements, pendingMeasurePoint } = useViewerStore.getState();
    assert.equal(measurements.length, 1, 'two taps did not produce a measurement');
    assert.equal(pendingMeasurePoint, null);
    assert.ok(Math.abs(measurements[0].distance - 3) < 1e-9, `distance ${measurements[0].distance}, expected 3`);
  });
});
