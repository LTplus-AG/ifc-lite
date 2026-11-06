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
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useMouseControls, type UseMouseControlsParams, type MouseState } from './useMouseControls.js';
import { useTouchControls, type UseTouchControlsParams } from './useTouchControls.js';
import { measureHintKey } from './tools/measure-modes/readouts.js';
import { measureEn } from '@/i18n/catalogues/measure.en';
import { MeasurementList } from './tools/MeasurementList.js';

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

function pointer(type: string, pointerType: 'touch' | 'mouse' | 'pen', x: number, y: number, buttons = 0): PointerEvent {
  const e = new PointerEvent(type, { button: 0, buttons, pointerId: 1, bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    clientX: { value: x, configurable: true },
    clientY: { value: y, configurable: true },
    pointerType: { value: pointerType, configurable: true },
  });
  return e;
}

function touchEvent(kind: string, canvas: HTMLCanvasElement, points: Array<[number, number]>, touchType?: 'direct' | 'stylus'): Event {
  const event = new window.Event(kind, { bubbles: true, cancelable: true });
  const touches = points.map(([x, y], i) => ({ identifier: i + 1, target: canvas, clientX: x, clientY: y, touchType }));
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

function pointerDrag(canvas: HTMLCanvasElement, pointerType: 'touch' | 'mouse' | 'pen'): void {
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
  useViewerStore.setState({ measureMode: 'drag', activeMeasurement: null, pointerInput: 'mouse' });
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

  it('a diagonal tap wobble that cancels the long press still selects without orbiting', async () => {
    const { canvas, camera, selectionCount } = rig('select', 42);
    const before = pos(camera);
    await act(async () => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]]));
      canvas.dispatchEvent(touchEvent('touchmove', canvas, [[208, 308]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.equal(pos(camera), before, "BUG: 8px,8px leaves the long-press slop (radius) but not the tap's per-axis slop: it orbited, which discards the tap's pick as stale");
    assert.equal(selectionCount(), 1, 'the tap still selects');
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]]));
      canvas.dispatchEvent(touchEvent('touchmove', canvas, [[230, 300]]));
    });
    assert.notEqual(pos(camera), before, 'past the slop the finger orbits');
    act(() => canvas.dispatchEvent(touchEvent('touchend', canvas, [])));
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
    const { measurements, activeMeasurement } = useViewerStore.getState();
    assert.equal(measurements.length, 1, 'two taps did not produce a measurement');
    assert.equal(activeMeasurement, null);
    assert.ok(Math.abs(measurements[0].distance - 3) < 1e-9, `distance ${measurements[0].distance}, expected 3`);
  });
});

describe('a touch that began before a Measure gesture reset places no point (#8786)', () => {
  it('a Distance touch, a switch to Polyline while held, then lift, adds no polyline point', async () => {
    useViewerStore.setState({ measureMode: 'drag', activePolyline: null });
    const { canvas } = rig('measure');
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    act(() => useViewerStore.getState().setMeasureMode('polyline'));
    await act(async () => { canvas.dispatchEvent(touchEvent('touchend', canvas, [])); });
    assert.equal(useViewerStore.getState().activePolyline === null, true, 'BUG: the lift added a polyline point the user never placed in Polyline');
    await tap(canvas, 300, 300);
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 1, 'the next tap in Polyline places its point');
    useViewerStore.getState().cancelPolyline();
  });

  it('a Polyline touch, a switch to Distance while held, then lift, sets no start', async () => {
    useViewerStore.setState({ measureMode: 'polyline', activePolyline: null });
    const { canvas } = rig('measure');
    act(() => canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]])));
    act(() => useViewerStore.getState().setMeasureMode('drag'));
    await act(async () => { canvas.dispatchEvent(touchEvent('touchend', canvas, [])); });
    assert.equal(useViewerStore.getState().activeMeasurement === null, true, 'BUG: the lift set a distance start the user never placed in Distance');
  });
});

/** The Measure hint line's English text for the store as it stands. */
const hint = (): string => String(measureEn[measureHintKey(useViewerStore.getState()) as keyof typeof measureEn]);
/** Words a touch user has no way to act on. */
const MOUSE_ONLY = /\b(click|dbl-click|shift|esc|enter)\b/i;
const mouseAt = (canvas: HTMLCanvasElement, type: string, x: number, y: number, kind: 'mouse' | 'pen' | 'touch' = 'mouse') =>
  act(() => { canvas.dispatchEvent(pointer(type, kind, x, y)); });

