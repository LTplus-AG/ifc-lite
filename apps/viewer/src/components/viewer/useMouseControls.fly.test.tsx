/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Right-button fly mode as the canvas sees it. `flyControls.test.ts` covers
 * the controller; this mounts the real hook and dispatches real pointer and
 * wheel events, because the routing (right button looks instead of panning,
 * the wheel sets speed instead of zooming, a plain right-click still opens the
 * context menu) only exists in `useMouseControls`.
 *
 * It deliberately imports no fly module: the revert oracle reverts the branch's
 * production files, and a test importing a module that revert deletes dies at
 * load instead of failing on an assertion. Speed-level arithmetic lives in
 * `flyControls.test.ts`; here the wheel is observed through the camera alone.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useMouseControls, type UseMouseControlsParams, type MouseState } from './useMouseControls.js';

const ref = <T,>(current: T) => ({ current });
const noop = () => {};

function pointer(type: string, button: number, x: number, y: number): PointerEvent {
  const e = new PointerEvent(type, { button, pointerId: 1, bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    clientX: { value: x, configurable: true },
    clientY: { value: y, configurable: true },
  });
  return e;
}

const mounted: { root: Root; host: HTMLElement }[] = [];

function mount(overrides: Partial<UseMouseControlsParams> = {}): { canvas: HTMLCanvasElement; camera: Camera; menus: number[] } {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  // happy-dom does not implement pointer capture on canvas in every version.
  Object.assign(canvas, { setPointerCapture: noop, releasePointerCapture: noop });
  document.body.appendChild(canvas);

  const camera = new Camera();
  camera.setPosition(0, 1.6, 10);
  camera.setTarget(0, 1.6, 0);
  const menus: number[] = [];
  const renderer = {
    getCamera: () => camera,
    getScene: () => ({}),
    requestRender: noop,
    pick: async () => null,
    pickRect: async () => [],
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
  return { canvas, camera, menus };
}

describe('useMouseControls right-button fly mode', () => {
  afterEach(() => {
    while (mounted.length) {
      const { root, host } = mounted.pop()!;
      act(() => root.unmount());
      host.remove();
    }
    document.body.innerHTML = '';
  });

  it('right-drag looks around the camera instead of panning', () => {
    const { canvas, camera } = mount();
    const target0 = camera.getTarget();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    canvas.dispatchEvent(pointer('pointermove', 2, 460, 300));
    assert.deepEqual(camera.getPosition(), { x: 0, y: 1.6, z: 10 }, 'a pan would have moved the camera');
    assert.ok(camera.getTarget().x > target0.x + 0.1, 'dragging right turns the view right');
    canvas.dispatchEvent(pointer('pointerup', 2, 460, 300));
  });

  it('the wheel does not zoom while flying, and zooms again after release', () => {
    const { canvas, camera } = mount();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    const wheel = (deltaY: number) => {
      const e = new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true });
      Object.defineProperties(e, { clientX: { value: 400 }, clientY: { value: 300 } });
      return e;
    };
    canvas.dispatchEvent(wheel(-120));
    assert.deepEqual(camera.getPosition(), { x: 0, y: 1.6, z: 10 }, 'no zoom while flying');
    canvas.dispatchEvent(wheel(120)); // step the persisted fly speed back down

    canvas.dispatchEvent(pointer('pointerup', 2, 400, 300));
    canvas.dispatchEvent(wheel(-120));
    assert.notDeepEqual(camera.getPosition(), { x: 0, y: 1.6, z: 10 }, 'plain wheel zooms');
  });

  it('a plain right-click whose contextmenu fired on press still opens the menu on release', async () => {
    const { canvas, menus } = mount();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    assert.equal(menus.length, 0, 'held back while the button is down');
    canvas.dispatchEvent(pointer('pointerup', 2, 400, 300));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(menus.length, 1);
  });

  /** #4868 review: `?controls=none` freezes the embed, and fly must not be a way around it. */
  it('a frozen view (controls=none) does not fly on the right button (#4868)', () => {
    const { canvas, camera } = mount();
    camera.setInteractionMode('none'); // what Viewport's setInteractionMode callback does
    const initial = useViewerStore.getState().interactionMode;
    useViewerStore.setState({ interactionMode: 'none' });
    try {
      canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
      canvas.dispatchEvent(pointer('pointermove', 2, 460, 330));
      canvas.dispatchEvent(pointer('pointerup', 2, 460, 330));
      assert.deepEqual(camera.getPosition(), { x: 0, y: 1.6, z: 10 });
      assert.deepEqual(camera.getTarget(), { x: 0, y: 1.6, z: 0 }, 'a frozen view must not turn');
    } finally {
      useViewerStore.setState({ interactionMode: initial });
    }
  });

  /**
   * #4868 review: Alt-Tab with the button held and the pointerup never comes.
   * The flight has to end with the focus, and so does the hook's drag, or the
   * wheel keeps setting fly speed and the next move keeps looking.
   */
  it('losing window focus mid-flight hands the wheel back to zoom (#4868)', () => {
    const { canvas, camera } = mount();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    window.dispatchEvent(new Event('blur'));
    const e = new WheelEvent('wheel', { deltaY: -120, deltaMode: 0, bubbles: true, cancelable: true });
    Object.defineProperties(e, { clientX: { value: 400 }, clientY: { value: 300 } });
    canvas.dispatchEvent(e);
    assert.notDeepEqual(camera.getPosition(), { x: 0, y: 1.6, z: 10 }, 'the wheel zooms again');
    const pose = { position: camera.getPosition(), target: camera.getTarget() };
    canvas.dispatchEvent(pointer('pointermove', 0, 460, 300));
    assert.deepEqual({ position: camera.getPosition(), target: camera.getTarget() }, pose, 'a buttonless move after the lost release must not move the camera');
  });

  /** #4868 review: a keys-only flight moved the camera under a stale hover tooltip. */
  it('pressing the right button clears the hover tooltip (#4868)', () => {
    let cleared = 0;
    const { canvas } = mount({ clearHover: () => { cleared++; } });
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    assert.ok(cleared > 0, 'the tooltip would otherwise ride along with the flight');
    canvas.dispatchEvent(pointer('pointerup', 2, 400, 300));
  });

  /** #4868 review: an active measurement routed right-button moves to the measure drag instead of the look. */
  it('the right button flies in the measure tool, even with a measurement active (#4868)', () => {
    const point = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
    let updates = 0;
    const { canvas, camera } = mount({
      activeToolRef: { current: 'measure' },
      activeMeasurementRef: { current: { start: point, current: point, distance: 0 } },
      updateMeasurement: () => { updates++; },
    });
    const target0 = camera.getTarget();
    canvas.dispatchEvent(pointer('pointerdown', 2, 400, 300));
    canvas.dispatchEvent(pointer('pointermove', 2, 460, 300));
    assert.ok(camera.getTarget().x > target0.x + 0.1, 'the right-drag looks around');
    assert.equal(updates, 0, 'and does not drag the measurement');
    canvas.dispatchEvent(pointer('pointerup', 2, 460, 300));
  });
});