describe('the Measure hint follows the last input (#8879)', () => {
  it('a tap leaves a Distance hint with no Shift, Esc or click', async () => {
    const { canvas } = rig('measure');
    await tap(canvas, 200, 300);
    assert.ok(useViewerStore.getState().activeMeasurement, 'the tap set the start');
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'the pending-end hint after a tap');
    assert.match(hint(), /\btap\b/i);
  });

  it('a mouse move after a tap brings back the click wording with Shift', async () => {
    const { canvas } = rig('measure');
    await tap(canvas, 200, 300);
    mouseAt(canvas, 'pointermove', 400, 300);
    assert.match(hint(), /Shift/, 'the mouse user is offered the axis lock again');
  });

  it('a mouse click with no move after a tap brings back the click wording', async () => {
    const { canvas } = rig('measure');
    await tap(canvas, 200, 300);
    await tap(canvas, 500, 300);
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'the start hint after two taps');
    mouseAt(canvas, 'pointerdown', 200, 300);
    mouseAt(canvas, 'pointerup', 200, 300);
    assert.match(hint(), /click/i);
  });

  it('on a hybrid device the hint follows whichever input was used last', async () => {
    const { canvas } = rig('measure');
    mouseAt(canvas, 'pointermove', 100, 300);
    assert.match(hint(), /click/i, 'mouse first');
    await tap(canvas, 200, 300);
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'then a tap');
    mouseAt(canvas, 'pointermove', 300, 300);
    assert.match(hint(), /Shift/, 'then the mouse again');
    await tap(canvas, 400, 300);
    assert.equal(useViewerStore.getState().measurements.length, 1, 'the tap finished the measurement');
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'then a tap again');
  });

  it('the touch-sourced pointer events of a finger keep the tap wording', async () => {
    const { canvas } = rig('measure');
    await tap(canvas, 200, 300);
    pointerDrag(canvas, 'touch');
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'a finger\'s pointer events are not a mouse');
  });

  it('a touch in another tool words the Measure hint for touch on entry', async () => {
    const { canvas } = rig('select');
    await tap(canvas, 200, 300);
    assert.equal(useViewerStore.getState().pointerInput, 'touch');
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'the Distance start hint on entering Measure');
  });

  it('a pen words the hint as touch does', () => {
    const { canvas } = rig('measure');
    mouseAt(canvas, 'pointermove', 100, 300, 'pen');
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'a stylus has no Shift or Esc to rely on');
  });
  it('a wheel after a tap, with no pointer move, brings back the click wording with Shift (#8999)', async () => {
    const { canvas } = rig('measure');
    await tap(canvas, 200, 300);
    act(() => { canvas.dispatchEvent(wheelAt()); });
    assert.equal(useViewerStore.getState().pointerInput, 'mouse');
    assert.match(hint(), /Shift/, 'a wheel or trackpad scroll is a mouse');
  });

  it('a trackpad pinch (ctrl+wheel) after a tap brings back the mouse wording (#8999)', async () => {
    const { canvas } = rig('measure');
    await tap(canvas, 200, 300);
    act(() => { canvas.dispatchEvent(wheelAt({ ctrlKey: true })); });
    assert.equal(useViewerStore.getState().pointerInput, 'mouse');
    assert.match(hint(), /Shift/, 'a pinch arrives as a ctrl+wheel from a mouse-class device');
  });

  it('a wheel with no tap before it changes nothing (#8999)', () => {
    const { canvas } = rig('measure');
    const before = hint();
    let writes = 0;
    const unsubscribe = useViewerStore.subscribe((next, prev) => { if (next.pointerInput !== prev.pointerInput) writes++; });
    try {
      act(() => { canvas.dispatchEvent(wheelAt()); });
    } finally {
      unsubscribe();
    }
    assert.equal(writes, 0, 'already mouse: no pointerInput write');
    assert.equal(hint(), before);
  });
});

/**
 * happy-dom's `WheelEvent` implements only the delta half of the init dict, so
 * `ctrlKey` and the position are defined explicitly, as in
 * `useMouseControls.wheelZoom.test.tsx`.
 */
function wheelAt(init: { ctrlKey?: boolean } = {}): WheelEvent {
  const e = new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    ctrlKey: { value: init.ctrlKey ?? false, configurable: true },
    metaKey: { value: false, configurable: true },
    clientX: { value: 400, configurable: true },
    clientY: { value: 300, configurable: true },
  });
  return e;
}

/**
 * #9000: an Apple Pencil on iPad. iOS Safari sends one Pencil press as pointer
 * events (`pointerType: 'pen'`) and as touch events (`touchType: 'stylus'`),
 * each pointer event just before its touch event. A desktop pen sends pointer
 * events only. Either way one pipeline owns the press.
 */
describe('a pen press goes through one pipeline (#9000)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const click = (x: number, y: number, pointerType: string | undefined = 'pen') => {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y });
    if (pointerType) Object.defineProperty(e, 'pointerType', { value: pointerType });
    return e;
  };

  /** iOS order: pointerdown, touchstart, pointermove, touchmove ... pointerup, touchend, then a possible click. */
  async function pencilTap(canvas: HTMLCanvasElement, x: number, y: number, touchType: 'stylus' | undefined = 'stylus') {
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

  function pencilDrag(canvas: HTMLCanvasElement, touchFirst = false, touchType: 'stylus' | undefined = 'stylus') {
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

  function fingerDrag(canvas: HTMLCanvasElement) {
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      for (let i = 1; i <= 5; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 + 20 * i, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
  }

  it('an iPad pen drag orbits once, exactly as a finger drag does', () => {
    const finger = rig('select');
    fingerDrag(finger.canvas);
    const expected = pos(finger.camera);
    cleanup(); finger.canvas.remove();
    const pen = rig('select');
    const before = pos(pen.camera);
    pencilDrag(pen.canvas);
    assert.notEqual(pos(pen.camera), before, 'the pen drag did not orbit');
    assert.equal(pos(pen.camera), expected, 'BUG: the pen drag orbited through both the mouse and the touch controls');
  });

  it('the same holds when the touchstart comes before the pointerdown', () => {
    const finger = rig('select');
    fingerDrag(finger.canvas);
    const expected = pos(finger.camera);
    cleanup(); finger.canvas.remove();
    const pen = rig('select');
    pencilDrag(pen.canvas, true);
    assert.equal(pos(pen.camera), expected, 'BUG: the pen drag orbited through both pipelines');
  });

  it('touchstart first without touchType: the touch at the pen point still owns the press', () => {
    const finger = rig('select');
    fingerDrag(finger.canvas);
    const expected = pos(finger.camera);
    cleanup(); finger.canvas.remove();
    const pen = rig('select');
    pencilDrag(pen.canvas, true, undefined);
    assert.equal(pos(pen.camera), expected, 'BUG: the pen drag orbited through both pipelines');
  });

  it('a touch-owned pen whose pointerup never arrived does not keep the next pointer-only press from the mouse side', () => {
    const mouse = rig('select');
    pointerDrag(mouse.canvas, 'mouse');
    const expected = pos(mouse.camera);
    cleanup(); mouse.canvas.remove();
    const pen = rig('select');
    act(() => {
      pen.canvas.dispatchEvent(pointer('pointerdown', 'pen', 100, 100));
      pen.canvas.dispatchEvent(touchEvent('touchstart', pen.canvas, [[100, 100]], 'stylus'));
      // a capture-phase listener stopped this pointerup before the mouse controls saw it
      pen.canvas.dispatchEvent(touchEvent('touchend', pen.canvas, []));
    });
    const before = pos(pen.camera);
    // A Pencil hover move releases the stale ownership; a following press without touches is the mouse side's
    act(() => pen.canvas.dispatchEvent(pointer('pointermove', 'pen', 400, 300)));
    assert.equal(pos(pen.camera), before, 'a hover move orbited');
    pointerDrag(pen.canvas, 'pen');
    assert.equal(pos(pen.camera), expected, 'the pointer-only pen drag no longer orbits like a mouse drag');
  });

  it('a held desktop pen press cancelled before it runs places nothing', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const { canvas } = rig('measure');
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 'pen', 200, 300));
      canvas.dispatchEvent(pointer('pointercancel', 'pen', 200, 300));
      await settle();
    });
    assert.equal(useViewerStore.getState().activeMeasurement === null, true, 'a cancelled pen press set a distance start');
  });

  it('an iPad pen press cancelled by the system places nothing on either side', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const { canvas } = rig('measure');
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 'pen', 200, 300));
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[200, 300]], 'stylus'));
      canvas.dispatchEvent(pointer('pointercancel', 'pen', 200, 300));
      canvas.dispatchEvent(touchEvent('touchcancel', canvas, []));
      await settle();
    });
    assert.equal(useViewerStore.getState().activeMeasurement === null, true, 'BUG: a cancelled pen press set a distance start');
  });

  it('an iPad pen tap in Select selects once', async () => {
    const { canvas, selectionCount } = rig('select', 42);
    await pencilTap(canvas, 200, 300);
    assert.equal(selectionCount(), 1, `BUG: one pen tap selected ${selectionCount()} times`);
  });

  it('a touch at the pen point without touchType still claims the press', async () => {
    const { canvas, selectionCount } = rig('select', 42);
    await pencilTap(canvas, 200, 300, undefined);
    assert.equal(selectionCount(), 1, `BUG: one pen tap selected ${selectionCount()} times`);
  });

  it('two iPad pen taps in Measure Distance measure once, start to end', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const { canvas } = rig('measure');
    await pencilTap(canvas, 200, 300);
    const start = useViewerStore.getState().activeMeasurement?.start.x;
    assert.equal(start, 2, `the first pen tap set the start at x ${String(start)}, expected 2`);
    assert.equal(useViewerStore.getState().measurements.length, 0, 'BUG: the first pen tap finished a measurement');
    await pencilTap(canvas, 500, 300);
    const { measurements, activeMeasurement } = useViewerStore.getState();
    assert.equal(measurements.length, 1, `BUG: two pen taps made ${measurements.length} measurements`);
    assert.equal(activeMeasurement === null, true, 'BUG: a start was left pending after the second tap');
    assert.ok(Math.abs(measurements[0].distance - 3) < 1e-9, `distance ${measurements[0].distance}, expected 3`);
  });

  it('a pen tap in Measure Polyline adds one point', async () => {
    useViewerStore.setState({ measureMode: 'polyline', activePolyline: null });
    const { canvas } = rig('measure');
    await pencilTap(canvas, 200, 300);
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 1, 'BUG: one pen tap added more or less than one polyline point');
    useViewerStore.getState().cancelPolyline();
  });

  it('a desktop pen (pointer events only) still drags through the mouse controls', () => {
    const mouse = rig('select');
    pointerDrag(mouse.canvas, 'mouse');
    const expected = pos(mouse.camera);
    cleanup(); mouse.canvas.remove();
    const pen = rig('select');
    pointerDrag(pen.canvas, 'pen');
    assert.equal(pos(pen.camera), expected, 'the desktop pen drag no longer orbits like a mouse drag');
  });

  it('a desktop pen tap selects once, through the click', async () => {
    const { canvas, selectionCount } = rig('select', 42);
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 'pen', 200, 300));
      await settle();
      canvas.dispatchEvent(pointer('pointerup', 'pen', 200, 300));
      canvas.dispatchEvent(click(200, 300));
      await settle();
    });
    assert.equal(selectionCount(), 1, `a desktop pen tap selected ${selectionCount()} times`);
  });

  it('two desktop pen clicks in Measure Distance measure once', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const { canvas } = rig('measure');
    for (const x of [200, 500]) {
      await act(async () => {
        canvas.dispatchEvent(pointer('pointerdown', 'pen', x, 300));
        canvas.dispatchEvent(pointer('pointerup', 'pen', x, 300));
        canvas.dispatchEvent(click(x, 300));
        await settle();
      });
    }
    const { measurements } = useViewerStore.getState();
    assert.equal(measurements.length, 1, `two desktop pen clicks made ${measurements.length} measurements`);
    assert.ok(Math.abs(measurements[0].distance - 3) < 1e-9, `distance ${measurements[0].distance}, expected 3`);
  });

  it('a desktop pen press held past a task still runs when nothing claims it', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const { canvas } = rig('measure');
    await act(async () => { canvas.dispatchEvent(pointer('pointerdown', 'pen', 200, 300)); await settle(); });
    assert.equal(useViewerStore.getState().activeMeasurement?.start.x, 2, 'the held desktop pen press never set the start');
    act(() => canvas.dispatchEvent(pointer('pointerup', 'pen', 200, 300)));
  });

  it('a finger touch far from a held desktop pen press does not take it', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const { canvas } = rig('measure');
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 'pen', 200, 300));
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[600, 100]], 'direct'));
      await settle();
    });
    assert.equal(useViewerStore.getState().activeMeasurement?.start.x, 2, 'a distant finger took the desktop pen press');
    act(() => {
      canvas.dispatchEvent(touchEvent('touchcancel', canvas, []));
      canvas.dispatchEvent(pointer('pointerup', 'pen', 200, 300));
    });
  });

  it('a finger (touchType direct) at the point of a held desktop pen press does not take it', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const { canvas } = rig('measure');
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 'pen', 200, 300));
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[202, 300]], 'direct'));
      await settle();
    });
    assert.equal(useViewerStore.getState().activeMeasurement?.start.x, 2, 'a finger took the desktop pen press');
    act(() => {
      canvas.dispatchEvent(touchEvent('touchcancel', canvas, []));
      canvas.dispatchEvent(pointer('pointerup', 'pen', 200, 300));
    });
  });

  it('a held desktop pen press does not run after unmount', async () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const { canvas } = rig('measure');
    act(() => canvas.dispatchEvent(pointer('pointerdown', 'pen', 200, 300)));
    cleanup();
    await settle();
    assert.equal(useViewerStore.getState().activeMeasurement === null, true, 'the held press ran after unmount');
  });

  it('the native menu after an iPad pen tap is suppressed, not shown', async () => {
    const { canvas, menus } = rig('select', 42);
    await pencilTap(canvas, 200, 300);
    const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 });
    assert.equal(canvas.dispatchEvent(native), false, 'the native menu after a pen tap was not prevented');
    await act(async () => { await settle(); });
    assert.deepEqual(menus, [], 'the pen tap opened the viewer menu');
  });

  it('a mouse click right after an iPad pen tap still selects', async () => {
    const { canvas, selectionCount } = rig('select', 42);
    await pencilTap(canvas, 200, 300);
    await act(async () => {
      canvas.dispatchEvent(pointer('pointerdown', 'mouse', 200, 300));
      canvas.dispatchEvent(pointer('pointerup', 'mouse', 200, 300));
      canvas.dispatchEvent(click(200, 300, 'mouse'));
      await settle();
    });
    assert.equal(selectionCount(), 2, `pen tap then mouse click selected ${selectionCount()} times`);

/** The Measurements list's Finish button for the open sequence, by its accessible name. */
function finishButton(): HTMLElement | null {
  const container = render(<MeasurementList />);
  return container.querySelector<HTMLElement>('button[aria-label="Finish (Enter)"]');
}

describe('touch finishes an open Polyline or Radius (#8991)', () => {
  it('a tapped polyline finishes from the live row as an open length, with no point dropped', async () => {
    useViewerStore.setState({ measureMode: 'polyline' });
    const { canvas } = rig('measure');
    for (const x of [100, 300, 500]) await tap(canvas, x, 300);
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 3, 'three taps placed three points');
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'the in-progress polyline hint after a tap');
    assert.match(hint(), /Measurements/, 'the hint names where touch finishes');
    const finish = finishButton();
    assert.equal(finish !== null, true, 'the live polyline row offers Finish');
    act(() => click(finish!));
    const { activePolyline, polylineMeasurements } = useViewerStore.getState();
    assert.equal(activePolyline, null, 'the sequence is finished');
    assert.equal(polylineMeasurements.length, 1);
    assert.equal(polylineMeasurements[0].closed, false, 'finished open, as Enter does');
    assert.deepEqual(polylineMeasurements[0].points.map((p) => p.x), [1, 3, 5], 'no point dropped');
  });

  it('a tapped radius finishes from the live row', async () => {
    useViewerStore.setState({ measureMode: 'radius' });
    const { canvas } = rig('measure');
    for (const x of [100, 300, 500]) await tap(canvas, x, 300);
    assert.equal(useViewerStore.getState().activeRadius?.points.length, 3, 'three taps placed three points');
    assert.doesNotMatch(hint(), MOUSE_ONLY, 'the in-progress radius hint after a tap');
    assert.match(hint(), /Measurements/, 'the hint names where touch finishes');
    const finish = finishButton();
    assert.equal(finish !== null, true, 'the live radius row offers Finish');
    act(() => click(finish!));
    const { activeRadius, radiusMeasurements } = useViewerStore.getState();
    assert.equal(activeRadius, null, 'the sequence is finished');
    assert.deepEqual(radiusMeasurements.map((m) => m.points.length), [3]);
  });

  it('Finish on a one-point polyline records nothing and keeps the sequence open', async () => {
    useViewerStore.setState({ measureMode: 'polyline' });
    const { canvas } = rig('measure');
    await tap(canvas, 100, 300);
    act(() => click(finishButton()!));
    const { activePolyline, polylineMeasurements } = useViewerStore.getState();
    assert.equal(polylineMeasurements.length, 0);
    assert.equal(activePolyline?.points.length, 1, 'the open point survives for the next tap');
  });

  it('with nothing open the list offers no Finish', () => {
    useViewerStore.setState({ measureMode: 'polyline', polylineMeasurements: [{ id: 'pl', points: [], closed: false, length: 0 }] });
    assert.equal(finishButton() === null, true);
  });
});
